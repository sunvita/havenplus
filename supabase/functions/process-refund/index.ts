import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@13'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' })
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SB_SERVICE_ROLE_KEY')!)
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── 공통: charge_id 조회 (payment_id or payment_intent 기반) ──
async function resolveChargeId(payment: { stripe_charge_id?: string | null, stripe_payment_id?: string | null }): Promise<string | null> {
  if (payment.stripe_charge_id) return payment.stripe_charge_id
  if (payment.stripe_payment_id) {
    try {
      const pi = await stripe.paymentIntents.retrieve(payment.stripe_payment_id)
      return pi.latest_charge as string || null
    } catch(e) {
      console.error('PaymentIntent retrieve error:', e)
    }
  }
  return null
}

// ── 공통: 취소 확인 이메일 발송 ──
async function sendCancelledEmail(userId: string, details: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({
      type: 'subscription_cancelled',
      notify_admins: true,
      recipients: [{ id: userId, type: 'customer' }],
      reference_type: 'cleaning',
      details,
    }),
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = await req.json()
    const { action } = body

    // ── 어드민 권한 체크 ──
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
    if (profile?.role !== 'admin') return new Response(JSON.stringify({ error: 'Admin only' }), { status: 403, headers: CORS })

    // ══ Case A: 즉시 취소 (환불 or 정산 없음) ══
    if (action === 'cancel_subscription') {
      const { stripe_subscription_id, subscription_id, payment_id, refund_amount, reason, note } = body

      if (!stripe_subscription_id) {
        return new Response(JSON.stringify({ error: 'stripe_subscription_id required' }), { status: 400, headers: CORS })
      }

      // 1. subscriptions에 취소 사유 기록 (status는 webhook이 처리)
      if (subscription_id) {
        await supabase.from('subscriptions').update({
          cancellation_reason: reason || null,
          cancellation_note: note || null,
        }).eq('id', subscription_id)
      }

      // 2. 환불 실행 (있을 때)
      let refundId = null
      if (refund_amount > 0 && payment_id) {
        const { data: payment } = await supabase
          .from('payments')
          .select('stripe_charge_id, stripe_payment_id, amount')
          .eq('id', payment_id)
          .maybeSingle()

        const chargeId = await resolveChargeId(payment || {})
        if (!chargeId) {
          return new Response(JSON.stringify({ error: 'Cannot resolve charge ID for refund' }), { status: 400, headers: CORS })
        }

        const refund = await stripe.refunds.create({
          charge: chargeId,
          amount: Math.round(refund_amount * 100),
          reason: 'requested_by_customer',
          metadata: { payment_id, refund_reason: reason || '' },
        })
        refundId = refund.id
        console.log(`Refund created: ${refundId}, amount: ${refund_amount}`)
      }

      // 3. Stripe 구독 취소 → customer.subscription.deleted webhook 발생 → DB + 이메일 처리
      await stripe.subscriptions.cancel(stripe_subscription_id)
      console.log(`Subscription cancelled: ${stripe_subscription_id}`)

      return new Response(JSON.stringify({ success: true, refund_id: refundId }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    // ══ Case B: 추가청구 → 납부 후 취소 ══
    if (action === 'send_cancellation_invoice') {
      const { stripe_customer_id, subscription_id, charge_amount, plan, reason, note, customer_name } = body

      if (!stripe_customer_id || !charge_amount || !subscription_id) {
        return new Response(JSON.stringify({ error: 'stripe_customer_id, subscription_id, charge_amount required' }), { status: 400, headers: CORS })
      }

      // 1. Stripe Invoice 생성 (sendInvoice 호출 안 함 — Haven Plus 이메일에 링크 포함)
      await stripe.invoiceItems.create({
        customer: stripe_customer_id,
        amount: Math.round(charge_amount * 100),
        currency: 'aud',
        description: `Early termination fee — ${plan || ''} plan`,
      })

      const invoice = await stripe.invoices.create({
        customer: stripe_customer_id,
        collection_method: 'send_invoice',
        days_until_due: 14,
        description: 'Haven Plus early termination fee',
      })

      const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id)
      const invoiceUrl = finalizedInvoice.hosted_invoice_url || ''
      const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
        .toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })

      // 2. subscriptions: pending_cancellation 상태 기록
      await supabase.from('subscriptions').update({
        pending_cancellation: true,
        pending_cancellation_invoice_id: invoice.id,
        cancellation_reason: reason || null,
        cancellation_note: note || null,
      }).eq('id', subscription_id)

      // 3. payments: additional_charge 기록
      const { data: sub } = await supabase.from('subscriptions').select('user_id').eq('id', subscription_id).maybeSingle()
      if (sub?.user_id) {
        await supabase.from('payments').insert({
          user_id: sub.user_id,
          payment_type: 'additional_charge',
          amount: charge_amount,
          currency: 'aud',
          status: 'additional_pending',
          stripe_additional_invoice_id: invoice.id,
          description: `Early termination fee — ${plan || ''} plan`,
          paid_at: new Date().toISOString(),
          additional_charge_amount: charge_amount,
          subscription_id,
        })

        // 4. Haven Plus 이메일 발송 (invoice URL 포함)
        await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
          body: JSON.stringify({
            type: 'subscription_cancellation_pending',
            notify_admins: true,
            recipients: [{ id: sub.user_id, type: 'customer' }],
            reference_type: 'cleaning',
            details: {
              plan,
              customer_name,
              charge_amount,
              invoice_url: invoiceUrl,
              due_date: dueDate,
              requested_on: new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }),
              reason,
            },
          }),
        })
        console.log(`Cancellation invoice sent: ${invoice.id}, amount: ${charge_amount}`)
      }

      return new Response(JSON.stringify({ success: true, invoice_id: invoice.id, invoice_url: invoiceUrl }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    // ══ SH번들 환불 ══
    if (action === 'refund') {
      const { payment_id, refund_amount, refund_reason } = body

      const { data: payment } = await supabase
        .from('payments')
        .select('stripe_charge_id, stripe_payment_id, amount, refund_amount')
        .eq('id', payment_id)
        .maybeSingle()

      const chargeId = await resolveChargeId(payment || {})
      if (!chargeId) {
        return new Response(JSON.stringify({ error: 'Cannot resolve charge ID for this payment' }), { status: 400, headers: CORS })
      }

      const refund = await stripe.refunds.create({
        charge: chargeId,
        amount: Math.round(refund_amount * 100),
        reason: 'requested_by_customer',
        metadata: { payment_id, refund_reason: refund_reason || '' },
      })

      return new Response(JSON.stringify({ success: true, refund_id: refund.id }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: CORS })

  } catch (err) {
    console.error('process-refund error:', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS })
  }
})
