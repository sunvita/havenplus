/**
 * ──────────────────────────────────────────────────────────
 * create-portal-session  –  Stripe Customer Billing Portal
 * ──────────────────────────────────────────────────────────
 *
 * Purpose : Creates a Stripe Customer Portal session so
 *           customers can manage subscriptions, payment
 *           methods, and invoices self-service.
 *
 * Called from:
 *   - profile.html → openPortal()  (user clicks "Manage Billing")
 *
 * Flow:
 *   1. Receives { user_id } from frontend
 *   2. Looks up stripe_customer_id from subscriptions table
 *   3. Creates a Stripe billing portal session (hosted by Stripe)
 *   4. Returns { url } for frontend to redirect
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY   – Stripe secret key
 *   SUPABASE_URL        – Supabase project URL
 *   SB_SERVICE_ROLE_KEY – Supabase service role key
 *
 * Stripe Dashboard prerequisite:
 *   Settings → Billing → Customer Portal must be enabled
 *   Portal config ID: bpc_1TCtICETHoBrxXOuHu4AroPP
 *
 * DB dependency:
 *   subscriptions.stripe_customer_id  (set by stripe-webhook on checkout.session.completed)
 *
 * ── Current Status (2026-03) ─────────────────────────────
 *   - Phase 1: Hosted Portal (현재)
 *     Stripe 호스팅 페이지로 리다이렉트하는 방식
 *     고객이 구독 관리, 결제 수단 변경, 인보이스 확인 가능
 *
 * ── Future Expansion Plan ────────────────────────────────
 *   - Phase 2: Embedded Portal (사이트 내 임베드)
 *     Stripe.js + @stripe/react-stripe-js 를 사용하여
 *     profile.html Payment 섹션에 직접 포털 UI 임베드
 *     → iframe 방식이 아닌 Stripe Elements 기반
 *     → 사이트를 떠나지 않고 결제 관리 가능
 *
 *   - Phase 3: Custom Billing UI (자체 결제 관리)
 *     Stripe API를 직접 호출하여 자체 UI 구축:
 *     1) stripe.subscriptions.retrieve()  → 구독 상태/플랜 표시
 *     2) stripe.invoices.list()           → 인보이스/결제 내역
 *     3) stripe.paymentMethods.list()     → 등록된 결제 수단
 *     4) stripe.subscriptions.update()    → 플랜 변경/취소
 *     5) stripe.setupIntents.create()     → 새 결제 수단 등록
 *     주의: PCI 컴플라이언스 요건 충족 필요
 *
 *   - 전환 시 변경 포인트:
 *     → profile.html: openPortal() → 자체 UI 렌더링으로 교체
 *     → 이 Edge Function: portal session → 개별 API 엔드포인트로 분리
 *       (get-subscription, list-invoices, update-payment-method 등)
 * ──────────────────────────────────────────────────────────
 */

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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  try {
    const { user_id } = await req.json()

    if (!user_id) {
      return new Response(JSON.stringify({ error: 'user_id is required' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    /* ── Step 1: DB에서 stripe_customer_id 조회 ────────── */
    const { data: sub, error: subErr } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user_id)
      .maybeSingle()

    if (subErr) {
      console.error('DB error:', subErr)
      return new Response(JSON.stringify({ error: 'Database error' }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    if (!sub?.stripe_customer_id) {
      return new Response(JSON.stringify({
        error: 'No active subscription found. Please subscribe to a plan first.',
      }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    /* ── Step 2: Stripe Billing Portal 세션 생성 ────────── */
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: 'https://havenpluscare.com/profile.html?section=payment',
    })

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (err) {
    console.error('Portal session error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
