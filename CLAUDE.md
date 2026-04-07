# Haven Plus — AI Session Context

> 새 AI 세션을 시작할 때 이 파일을 먼저 읽으세요.
> 전체 맥락, 결정 사항, 현재 진행 상태가 여기 있습니다.

---

## ⚠️ 코딩 대전제 — 반드시 준수

### 1. 수정 전 코드 리뷰 필수
- 수정/추가 로직이 **기존 로직에 영향을 주지 않는지** 먼저 검토
- 관련 함수의 스코프(전역/로컬), 호출 흐름, 의존성 파악 완료 후 작업
- 수정할 위치의 전후 컨텍스트 확인 (라인 번호, 변수명, 함수명)

### 2. 수정 후 검증 필수 (HTML 파일)
```python
import re
content = open('파일명').read()
scripts = re.findall(r'<script[^>]*>([\s\S]*?)</script>', content)
print(f"Script blocks: {len(scripts)}, sizes: {[len(s) for s in scripts]}")
print(f"</body>:{content.count('</body>')} </html>:{content.count('</html>')}")
# 추가한 기능 키워드 존재 여부 확인
```

### 3. 이전 버전과 diff 비교
- 커밋 전 `git diff HEAD -- 파일명`으로 변경사항 확인
- 의도하지 않은 변경 없는지 확인 후 커밋

### 4. 한 번에 정확하게
- 검증 통과 후 커밋 — 재수정 최소화
- 검증 스크립트 오류 시 원인 파악 후 재검증, 오탐이면 별도 확인

### 5. 배포 원칙
- stripe-webhook, process-refund: 반드시 `--no-verify-jwt`
- Dashboard 복붙 배포 불필요 — CLI가 GitHub 파일 그대로 업로드

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

## 현재 상태 (2026-04-03 기준)

### ✅ 완료된 작업

#### AI 에이전트 시스템 (Phase 1)
- admin_tasks, admin_approvals, chat_sessions, bug_reports DB 테이블 생성
- ai-ceo-weekly Edge Function — 매주 금요일 07:00 Perth (pg_cron 0 23 * * 4)
  - KPI 수집 + Claude 분석 + 이슈 감지 + admin_tasks/admin_approvals 생성
  - Sunny/Jaden 이메일 브리핑 발송 / Rule-based fallback
  - 수동 테스트 완료 확인
- ai-dev-agent Edge Function — 승인된 태스크 자동 실행
  - admin_approvals approved → GitHub API 코드 수정 → 자동 배포
  - 패턴 매칭 robust화 + alreadyPatched 체크
- profile.html AI Tasks (의사결정) 전용 메뉴
  - 검토 대기 / 결정 내역 탭
  - 승인·거절·검토 보류 / 보류 카드 펼치기 / 되돌리기 / 최종 거절
  - 에이전트 출처 배지, 실행 상태 배지
  - Dashboard 사이드바 메뉴 + 요약 카드

#### 결제·이메일 시스템 (최종 확정)
- send-notification resolveEmail → auth.users 직접 조회 (profiles.email 없음)
- 이메일 수신자 최종 정리 (CEO 검토 완료):

| 시나리오 | 고객 | 어드민 |
|---------|------|--------|
| 구독 신규 | ✅ subscription_confirmed | ✅ |
| 구독 갱신 | ✅ subscription_renewed | ❌ (자동처리) |
| SH 단품/번들 | ✅ sh_bundle_confirmed | ✅ |
| 결제 실패 | ✅ payment_failed | ✅ |
| payment_received | ❌ 제거 | ❌ 제거 |

- 모든 이메일: 로고 이미지 + Haven Plus 브랜드 템플릿
- Stripe에서 실제 amount, billing_cycle, receipt_url 조회해서 전달
- Wealthstone Property 영수증 수동 재발송 완료

#### Resend 도메인 Bounce 수정
- 원인: `send.havenpluscare.com` MX 레코드 없어서 "Domain not found" Bounce
- 해결: Namecheap Mail Settings → Custom MX로 변경
  - `@` mx1.privateemail.com (Priority 10) — hi@havenpluscare.com 수신 유지
  - `@` mx2.privateemail.com (Priority 10)
  - `send` feedback-smtp.[...].amazonses.com (Priority 10) — Resend bounce 처리
- 결과: hi@havenpluscare.com Bounce 문제 해결

#### create-portal-session 수정
- JWT verification OFF (Supabase 대시보드)
- 구독 없는 고객: "No active subscription. Choose a plan →" 안내
- stripe_customer_id 수동 업데이트:
  - ysland2033@gmail.com → cus_UDVlnt8zlcapPx
  - jinhyunmail@gmail.com → cus_U8kwffowu63DfM

#### dashboard.html
- Property card a모드 UX 개선 (dimmed preview + CTA)
- EN/KO 이중언어 + 언어 토글 시 reload
- SyntaxError 수정 12곳 (이스케이프 오류)

#### haventeam.html
- Start Job 실패 수정 (Storage upsert + RLS with_check)
- Gallery PIN 기능 (Before/After 갤러리 선택 예외 처리)

---

## Supabase 설정 현황

### Edge Functions
| 함수 | 역할 | 최근 변경 |
|------|------|-----------|
| stripe-webhook | 결제·구독 자동화 + 이메일 | 2026-04-03 |
| send-notification | 이메일·인앱 알림 | 2026-04-03 |
| ai-ceo-weekly | 주간 KPI + 태스크 생성 | 2026-04-02 |
| ai-dev-agent | 승인 태스크 자동 실행 | 2026-04-02 |
| daily-reminder | 전날 방문 리마인더 | Mar 20 |
| create-checkout-session | Stripe 체크아웃 | Apr 1 |
| create-portal-session | Stripe 포털 (JWT verify OFF) | 2026-04-03 |

### pg_cron
| 이름 | 스케줄 | 역할 |
|------|--------|------|
| ai-ceo-weekly | 0 23 * * 4 (Perth 금 07:00) | 주간 KPI |
| daily-cleaning-reminder | 0 4 * * * | 방문 리마인더 |

### DB Webhook
- on_approval_approved: admin_approvals UPDATE → ai-dev-agent

### Secrets
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SB_SERVICE_ROLE_KEY,
RESEND_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN — 모두 설정 완료

---

## 사이트 구조

| 파일 | 역할 | 접근 |
|------|------|------|
| index.html | 랜딩 (EN/KO) | 공개 |
| plans.html | 플랜 선택 + Stripe | 공개 |
| dashboard.html | 고객 대시보드 | 로그인 |
| profile.html | 계정 설정 + 어드민 | 로그인 |
| haventeam.html | 워커 앱 (PWA) | 워커 |

---

## DB 테이블

| 테이블 | 설명 |
|--------|------|
| profiles | 사용자 프로필 ⚠️ email 컬럼 없음 — auth.users 사용 |
| properties | 등록 부동산 |
| subscriptions | 구독 (plan_type, cleaning_hours, sh_hours, stripe_customer_id) |
| cleaning_schedule | 방문 일정 |
| service_requests | 핸디맨·SH 요청 |
| sh_balance | SH 잔량 |
| payments | 결제 이력 |
| workers | 워커 정보 |
| notifications | 인앱 알림 |
| admin_settings | 어드민 설정 (override_pin, gallery_pin) |
| admin_tasks | CEO 에이전트 태스크 ✅ |
| admin_approvals | 승인 이력 ✅ |
| chat_sessions | 챗봇 대화 ✅ |
| bug_reports | 오류 리포트 ✅ |

---

## 실제 고객 현황

| 이메일 | 플랜 | stripe_customer_id |
|--------|------|-------------------|
| wealthstone.property@gmail.com | Smart Annual $900 | cus_UFn7gt0WnZJsES |
| ysland2033@gmail.com | Premium | cus_UDVlnt8zlcapPx |
| jinhyunmail@gmail.com | Premium | cus_U8kwffowu63DfM |

---

## AI 에이전트 다음 작업

### Phase 2 — 즉시
1. **ai-support-agent + 챗봇** — Claude Sonnet, chat_sessions, bug_reports 연동
2. **ai-dev-agent 패턴 확장** — ERROR_PATTERNS.md 기반 자동 수정

### Phase 2 — 중기
3. **ai-scheduling-agent** — 워커 자동 배정
4. **ai-report-generator** — 월간 리포트
5. **ai-conversion-agent** — 미결제 부동산 follow-up

### Phase 3
6. **ai-social-agent** — Meta Business API 연동 필요

---

## 알려진 오류 패턴

| # | 원인 | 상태 |
|---|------|------|
| 1 | 결제→Supabase 미전달 | ✅ |
| 2 | 이메일 미발송 (resolveEmail) | ✅ |
| 3 | 결제 실패 후 상태 불일치 | 모니터링 |
| 4 | SH 부동소수점 오류 | ✅ |
| 5 | 챗봇/UI 오류 | Phase 2 |
| 6 | Start Job 실패 | ✅ |
| 7 | 결제 영수증 미발송 | ✅ |

---

## 승인 권한 매트릭스

| 구분 | 담당 |
|------|------|
| 자율 실행 | 챗봇, SR·MCR 초안, 소셜, Low 버그, 리마인더 |
| Sunny 단독 | 환불 $100↑, Mid/High 버그, stripe-webhook, DB 스키마 |
| Jaden 단독 | 노쇼 3회, 워커 등록·제거, SH 예외, 스케줄 변경 |
| 공동 승인 | 가격 정책, 플랜 구조, 서비스 중단 (72h) |

---

## 주요 결정 사항 (ADR)

1. **AI cadence** — 주 1회 금요일 오전 보고 → 검토 → 실행
2. **payment_received 제거** — subscription_confirmed / sh_bundle_confirmed로 대체
3. **subscription_renewed 어드민 없음** — 자동 처리, 개입 불필요
4. **profiles.email 없음** — auth.users에서 조회
5. **Gallery PIN** — admin_settings gallery_pin (SHA-256)
6. **create-portal-session JWT verify OFF**
7. **Resend 도메인** — Namecheap Custom MX로 send.havenpluscare.com MX 추가
8. **공동 승인 72h 타임아웃** — 현상 유지

---

## 다음 세션 시작 방법

```
"CLAUDE.md 읽고 현재 상태 파악해줘.
 오늘은 [작업 내용]을 할 거야."
```

---

## 운영 주의사항 (2026-04-05 추가)

### Edge Function 재배포 후 필수 확인
- `create-portal-session`: JWT verify OFF 유지 확인 (고객 비인증 호출)
- `stripe-webhook`: 401 발생 시 Supabase Edge Function 일시 장애 가능성
  STRIPE_WEBHOOK_SECRET 불일치라면 Resend도 동일하게 실패함
  → Resend 성공 시 일시적 함수 다운이 원인, 별도 조치 불필요

### Stripe 웹훅 장애 대응 절차
1. Stripe → Developers → Webhooks → Recent deliveries에서 실패 이벤트 확인
2. Supabase → Edge Functions → stripe-webhook → JWT verify OFF 확인
3. 실패한 `checkout.session.completed` **만** Resend (invoice.payment_succeeded, customer.subscription.updated는 Resend 불필요)
4. Resend 후 subscriptions, payments 테이블 데이터 반드시 크로스체크

### stripe-webhook 핵심 버그 수정 이력 (2026-04-05)
- `invoice.payment_succeeded`: `billing_reason !== 'subscription_cycle'`이면 skip
  - 신규 구독 첫 결제 시 `checkout.session.completed`와 중복 실행 방지
- `recordPayment`: `stripe_payment_id` / `stripe_invoice_id` 중복 체크 추가
  - Resend 시 payments 테이블 중복 insert 방지

---

## Edge Function 배포 원칙 (2026-04-05 추가)

### 배포 전 필수 절차 — 반드시 준수
Edge Function 수정 및 배포 시 아래 절차를 반드시 따를 것.
이를 무시하고 배포하면 운영 복구가 매우 어려움.

1. **현재 운영 버전 확인**
   - Supabase에 실제 배포된 버전을 첨부 또는 붙여넣기로 먼저 확인
   - GitHub repo 버전과 실제 운영 버전이 다를 수 있음

2. **diff 비교**
   - 현재 운영 버전 vs 수정 버전을 라인 단위로 비교
   - 변경되는 부분만 명확히 식별

3. **영향 분석**
   - 변경 사항이 어떤 이벤트/케이스에 영향을 주는지 명시
   - 제거되는 기능, 추가되는 기능, 동일한 기능 구분

4. **승인 후 배포**
   - 위 3가지 확인 결과를 Sunny에게 보고 후 승인받아 배포
   - "배포 진행해" 요청이 와도 위 절차 없이 present_file 하지 않음

5. **배포 후 확인**
   - Stripe Dashboard → Webhooks → havenplus-webhook → Event deliveries에서 200 OK 확인

### Edge Function CLI 배포 명령어 (맥북 터미널)
반드시 --no-verify-jwt 플래그 포함해서 배포할 것.
Dashboard 배포 시 JWT가 ON으로 초기화되어 웹훅 401 반복 발생함.

**Sunny 맥북 havenplus 경로: **

```bash
# 배포 전 항상 최신화
cd /Users/syna/havenplus && git pull

# stripe-webhook (JWT OFF 필수 — Stripe가 JWT 없이 호출)
supabase functions deploy stripe-webhook --project-ref rtkgnlcgepromqtoelre --no-verify-jwt

# create-portal-session (JWT OFF 필수 — 고객 비인증 호출)
supabase functions deploy create-portal-session --project-ref rtkgnlcgepromqtoelre --no-verify-jwt

# 그 외 함수 (JWT ON 유지)
supabase functions deploy [함수명] --project-ref rtkgnlcgepromqtoelre

# 전체 배포 (오늘 기준 전체 함수)
supabase functions deploy stripe-webhook --project-ref rtkgnlcgepromqtoelre --no-verify-jwt
supabase functions deploy process-refund --project-ref rtkgnlcgepromqtoelre --no-verify-jwt
supabase functions deploy send-notification --project-ref rtkgnlcgepromqtoelre --no-verify-jwt
supabase functions deploy create-portal-session --project-ref rtkgnlcgepromqtoelre --no-verify-jwt
supabase functions deploy ai-ceo-weekly --project-ref rtkgnlcgepromqtoelre
supabase functions deploy ai-dev-agent --project-ref rtkgnlcgepromqtoelre
supabase functions deploy daily-reminder --project-ref rtkgnlcgepromqtoelre
```

Docker 없이도 배포 가능. Supabase CLI 로그인 상태 필요.
Dashboard에서 직접 복붙 배포 불필요 — CLI가 GitHub 파일 그대로 Supabase에 업로드.

---

## HTML 파일 수정 원칙 (2026-04-05 추가)

### 대형 HTML 파일 수정 시 필수 절차
profile.html, dashboard.html, haventeam.html 등 대형 파일 수정 시 반드시 준수.

**수정 전:**
1. 현재 파일 구조 파악
   - script 블록 수/크기 확인
   - 수정할 위치 정확한 라인 번호 확인
   - 수정 전후 컨텍스트 확인
2. 안정 버전 백업 확인 (git log로 커밋 확인)
3. 영향 범위 분석 (어떤 기능에 영향 주는지)

**수정 후 반드시 검증:**
```python
import re
content = open('profile.html').read()
scripts = re.findall(r'<script[^>]*>([\s\S]*?)</script>', content)
print(f"Script blocks: {len(scripts)}")
for i, s in enumerate(scripts):
    print(f"  [{i}] {len(s)} chars")
print(f"</body>: {content.count('</body>')}")
print(f"</html>: {content.count('</html>')}")
print(f"추가한 기능 키워드 존재 여부 확인")
```

**검증 항목:**
- script 블록 수/크기가 수정 전과 비교해 정상인지
- </body>, </html> 각 1개씩 존재하는지
- 추가한 HTML/JS 요소가 실제로 존재하는지
- 기존 주요 기능 키워드 유지되는지

**이상 발견 시:**
- 즉시 git checkout 또는 안정 버전으로 롤백
- 원인 파악 후 재시도

### 수정 방식 우선순위
1. **Python으로 정확한 문자열 교체** — 가장 안전
2. **str_replace 도구** — 짧고 고유한 문자열일 때
3. **rfind()로 마지막 위치 교체** — 절대 사용 금지 (위치 오판 위험)

---

## Payments — 환불/취소 시스템 (2026-04-05)

### Cancel Subscription 흐름
- **Case A** (추가청구 없음): 즉시 취소 → 환불(있으면) → subscription_cancelled 이메일
- **Case B** (추가청구 있음): Invoice 발송 → pending_cancellation=true → 고객 납부 → invoice.paid webhook → 자동 취소 → subscription_cancelled 이메일

### 이메일 타입
| 타입 | 발송 시점 |
|------|---------|
| subscription_cancelled | 구독 취소 완료 시 (Case A/B 공통) |
| subscription_cancellation_pending | Invoice 발송 시 (Case B) |
| refund_confirmed | SH번들 환불 완료 시 |

### 미구현 — 추후 처리 필요
- Case B Invoice 미납 시 (14일 만료 후) 처리 로직
  - invoice.payment_failed 웹훅으로 어드민 알림 또는 자동 취소 처리

### 쿨링오프 자격 체크 (profile.html openCancelSubModal)
1. 구독 시작 30일 이내
2. cleaning_schedule completed 없음
3. service_requests completed 없음
→ 3개 모두 충족 시만 활성화

---

## 미해결 — 다음 세션 작업 필요 (2026-04-05)

### profile.html 반응형 미완성
1. **사이드바 모바일 숨김 안 됨** — `aside` grid flow 제거 시도했으나 미해결
2. **Payments 요약 카드 반응형 미적용** — grid 2열 전환 안 됨
- 현재 코드: `display:none` + `display:block !important` 충돌 의심
- 접근 방법 변경 필요: JS로 직접 style 제어 또는 CSS 구조 재검토

---

## 내일 확인 항목 (2026-04-06)

- [ ] 고객 취소 확인 이메일 수신 확인 (subscription_cancelled)
- [ ] 고객 dashboard.html 구독 비활성 표시 확인
- [ ] 반응형 사이드바 이슈 해결 (profile.html 미완성)

---

## 다음 세션 작업 백로그

### 1. 워커 앱 — 작업 시작/종료 + 영수증 섹션
- 작업 시작/종료 버튼 (haventeam.html)
- 영수증 업로드 섹션 추가
- **옵션 A** (복잡성 검토): 영수증 업로드 시 AI가 품목/금액 자동 파싱
- **옵션 B** (효율성 검토): 사용 금액을 결제일 기준으로 정리 → 확인 → 승인 → 작업자 결재 추가 프로세스

### 2. 워커 가용 일정 등록 시스템
- 날짜/시간 단위 가용 일정 등록 메뉴 (haventeam.html)
- 작업(Cleaning/Service) 요청 발생 시 전체 가용 인원에게 공개
- 워커가 스스로 일정 매칭할 수 있는 시스템

### 3. 워커 결제 시스템
- 매주 결제 요일 설정
- 작업자 개인정보 입력 시 결제 계좌 함께 입력
- 어드민: 작업자별 입금 금액 확인 (작업시간 기반 + 영수증 내역)
- 자동 송금 가능 여부 검토 (클릭 시 자동 송금)

### 4. Dashboard 개선 (오늘 마지막 작업)
**4-1. SH 이벤트 기반 서비스 히스토리 활성화**
- 구독 플랜도 SH 구매 기록도 없는 부동산에 SH 사용 시
- 해당 이벤트(requested) 기반으로 Property 서비스 히스토리 활성화

**4-2. Cleaning Hours / Service Hours 카드 클릭 인터랙션**
- CH 카드 클릭 → 해당 Property 청소 히스토리 표시
- SH 카드 클릭 → 해당 Property 서비스 히스토리 표시
- 양방향 UX: Property 기준 + 각 시간 기준

---

## 2026-04-05 세션 완료 작업 요약

### Payments 섹션 (profile.html 어드민)
- 사이드바 Payments 메뉴 추가 (Dashboard 바로 아래)
- 결제 내역 테이블: Date / Customer / Property / Type / Amount / Stripe Fee / Net / Status / Manage
- 요약 카드: Total Revenue / Stripe Fees (+unrecovered) / Net Revenue (before refund) / Refunded
- **Cancel Sub 흐름 (Case A/B)**
  - Case A (추가청구 없음): 즉시 취소 → 환불 → subscription_cancelled 이메일
  - Case B (추가청구 있음): Invoice 발송 (sendInvoice X, Haven Plus 이메일에 링크 포함) → 고객 납부 → invoice.paid webhook → 자동 취소
- **Cancel Sub 모달 자동 계산**: 플랜/월납연납/경과월/잔여월 기반 정산
- **쿨링오프**: 어드민 직접 선택 방식 (자동 체크 제거)
- **Manage 컬럼**: subscription→Cancel Sub, sh_bundle→Refund, 취소/환불 후 버튼 자동 숨김
- **Net 계산**: 환불된 건 = net_amount - refund_amount (수수료 이중차감 방지)

### 이메일 템플릿 (send-notification)
- `subscription_cancelled`: 고객/어드민 동일 HTML, 어드민 제목 [Admin Notice] 접두사
- `subscription_cancellation_pending`: Invoice 링크 포함 (Case B)
- `refund_confirmed`: SH번들 환불 확인

### process-refund Edge Function
- `cancel_subscription`: Stripe 취소 + 환불 (있을 때) + cancellation_reason/note 기록
- `send_cancellation_invoice`: Invoice 생성 (finalize only) + pending_cancellation 기록 + 이메일
- `refund`: resolveChargeId로 charge_id 없는 케이스 해결 (payment_intent → latest_charge)
- **주의**: 반드시 `--no-verify-jwt` 플래그로 배포

### stripe-webhook 강화
- `customer.subscription.deleted`: status=cancelled + subscription_cancelled 이메일 통합
- `invoice.paid`: pending_cancellation 구독 자동 취소 트리거
- `charge.refunded`: stripe_payment_id fallback 추가 (stripe_charge_id null인 경우)

### DB 마이그레이션
```sql
-- subscriptions
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancellation_note text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_cancellation boolean DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_cancellation_invoice_id text;

-- payments
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_amount numeric;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_refund_id text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS additional_charge_amount numeric;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_additional_invoice_id text;
```

### Dashboard 개선 (dashboard.html)
**4-1. 구독 없는 부동산 서비스 히스토리 활성화**
- service_requests 이력 있으면 Service History 버튼 활성화
- srByProp 전역 변수로 선언 (showStateActive가 전역 함수라 스코프 주의)

**4-2. CH/SH 클릭 → 히스토리 필터링**
- 상단 Cleaning Hours 카드: Property 1개→바로 오픈, 2개 이상→Property 선택 모달
- 상단 Service Hours 카드: 전체 Property 통합 히스토리 (openServiceHistoryAll)
- property 카드 내 Cleaning hrs 🔍 / SH vouchers 🔍 클릭 → 해당 필터
- summaryMeta Cleaning/SH 텍스트 클릭 가능 (점선 밑줄)
- 서비스 히스토리 job 항목: 날짜 아래 📍 Property 주소 두 번째 줄 표시

### 코딩 원칙 추가 확인
- 새 변수 추가 시 사용 범위(스코프) 먼저 파악 후 전역/로컬 결정
- 수정 전 관련 함수가 전역인지 로컬인지 확인 필수

---

## 2026-04-07 Stripe 수수료 검증 및 수정

### Stripe 수수료 구조 확정

**결제 시 수수료 (balance_transaction.fee):**
```
Charge fee = amount × 1.7% + $0.30 (GST 포함)
```

**Billing Usage Fee (Monthly 구독 갱신에만 적용):**
```
Billing fee = amount × 0.7% × 1.1(GST) = amount × 0.77%
```

**유형별 총 수수료:**
| 결제 유형 | Charge fee | Billing fee | 예시 ($150) |
|---------|-----------|------------|------------|
| Monthly 구독 갱신 | ✅ | ✅ | $2.85 + $1.16 = $4.01 |
| Annual 구독 신규 (checkout) | ✅ | ❌ | $15.60 ($900) |
| SH Bundle (checkout) | ✅ | ❌ | $11.18 ($640) |
| 환불 시 | 미환급 (손실) | 없음 | -$2.85 손실 |

### stripe-webhook 수정 내용
- `STRIPE_BILLING_FEE = 1.16` 고정값 제거
- Monthly 갱신: `amount × 0.7% × 1.1` 동적 계산
- Annual/checkout 신규: `isSubscriptionInvoice: false` → Billing fee $0

### 배포 완료 (2026-04-07)
```bash
supabase functions deploy stripe-webhook --project-ref rtkgnlcgepromqtoelre --no-verify-jwt
```

---

## 백로그 — 내부 정산 정확도

### Payout 이후 환불 시 unrecovered 과소 표시 이슈

**배경:**
- Stripe Billing Usage Fee (amount × 0.77%)는 결제 후 5일 뒤 payout 시 차감
- 현재 payments.stripe_fee = balance_transaction.fee (charge fee만 저장)
- billing_usage_fee는 별도 컬럼 없이 코드에서 합산해서 표시

**현재 동작:**
- Payout 전 환불: charge fee만 손실 → unrecovered 정확 ✅
- Payout 후 환불: charge fee + billing fee 모두 손실인데 charge fee만 표시 → 과소 표시 ❌

**실제 손실:**
```
charge fee:       $2.85 (balance_transaction.fee)
billing_usage_fee: $1.16 (amount × 0.77%)
총 손실:          $4.01
```

**해결 방향:**
- `billing_usage_fee` 컬럼 별도 추가 (payments 테이블)
- 환불 시 두 항목 합산해서 unrecovered 표시
- payout 이후 환불 케이스 발생 시 Stripe Dashboard에서 실제 동작 확인 후 구현

**우선순위:** 낮음 (실제 케이스 발생 전까지 운영 영향 없음)
