// ══════════════════════════════════════════════════════════
// ai-dev-agent Edge Function
// ══════════════════════════════════════════════════════════
//
// 트리거:
//   - admin_approvals 상태가 'approved'로 변경될 때 (Supabase DB webhook)
//   - 수동 POST 호출 (테스트용)
//
// 역할:
//   1. 승인된 admin_approvals 조회
//   2. 태스크 타입별 실행 함수 라우팅
//   3. GitHub API로 코드 수정 + 커밋
//   4. admin_tasks 상태 업데이트
//   5. Sunny에게 결과 알림
//
// 현재 구현된 태스크 타입:
//   - ux_improvement / property_card_preview: dashboard.html property card a모드 개선
//
// Env vars:
//   SUPABASE_URL, SB_SERVICE_ROLE_KEY
//   GITHUB_TOKEN (github_pat_...)
//   RESEND_API_KEY
// ══════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SB_SERVICE_ROLE_KEY')!
)

const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN') || ''
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || ''
const REPO = 'sunvita/havenplus'
const SUNNY_EMAIL = 'hi@havenpluscare.com'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── GitHub API 헬퍼 ───────────────────────────────────────

async function getFileContent(path: string): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  })
  if (!res.ok) {
    console.error(`GitHub get file failed: ${path}`, await res.text())
    return null
  }
  const data = await res.json()
  const content = atob(data.content.replace(/\n/g, ''))
  return { content, sha: data.sha }
}

async function commitFile(path: string, content: string, sha: string, message: string): Promise<boolean> {
  const encoded = btoa(unescape(encodeURIComponent(content)))
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content: encoded,
      sha,
      committer: { name: 'Haven Plus AI', email: 'ai@havenpluscare.com' },
    }),
  })
  if (!res.ok) {
    console.error('GitHub commit failed:', await res.text())
    return false
  }
  return true
}

// ── 태스크 실행: property card a모드 UX 개선 ─────────────

async function executePropertyCardPreview(proposalId: number): Promise<{ success: boolean; message: string }> {
  console.log(`Executing property card preview fix, proposal: ${proposalId}`)

  const file = await getFileContent('dashboard.html')
  if (!file) return { success: false, message: 'Failed to fetch dashboard.html from GitHub' }

  let html = file.content

  // ── 변경 1: summaryMeta — a모드 카드 헤더에 플랜 preview 추가 ──
  const oldSummaryMeta = `      : \`<span class="prop-hub-plan-pill pill-none">No plan</span>
         \${bedBath}\`;`

  const newSummaryMeta = `      : \`<span class="prop-hub-plan-pill pill-none"><span class="lang-en">No plan yet</span><span class="lang-ko" style="display:\${currentLang==='ko'?'':'none'}">플랜 없음</span></span>
         \${bedBath}
         <span style="color:#2563eb;font-size:12px;font-weight:600">
           <span class="lang-en">Smart plan: 6 visits · 12h cleaning · 3h SH included</span>
           <span class="lang-ko" style="display:\${currentLang==='ko'?'':'none'}">Smart 기준: 방문 6회 · 청소 12h · SH 3h 포함</span>
         </span>\`;`

  if (html.includes(oldSummaryMeta)) {
    html = html.replace(oldSummaryMeta, newSummaryMeta)
    console.log('summaryMeta patch applied')
  } else {
    console.warn('summaryMeta pattern not found — may have already been patched')
  }

  // ── 변경 2: detailInner — a모드 펼쳤을 때 preview 레이아웃 ──
  const oldDetailNoplan = `      <div class="prop-hub-noplan">
        <div class="prop-hub-noplan-text">No subscription plan for this property yet.</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <a href="plans.html" class="btn-action btn-primary" onclick="event.stopPropagation();sessionStorage.setItem('hp_selected_property','\${p.id}')">Choose a Plan</a>
          <button class="btn-action btn-secondary" onclick="event.stopPropagation();openEditPropertyModal('\${p.id}')">Update Details</button>
          \${isAdmin ? \`<button class="btn-delete-prop" onclick="event.stopPropagation();deleteProperty('\${p.id}','\${p.address.replace(/'/g,\"\\\\\\'\")}')">Delete</button>\` : ''}
        </div>
      </div>`

  const newDetailNoplan = `      <div class="prop-hub-divider"></div>

      <!-- Plan preview (before subscription) -->
      <div style="position:relative;margin-bottom:16px">
        <div class="pd-grid" style="opacity:.35;pointer-events:none;user-select:none">
          <div><div class="pd-item-label">Plan</div><div class="pd-item-val">Smart</div></div>
          <div><div class="pd-item-label">Visits / yr</div><div class="pd-item-val">6</div></div>
          <div><div class="pd-item-label">Cleaning hrs</div><div class="pd-item-val">0 used / 12</div></div>
          <div><div class="pd-item-label">SH vouchers</div><div class="pd-item-val">0 used / 3</div></div>
          <div><div class="pd-item-label">Repair checkup</div><div class="pd-item-val">Every visit</div></div>
          <div><div class="pd-item-label">Smoke alarm</div><div class="pd-item-val">Annually</div></div>
        </div>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px">
          <div style="font-size:12px;color:var(--text-light);font-weight:600">Smart 플랜 기준 미리보기</div>
          <a href="plans.html" class="btn-action btn-primary"
             style="font-size:13px;padding:10px 24px"
             onclick="event.stopPropagation();sessionStorage.setItem('hp_selected_property','\${p.id}')">
            🏠 이 부동산에 플랜 시작하기
          </a>
        </div>
      </div>

      <!-- Schedule preview dots -->
      <div style="margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:var(--navy);margin-bottom:8px">📅 Cleaning Schedule</div>
        <div class="sched-timeline" style="opacity:.35">
          \${[...Array(6)].map((_,i) => \`
            <div class="sched-dot future"><div class="sched-dot-circle future"></div><div class="sched-dot-label">—</div></div>
            \${i < 5 ? '<div class="sched-line"></div>' : ''}
          \`).join('')}
        </div>
        <div style="font-size:12px;color:var(--text-light);margin-top:8px">플랜 선택 후 방문 스케줄이 여기 표시됩니다</div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-action btn-secondary" onclick="event.stopPropagation();openEditPropertyModal('\${p.id}')">Update Details</button>
        \${isAdmin ? \`<button class="btn-delete-prop" onclick="event.stopPropagation();deleteProperty('\${p.id}','\${p.address.replace(/'/g,\"\\\\\\'\")}')">Delete</button>\` : ''}
      </div>`

  // 이미 패치됐는지 확인
  const alreadyPatched = html.includes('이 부동산에 플랜 시작하기') || html.includes('Smart 플랜 기준 미리보기')

  if (alreadyPatched) {
    console.log('detailInner already patched — skipping')
  } else if (html.includes(oldDetailNoplan)) {
    html = html.replace(oldDetailNoplan, newDetailNoplan)
    console.log('detailInner patch applied')
  } else {
    // 간략 패턴으로 재시도 (줄바꿈/공백 차이 대응)
    const simpleMarker = 'No subscription plan for this property yet.'
    if (html.includes(simpleMarker)) {
      // prop-hub-noplan 블록 전체를 정규식으로 교체
      html = html.replace(
        /\s*<div class="prop-hub-noplan">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*`\s*;/,
        `
      ${newDetailNoplan}
    \`;`
      )
      console.log('detailInner patch applied via regex fallback')
    } else {
      console.warn('detailInner: no-plan section not found at all')
    }
  }

  // GitHub에 커밋
  const commitMessage = `fix(ai-dev): property card a-mode — show plan preview before subscription

- summaryMeta: add Smart plan preview line when no subscription
- detailInner: replace minimal no-plan block with dimmed pd-grid preview
- Schedule preview: show 6 empty dots with activation CTA
- CTA: full-width "이 부동산에 플랜 시작하기" button

Severity: Low (UI only, no payment/auth changes)
Auto-deployed by ai-dev-agent
Approved by: Sunny (MD)`

  const committed = await commitFile('dashboard.html', html, file.sha, commitMessage)
  if (!committed) return { success: false, message: 'GitHub commit failed' }

  return { success: true, message: 'Property card preview patch committed and deployed via GitHub Pages' }
}

// ── 결과 이메일 ───────────────────────────────────────────

async function sendResultEmail(to: string, taskTitle: string, success: boolean, message: string) {
  if (!RESEND_KEY) return
  const html = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#0f2b46,#1a3a5c);padding:20px 24px;">
        <div style="font-size:16px;font-weight:800;color:#fff">HAVEN<span style="color:#ff6b35">PLUS</span> — 개발 에이전트</div>
      </div>
      <div style="padding:20px 24px;">
        <div style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;background:${success ? '#f0fdf4' : '#fef2f2'};color:${success ? '#16a34a' : '#dc2626'};margin-bottom:12px">
          ${success ? '✅ 배포 완료' : '❌ 배포 실패'}
        </div>
        <div style="font-size:14px;font-weight:700;color:#111;margin-bottom:8px">${taskTitle}</div>
        <div style="font-size:13px;color:#555;line-height:1.6">${message}</div>
        ${success ? `
          <div style="margin-top:16px;padding:12px;background:#f9fafb;border-radius:8px;font-size:12px;color:#666">
            GitHub Pages 자동 배포 완료 — 변경사항은 1~2분 후 사이트에 반영됩니다.<br>
            커밋: <a href="https://github.com/${REPO}/commits/main" style="color:#ff6b35">github.com/${REPO}/commits/main</a>
          </div>
        ` : `
          <div style="margin-top:16px;padding:12px;background:#fef9f0;border-radius:8px;font-size:12px;color:#92400e">
            수동 확인이 필요합니다. dashboard.html의 buildPropertyHubCards() 함수를 직접 검토해주세요.
          </div>
        `}
      </div>
    </div>
  `
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({
      from: 'Haven Plus AI <noreply@havenpluscare.com>',
      to: [to],
      subject: `[ai-dev-agent] ${success ? '배포 완료' : '배포 실패'}: ${taskTitle}`,
      html,
    }),
  })
}

// ══════════════════════════════════════════════════════════
// Main handler
// ══════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = await req.json().catch(() => ({}))

    // DB webhook에서 직접 approval_id를 받거나, 수동으로 task_id 전달
    const { approval_id, task_id } = body

    let approvals: any[] = []

    if (approval_id) {
      // DB webhook: 특정 approval 처리
      const { data } = await supabase
        .from('admin_approvals')
        .select('*, admin_tasks(*)')
        .eq('id', approval_id)
        .eq('status', 'approved')
      approvals = data || []
    } else if (task_id) {
      // 수동: 특정 task의 승인된 approval
      const { data } = await supabase
        .from('admin_approvals')
        .select('*, admin_tasks(*)')
        .eq('task_id', task_id)
        .eq('status', 'approved')
      approvals = data || []
    } else {
      // 전체: 미처리 승인된 approvals
      const { data } = await supabase
        .from('admin_approvals')
        .select('*, admin_tasks(*)')
        .eq('status', 'approved')
      // executing 중인 태스크는 제외
      approvals = (data || []).filter((a: any) => a.admin_tasks?.status !== 'executing' && a.admin_tasks?.status !== 'done')
    }

    if (approvals.length === 0) {
      return new Response(JSON.stringify({ success: true, message: 'No approved tasks to execute' }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    const results = []

    for (const approval of approvals) {
      const task = approval.admin_tasks
      if (!task) continue

      console.log(`Executing task: ${task.title} (${task.type})`)

      // 태스크 상태 → executing
      await supabase.from('admin_tasks').update({ status: 'executing' }).eq('id', task.id)

      let result = { success: false, message: 'Unknown task type' }

      // 태스크 타입별 라우팅
      if (task.type === 'ux_improvement' && task.title.includes('property card')) {
        const proposalId = approval.payload?.selected_proposal ?? task.selected_proposal ?? 1
        result = await executePropertyCardPreview(proposalId)
      }
      // 향후 추가:
      // else if (task.type === 'payment_failure') { ... }
      // else if (task.type === 'bug_report') { ... }

      // 태스크 상태 업데이트
      await supabase.from('admin_tasks')
        .update({
          status: result.success ? 'done' : 'proposed',
          // 실패 시 proposed로 되돌려서 재시도 가능하게
          resolved_at: result.success ? new Date().toISOString() : null,
        })
        .eq('id', task.id)

      // Sunny에게 결과 알림
      await sendResultEmail(SUNNY_EMAIL, task.title, result.success, result.message)

      results.push({ task_id: task.id, title: task.title, ...result })
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('ai-dev-agent error:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
