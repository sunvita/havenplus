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
- **Sunny** — Managing Director. 비즈니스 운영, 결제, 마케팅, 개발 담당. hi@havenpluscare.com
- **Jaden** — Field Director. 현장 인력, 스케줄링, SOP, 워커 관리 담당. jinhyunmail@gmail.com

---

## 현재 상태 (2026-04-02 기준)

### ✅ 완료된 작업

#### AI 에이전트 시스템 (Phase 1)
- admin_tasks, admin_approvals, chat_sessions, bug_reports DB 테이블 생성
- ai-ceo-weekly Edge Function — 매주 금요일 07:00 Perth (pg_cron 0 23 * * 4)
  - KPI 수집 + Claude 분석 + 이슈 감지 + admin_tasks/admin_approvals 생성
  - Sunny/Jaden 이메일 브리핑 발송
  - Rule-based fallback (ANTHROPIC_API_KEY 없을 때)
- ai-dev-agent Edge Function — 승인된 태스크 자동 실행
  - admin_approvals approved → GitHub API 코드 수정 → 자동 배포
  - 현재 구현: property card UX 개선 태스크
- profile.html AI Tasks (의사결정) 전용 메뉴 추가
  - 검토 대기 / 결정 내역 탭
  - 승인·거절·검토 보류 기능
  - 보류 카드 클릭 시 내용 펼치기 / 검토 대기로 되돌리기 / 최종 거절
  - 에이전트 출처 배지, 실행 상태 배지 (대기중/실행중/배포완료)
- Dashboard에 AI Tasks 요약 카드 (대기 건수 배지)

#### 결제·이메일 시스템
- send-notification resolveEmail — profiles.email 제거 → auth.users 직접 조회
- 이메일 타입 4개 추가 (모두 로고 이미지 + Haven Plus 브랜드 템플릿):
  - subscription_confirmed — 신규 구독 Welcome + View Receipt (Stripe invoice URL)
  - subscription_renewed — 구독 갱신 + View Receipt + 다음 갱신일
  - sh_bundle_confirmed — SH 번들 구매 + View Receipt (charge.receipt_url)
  - payment_failed — 결제 실패 + Update Payment Method (Stripe customer portal)
- stripe-webhook에서 위 4개 이메일 자동 발송
- Stripe에서 실제 amount, billing_cycle, receipt_url 조회해서 전달

#### dashboard.html
- Property card a모드 (미결제) UX 개선
  - 헤더: Smart 기준 플랜 preview 라인
  - 펼쳤을 때: dimmed pd-grid + 스케줄 preview + CTA 버튼
  - EN/KO 이중언어 완전 적용
- 언어 토글 시 location.reload()로 카드 재렌더링
- SyntaxError 수정 (이스케이프 오류 12곳)

#### haventeam.html (워커 앱)
- Start Job 실패 수정
  - Storage upsert: false → true (경로 충돌 방지)
  - service_requests UPDATE RLS with_check null 수정
  - 에러 메시지 상세화
- Gallery PIN 기능
  - Before/After 사진 모달에 갤러리 선택 버튼 (PIN 필요)
  - 4자리 PIN 인증 모달
  - admin_settings gallery_pin 키로 SHA-256 해시 저장
  - profile.html Security 섹션에 Gallery Access PIN 관리 UI

---

## Supabase 설정 현황

### Edge Functions
| 함수 | 역할 | 최근 변경 |
|------|------|-----------|
| stripe-webhook | 결제·구독 자동화 + 이메일 발송 | 2026-04-02 |
| send-notification | 이메일·인앱 알림 디스패처 | 2026-04-02 |
| ai-ceo-weekly | 주간 KPI 분석 + 태스크 생성 | 2026-04-02 |
| ai-dev-agent | 승인 태스크 자동 실행 | 2026-04-02 |
| daily-reminder | 전날 방문 리마인더 (pg_cron) | Mar 20 |
| create-checkout-session | Stripe 체크아웃 + 업그레이드 | Apr 1 |
| create-portal-session | Stripe 포털 | Mar 20 |

### pg_cron Jobs
| 이름 | 스케줄 | 역할 |
|------|--------|------|
| ai-ceo-weekly | 0 23 * * 4 (Perth 금 07:00) | 주간 KPI 분석 |
| daily-cleaning-reminder | 0 4 * * * | 전날 방문 리마인더 |

### DB Webhook
- on_approval_approved: admin_approvals UPDATE → ai-dev-agent 트리거

### Secrets
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SB_SERVICE_ROLE_KEY,
RESEND_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN — 모두 설정 완료

---

## 사이트 구조

| 파일 | 역할 | 접근 |
|------|------|------|
| index.html | 랜딩 페이지 (EN/KO 이중언어) | 공개 |
| plans.html | 플랜 선택 + Stripe 체크아웃 | 공개 |
| dashboard.html | 고객 대시보드 | 로그인 필요 |
| profile.html | 계정 설정 + 어드민 패널 | 로그인 필요 |
| haventeam.html | 워커 앱 (PWA) | 워커 계정 |

---

## DB 테이블 (Supabase)

| 테이블 | 설명 |
|--------|------|
| profiles | 사용자 프로필 (role: customer/worker/admin) ⚠️ email 컬럼 없음 — auth.users 사용 |
| properties | 등록 부동산 |
| subscriptions | 구독 현황 (plan_type, cleaning_hours, sh_hours, status) |
| cleaning_schedule | 방문 일정 |
| service_requests | 핸디맨·SH 요청 |
| sh_balance | SH 잔량 |
| payments | 결제 이력 |
| workers | 워커 정보 |
| notifications | 인앱 알림 |
| admin_settings | 어드민 설정 (override_pin, gallery_pin 등) |
| admin_tasks | CEO 에이전트 태스크 관리 ✅ |
| admin_approvals | 승인 요청·결정 이력 ✅ |
| chat_sessions | 챗봇 대화 이력 ✅ |
| bug_reports | 오류 리포트 ✅ |

---

## 이메일 발송 흐름

| 이벤트 | 타입 | 트리거 | 영수증 링크 |
|--------|------|--------|------------|
| 구독 신규 | subscription_confirmed | stripe-webhook checkout.session.completed | Stripe invoice URL |
| 구독 갱신 | subscription_renewed | stripe-webhook invoice.payment_succeeded | invoice.hosted_invoice_url |
| SH 번들 | sh_bundle_confirmed | stripe-webhook checkout.session.completed | charge.receipt_url |
| 결제 실패 | payment_failed | stripe-webhook invoice.payment_failed | Stripe customer portal |
| 방문 확정 | scheduled | profile.html saveSchedEdit() | — |
| 방문 완료 | completed | haventeam.html confirmComplete() | — |
| 전날 리마인더 | reminder | daily-reminder pg_cron | — |

---

## AI 에이전트 다음 작업

### Phase 2 — 즉시 필요
1. **ai-support-agent + 챗봇 위젯**
   - 웹사이트 챗봇 (index.html, dashboard.html)
   - chat_sessions 테이블 활용
   - 오류 감지 → bug_reports 자동 기록 → ai-dev-agent 라우팅
   - Claude Sonnet API 직접 호출

2. **ai-dev-agent 패턴 확장**
   - 현재: property card UX만 처리
   - 추가 필요: ERROR_PATTERNS.md 패턴 자동 감지 + 수정
   - 알려진 패턴 매칭 → 자동 코드 수정 → 배포

### Phase 2 — 중기
3. **ai-scheduling-agent** — 워커 자동 배정
   - 새 서비스 요청 → 가용 워커 + 지역 매칭 → 자동 배정
   - Jaden 승인 필요 항목만 escalate

4. **ai-report-generator** — 월간 리포트 자동 생성
   - 매월 1일 수익·방문·고객 만족도 리포트
   - Sunny/Jaden 이메일 발송

5. **ai-conversion-agent** — 전환율 최적화
   - 미결제 부동산 고객 자동 follow-up 이메일
   - property card preview → 플랜 전환 유도

### Phase 3
6. **ai-social-agent** — SNS 자동 포스팅 (Meta Business API 연동 필요)
7. **ai-report-generator** — 고급 분석 대시보드

---

## 알려진 오류 패턴

자세한 내용: docs/ai-dev-agent/ERROR_PATTERNS.md

| # | 원인 | 상태 |
|---|------|------|
| 1 | 결제→Supabase 미전달 (webhook signature, upsert 충돌) | ✅ 수정 완료 |
| 2 | 이메일 미발송 (RESEND_API_KEY, resolveEmail) | ✅ 수정 완료 |
| 3 | 결제 실패 후 계정 상태 불일치 | 모니터링 중 |
| 4 | SH 잔량 부동소수점 오류 | ✅ 수정 완료 |
| 5 | 챗봇/UI 오류 | Phase 2 |
| 6 | Start Job 실패 (storage upsert + RLS with_check) | ✅ 수정 완료 |
| 7 | 결제 영수증 미발송 (profiles.email 컬럼 없음) | ✅ 수정 완료 |

---

## 승인 권한 매트릭스

| 구분 | 담당 |
|------|------|
| 자율 실행 | 챗봇 응답, SR·MCR 초안, 소셜 예약, Low 버그, 리마인더 |
| Sunny 단독 | 환불 $100↑, Mid/High 버그, 마케팅 예산, stripe-webhook, DB 스키마 |
| Jaden 단독 | 노쇼 3회, 워커 등록·제거, SH 예외, 스케줄 대규모 변경 |
| 공동 승인 | 가격 정책, 플랜 구조, 서비스 중단 (72h 타임아웃) |

---

## 주요 결정 사항 (ADR)

1. **AI cadence** — 매일이 아닌 주 1회 금요일 오전 보고 → 검토 → 실행
2. **별도 결제 에이전트 없음** — stripe-webhook 처리. ai-ceo-weekly가 주간 브리핑 커버
3. **daily-reminder 기존 유지** — ai-scheduling-agent는 배정 로직만 담당
4. **챗봇 오류 자동화** — ai-support-agent → bug_reports → ai-dev-agent 라우팅
5. **공동 승인 72h 타임아웃** — 합의 없으면 현상 유지
6. **profiles.email 없음** — 고객 이메일은 항상 auth.users에서 조회
7. **Gallery PIN** — 워커 갤러리 접근 예외용. admin_settings gallery_pin (SHA-256)

---

## 다음 세션 시작 방법

```
"CLAUDE.md 읽고 현재 상태 파악해줘.
 오늘은 [작업 내용]을 할 거야."
```
