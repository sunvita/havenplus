// ══════════════════════════════════════════════════════════
// daily-reminder Edge Function
// ══════════════════════════════════════════════════════════
//
// Runs daily via pg_cron (cron job: 'daily-cleaning-reminder', '0 4 * * *' UTC = Perth noon).
// Queries cleaning_schedule for tomorrow's cleanings (status: scheduled/confirmed),
// then calls send-notification to deliver reminder emails + in-app bell notifications
// to both customers and assigned workers.
//
// Env vars:
//   SUPABASE_URL          — auto-provided by Supabase
//   SB_SERVICE_ROLE_KEY   — Supabase service role key (Secrets)
//   BUSINESS_TIMEZONE     — IANA timezone string (default: Australia/Perth)
//
// Current limitation (single timezone):
//   Currently uses one global BUSINESS_TIMEZONE for all customers.
//   "Tomorrow" is calculated based on this single timezone.
//
// TODO: Multi-timezone support (when expanding to multiple cities)
//   When operating in Perth + Sydney simultaneously:
//   1. Add 'timezone' column to properties table (e.g. 'Australia/Perth', 'Australia/Sydney')
//   2. Remove BUSINESS_TIMEZONE env var dependency
//   3. Query all cleanings for tomorrow across ALL relevant timezones:
//      - For each unique timezone in properties, calculate that timezone's "tomorrow"
//      - Query cleaning_schedule joined with properties.timezone
//      - Group by timezone and send reminders accordingly
//   4. Update pg_cron to run at earliest noon across all timezones
//      (e.g. Sydney noon = UTC 01:00, Perth noon = UTC 04:00 → run at '0 1 * * *')
//   5. In the function, skip cleanings whose property timezone hasn't reached noon yet
//      (or run cron multiple times: '0 1 * * *' and '0 4 * * *')
//
// Related:
//   - send-notification Edge Function (handles actual email + DB insert)
//   - notifications table (user_id FK removed to support worker recipients)
//   - pg_cron job registered via: SELECT cron.schedule('daily-cleaning-reminder', ...)
//
// ══════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Supabase (service role — bypasses RLS) ──
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SB_SERVICE_ROLE_KEY')!
)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Internal call to send-notification Edge Function ──
async function callSendNotification(payload: {
  type: string
  recipients: Array<{ id: string; type: string }>
  reference_id: string
  reference_type: string
  details: { address?: string; date?: string; time?: string }
}): Promise<{ success: boolean; results?: unknown }> {
  try {
    const res = await fetch(
      `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-notification`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SB_SERVICE_ROLE_KEY')}`,
        },
        body: JSON.stringify(payload),
      }
    )
    return await res.json()
  } catch (e) {
    console.error('callSendNotification error:', e)
    return { success: false }
  }
}

// ══════════════════════════════════════════════════════════
// ── Main handler ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════
//
// This function runs daily (via pg_cron or external cron).
// It finds all cleaning_schedule entries for TOMORROW with
// status 'scheduled' or 'confirmed', then sends reminder
// notifications to customers and assigned workers.
//
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  try {
    // Calculate tomorrow's date in business timezone (from env, default: Australia/Perth)
    const tz = Deno.env.get('BUSINESS_TIMEZONE') || 'Australia/Perth'
    const now = new Date()
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
    // localDate = "YYYY-MM-DD" (en-CA format)
    const [y, m, d] = localDate.split('-').map(Number)
    const tomorrow = new Date(y, m - 1, d + 1)
    const tomorrowStr = tomorrow.toISOString().split('T')[0] // "YYYY-MM-DD"

    console.log(`daily-reminder: checking for cleanings on ${tomorrowStr}`)

    // Query cleaning_schedule for tomorrow, status = scheduled or confirmed
    const { data: cleanings, error } = await supabase
      .from('cleaning_schedule')
      .select('id, planned_date, planned_time, status, user_id, assigned_workers, assigned_worker_id, property_id, properties(address, suburb)')
      .eq('planned_date', tomorrowStr)
      .in('status', ['scheduled', 'confirmed'])

    if (error) {
      console.error('Query error:', error)
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    if (!cleanings?.length) {
      console.log('daily-reminder: no cleanings found for tomorrow')
      return new Response(JSON.stringify({ success: true, message: 'No cleanings tomorrow', count: 0 }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    console.log(`daily-reminder: found ${cleanings.length} cleaning(s) for tomorrow`)

    const results = []

    for (const c of cleanings) {
      const prop = (c as any).properties || {}
      const addr = [prop.address, prop.suburb].filter(Boolean).join(', ') || 'Property'

      // Build recipients: customer + assigned workers
      const recipients: Array<{ id: string; type: string }> = []

      if (c.user_id) {
        recipients.push({ id: c.user_id, type: 'customer' })
      }

      // Gather worker IDs from assigned_workers array or fallback to assigned_worker_id
      const workerIds: string[] = []
      if (Array.isArray(c.assigned_workers) && c.assigned_workers.length > 0) {
        workerIds.push(...c.assigned_workers)
      } else if (c.assigned_worker_id) {
        workerIds.push(c.assigned_worker_id)
      }

      for (const wid of workerIds) {
        recipients.push({ id: wid, type: 'worker' })
      }

      if (recipients.length === 0) {
        console.warn(`Skipping cleaning ${c.id}: no recipients`)
        continue
      }

      // Call send-notification
      const res = await callSendNotification({
        type: 'reminder',
        recipients,
        reference_id: c.id,
        reference_type: 'cleaning',
        details: {
          address: addr,
          date: c.planned_date,
          time: c.planned_time || '',
        },
      })

      results.push({ cleaning_id: c.id, address: addr, recipients: recipients.length, result: res })
    }

    console.log(`daily-reminder: sent ${results.length} reminder(s)`, JSON.stringify(results))

    return new Response(JSON.stringify({ success: true, count: results.length, results }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('daily-reminder error:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
