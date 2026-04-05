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

const STRIPE_BILLING_FEE = 1.16

// ── 결제 기록 헬퍼 함수 (중복 방지: stripe_payment_id + stripe_invoice_id unique 체크) ──
async function recordPayment(opts: {
  userId: string
  stripePaymentId?: string | null
  stripeInvoiceId?: string | null
  amount: number
  currency: string
  paymentType: string
  shBundleSize?: number | null
  subscriptionUUID?: string | null
  stripeChargeId?: string | null
  description?: string | null
  isSubscriptionInvoice?: boolean
  plan?: string | null
}) {
  // ── 중복 방지: 동일 stripe_payment_id 또는 stripe_invoice_id 이미 존재하면 skip ──
  if (opts.stripePaymentId) {
    const { data: existing } = await supabase
      .from('payments')
      .select('id')
      .eq('stripe_payment_id', opts.stripePaymentId)
      .maybeSingle()
    if (existing) {
      console.log(`recordPayment: duplicate skipped for stripe_payment_id=${opts.stripePaymentId}`)
      return
    }
  }
  if (opts.stripeInvoiceId) {
    const { data: existing } = await supabase
      .from('payments')
      .select('id')
      .eq('stripe_invoice_id', opts.stripeInvoiceId)
      .maybeSingle()
    if (existing) {
      console.log(`recordPayment: duplicate skipped for stripe_invoice_id=${opts.stripeInvoiceId}`)
      return
    }
  }

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
        chargeFee = balanceTx.fee / 100
        balanceTxId = balanceTx.id
      }
    } catch (e) {
      console.error('charge retrieve error:', e)
    }
  }

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

  if (error) console.error('payments insert error:', error)
}

serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  const body = await req.text()

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

  try {
    switch (event.type) {

      // ── 구독/SH번들 결제 완료 ──
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.metadata?.user_id
        const priceId = session.metadata?.price_id
        const propertyId = session.metadata?.property_id || null

        if (!userId || !priceId) break

        // ── 구독 플랜인 경우 ──
        if (PRICE_TO_PLAN[priceId]) {
          const plan = PRICE_TO_PLAN[priceId]
          const stripeSubId = session.subscription as string

          const stripeSub = await stripe.subscriptions.retrieve(stripeSubId)

          const subData: Record<string, unknown> = {
            user_id: userId,
            plan_type: plan,
            status: 'active',
            stripe_subscription_id: stripeSubId,
            stripe_customer_id: session.customer as string,
            cleaning_hours_total: CLEANING_HOURS_MAP[plan] || 0,
            cleaning_hours_used: 0,
            voucher_sh_total: VOUCHER_MAP[plan],
            voucher_sh_period: 0,
            sh_hours_total: VOUCHER_MAP[plan],
            sh_hours_used: 0,
            start_date: new Date().toISOString(),
            end_date: null,
            current_period_end: stripeSub.current_period_end,
          }
          if (propertyId) subData.property_id = propertyId

          const { error: upsertError } = propertyId
            ? await supabase.from('subscriptions').upsert(subData, { onConflict: 'user_id,property_id' })
            : await supabase.from('subscriptions').upsert(subData, { onConflict: 'user_id' })

          if (upsertError) console.error('subscriptions upsert error:', upsertError)

          // payments 기록 (중복 방지 내장)
          // 구독 결제는 session.payment_intent가 null — invoice에서 charge 조회
          let paymentIntentId: string | null = session.payment_intent as string || null
          let chargeId: string | null = null
          let invoiceId: string | null = session.invoice as string || null

          try {
            if (invoiceId) {
              // invoice에서 payment_intent + charge 조회 (구독 결제 표준 방법)
              const invoice = await stripe.invoices.retrieve(invoiceId)
              if (!paymentIntentId && invoice.payment_intent) {
                paymentIntentId = invoice.payment_intent as string
              }
              if (invoice.charge) {
                chargeId = invoice.charge as string
              } else if (paymentIntentId) {
                const pi = await stripe.paymentIntents.retrieve(paymentIntentId)
                chargeId = pi.latest_charge as string || null
              }
            } else if (paymentIntentId) {
              const pi = await stripe.paymentIntents.retrieve(paymentIntentId)
              chargeId = pi.latest_charge as string || null
            }
          } catch (e) {
            console.error('charge retrieval error:', e)
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

          // 구독 확인 이메일
          try {
            const { data: { user } } = await supabase.auth.admin.getUserById(userId)
            const customerEmail = user?.email || ''
            const customerName = user?.user_metadata?.full_name || ''

            let receiptUrl = ''
            let amountPaid = session.amount_total ? session.amount_total / 100 : 0
            let billingCycle = ''
            try {
              if (stripeSubId) {
                const invoices = await stripe.invoices.list({ subscription: stripeSubId, limit: 1 })
                const invoice = invoices.data[0]
                receiptUrl = invoice?.hosted_invoice_url || ''
                if (invoice?.amount_paid) amountPaid = invoice.amount_paid / 100
              }
              const stripeSub2 = await stripe.subscriptions.retrieve(stripeSubId)
              billingCycle = stripeSub2.items.data[0]?.plan?.interval || ''
            } catch(e) { console.error('stripe invoice/interval fetch error:', e) }

            if (customerEmail) {
              const supabaseUrl = Deno.env.get('SUPABASE_URL')!
              await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${Deno.env.get('SB_SERVICE_ROLE_KEY')}`,
                },
                body: JSON.stringify({
                  type: 'subscription_confirmed',
                  notify_admins: true,
                  recipients: [{ id: userId, type: 'customer' }],
                  reference_type: 'cleaning',
                  details: { plan, customer_name: customerName, receipt_url: receiptUrl, amount: amountPaid, billing_cycle: billingCycle },
                }),
              })
              console.log(`subscription_confirmed sent to ${customerEmail}`)
            }
          } catch(e) {
            console.error('subscription_confirmed email error:', e)
          }
        }

        // ── SH 번들 구매인 경우 ──
        if (SH_PRICES[priceId]) {
          const shAmount = SH_PRICES[priceId]

          let subQuery = supabase
            .from('subscriptions')
            .select('id, sh_hours_total')
            .eq('user_id', userId)
          if (propertyId) subQuery = subQuery.eq('property_id', propertyId)

          const { data: sub } = await subQuery.maybeSingle()

          if (!sub) {
            // property에 구독이 없으면 SH번들 업데이트 불가 — 로그만 남김
            console.error(`SH bundle: no subscription found for user=${userId} property=${propertyId}`)
          } else {
            const currentSH = Number(sub.sh_hours_total) ?? 0

            let updateQuery = supabase
              .from('subscriptions')
              .update({ sh_hours_total: currentSH + shAmount })
              .eq('user_id', userId)
            if (propertyId) updateQuery = updateQuery.eq('property_id', propertyId)

            const { error } = await updateQuery
            if (error) console.error('sh_hours_total update error:', error)
            else console.log(`SH bundle +${shAmount} applied to subscription ${sub.id}, total=${currentSH + shAmount}`)
          }

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

          // SH번들 확인 이메일
          try {
            const { data: { user } } = await supabase.auth.admin.getUserById(userId)
            const customerEmail = user?.email || ''
            const customerName = user?.user_metadata?.full_name || ''

            let receiptUrl = ''
            const amountPaid = session.amount_total ? session.amount_total / 100 : 0
            try {
              if (paymentIntentId) {
                const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] })
                const charge = pi.latest_charge as any
                receiptUrl = charge?.receipt_url || ''
              }
            } catch(e) { console.error('SH receipt fetch error:', e) }

            if (customerEmail) {
              const supabaseUrl = Deno.env.get('SUPABASE_URL')!
              await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${Deno.env.get('SB_SERVICE_ROLE_KEY')}`,
                },
                body: JSON.stringify({
                  type: 'sh_bundle_confirmed',
                  notify_admins: true,
                  recipients: [{ id: userId, type: 'customer' }],
                  reference_type: 'service',
                  details: { sh_amount: shAmount, customer_name: customerName, amount: amountPaid, receipt_url: receiptUrl },
                }),
              })
              console.log(`sh_bundle_confirmed sent to ${customerEmail}`)
            }
          } catch(e) {
            console.error('sh_bundle_confirmed email error:', e)
          }
        }
        break
      }

      // ── 구독 갱신 (매월 자동결제) — 신규 구독 첫 결제는 반드시 skip ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
        const stripeSubId = invoice.subscription as string
        if (!stripeSubId) break

        // ★ 핵심: billing_reason이 subscription_cycle(갱신)일 때만 처리
        // subscription_create(신규), manual 등은 checkout.session.completed에서 처리
        if (invoice.billing_reason !== 'subscription_cycle') {
          console.log(`invoice.payment_succeeded skipped: billing_reason=${invoice.billing_reason}`)
          break
        }

        const stripeSub = await stripe.subscriptions.retrieve(stripeSubId)
        const priceId = stripeSub.items.data[0]?.price.id
        const plan = PRICE_TO_PLAN[priceId]
        if (!plan) break

        // stripe_subscription_id로 구독 조회
        const { data: subRecord } = await supabase
          .from('subscriptions')
          .select('id, user_id, voucher_sh_total, sh_hours_total')
          .eq('stripe_subscription_id', stripeSubId)
          .maybeSingle()

        if (!subRecord) {
          console.error(`invoice.payment_succeeded: no subscription found for stripeSubId=${stripeSubId}`)
          break
        }

        // 갱신: 바우처 추가 + 청소시간 리셋
        const newVoucherTotal = (Number(subRecord.voucher_sh_total) ?? 0) + VOUCHER_MAP[plan]
        const newSHTotal = (Number(subRecord.sh_hours_total) ?? 0) + VOUCHER_MAP[plan]

        const { error } = await supabase
          .from('subscriptions')
          .update({
            status: 'active',
            end_date: new Date(stripeSub.current_period_end * 1000).toISOString(),
            current_period_end: stripeSub.current_period_end,
            voucher_sh_total: newVoucherTotal,
            sh_hours_total: newSHTotal,
            cleaning_hours_total: CLEANING_HOURS_MAP[plan] || 0,
            cleaning_hours_used: 0,
          })
          .eq('stripe_subscription_id', stripeSubId)

        if (error) console.error('invoice renewal update error:', error)
        else console.log(`subscription renewed: ${stripeSubId}, new sh_hours_total=${newSHTotal}`)

        // payments 기록 (중복 방지 내장)
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

        // 갱신 확인 이메일
        try {
          const { data: { user } } = await supabase.auth.admin.getUserById(subRecord.user_id)
          const customerEmail = user?.email || ''
          const customerName = user?.user_metadata?.full_name || ''
          const amountPaid = invoice.amount_paid ? invoice.amount_paid / 100 : 0
          const receiptUrl = invoice.hosted_invoice_url || ''
          const billingCycle = stripeSub.items.data[0]?.plan?.interval || ''
          const nextDate = new Date(stripeSub.current_period_end * 1000)
            .toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })

          if (customerEmail) {
            const supabaseUrl = Deno.env.get('SUPABASE_URL')!
            await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Deno.env.get('SB_SERVICE_ROLE_KEY')}`,
              },
              body: JSON.stringify({
                type: 'subscription_renewed',
                recipients: [{ id: subRecord.user_id, type: 'customer' }],
                reference_type: 'cleaning',
                details: { plan, customer_name: customerName, amount: amountPaid, billing_cycle: billingCycle, receipt_url: receiptUrl, next_renewal_date: nextDate },
              }),
            })
            console.log(`subscription_renewed sent to ${customerEmail}`)
          }
        } catch(e) {
          console.error('subscription_renewed email error:', e)
        }
        break
      }

      // ── 구독 취소 ──
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription

        // DB에서 구독 정보 조회
        const { data: subRecord } = await supabase
          .from('subscriptions')
          .select('id, user_id, plan_type, cancellation_reason, pending_cancellation')
          .eq('stripe_subscription_id', sub.id)
          .maybeSingle()

        // status 업데이트
        const { error } = await supabase
          .from('subscriptions')
          .update({ status: 'cancelled', end_date: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id)

        if (error) console.error('subscription cancel error:', error)

        // 취소 확인 이메일 발송 (Case A + Case B 완료 모두)
        if (subRecord?.user_id) {
          try {
            const planLabel: Record<string, string> = {
              essential: 'Essential Care', smart: 'Smart Care', premium: 'Premium Care'
            }
            const supabaseUrl = Deno.env.get('SUPABASE_URL')!
            await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SB_SERVICE_ROLE_KEY')}` },
              body: JSON.stringify({
                type: 'subscription_cancelled',
                notify_admins: true,
                recipients: [{ id: subRecord.user_id, type: 'customer' }],
                reference_type: 'cleaning',
                details: {
                  plan: subRecord.plan_type,
                  reason: subRecord.cancellation_reason || 'general',
                  cancelled_on: new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }),
                },
              }),
            })
            console.log(`subscription_cancelled email sent for sub: ${sub.id}`)
          } catch(e) {
            console.error('subscription_cancelled email error:', e)
          }
        }
        break
      }

      // ── 환불 완료 ──
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        const refundId = charge.refunds?.data?.[0]?.id || null
        const refundAmount = charge.amount_refunded / 100
        const chargeId = charge.id

        // payments 테이블 업데이트
        const isFullRefund = charge.refunded
        const { data: payment } = await supabase
          .from('payments')
          .select('id, amount, payment_type, subscription_id, sh_bundle_size, user_id')
          .eq('stripe_charge_id', chargeId)
          .maybeSingle()

        if (payment) {
          await supabase.from('payments').update({
            status: isFullRefund ? 'refunded' : 'partial_refunded',
            refund_amount: refundAmount,
            refunded_at: new Date().toISOString(),
            stripe_refund_id: refundId,
            refund_reason: charge.refunds?.data?.[0]?.metadata?.refund_reason || null,
          }).eq('id', payment.id)

          // SH번들 환불 → sh_hours 차감
          if (payment.payment_type === 'sh_bundle' && payment.subscription_id) {
            const { data: sub } = await supabase
              .from('subscriptions')
              .select('sh_hours_total, sh_hours_used')
              .eq('id', payment.subscription_id)
              .maybeSingle()

            if (sub) {
              // 환불된 SH 수량 계산 (환불금액 / $99)
              const refundedSH = Math.round(refundAmount / 99)
              const newTotal = Math.max(0, Number(sub.sh_hours_total) - refundedSH)
              await supabase.from('subscriptions')
                .update({ sh_hours_total: newTotal })
                .eq('id', payment.subscription_id)
            }
          }

          // 구독 환불 (전액) → subscriptions 취소
          if (payment.payment_type === 'subscription' && isFullRefund && payment.subscription_id) {
            await supabase.from('subscriptions')
              .update({ status: 'cancelled' })
              .eq('id', payment.subscription_id)
          }

          // 고객 이메일 발송
          try {
            const supabaseUrl = Deno.env.get('SUPABASE_URL')!
            await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SB_SERVICE_ROLE_KEY')}` },
              body: JSON.stringify({
                type: 'refund_confirmed',
                notify_admins: true,
                recipients: [{ id: payment.user_id, type: 'customer' }],
                reference_type: 'cleaning',
                details: {
                  refund_amount: refundAmount,
                  is_full_refund: isFullRefund,
                  refund_reason: charge.refunds?.data?.[0]?.metadata?.refund_reason || '',
                },
              }),
            })
            console.log(`refund_confirmed sent, amount: ${refundAmount}`)
          } catch(e) {
            console.error('refund_confirmed email error:', e)
          }
        }
        break
      }

      // ── 추가 납부 완료 ──
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice

        // payments 테이블 업데이트
        const { data: payment } = await supabase
          .from('payments')
          .select('id, subscription_id')
          .eq('stripe_additional_invoice_id', invoice.id)
          .maybeSingle()

        if (payment) {
          await supabase.from('payments').update({
            status: 'additional_paid',
            paid_at: new Date().toISOString(),
          }).eq('id', payment.id)
          console.log(`additional_charge paid: invoice=${invoice.id}`)

          // pending_cancellation 구독 확인 → 자동 취소
          if (payment.subscription_id) {
            const { data: subRecord } = await supabase
              .from('subscriptions')
              .select('id, stripe_subscription_id, pending_cancellation')
              .eq('id', payment.subscription_id)
              .maybeSingle()

            if (subRecord?.pending_cancellation && subRecord?.stripe_subscription_id) {
              try {
                // Stripe 구독 취소 → customer.subscription.deleted webhook 발생 → DB + 이메일 처리
                await stripe.subscriptions.cancel(subRecord.stripe_subscription_id)
                console.log(`Pending cancellation executed: ${subRecord.stripe_subscription_id}`)
              } catch(e) {
                console.error('Pending cancellation error:', e)
              }
            }
          }
        }
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

        try {
          const stripeSub = await stripe.subscriptions.retrieve(stripeSubId)
          const priceId = stripeSub.items.data[0]?.price.id
          const plan = PRICE_TO_PLAN[priceId] || ''
          const billingCycle = stripeSub.items.data[0]?.plan?.interval || ''

          const { data: subRecord } = await supabase
            .from('subscriptions')
            .select('user_id')
            .eq('stripe_subscription_id', stripeSubId)
            .maybeSingle()

          if (subRecord?.user_id) {
            const { data: { user } } = await supabase.auth.admin.getUserById(subRecord.user_id)
            const customerEmail = user?.email || ''
            const customerName = user?.user_metadata?.full_name || ''
            const amountDue = invoice.amount_due ? invoice.amount_due / 100 : 0
            const failedDate = new Date(invoice.created * 1000)
              .toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })

            let portalUrl = 'https://havenpluscare.com/dashboard.html'
            try {
              const portalSession = await stripe.billingPortal.sessions.create({
                customer: stripeSub.customer as string,
                return_url: 'https://havenpluscare.com/dashboard.html',
              })
              portalUrl = portalSession.url
            } catch(e) { console.error('portal session error:', e) }

            if (customerEmail) {
              const supabaseUrl = Deno.env.get('SUPABASE_URL')!
              await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${Deno.env.get('SB_SERVICE_ROLE_KEY')}`,
                },
                body: JSON.stringify({
                  type: 'payment_failed',
                  notify_admins: true,
                  recipients: [{ id: subRecord.user_id, type: 'customer' }],
                  reference_type: 'cleaning',
                  details: { plan, customer_name: customerName, amount: amountDue, billing_cycle: billingCycle, failed_date: failedDate, portal_url: portalUrl, attempt_count: invoice.attempt_count || 1 },
                }),
              })
              console.log(`payment_failed sent to ${customerEmail}`)
            }
          }
        } catch(e) {
          console.error('payment_failed email error:', e)
        }
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
