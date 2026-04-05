-- ══════════════════════════════════════════════════════
-- payments 테이블 환불/추가결제 컬럼 추가
-- ══════════════════════════════════════════════════════

-- 환불 관련
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount      numeric;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at        timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason      text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_refund_id   text;

-- 추가 납부 관련
ALTER TABLE payments ADD COLUMN IF NOT EXISTS additional_charge_amount   numeric;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_additional_invoice_id text;

-- status 업데이트: refunded, partial_refunded, pending_refund, additional_pending, additional_paid, cancelled
-- payment_type 업데이트: refund, additional_charge
