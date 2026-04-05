-- ══════════════════════════════════════════════════════════════════
-- subscriptions 테이블 취소 관련 컬럼 추가
-- ══════════════════════════════════════════════════════════════════
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancellation_note text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_cancellation boolean DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_cancellation_invoice_id text;
