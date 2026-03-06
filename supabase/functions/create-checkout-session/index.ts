import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import Stripe from 'https://esm.sh/stripe@13'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
})

const PRICE_MAP: Record<string, string> = {
  essential: 'price_1T7ppGRVro18Xo3KNaJj6ULN',
  smart:     'price_1T7pqHRVro18Xo3K2ZdYQDoo',
  premium:   'price_1T7psTRVro18Xo3KRUNcEcRZ',
  sh_1:      'price_1T7ptdRVro18Xo3Kvz3Hh0jb',
  sh_4:      'price_1T7pulRVro18Xo3KaZUWJBre',
  sh_8:      'price_1T7pvURVro18Xo3KNLzwtH2Z',
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
    const { planKey, userId, userEmail, successParam } = await req.json()

    const priceId = PRICE_MAP[planKey]
    if (!priceId) {
      return new Response(JSON.stringify({ error: 'Invalid plan key' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    const isSub = ['essential', 'smart', 'premium'].includes(planKey)

    const session = await stripe.checkout.sessions.create({
      mode: isSub ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      customer_email: userEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        user_id: userId,
        price_id: priceId,
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
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
})
