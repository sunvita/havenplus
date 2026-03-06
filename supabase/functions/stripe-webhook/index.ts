import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@13'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
})

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// Price ID → plan 매핑
const PRICE_TO_PLAN: Record<string, string> = {
  'price_1T7ppGRVro18Xo3KNaJj6ULN': 'essential',
  'price_1T7pqHRVro18Xo3K2ZdYQDoo': 'smart',
  'price_1T7psTRVro18Xo3KRUNcEcRZ': 'premium',
}

const SH_PRICES: Record<string, number> = {
  'price_1T7ptdRVro18Xo3Kvz3Hh0jb': 1,  // 1 SH
  'price_1T7pulRVro18Xo3KaZUWJBre': 4,  // 4 SH Bundle
  'price_1T7pvURVro18Xo3KNLzwtH2Z': 8,  // 8 SH Bundle
}

serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  const body = await req.text()

  // Webhook 서명 검증
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature!,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!
    )
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    return new Response('Webhook Error', { status: 400 })
  }

  // 이벤트 처리
  try {
    switch (event.type) {

      // ── 구독 결제 완료 ──
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.metadata?.user_id
        const priceId = session.metadata?.price_id

        if (!userId || !priceId) break

        // 구독 플랜인 경우
        if (PRICE_TO_PLAN[priceId]) {
          const plan = PRICE_TO_PLAN[priceId]
          const stripeSubId = session.subscription as string

          // SH 바우처 수량 설정
          const voucherMap: Record<string, number> = {
            essential: 2,
            smart: 3,
            premium: 6,
          }

          const { error } = await supabase.from('subscriptions').upsert({
            user_id: userId,
            plan: plan,
            status: 'active',
            stripe_subscription_id: stripeSubId,
            stripe_customer_id: session.customer as string,
            sh_balance: voucherMap[plan],
            started_at: new Date().toISOString(),
            current_period_end: null, // subscription.updated 이벤트에서 업데이트
          }, { onConflict: 'user_id' })

          if (error) console.error('subscriptions upsert error:', error)
        }

        // SH 번들 구매인 경우
        if (SH_PRICES[priceId]) {
          const shAmount = SH_PRICES[priceId]

          // 기존 sh_balance에 추가
          const { data: sub } = await supabase
            .from('subscriptions')
            .select('sh_balance')
            .eq('user_id', userId)
            .maybeSingle()

          const currentBalance = sub?.sh_balance ?? 0

          const { error } = await supabase
            .from('subscriptions')
            .update({ sh_balance: currentBalance + shAmount })
            .eq('user_id', userId)

          if (error) console.error('sh_balance update error:', error)
        }
        break
      }

      // ── 구독 갱신 (매월 자동결제 성공) ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
        const stripeSubId = invoice.subscription as string
        if (!stripeSubId) break

        // 구독 정보 조회
        const stripeSub = await stripe.subscriptions.retrieve(stripeSubId)
        const priceId = stripeSub.items.data[0]?.price.id
        const plan = PRICE_TO_PLAN[priceId]
        if (!plan) break

        const voucherMap: Record<string, number> = {
          essential: 2,
          smart: 3,
          premium: 6,
        }

        // period_end 업데이트 + 갱신 시 바우처 지급
        const { error } = await supabase
          .from('subscriptions')
          .update({
            status: 'active',
            current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString(),
            sh_balance: supabase.rpc('increment_sh', {
              p_stripe_sub_id: stripeSubId,
              p_amount: voucherMap[plan],
            }),
          })
          .eq('stripe_subscription_id', stripeSubId)

        if (error) console.error('invoice renewal update error:', error)
        break
      }

      // ── 구독 취소 ──
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        const { error } = await supabase
          .from('subscriptions')
          .update({ status: 'cancelled' })
          .eq('stripe_subscription_id', sub.id)

        if (error) console.error('subscription cancel error:', error)
        break
      }

      // ── 결제 실패 ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const stripeSubId = invoice.subscription as string
        if (!stripeSubId) break

        const { error } = await supabase
          .from('subscriptions')
          .update({ status: 'past_due' })
          .eq('stripe_subscription_id', stripeSubId)

        if (error) console.error('payment failed update error:', error)
        break
      }
    }
  } catch (err) {
    console.error('Event processing error:', err)
    return new Response('Internal Error', { status: 500 })
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
})
