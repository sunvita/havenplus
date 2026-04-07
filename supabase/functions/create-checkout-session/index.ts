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

const PRICE_MAP: Record<string, Record<string, string>> = {
  essential: {
    monthly: 'price_1TAQ8eETHoBrxXOuBJykRrxO',
    annual:  'price_1TByOdETHoBrxXOuP5mhiRTy',
  },
  smart: {
    monthly: 'price_1TAQ9ZETHoBrxXOuK0JnkQeb',
    annual:  'price_1TByPYETHoBrxXOuSOpUL7pN',
  },
  premium: {
    monthly: 'price_1TAQAjETHoBrxXOuyhs48ER7',
    annual:  'price_1TByPwETHoBrxXOuwNJ9BDuH',
  },
  sh_1: { one_time: 'price_1TAQDNETHoBrxXOu9gW5qdjC' },
  sh_4: { one_time: 'price_1TAQDtETHoBrxXOuCpFDkNCL' },
  sh_8: { one_time: 'price_1TAQEMETHoBrxXOuJ1lTGqCb' },
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  try {
    const { planKey, billingCycle, propertyId, userId, userEmail, successParam, isUpgrade } = await req.json()

    const isSub = ['essential', 'smart', 'premium'].includes(planKey)
    const cycle = isSub ? (billingCycle || 'monthly') : 'one_time'
    const priceId = PRICE_MAP[planKey]?.[cycle]

    if (!priceId) {
      return new Response(JSON.stringify({ error: 'Invalid plan key or billing cycle' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // ── UPGRADE PATH: update existing Stripe subscription ──
    if (isUpgrade && isSub) {
      const { data: currentSub, error: subErr } = await supabase
        .from('subscriptions')
        .select('stripe_subscription_id, plan, plan_type, start_date, cleaning_hours_total, cleaning_hours_used, sh_hours_total, sh_hours_used')
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle()

      if (subErr || !currentSub?.stripe_subscription_id) {
        return new Response(JSON.stringify({ error: 'No active subscription found' }), {
          status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
        })
      }

      const stripeSub = await stripe.subscriptions.retrieve(currentSub.stripe_subscription_id)
      const subItemId = stripeSub.items.data[0]?.id

      if (!subItemId) {
        return new Response(JSON.stringify({ error: 'Subscription item not found' }), {
          status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
        })
      }

      await stripe.subscriptions.update(currentSub.stripe_subscription_id, {
        items: [{ id: subItemId, price: priceId }],
        proration_behavior: 'create_prorations',
        metadata: {
          user_id: userId,
          new_plan: planKey,
          billing_cycle: cycle,
          ...(propertyId ? { property_id: propertyId } : {}),
          is_upgrade: 'true',
          upgraded_at: new Date().toISOString(),
        },
      })

      return new Response(JSON.stringify({
        url: `https://havenpluscare.com/dashboard.html?payment=upgrade_success`,
      }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // ── NEW SUBSCRIPTION / SH PURCHASE: Stripe Checkout ──
    const session = await stripe.checkout.sessions.create({
      mode: isSub ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      customer_email: userEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        user_id: userId,
        price_id: priceId,
        billing_cycle: cycle,
        ...(propertyId ? { property_id: propertyId } : {}),
      },
      success_url: `https://havenpluscare.com/plans.html?${successParam}=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://havenpluscare.com/plans.html?cancelled=true`,
    })

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (err) {
    console.error('Checkout session error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
