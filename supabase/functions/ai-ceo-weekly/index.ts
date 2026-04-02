// ══════════════════════════════════════════════════════════
// ai-ceo-weekly Edge Function
// ══════════════════════════════════════════════════════════
//
// 실행: 매주 금요일 UTC 23:00 (Perth 금요일 오전 7시)
// pg_cron: SELECT cron.schedule('ai-ceo-weekly', '0 23 * * 4', ...)
//
// 역할:
//   1. 한 주 KPI 스캔 (구독·결제·방문·SH·전환율)
//   2. 이슈 감지 + admin_tasks 생성
//   3. 현재 태스크: property card UX 개선 (미결제 → b모드 preview)
//   4. Sunny/Jaden에게 이메일 브리핑 발송
//   5. admin_approvals 생성 → 대시보드 승인 대기
//
// Env vars:
//   SUPABASE_URL, SB_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY
//   RESEND_API_KEY
// ══════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SB_SERVICE_ROLE_KEY')!
)

const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || ''
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''

const SUNNY_EMAIL = 'hi@havenpluscare.com'
const JADEN_EMAIL = 'jinhyunmail@gmail.com'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── KPI 수집 ──────────────────────────────────────────────

async function collectKPIs() {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const weekAgoStr = weekAgo.toISOString()

  const [subRes, payRes, cleanRes, shRes, bugRes] = await Promise.all([
    // 활성 구독
    supabase.from('subscriptions').select('id, plan_type, status, created_at').in('status', ['active', 'past_due', 'suspended']),
    // 이번 주 결제
    supabase.from('payments').select('id, amount, status, created_at').gte('created_at', weekAgoStr),
    // 이번 주 방문
    supabase.from('cleaning_schedule').select('id, status, planned_date').gte('planned_date', weekAgo.toISOString().split('T')[0]),
    // SH 잔량 낮은 구독
    supabase.from('subscriptions').select('id, user_id, sh_hours_total, sh_hours_used').eq('status', 'active'),
    // 미처리 버그
    supabase.from('bug_reports').select('id, severity, status, created_at').in('status', ['new', 'investigating']),
  ])

  const subs = subRes.data || []
  const payments = payRes.data || []
  const cleans = cleanRes.data || []
  const shSubs = shRes.data || []
  const bugs = bugRes.data || []

  const activeSubs = subs.filter(s => s.status === 'active').length
  const pastDueSubs = subs.filter(s => s.status === 'past_due' || s.status === 'suspended').length
  const newSubsThisWeek = subs.filter(s => new Date(s.created_at) >= weekAgo).length
  const weekRevenue = payments.filter(p => p.status === 'paid').reduce((sum, p) => sum + (p.amount || 0), 0)
  const completedVisits = cleans.filter(c => c.status === 'completed').length
  const scheduledVisits = cleans.filter(c => ['scheduled', 'confirmed'].includes(c.status)).length
  const lowSHSubs = shSubs.filter(s => {
    const rem = (s.sh_hours_total || 0) - (s.sh_hours_used || 0)
    return rem < 1
  }).length
  const openBugs = bugs.length
  const highBugs = bugs.filter(b => b.severity === 'high').length

  return {
    activeSubs,
    pastDueSubs,
    newSubsThisWeek,
    weekRevenue,
    completedVisits,
    scheduledVisits,
    lowSHSubs,
    openBugs,
    highBugs,
  }
}

// ── Claude로 KPI 분석 + 이슈 감지 ────────────────────────

async function analyzeWithClaude(kpis: Record<string, number>, existingTasks: any[]) {
  if (!ANTHROPIC_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — using rule-based analysis')
    return ruleBasedAnalysis(kpis, existingTasks)
  }

  const prompt = `You are the CEO agent for Haven Plus, a property care subscription service in Perth, Australia.

Weekly KPIs:
- Active subscriptions: ${kpis.activeSubs}
- Past due / suspended: ${kpis.pastDueSubs}
- New subscriptions this week: ${kpis.newSubsThisWeek}
- Weekly revenue: $${kpis.weekRevenue.toFixed(2)}
- Completed visits: ${kpis.completedVisits}
- Upcoming visits: ${kpis.scheduledVisits}
- Subscribers with low SH balance (<1h): ${kpis.lowSHSubs}
- Open bug reports: ${kpis.openBugs} (high severity: ${kpis.highBugs})

Existing open tasks (do not duplicate):
${existingTasks.map(t => `- ${t.title} (${t.status})`).join('\n') || 'None'}

Known UX issue (always include if no existing task):
Property cards in dashboard show minimal info before subscription (mode a), but rich info after (mode b). Users who register a property but don't subscribe see only address + "No plan" badge. Proposed fix: show plan preview in mode-a cards to increase conversion.

Analyze the KPIs and identify the top 1-3 issues that need attention this week.
For each issue, provide 2-3 concrete proposals.

Respond ONLY in this exact JSON format, no markdown:
{
  "tasks": [
    {
      "type": "ux_improvement|revenue_alert|sop_issue|scheduling|payment_failure|bug_report|marketing",
      "severity": "urgent|normal|longterm",
      "owner": "sunny|jaden|both",
      "title": "short title",
      "description": "what was detected and why it matters",
      "context_data": {"key": "value"},
      "proposals": [
        {
          "id": 0,
          "title": "proposal title",
          "description": "what to do specifically",
          "effort": "low|mid|high",
          "expected_impact": "expected outcome"
        }
      ]
    }
  ],
  "sunny_summary": "2-3 sentence summary for Sunny covering business/tech issues",
  "jaden_summary": "2-3 sentence summary for Jaden covering field/scheduling issues"
}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const data = await res.json()
  const text = data.content?.[0]?.text || ''

  try {
    return JSON.parse(text)
  } catch {
    console.error('Claude response parse failed:', text)
    return ruleBasedAnalysis(kpis, existingTasks)
  }
}

// ── 규칙 기반 분석 (ANTHROPIC_API_KEY 없을 때 fallback) ──

function ruleBasedAnalysis(kpis: Record<string, number>, existingTasks: any[]) {
  const tasks = []

  // UX 이슈 — property card a모드 개선 (항상 포함, 기존 태스크 없을 때)
  const hasUXTask = existingTasks.some(t => t.type === 'ux_improvement' && t.title.includes('property card'))
  if (!hasUXTask) {
    tasks.push({
      type: 'ux_improvement',
      severity: 'normal',
      owner: 'sunny',
      title: 'Property card: show plan preview before subscription',
      description: 'Users who register a property but haven\'t subscribed see minimal info (address + "No plan" badge only). The post-subscription card shows rich data: schedule timeline, SH balance, cleaning hours grid. Showing a preview of this value before payment could increase conversion.',
      context_data: {
        current_mode_a: 'address + No plan badge + Choose a Plan button only',
        current_mode_b: 'schedule timeline + SH balance + pd-grid + service history',
        affected_file: 'dashboard.html',
        affected_function: 'buildPropertyHubCards()',
        change_lines: '~1148-1215 (summaryMeta, detailInner branches)',
        severity_classification: 'low — UI only, no payment/auth changes',
      },
      proposals: [
        {
          id: 0,
          title: 'Plan preview in collapsed card header',
          description: 'Add a preview line to summaryMeta when hasSub=false: show Smart plan defaults (6 visits/yr · 12h cleaning · 3 SH) with a "Preview" badge',
          effort: 'low',
          expected_impact: 'Users immediately see what they\'d get, increasing motivation to click Choose a Plan',
        },
        {
          id: 1,
          title: 'Full b-mode layout with dimmed overlay when expanded',
          description: 'Show the full pd-grid and schedule timeline dots (all future) with 40% opacity + "Choose a plan to activate" overlay CTA',
          effort: 'mid',
          expected_impact: 'Strong visual demonstration of value — mimics freemium "locked feature" pattern',
        },
      ],
    })
  }

  // 결제 실패 경고
  if (kpis.pastDueSubs > 0) {
    tasks.push({
      type: 'payment_failure',
      severity: kpis.pastDueSubs >= 3 ? 'urgent' : 'normal',
      owner: 'sunny',
      title: `${kpis.pastDueSubs} subscription(s) past due or suspended`,
      description: `${kpis.pastDueSubs} active subscriptions have failed payments. Stripe auto-retry is running but personalised outreach may help recover these.`,
      context_data: { past_due_count: kpis.pastDueSubs },
      proposals: [
        {
          id: 0,
          title: 'Send personalised payment recovery email',
          description: 'ai-conversion-agent sends a warm, personal email to each past-due subscriber with a direct link to update payment method',
          effort: 'low',
          expected_impact: 'Estimated 30-50% recovery rate with personal outreach vs Stripe generic emails',
        },
      ],
    })
  }

  // SH 잔량 낮음
  if (kpis.lowSHSubs > 0) {
    tasks.push({
      type: 'marketing',
      severity: 'longterm',
      owner: 'sunny',
      title: `${kpis.lowSHSubs} subscriber(s) with low SH balance`,
      description: 'These subscribers may need SH bundles soon. Proactive outreach before they run out improves retention and generates upsell revenue.',
      context_data: { low_sh_count: kpis.lowSHSubs },
      proposals: [
        {
          id: 0,
          title: 'Send SH bundle upsell email',
          description: 'Personalised email highlighting their remaining balance and suggesting the 4-pack ($340) as best value',
          effort: 'low',
          expected_impact: 'SH bundle revenue + improved retention',
        },
      ],
    })
  }

  return {
    tasks,
    sunny_summary: `This week: ${kpis.newSubsThisWeek} new subscription(s), $${kpis.weekRevenue.toFixed(0)} revenue, ${kpis.pastDueSubs} payment issue(s). Key action: review ${tasks.filter(t => t.owner === 'sunny' || t.owner === 'both').length} proposed task(s) below.`,
    jaden_summary: `This week: ${kpis.completedVisits} visit(s) completed, ${kpis.scheduledVisits} upcoming. ${kpis.lowSHSubs} subscriber(s) have low SH balance. No urgent field issues detected.`,
  }
}

// ── admin_tasks + admin_approvals 저장 ───────────────────

async function saveTasks(tasks: any[], weekOf: string) {
  const saved = []

  for (const task of tasks) {
    // admin_tasks 생성
    const { data: taskData, error: taskErr } = await supabase
      .from('admin_tasks')
      .insert({
        type: task.type,
        severity: task.severity,
        owner: task.owner,
        status: 'proposed',
        title: task.title,
        description: task.description,
        context_data: task.context_data || {},
        proposals: task.proposals || [],
        week_of: weekOf,
      })
      .select()
      .single()

    if (taskErr) {
      console.error('admin_tasks insert error:', taskErr)
      continue
    }

    // admin_approvals 생성 (승인 대기)
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + (task.severity === 'urgent' ? 1 : 3))

    const { error: approvalErr } = await supabase
      .from('admin_approvals')
      .insert({
        task_id: taskData.id,
        requester: 'ai-ceo-weekly',
        owner_target: task.owner,
        action: `Review and approve proposal for: ${task.title}`,
        payload: { proposals: task.proposals, context: task.context_data },
        status: 'pending',
        expires_at: task.severity === 'high' ? null : expiresAt.toISOString(),
      })

    if (approvalErr) console.error('admin_approvals insert error:', approvalErr)

    saved.push({ task: taskData, proposals: task.proposals })
  }

  return saved
}

// ── 이메일 발송 ───────────────────────────────────────────

async function sendWeeklyBriefing(opts: {
  kpis: Record<string, number>
  sunnySummary: string
  jadenSummary: string
  sunnyTasks: any[]
  jadenTasks: any[]
  weekOf: string
}) {
  if (!RESEND_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email')
    return
  }

  const dashboardUrl = 'https://havenpluscare.com/profile.html#ai-tasks'

  // Sunny 이메일
  if (opts.sunnyTasks.length > 0) {
    const sunnyHTML = buildEmailHTML({
      name: 'Sunny',
      role: 'Managing Director',
      weekOf: opts.weekOf,
      summary: opts.sunnySummary,
      kpis: opts.kpis,
      tasks: opts.sunnyTasks,
      dashboardUrl,
    })

    await sendEmail(SUNNY_EMAIL, `[Haven Plus 주간 보고] ${opts.weekOf} — ${opts.sunnyTasks.length}개 검토 필요`, sunnyHTML)
  }

  // Jaden 이메일
  if (opts.jadenTasks.length > 0) {
    const jadenHTML = buildEmailHTML({
      name: 'Jaden',
      role: 'Field Director',
      weekOf: opts.weekOf,
      summary: opts.jadenSummary,
      kpis: opts.kpis,
      tasks: opts.jadenTasks,
      dashboardUrl,
    })

    await sendEmail(JADEN_EMAIL, `[Haven Plus 주간 보고] ${opts.weekOf} — ${opts.jadenTasks.length}개 검토 필요`, jadenHTML)
  }
}

function buildEmailHTML(opts: {
  name: string
  role: string
  weekOf: string
  summary: string
  kpis: Record<string, number>
  tasks: any[]
  dashboardUrl: string
}) {
  const taskRows = opts.tasks.map(t => `
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;background:${t.severity === 'urgent' ? '#fef2f2' : t.severity === 'longterm' ? '#eff6ff' : '#f0fdf4'};color:${t.severity === 'urgent' ? '#dc2626' : t.severity === 'longterm' ? '#2563eb' : '#16a34a'}">
          ${t.severity.toUpperCase()}
        </span>
        <strong style="font-size:14px;color:#111">${t.title}</strong>
      </div>
      <p style="font-size:13px;color:#555;margin:0 0 12px;">${t.description}</p>
      ${(t.proposals || []).map((p: any, i: number) => `
        <div style="background:#f9fafb;border-radius:8px;padding:10px 12px;margin-bottom:6px;">
          <div style="font-size:12px;font-weight:700;color:#111;margin-bottom:4px;">제안 ${i + 1}: ${p.title}</div>
          <div style="font-size:12px;color:#555;margin-bottom:4px;">${p.description}</div>
          <div style="font-size:11px;color:#888">난이도: ${p.effort} · 예상 효과: ${p.expected_impact}</div>
        </div>
      `).join('')}
    </div>
  `).join('')

  return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#0f2b46 0%,#1a3a5c 100%);padding:24px 28px;">
        <div style="font-size:18px;font-weight:800;color:#fff">HAVEN<span style="color:#ff6b35">PLUS</span></div>
        <div style="font-size:12px;color:rgba(255,255,255,.6);margin-top:2px">AI 주간 보고 — ${opts.weekOf}</div>
      </div>
      <div style="padding:24px 28px;">
        <p style="font-size:14px;color:#333;margin:0 0 16px">안녕하세요, <strong>${opts.name}</strong> (${opts.role}) 님</p>
        <p style="font-size:14px;color:#555;margin:0 0 20px;line-height:1.6">${opts.summary}</p>

        <div style="background:#f9fafb;border-radius:10px;padding:14px 16px;margin-bottom:20px;display:flex;gap:24px;flex-wrap:wrap;">
          <div><div style="font-size:11px;color:#888">활성 구독</div><div style="font-size:20px;font-weight:800;color:#0f2b46">${opts.kpis.activeSubs}</div></div>
          <div><div style="font-size:11px;color:#888">이번 주 신규</div><div style="font-size:20px;font-weight:800;color:#0f2b46">${opts.kpis.newSubsThisWeek}</div></div>
          <div><div style="font-size:11px;color:#888">결제 이슈</div><div style="font-size:20px;font-weight:800;color:${opts.kpis.pastDueSubs > 0 ? '#dc2626' : '#0f2b46'}">${opts.kpis.pastDueSubs}</div></div>
          <div><div style="font-size:11px;color:#888">완료 방문</div><div style="font-size:20px;font-weight:800;color:#0f2b46">${opts.kpis.completedVisits}</div></div>
        </div>

        <div style="font-size:13px;font-weight:700;color:#0f2b46;margin-bottom:12px">검토 필요한 태스크 (${opts.tasks.length}개)</div>
        ${taskRows}

        <div style="text-align:center;margin-top:20px">
          <a href="${opts.dashboardUrl}" style="display:inline-block;background:#ff6b35;color:white;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none">
            대시보드에서 승인하기 →
          </a>
        </div>
        <p style="font-size:12px;color:#999;text-align:center;margin-top:16px">이메일로 답장 시 "승인 [제안번호]" 또는 "거절"을 입력하세요.</p>
      </div>
    </div>
  `
}

async function sendEmail(to: string, subject: string, html: string) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from: 'Haven Plus AI <noreply@havenpluscare.com>',
        to: [to],
        subject,
        html,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error('Resend error:', err)
    }
  } catch (e) {
    console.error('Email send failed:', e)
  }
}

// ══════════════════════════════════════════════════════════
// Main handler
// ══════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const tz = 'Australia/Perth'
    const now = new Date()
    const weekOf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

    console.log(`ai-ceo-weekly: starting weekly analysis for ${weekOf}`)

    // 1. KPI 수집
    const kpis = await collectKPIs()
    console.log('KPIs collected:', JSON.stringify(kpis))

    // 2. 이번 주 기존 태스크 확인 (중복 방지)
    const { data: existingTasks } = await supabase
      .from('admin_tasks')
      .select('title, type, status')
      .eq('week_of', weekOf)
      .neq('status', 'done')

    // 3. Claude 분석
    const analysis = await analyzeWithClaude(kpis, existingTasks || [])
    const { tasks, sunny_summary, jaden_summary } = analysis

    if (!tasks || tasks.length === 0) {
      console.log('No issues detected this week')
      return new Response(JSON.stringify({ success: true, message: 'No issues detected', weekOf }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // 4. DB 저장
    const saved = await saveTasks(tasks, weekOf)
    console.log(`Saved ${saved.length} tasks`)

    // 5. 이메일 브리핑
    const sunnyTasks = tasks.filter((t: any) => t.owner === 'sunny' || t.owner === 'both')
    const jadenTasks = tasks.filter((t: any) => t.owner === 'jaden' || t.owner === 'both')

    await sendWeeklyBriefing({
      kpis,
      sunnySummary: sunny_summary,
      jadenSummary: jaden_summary,
      sunnyTasks,
      jadenTasks,
      weekOf,
    })

    console.log(`ai-ceo-weekly complete: ${tasks.length} tasks, emails sent`)

    return new Response(JSON.stringify({
      success: true,
      weekOf,
      tasksCreated: saved.length,
      sunnyTasks: sunnyTasks.length,
      jadenTasks: jadenTasks.length,
      kpis,
    }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('ai-ceo-weekly error:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
