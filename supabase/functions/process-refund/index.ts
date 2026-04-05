import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@13'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' })
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SB_SERVICE_ROLE_KEY')!)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body_json = await req.json()
    const { action, payment_id, refund_amount, refund_reason, additional_amount, customer_email, customer_stripe_id, description,
            stripe_subscription_id, subscription_id, reason, note } = body_json

    // ── 어드민 권한 체크 ──
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
    if (profile?.role !== 'admin') return new Response(JSON.stringify({ error: 'Admin only' }), { status: 403, headers: CORS })

    // ── 환불 처리 ──
    if (action === 'refund') {
      const { data: payment } = await supabase
        .from('payments')
        .select('stripe_charge_id, amount, refund_amount')
        .eq('id', payment_id)
        .maybeSingle()

      if (!payment?.stripe_charge_id) {
        return new Response(JSON.stringify({ error: 'No charge ID found for this payment' }), { status: 400, headers: CORS })
      }

      // Stripe 환불 실행
      const refund = await stripe.refunds.create({
        charge: payment.stripe_charge_id,
        amount: Math.round(refund_amount * 100), // cents
        reason: 'requested_by_customer',
        metadata: { payment_id, refund_reason },
      })

      return new Response(JSON.stringify({ success: true, refund_id: refund.id, status: refund.status }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── 추가 납부 Invoice 생성 ──
    if (action === 'additional_charge') {
      // Stripe Invoice 생성
      const invoiceItem = await stripe.invoiceItems.create({
        customer: customer_stripe_id,
        amount: Math.round(additional_amount * 100),
        currency: 'aud',
        description: description || 'Early termination fee',
      })

      const invoice = await stripe.invoices.create({
        customer: customer_stripe_id,
        collection_method: 'send_invoice',
        days_until_due: 14,
        description: description || 'Haven Plus additional charge',
      })

      await stripe.invoices.finalizeInvoice(invoice.id)
      await stripe.invoices.sendInvoice(invoice.id)

      // payments 테이블에 추가 납부 기록
      await supabase.from('payments').insert({
        user_id: (await supabase.from('subscriptions').select('user_id').eq('stripe_customer_id', customer_stripe_id).maybeSingle()).data?.user_id,
        payment_type: 'additional_charge',
        amount: additional_amount,
        currency: 'aud',
        status: 'additional_pending',
        stripe_additional_invoice_id: invoice.id,
        description: description || 'Early termination fee',
        paid_at: new Date().toISOString(),
        additional_charge_amount: additional_amount,
      })

      return new Response(JSON.stringify({ success: true, invoice_id: invoice.id, invoice_url: invoice.hosted_invoice_url }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── 구독 취소 ──
    if (action === 'cancel_subscription') {
      if (!stripe_subscription_id) {
        return new Response(JSON.stringify({ error: 'stripe_subscription_id required' }), { status: 400, headers: CORS })
      }

      // Stripe 구독 즉시 취소
      await stripe.subscriptions.cancel(stripe_subscription_id)

      // Supabase subscriptions 상태 업데이트
      if (subscription_id) {
        await supabase.from('subscriptions').update({
          status: 'cancelled',
          end_date: new Date().toISOString(),
        }).eq('id', subscription_id)
      }

      console.log(`Subscription cancelled: ${stripe_subscription_id}, reason: ${reason}, note: ${note}`)
      return new Response(JSON.stringify({ success: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: CORS })

  } catch (err) {
    console.error('process-refund error:', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS })
  }
})
