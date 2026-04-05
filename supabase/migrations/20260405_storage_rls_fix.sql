-- ══════════════════════════════════════════════════════════════════
-- job-photos Storage Bucket RLS Fix
-- 문제: 워커가 before/after 사진 업로드 시 INSERT 권한 없음
-- 해결: workers 테이블에 등록된 사용자에게 job-photos 버킷 권한 부여
-- ══════════════════════════════════════════════════════════════════

-- 1. 버킷이 없으면 생성 (이미 있으면 무시됨)
INSERT INTO storage.buckets (id, name, public)
VALUES ('job-photos', 'job-photos', true)
ON CONFLICT (id) DO NOTHING;

-- 2. 기존 job-photos 관련 정책 초기화 (중복 방지)
DROP POLICY IF EXISTS "workers_can_upload_job_photos"   ON storage.objects;
DROP POLICY IF EXISTS "workers_can_update_job_photos"   ON storage.objects;
DROP POLICY IF EXISTS "workers_can_read_job_photos"     ON storage.objects;
DROP POLICY IF EXISTS "admins_can_all_job_photos"       ON storage.objects;
DROP POLICY IF EXISTS "public_can_read_job_photos"      ON storage.objects;

-- 3. 공개 읽기 (고객·어드민 모두 사진 열람)
CREATE POLICY "public_can_read_job_photos"
ON storage.objects FOR SELECT
USING (bucket_id = 'job-photos');

-- 4. 워커 업로드 허용 (INSERT)
--    workers 테이블에 auth.uid() 가 존재하는 사용자만
CREATE POLICY "workers_can_upload_job_photos"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'job-photos'
  AND EXISTS (
    SELECT 1 FROM public.workers
    WHERE user_id = auth.uid()
  )
);

-- 5. 워커 업데이트 허용 (upsert: true 이므로 UPDATE도 필요)
CREATE POLICY "workers_can_update_job_photos"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'job-photos'
  AND EXISTS (
    SELECT 1 FROM public.workers
    WHERE user_id = auth.uid()
  )
);

-- 6. 어드민 전체 권한
CREATE POLICY "admins_can_all_job_photos"
ON storage.objects FOR ALL
USING (
  bucket_id = 'job-photos'
  AND EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  )
);

-- ── 2차 정리 (2026-04-05) ─────────────────────────────────────────
-- 워커 앱은 Supabase Auth를 사용하지 않음 (worker_code 기반 인증)
-- 따라서 authenticated role 기반 정책은 실제로 작동하지 않아 삭제
DROP POLICY IF EXISTS "Workers can upload job photos"           ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can view job photos" ON storage.objects;
DROP POLICY IF EXISTS "Workers can update job photos"           ON storage.objects;
DROP POLICY IF EXISTS "Workers can delete job photos"           ON storage.objects;
-- 결과: anon(public) 기반 정책 4개만 유지
--   public_can_read_job_photos    SELECT  public
--   anon_can_upload_job_photos    INSERT  public
--   anon_can_update_job_photos    UPDATE  public
--   admins_can_all_job_photos     ALL     public
