# ai-dev-agent — 알려진 오류 패턴

**최종 업데이트:** 2026-04-02

ai-dev-agent가 오류를 빠르게 분류하고 수정하기 위한 패턴 사전.
새 오류 발견 시 여기에 추가.

---

## 패턴 1: 결제 클릭 → Stripe 정상 → Supabase 미전달

### 증상
- 고객이 결제 완료했는데 대시보드에 구독이 안 보임
- Stripe 대시보드에는 결제 성공으로 표시
- `subscriptions` 테이블에 레코드 없음

### 원인 분류

**1-A) Webhook Signature 검증 실패**
```
로그 패턴: "Webhook Error" (status 400)
위치: stripe-webhook/index.ts line ~198
원인: STRIPE_WEBHOOK_SECRET 환경변수 불일치
수정: Supabase Secrets에서 STRIPE_WEBHOOK_SECRET 재확인
심각도: High
```

**1-B) subscriptions upsert 충돌**
```
로그 패턴: "subscriptions upsert error: duplicate key"
위치: stripe-webhook/index.ts ~256
원인: user_id + property_id 복합 유니크 제약 위반
     (같은 사용자가 같은 부동산에 중복 구독 시도)
수정: upsert onConflict 조건 확인, property_id null 처리 점검
심각도: Mid
```

**1-C) checkout.session.completed 이벤트 누락**
```
로그 패턴: 없음 (Stripe에서 webhook 미전달)
확인: Stripe Dashboard → Webhooks → 이벤트 로그
원인: Webhook endpoint URL 변경되었거나 Supabase Edge Function URL 만료
수정: Stripe Dashboard에서 webhook URL 재등록
심각도: High
```

**1-D) metadata 누락으로 user_id 없음**
```
로그 패턴: "user_id missing in session metadata"
위치: stripe-webhook/index.ts checkout.session.completed 처리
원인: create-checkout-session에서 metadata.user_id 미포함
수정: create-checkout-session metadata 객체 확인
심각도: High
```

### 진단 쿼리
```sql
-- 최근 결제 vs 구독 불일치 확인
SELECT p.created_at, p.amount, p.user_id, s.id as sub_id
FROM payments p
LEFT JOIN subscriptions s ON s.user_id = p.user_id
WHERE p.created_at > now() - interval '24 hours'
AND s.id IS NULL;
```

---

## 패턴 2: 이메일 미발송

### 증상
- 결제 완료 후 확인 이메일 미수신
- 방문 완료 후 SR 이메일 미수신
- daily-reminder 이메일 미수신

### 원인 분류

**2-A) RESEND_API_KEY 미설정**
```
로그 패턴: "RESEND_API_KEY not set — skipping email"
위치: send-notification/index.ts ~63
수정: Supabase Secrets에 RESEND_API_KEY 추가
심각도: Mid
```

**2-B) 수신자 이메일 없음**
```
로그 패턴: "resolveEmail returned null for userId: {id}"
위치: send-notification/index.ts resolveEmail()
원인: profiles 테이블에 email 없음 또는 auth.users와 불일치
수정:
  SELECT id, email FROM profiles WHERE email IS NULL;
  -- 누락된 경우 auth.users에서 동기화
심각도: Mid
```

**2-C) Resend API 오류**
```
로그 패턴: "Resend error: {status} {message}"
위치: send-notification/index.ts sendEmail()
원인: Resend 서비스 오류, 발송 도메인 미인증, 수신자 차단
수정: Resend 대시보드에서 도메인 인증 상태 확인
심각도: Mid
```

**2-D) send-notification 함수 내부 에러**
```
로그 패턴: "send-notification error" (500 응답)
원인: 알림 타입이 DB CHECK 제약과 불일치
     유효 타입: scheduled, completed, reminder, payment_received, new_request
수정: 호출처에서 type 값 확인
심각도: Low
```

**2-E) daily-reminder 작동 안 함**
```
확인: Supabase Dashboard → Database → pg_cron jobs
     'daily-cleaning-reminder' job 상태 확인
원인: pg_cron job이 등록 해제되었거나 Edge Function URL 변경
수정:
  SELECT cron.schedule(
    'daily-cleaning-reminder',
    '0 4 * * *',
    $$SELECT net.http_post(url:='...')$$
  );
심각도: Mid
```

---

## 패턴 3: 결제 실패 이후 계정 상태 불일치

### 증상
- Stripe에서 past_due인데 대시보드에 active로 표시
- 서비스 접근이 차단되어야 하는데 정상 작동

### 원인
```
로그 패턴: "invoice renewal update error"
위치: stripe-webhook/index.ts invoice.payment_failed 처리
원인: stripe_subscription_id 매핑 불일치
     getSubscriptionUUID() 반환값 null
수정:
  SELECT stripe_subscription_id, status FROM subscriptions
  WHERE user_id = '{userId}';
  -- stripe_subscription_id가 실제 Stripe ID와 일치하는지 확인
심각도: Mid
```

---

## 패턴 4: SH 잔량 계산 오류

### 증상
- 고객이 SH를 사용했는데 잔량이 안 줄어듦
- 또는 잔량이 마이너스로 표시

### 원인
```
위치: stripe-webhook/index.ts sh_hours_total 업데이트
     haventeam.html 완료 처리 시 sh_balance 차감
원인: 소수점 부동소수점 오류 (예: 7 * 1.1 = 7.700000000000001)
수정: Math.round(value * 4) / 4 로 0.25 단위 반올림 처리
심각도: Low
```

---

## 패턴 5: 챗봇/UI 오류 (고객 리포트)

### "결제 버튼이 안 눌려요"
```
확인 순서:
1. create-checkout-session 함수 로그 확인
2. 브라우저 콘솔 에러 (CORS? 401?)
3. Supabase Auth 세션 만료 여부
4. planKey, userId 값이 올바르게 전달되는지 확인
심각도: High (결제 관련)
```

### "알림이 안 와요"
```
확인 순서:
1. notifications 테이블에 레코드 있는지 확인
2. send-notification 로그 확인
3. 이메일 스팸 폴더 확인 안내
4. 패턴 2 진단 순서 따름
심각도: Mid
```

### "대시보드가 안 불러와져요"
```
확인 순서:
1. Supabase Auth 상태 확인 (세션 만료?)
2. profiles.role 컬럼 값 확인
3. RLS 정책 확인 (해당 user_id로 SELECT 가능한지)
심각도: Mid
```

---

## 오류 추가 방법

새 오류 패턴 발견 시 이 파일에 추가:

```markdown
## 패턴 N: {증상 한 줄 요약}

### 증상
- 고객/오너가 보고한 내용

### 원인 분류
**N-A) {원인명}**
로그 패턴: "{로그에서 찾을 수 있는 텍스트}"
위치: {파일명:라인번호}
원인: {기술적 원인}
수정: {수정 방법}
심각도: Low / Mid / High
```
