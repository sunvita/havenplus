-- ══════════════════════════════════════════════════════════
-- pg_cron: ai-ceo-weekly 금요일 오전 7시 (Perth) 등록
-- UTC 23:00 목요일 = Perth 금요일 07:00 (AWST UTC+8)
-- Supabase Dashboard → SQL Editor에서 실행
-- ══════════════════════════════════════════════════════════

-- 기존 job 있으면 삭제 후 재등록
SELECT cron.unschedule('ai-ceo-weekly') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'ai-ceo-weekly'
);

SELECT cron.schedule(
  'ai-ceo-weekly',
  '0 23 * * 4',  -- 매주 목요일 UTC 23:00 = Perth 금요일 07:00
  $$
  SELECT net.http_post(
    url := 'https://rtkgnlcgepromqtoelre.supabase.co/functions/v1/ai-ceo-weekly',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
    ),
    body := '{}'::jsonb
  )
  $$
);

-- 등록 확인
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'ai-ceo-weekly';

-- ══════════════════════════════════════════════════════════
-- Supabase DB Webhook: admin_approvals approved → ai-dev-agent
-- Supabase Dashboard → Database → Webhooks → Create Webhook
--
-- Name: on_approval_approved
-- Table: admin_approvals
-- Events: UPDATE
-- URL: https://rtkgnlcgepromqtoelre.supabase.co/functions/v1/ai-dev-agent
-- HTTP Method: POST
-- Headers: Authorization: Bearer {SERVICE_ROLE_KEY}
-- Payload filter: NEW.status = 'approved'
-- ══════════════════════════════════════════════════════════
