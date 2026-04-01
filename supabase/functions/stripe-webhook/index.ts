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

// Price ID → plan 매핑 (monthly + annual)
const PRICE_TO_PLAN: Record<string, string> = {
  'price_1TAQ8eETHoBrxXOuBJykRrxO': 'essential',  // monthly
  'price_1TByOdETHoBrxXOuP5mhiRTy': 'essential',  // annual
  'price_1TAQ9ZETHoBrxXOuK0JnkQeb': 'smart',      // monthly
  'price_1TByPYETHoBrxXOuSOpUL7pN': 'smart',      // annual
  'price_1TAQAjETHoBrxXOuyhs48ER7': 'premium',    // monthly
  'price_1TByPwETHoBrxXOuwNJ9BDuH': 'premium',    // annual
}

const SH_PRICES: Record<string, number> = {
  'price_1TAQDNETHoBrxXOu9gW5qdjC': 1,  // 1 SH
  'price_1TAQDtETHoBrxXOuCpFDkNCL': 4,  // 4 SH Bundle
  'price_1TAQEMETHoBrxXOuJ1lTGqCb': 8,  // 8 SH Bundle
}

// Plan별 바우처 SH 수량
const VOUCHER_MAP: Record<string, number> = {
  essential: 2,
  smart: 3,
  premium: 6,
}

// Plan별 연간 청소 시간
const CLEANING_HOURS_MAP: Record<string, number> = {
  essential: 8,
  smart: 12,
  premium: 24,
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

// Stripe Billing Usage Fee (인보이스당 고정 비용: $1.05 + 수수료 $0.11 = $1.16)
// Stripe Billing 기능 사용 시 인보이스당 자동 부과됨
const STRIPE_BILLING_FEE = 1.16

// ── 결제 기록 헬퍼 함수 ──
async function notifyAdminPayment(opts: {
  userId: string
  amount: number        // dollars
  plan: string
  paymentId?: string | null
  paidAt: string
}) {
  try {
    // Resolve customer name + email
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', opts.userId)
      .maybeSingle()

    let customerName = profile?.full_name || ''
    let customerEmail = profile?.email || ''

    if (!customerEmail) {
      const { data: { user } } = await supabase.auth.admin.getUserById(opts.userId)
      customerEmail = user?.email || ''
      if (!customerName) customerName = user?.user_metadata?.full_name || user?.email || ''
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SB_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({
        type: 'payment_received',
        notify_admins: true,
        recipients: [{ id: opts.userId, type: 'customer' }],
        reference_type: 'cleaning',
        details: {
          amount: opts.amount,
          plan: opts.plan,
          customer_name: customerName,
          customer_email: customerEmail,
          payment_id: opts.paymentId,
          paid_at: opts.paidAt,
        },
      }),
    })
  } catch (e) {
    console.error('Admin payment notification failed:', e)
  }
}

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
  isSubscriptionInvoice?: boolean   // Billing Usage Fee 포함 여부
  plan?: string | null
}) {
  // Stripe charge에서 결제 수수료 조회
  let chargeFee = 0
  let balanceTxId = null

  if (opts.stripeChargeId) {
    try {
      const charge = await stripe.charges.retrieve(opts.stripeChargeId, {
        expand: ['balance_transaction'],
      })
      const balanceTx = charge.balance_transaction as Stripe.BalanceTransaction
      if (balanceTx) {
        chargeFee = balanceTx.fee / 100       // 결제 수수료 (예: $2.85)
        balanceTxId = balanceTx.id
      }
    } catch (e) {
      console.error('charge retrieve error:', e)
    }
  }

  // 총 수수료 = 결제 수수료 + Billing Usage Fee (구독 인보이스인 경우)
  const billingFee = opts.isSubscriptionInvoice ? STRIPE_BILLING_FEE : 0
  const totalFee = chargeFee + billingFee

  const amountDollars = opts.amount / 100
  const netAmount = amountDollars - totalFee

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
    stripe_fee: totalFee,
    net_amount: netAmount,
    description: opts.description || null,
  })

  if (error) {
    console.error('payments insert error:', error)
    return
  }

  // Notify admin emails after successful payment record
  if (opts.paymentType === 'subscription' || opts.paymentType === 'sh_bundle') {
    await notifyAdminPayment({
      userId: opts.userId,
      amount: amountDollars,
      plan: opts.plan || opts.description || '',
      paymentId: opts.stripePaymentId,
      paidAt: new Date().toISOString(),
    })
  }
}

serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  const body = await req.text()

  // Webhook 서명 검증 (async required in Deno/Supabase Edge Runtime)
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
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
        const propertyId = session.metadata?.property_id || null

        if (!userId || !priceId) break

        // 구독 플랜인 경우
        if (PRICE_TO_PLAN[priceId]) {
          const plan = PRICE_TO_PLAN[priceId]
          const stripeSubId = session.subscription as string

          // Retrieve Stripe subscription to get period_end
          const stripeSub = await stripe.subscriptions.retrieve(stripeSubId)

          const subData: Record<string, unknown> = {
            user_id: userId,
            plan_type: plan,
            status: 'active',
            stripe_subscription_id: stripeSubId,
            stripe_customer_id: session.customer as string,
            // Cleaning hours
            cleaning_hours_total: CLEANING_HOURS_MAP[plan] || 0,
            cleaning_hours_used: 0,
            // Service hours (voucher)
            voucher_sh_total: VOUCHER_MAP[plan],
            voucher_sh_period: 0,
            sh_hours_total: VOUCHER_MAP[plan],
            sh_hours_used: 0,
            // Dates
            start_date: new Date().toISOString(),
            end_date: null,
            current_period_end: stripeSub.current_period_end,  // Unix timestamp
          }
          if (propertyId) subData.property_id = propertyId

          // Use property-scoped upsert if property_id is present (multi-property),
          // otherwise fall back to user-scoped upsert (legacy single-property)
          const { error } = propertyId
            ? await supabase.from('subscriptions').upsert(
                subData,
                { onConflict: 'user_id,property_id' }
              )
            : await supabase.from('subscriptions').upsert(
                subData,
                { onConflict: 'user_id' }
              )

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
            isSubscriptionInvoice: true,
            plan: `${plan} plan`,
          })
        }

        // SH 번들 구매인 경우
        if (SH_PRICES[priceId]) {
          const shAmount = SH_PRICES[priceId]

          // 기존 sh_hours_total에 추가 (property-scoped if property_id present)
          let subQuery = supabase
            .from('subscriptions')
            .select('id, sh_hours_total')
            .eq('user_id', userId)
          if (propertyId) subQuery = subQuery.eq('property_id', propertyId)

          const { data: sub } = await subQuery.maybeSingle()

          const currentSH = sub?.sh_hours_total ?? 0

          let updateQuery = supabase
            .from('subscriptions')
            .update({ sh_hours_total: currentSH + shAmount })
            .eq('user_id', userId)
          if (propertyId) updateQuery = updateQuery.eq('property_id', propertyId)

          const { error } = await updateQuery

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
            isSubscriptionInvoice: false,
            plan: `${shAmount} SH bundle`,
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
          .select('id, user_id, voucher_sh_total, sh_hours_total')
          .eq('stripe_subscription_id', stripeSubId)
          .maybeSingle()

        if (!subRecord) break

        // period_end 업데이트 + 갱신 시 바우처/시간 추가 지급
        const newVoucherTotal = (subRecord.voucher_sh_total ?? 0) + VOUCHER_MAP[plan]
        const newSHTotal = (subRecord.sh_hours_total ?? 0) + VOUCHER_MAP[plan]
        const { error } = await supabase
          .from('subscriptions')
          .update({
            status: 'active',
            end_date: new Date(stripeSub.current_period_end * 1000).toISOString(),
            current_period_end: stripeSub.current_period_end,
            voucher_sh_total: newVoucherTotal,
            sh_hours_total: newSHTotal,
            // Reset cleaning hours for new period
            cleaning_hours_total: CLEANING_HOURS_MAP[plan] || 0,
            cleaning_hours_used: 0,
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
          isSubscriptionInvoice: true,
          plan: `${plan} plan renewal`,
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
