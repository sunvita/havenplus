import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SB_SERVICE_ROLE_KEY')!

serve(async (req) => {
  try {
    const url = new URL(req.url)
    // URL: /generate-ics?worker_id=uuid
    const workerId = url.searchParams.get('worker_id')
    if (!workerId) {
      return new Response('Missing worker_id', { status: 400 })
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE)

    // 워커 존재 확인
    const { data: worker } = await sb
      .from('workers')
      .select('id, full_name')
      .eq('id', workerId)
      .maybeSingle()

    if (!worker) return new Response('Worker not found', { status: 404 })

    // 배정된 cleaning_schedule 조회 (90일치)
    const from = new Date()
    from.setDate(from.getDate() - 7) // 7일 전부터
    const to = new Date()
    to.setDate(to.getDate() + 90)    // 90일 후까지

    const [cleaningRes, srRes] = await Promise.all([
      sb.from('cleaning_schedule')
        .select('id, planned_date, planned_time, duration_hours, status, properties(address, suburb)')
        .contains('assigned_workers', [workerId])
        .gte('planned_date', from.toISOString().split('T')[0])
        .lte('planned_date', to.toISOString().split('T')[0])
        .in('status', ['scheduled', 'confirmed', 'in_progress', 'completed']),
      sb.from('service_requests')
        .select('id, scheduled_date, scheduled_time, sh_hours_used, category, status, properties(address, suburb)')
        .contains('assigned_workers', [workerId])
        .gte('scheduled_date', from.toISOString().split('T')[0])
        .lte('scheduled_date', to.toISOString().split('T')[0])
        .in('status', ['scheduled', 'confirmed', 'in_progress', 'completed'])
    ])

    const events: string[] = []

    // cleaning events
    for (const c of cleaningRes.data || []) {
      const addr = c.properties ? `${c.properties.address}, ${c.properties.suburb}` : 'Haven Plus Job'
      const dtStart = formatDT(c.planned_date, c.planned_time || '08:00')
      const dtEnd = formatDT(c.planned_date, c.planned_time || '08:00', c.duration_hours || 2)
      events.push(buildEvent(`CLEANING-${c.id}`, dtStart, dtEnd, `🧹 Cleaning — ${addr}`, addr, c.status))
    }

    // service request events
    for (const s of srRes.data || []) {
      const addr = s.properties ? `${s.properties.address}, ${s.properties.suburb}` : 'Haven Plus Job'
      const dtStart = formatDT(s.scheduled_date, s.scheduled_time || '09:00')
      const dtEnd = formatDT(s.scheduled_date, s.scheduled_time || '09:00', s.sh_hours_used || 1)
      const summary = `🔧 ${s.category || 'Service'} — ${addr}`
      events.push(buildEvent(`SR-${s.id}`, dtStart, dtEnd, summary, addr, s.status))
    }

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Haven Plus//Worker Schedule//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:Haven Plus — ${worker.full_name}`,
      'X-WR-TIMEZONE:Australia/Perth',
      'X-WR-CALDESC:Haven Plus work schedule',
      ...events,
      'END:VCALENDAR'
    ].join('\r\n')

    return new Response(ics, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="havenplus-${workerId}.ics"`,
        'Cache-Control': 'no-cache',
      }
    })

  } catch (e) {
    console.error('generate-ics error:', e)
    return new Response('Internal error', { status: 500 })
  }
})

function formatDT(date: string, time: string, addHours = 0): string {
  // Perth time (AWST = UTC+8) — ics에 TZID 없이 로컬타임으로
  const [y, mo, d] = date.split('-')
  const [h, m] = time.split(':').map(Number)
  const totalMin = h * 60 + m + addHours * 60
  const endH = Math.floor(totalMin / 60)
  const endM = totalMin % 60
  const hh = addHours > 0 ? endH : h
  const mm = addHours > 0 ? endM : m
  return `${y}${mo}${d}T${String(hh).padStart(2,'0')}${String(mm).padStart(2,'0')}00`
}

function buildEvent(uid: string, dtStart: string, dtEnd: string, summary: string, location: string, status: string): string {
  const now = new Date().toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z'
  const statusNote = status === 'completed' ? ' ✓' : status === 'in_progress' ? ' (In progress)' : ''
  return [
    'BEGIN:VEVENT',
    `UID:${uid}@havenpluscare.com`,
    `DTSTAMP:${now}`,
    `DTSTART;TZID=Australia/Perth:${dtStart}`,
    `DTEND;TZID=Australia/Perth:${dtEnd}`,
    `SUMMARY:${summary}${statusNote}`,
    `LOCATION:${location}`,
    'END:VEVENT'
  ].join('\r\n')
}
