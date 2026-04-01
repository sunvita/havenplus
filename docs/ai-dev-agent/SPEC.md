# ai-dev-agent — 기술 명세

**최종 업데이트:** 2026-04-02

---

## 역할 요약

오류 수신 → 코드 분석 → 수정 → 테스트 → 배포를 자동화.
Sunny(MD) 승인 매트릭스와 연동하여 안전하게 운영.

---

## 전체 파이프라인

```
┌─────────────────────────────────────────────────────┐
│                   인풋 소스                          │
│  챗봇 오류 리포트 · 이메일 불만 · CEO 에이전트 감지    │
└──────────────────────┬──────────────────────────────┘
                       ↓
              [1] bug_reports 수신
                       ↓
              [2] 검증 (재현 + 로그 + 코드 분석)
                       ↓
              [3] 심각도 분류
                  Low / Mid / High
                       ↓
              [4] 코드 수정 (GitHub API)
                       ↓
              [5] 테스트 (샌드박스 실행)
                       ↓
              [6] 배포 결정
                  Low → 자율 배포 + Sunny 알림
                  Mid → admin_approvals → Sunny 승인
                  High → admin_approvals → Sunny 필수 승인
```

---

## 심각도 분류 기준

### Low (자율 배포)
- UI 텍스트·스타일 오류
- 이메일 템플릿 문구 수정
- 알림 타이밍 조정
- 콘솔 에러 (기능 영향 없음)

**조건:** 결제·인증·데이터 무결성과 무관 + Edge Function 단위 변경만

### Mid (Sunny 단독 승인, 24h)
- 비결제 로직 버그
- 알림 미발송 (send-notification 오류)
- 대시보드 데이터 표시 오류
- daily-reminder 타이밍 오류

### High (Sunny 필수 승인, 즉시 알림)
- 결제 플로우 오류
- 인증 관련 버그
- 데이터 손실 위험
- stripe-webhook 관련 모든 변경

---

## 자율 배포 금지 목록 (항상 Sunny 승인)

```
supabase/functions/stripe-webhook/
supabase/functions/create-checkout-session/
supabase/functions/create-portal-session/
```
- 인증 로직 (Supabase Auth 관련)
- DB 스키마 변경 (마이그레이션)
- 환경 변수 변경

---

## Sunny 승인 플로우

```
ai-dev-agent → admin_approvals 레코드 생성
  → Sunny 이메일 발송 (오류 설명 + 수정 내용 + 테스트 결과)
  → Sunny: 이메일 답장 "승인" / 대시보드 원클릭 승인
  → ai-dev-agent: 승인 감지 → Supabase Management API 배포
  → 배포 완료 → Sunny 결과 알림
```

**타임아웃:** Mid 24h, High 없음 (Sunny가 직접 해결할 때까지 대기)

---

## 도구 및 API

### GitHub API
- 코드 조회: `GET /repos/sunvita/havenplus/contents/{path}`
- 코드 수정: `PUT /repos/sunvita/havenplus/contents/{path}` (base64 인코딩)
- 커밋 메시지 형식: `fix(ai-dev): {오류 설명} — auto-fix by ai-dev-agent`

### Supabase Management API
- 함수 배포: `POST /v1/projects/{ref}/functions/{slug}/deploy`
- 로그 조회: `GET /v1/projects/{ref}/logs?source=edge-functions`

### 로그 분석
- Supabase Dashboard Edge Function 로그
- `console.error` 패턴 매칭
- 오류 발생 시각 + 관련 요청 추적

---

## 배포 후 검증

1. Edge Function 배포 상태 확인
2. 테스트 요청 1회 실행 (샌드박스)
3. 오류 재발 없음 확인 (5분 모니터링)
4. bug_reports.status → 'deployed'
5. Sunny에게 결과 리포트

---

## 에러 패턴 참조

`docs/ai-dev-agent/ERROR_PATTERNS.md` 참조
