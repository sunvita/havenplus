# Haven Plus — AI Session Context

> 새 AI 세션을 시작할 때 이 파일을 먼저 읽으세요.
> 전체 맥락, 결정 사항, 현재 진행 상태가 여기 있습니다.

---

## 프로젝트 개요

**Haven Plus** — Perth, Western Australia 기반 주거용 부동산 케어 구독 서비스.
- 사이트: https://havenpluscare.com
- Repo: https://github.com/sunvita/havenplus (GitHub Pages)
- Stack: Supabase (DB + Edge Functions + Storage) · Stripe · Resend · Vanilla JS

**공동 오너 (50:50)**
- **Sunny** — Managing Director. 비즈니스 운영, 결제, 마케팅, 개발 담당
- **Jaden** — Field Director. 현장 인력, 스케줄링, SOP, 워커 관리 담당

---

## 현재 진행 중인 작업

### AI 에이전트 시스템 구축 (Phase 1)

Polsia 모델 참고하여 Haven Plus 운영의 80%를 AI 에이전트로 자동화하는 프로젝트.
세부 설계: `docs/AGENT_PLAN.md` 참조.

**구현 예정 순서:**
1. `admin_tasks` + `admin_approvals` DB 테이블 생성
2. `ai-ceo-daily` Edge Function
3. 대시보드 승인 UI (profile.html admin 섹션)
4. `ai-support-agent` + 챗봇 위젯
5. `ai-dev-agent`
6. `ai-scheduling-agent`
7. `ai-report-generator`
8. `ai-social-agent` + `ai-conversion-agent`

**현재 상태:** 설계 완료, 구현 미시작.

---

## 사이트 구조

자세한 내용: `docs/ARCHITECTURE.md`

| 파일 | 역할 | 접근 |
|------|------|------|
| `index.html` | 랜딩 페이지 (EN/KO 이중언어) | 공개 |
| `plans.html` | 플랜 선택 + Stripe 체크아웃 | 공개 |
| `dashboard.html` | 고객 대시보드 | 로그인 필요 |
| `profile.html` | 계정 설정 + 어드민 패널 | 로그인 필요 (어드민 별도) |
| `haventeam.html` | 워커 앱 (PWA) | 워커 계정 |

---

## Edge Functions (Supabase)

| 함수 | 역할 | 최근 변경 |
|------|------|-----------|
| `stripe-webhook` | 결제·구독 자동화 (35회 배포) | Apr 1 |
| `send-notification` | 이메일·인앱 알림 디스패처 | Apr 1 |
| `daily-reminder` | 전날 방문 리마인더 (pg_cron) | Mar 20 |
| `create-checkout-session` | Stripe 체크아웃 + 업그레이드 | Apr 1 |
| `create-portal-session` | Stripe 포털 | Mar 20 |

**주의:** stripe-webhook, create-checkout-session 변경은 Sunny 단독 승인 필요.

---

## DB 테이블 (Supabase)

| 테이블 | 설명 |
|--------|------|
| `profiles` | 사용자 프로필 (role: customer/worker/admin) |
| `properties` | 등록 부동산 |
| `subscriptions` | 구독 현황 (plan_type, cleaning_hours, sh_hours, status) |
| `cleaning_schedule` | 방문 일정 (planned_date, assigned_workers, status) |
| `service_requests` | 핸디맨·SH 요청 |
| `sh_balance` | SH 잔량 |
| `sh_transactions` | SH 사용 이력 |
| `payments` | 결제 이력 |
| `workers` | 워커 정보 (email, area, hourly_rate) |
| `notifications` | 인앱 알림 |
| `admin_settings` | 어드민 설정 |

**추가 예정 (AI 에이전트용):**
- `admin_tasks` — CEO 에이전트 태스크 관리
- `admin_approvals` — 승인 요청·결정 이력
- `chat_sessions` — 챗봇 대화 이력
- `bug_reports` — 오류 리포트

---

## 승인 권한 매트릭스

| 구분 | 담당 |
|------|------|
| **자율 실행** | 챗봇 응답, SR·MCR 초안, 소셜 예약, Low 버그 배포, 리마인더 |
| **Sunny 단독** | 환불 $100↑, Mid 버그 배포, 마케팅 예산, stripe-webhook 변경, DB 스키마 변경 |
| **Jaden 단독** | 노쇼 3회 처리, 워커 등록·제거, SH 예외, 스케줄 대규모 변경 |
| **공동 승인** | 가격 정책 변경, 플랜 구조 변경, 서비스 일시 중단 |

---

## 알려진 오류 패턴

자세한 내용: `docs/ai-dev-agent/ERROR_PATTERNS.md`

**결제 → Supabase 미전달 패턴:**
- Stripe webhook signature 검증 실패
- `subscriptions` upsert 충돌 (user_id + property_id 복합키)
- `payments` insert 시 FK 불일치

**이메일 미발송 패턴:**
- Resend API key 미설정 (RESEND_API_KEY env var)
- 수신자 이메일 profiles 테이블에 없음
- send-notification 함수 내부 오류 (로그만 남고 실패)

---

## 주요 결정 사항 (ADR)

1. **별도 결제 에이전트 없음** — stripe-webhook이 D+0~D+30 재시도를 처리. ai-ceo-daily가 매일 결제 실패 브리핑으로 커버.
2. **daily-reminder는 기존 유지** — ai-scheduling-agent는 배정 로직만 담당. 전날 알림은 daily-reminder가 계속 담당.
3. **챗봇 오류 → 자동 bug_reports** — ai-support-agent가 오류 감지 시 bug_reports 테이블에 자동 기록 → ai-dev-agent로 라우팅.
4. **공동 승인 72h 타임아웃** — 72시간 내 합의 없으면 보수적 기본값(현상 유지) 실행.
5. **마케팅 에이전트 Instagram API 연동** — Meta Business API 별도 세팅 필요 (Phase 2).

---

## 환경 변수 (Supabase Secrets)

```
STRIPE_SECRET_KEY
SUPABASE_URL
SB_SERVICE_ROLE_KEY
RESEND_API_KEY
BUSINESS_TIMEZONE=Australia/Perth
ANTHROPIC_API_KEY  ← AI 에이전트용, 추가 필요
```

---

## 다음 세션 시작 방법

```
"CLAUDE.md 읽고 현재 상태 파악해줘. 
 오늘은 [작업 내용]을 할 거야."
```
