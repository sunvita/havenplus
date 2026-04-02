-- ══════════════════════════════════════════════════════════
-- Haven Plus — AI Agent Tables Migration
-- Created: 2026-04-02
-- Run in: Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════════════

-- ── 1. admin_tasks ───────────────────────────────────────
-- CEO 에이전트가 감지한 이슈·태스크 관리
CREATE TABLE IF NOT EXISTS admin_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  -- 'ux_improvement' | 'revenue_alert' | 'sop_issue'
  -- 'scheduling' | 'payment_failure' | 'bug_report' | 'marketing'
  severity      text NOT NULL CHECK (severity IN ('urgent', 'normal', 'longterm')),
  owner         text NOT NULL CHECK (owner IN ('sunny', 'jaden', 'both')),
  status        text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'approved', 'rejected', 'executing', 'done')),
  title         text NOT NULL,
  description   text,
  context_data  jsonb,
  -- 데이터 근거 (예: 전환율, 코드 분석 결과 등)
  proposals     jsonb,
  -- [{id, title, description, effort, expected_impact}]
  selected_proposal int,
  -- proposals 배열의 인덱스
  week_of       date,
  -- 이슈가 감지된 주 (금요일 기준)
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

-- ── 2. admin_approvals ───────────────────────────────────
-- 승인 요청·결정 이력
CREATE TABLE IF NOT EXISTS admin_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES admin_tasks(id) ON DELETE CASCADE,
  requester     text NOT NULL,
  -- 에이전트 함수명 (예: 'ai-ceo-weekly', 'ai-dev-agent')
  owner_target  text NOT NULL CHECK (owner_target IN ('sunny', 'jaden', 'both')),
  action        text NOT NULL,
  -- 수행할 작업 설명
  payload       jsonb,
  -- 실행에 필요한 데이터
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'modified')),
  decided_by    text,
  -- 'sunny' | 'jaden'
  decided_at    timestamptz,
  comment       text,
  expires_at    timestamptz
  -- NULL이면 타임아웃 없음 (High severity)
);

-- ── 3. chat_sessions ─────────────────────────────────────
-- 챗봇 대화 이력
CREATE TABLE IF NOT EXISTS chat_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  channel        text NOT NULL CHECK (channel IN ('chatbot', 'email')),
  messages       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{role: 'user'|'assistant', content, timestamp}]
  resolved       boolean NOT NULL DEFAULT false,
  bug_reported   boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── 4. bug_reports ───────────────────────────────────────
-- 오류 리포트 (챗봇·이메일·CEO에이전트·수동)
CREATE TABLE IF NOT EXISTS bug_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text NOT NULL CHECK (source IN ('chatbot', 'email', 'ceo_agent', 'manual')),
  chat_session_id  uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  description      text NOT NULL,
  error_type       text CHECK (error_type IN ('payment', 'notification', 'ui', 'data', 'auth', 'other')),
  severity         text NOT NULL DEFAULT 'mid' CHECK (severity IN ('low', 'mid', 'high')),
  status           text NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'investigating', 'fixing', 'testing', 'deployed', 'closed')),
  related_function text,
  -- 'stripe-webhook' | 'send-notification' | 'dashboard' 등
  fix_description  text,
  deployed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ── RLS 정책 ─────────────────────────────────────────────
-- admin_tasks: admin role만 읽기/쓰기
ALTER TABLE admin_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_tasks_admin_only" ON admin_tasks
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- admin_approvals: admin role만 읽기/쓰기
ALTER TABLE admin_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_approvals_admin_only" ON admin_approvals
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- chat_sessions: 본인 세션만 읽기
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_sessions_own" ON chat_sessions
  USING (user_id = auth.uid());
CREATE POLICY "chat_sessions_admin" ON chat_sessions
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- bug_reports: admin만
ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bug_reports_admin_only" ON bug_reports
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ));

-- ── 인덱스 ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_admin_tasks_status ON admin_tasks(status);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_owner ON admin_tasks(owner);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_week ON admin_tasks(week_of);
CREATE INDEX IF NOT EXISTS idx_admin_approvals_task ON admin_approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_admin_approvals_status ON admin_approvals(status);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id);
