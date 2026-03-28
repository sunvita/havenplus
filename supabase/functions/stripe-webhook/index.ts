import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@13'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
})

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SB_SERVICE_ROLE_KEY')!
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

// Plan별 바우처 SH 수량
const VOUCHER_MAP: Record<string, number> = {
  essential: 2,
  smart: 3,
  premium: 6,
}

// ── 내부 subscription UUID 조회 헬퍼 ──
async function getSubscriptionUUID(stripeSubId: string): Promise<string | null> {
  const { data } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('stripe_subscription_id', stripeSubId)
    .maybeSingle()
  return data?.id || null
}

// ── 결제 기록 헬퍼 함수 ──
async function recordPayment(opts: {
  userId: string
  stripePaymentId?: string | null
  stripeInvoiceId?: string | null
  amount: number          // cents (Stripe 원본)
  currency: string
  paymentType: string     // 'subscription' | 'sh_bundle'
  shBundleSize?: number | null
  subscriptionUUID?: string | null  // 내부 UUID
  stripeChargeId?: string | null
  description?: string | null
}) {
  // Stripe charge에서 수수료 정보 조회
  let stripeFee = null
  let netAmount = null
  let balanceTxId = null

  if (opts.stripeChargeId) {
    try {
      const charge = await stripe.charges.retrieve(opts.stripeChargeId, {
        expand: ['balance_transaction'],
      })
      const balanceTx = charge.balance_transaction as Stripe.BalanceTransaction
      if (balanceTx) {
        stripeFee = balanceTx.fee / 100
        netAmount = balanceTx.net / 100
        balanceTxId = balanceTx.id
      }
    } catch (e) {
      console.error('charge retrieve error:', e)
    }
  }

  const amountDollars = opts.amount / 100

  const { error } = await supabase.from('payments').insert({
    user_id: opts.userId,
    stripe_payment_id: opts.stripePaymentId || null,
    stripe_invoice_id: opts.stripeInvoiceId || null,
    amount: amountDollars,
    currency: opts.currency || 'aud',
    payment_type: opts.paymentType,
    sh_bundle_size: opts.shBundleSize || null,
    status: 'paid',
    paid_at: new Date().toISOString(),
    subscription_id: opts.subscriptionUUID || null,
    stripe_charge_id: opts.stripeChargeId || null,
    stripe_balance_transaction_id: balanceTxId,
    stripe_fee: stripeFee,
    net_amount: netAmount ?? amountDollars,
    description: opts.description || null,
  })

  if (error) console.error('payments insert error:', error)
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

          const { error } = await supabase.from('subscriptions').upsert({
            user_id: userId,
            plan_type: plan,
            status: 'active',
            stripe_subscription_id: stripeSubId,
            stripe_customer_id: session.customer as string,
            voucher_sh_total: VOUCHER_MAP[plan],
            voucher_sh_period: 0,
            start_date: new Date().toISOString(),
            end_date: null,
          }, { onConflict: 'user_id' })

          if (error) console.error('subscriptions upsert error:', error)

          // ── 결제 기록 → payments 테이블 ──
          const paymentIntentId = session.payment_intent as string
          let chargeId: string | null = null
          if (paymentIntentId) {
            try {
              const pi = await stripe.paymentIntents.retrieve(paymentIntentId)
              chargeId = pi.latest_charge as string || null
            } catch (e) {
              console.error('paymentIntent retrieve error:', e)
            }
          }

          const subUUID = await getSubscriptionUUID(stripeSubId)

          await recordPayment({
            userId,
            stripePaymentId: paymentIntentId,
            amount: session.amount_total || 0,
            currency: session.currency || 'aud',
            paymentType: 'subscription',
            subscriptionUUID: subUUID,
            stripeChargeId: chargeId,
            description: `${plan} plan subscription`,
          })
        }

        // SH 번들 구매인 경우
        if (SH_PRICES[priceId]) {
          const shAmount = SH_PRICES[priceId]

          // 기존 sh_hours_total에 추가
          const { data: sub } = await supabase
            .from('subscriptions')
            .select('id, sh_hours_total')
            .eq('user_id', userId)
            .maybeSingle()

          const currentSH = sub?.sh_hours_total ?? 0

          const { error } = await supabase
            .from('subscriptions')
            .update({ sh_hours_total: currentSH + shAmount })
            .eq('user_id', userId)

          if (error) console.error('sh_hours_total update error:', error)

          // ── 결제 기록 → payments 테이블 ──
          const paymentIntentId = session.payment_intent as string
          let chargeId: string | null = null
          if (paymentIntentId) {
            try {
              const pi = await stripe.paymentIntents.retrieve(paymentIntentId)
              chargeId = pi.latest_charge as string || null
            } catch (e) {
              console.error('paymentIntent retrieve error:', e)
            }
          }

          await recordPayment({
            userId,
            stripePaymentId: paymentIntentId,
            amount: session.amount_total || 0,
            currency: session.currency || 'aud',
            paymentType: 'sh_bundle',
            shBundleSize: shAmount,
            subscriptionUUID: sub?.id || null,
            stripeChargeId: chargeId,
            description: `${shAmount} SH bundle purchase`,
          })
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

        // 내부 subscription 조회
        const { data: subRecord } = await supabase
          .from('subscriptions')
          .select('id, user_id, voucher_sh_total')
          .eq('stripe_subscription_id', stripeSubId)
          .maybeSingle()

        if (!subRecord) break

        // period_end 업데이트 + 갱신 시 바우처 추가 지급
        const newVoucherTotal = (subRecord.voucher_sh_total ?? 0) + VOUCHER_MAP[plan]
        const { error } = await supabase
          .from('subscriptions')
          .update({
            status: 'active',
            end_date: new Date(stripeSub.current_period_end * 1000).toISOString(),
            voucher_sh_total: newVoucherTotal,
          })
          .eq('stripe_subscription_id', stripeSubId)

        if (error) console.error('invoice renewal update error:', error)

        // ── 결제 기록 → payments 테이블 ──
        const chargeId = invoice.charge as string || null

        await recordPayment({
          userId: subRecord.user_id,
          stripePaymentId: invoice.payment_intent as string,
          stripeInvoiceId: invoice.id,
          amount: invoice.amount_paid || 0,
          currency: invoice.currency || 'aud',
          paymentType: 'subscription',
          subscriptionUUID: subRecord.id,
          stripeChargeId: chargeId,
          description: `${plan} plan renewal`,
        })
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
