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
```

Docker 없이도 배포 가능. Supabase CLI 로그인 상태 필요.

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
