# Haven Plus — 사이트 구조 및 기능 명세

**최종 업데이트:** 2026-04-02
**버전:** 현재 프로덕션 기준

---

## 1. 전체 아키텍처

```
┌─────────────────────────────────────────────────────┐
│                GitHub Pages (정적 호스팅)              │
│  index.html · plans.html · dashboard.html           │
│  profile.html · haventeam.html                      │
└──────────────────────┬──────────────────────────────┘
                       │ Supabase JS SDK
┌──────────────────────▼──────────────────────────────┐
│                   Supabase                          │
│  PostgreSQL DB · Auth · Storage · Edge Functions    │
│  Realtime · pg_cron                                 │
└──────┬───────────────┬───────────────┬──────────────┘
       │               │               │
  ┌────▼────┐    ┌─────▼─────┐   ┌────▼────┐
  │ Stripe  │    │  Resend   │   │ Storage │
  │ 결제·구독│    │  이메일    │   │ 사진파일 │
  └─────────┘    └───────────┘   └─────────┘
```

---

## 2. 페이지별 구조 및 기능

### 2.1 index.html — 랜딩 페이지

**접근:** 공개 | **언어:** EN/KO 이중언어 토글

**섹션 구성:**
- Hero — 헤드라인, 서브타이틀, CTA 버튼 (Sign Up / View Plans)
- Features — 서비스 특징 카드 (청소·MCR·SR·AI 관리)
- Pricing — Essential($55) / Smart($75) / Premium($150) 플랜 카드
  - Monthly/Annual 토글 (Annual 할인)
  - What's included 접이식 섹션
  - 구독 CTA → plans.html로 이동
- Footer CTA — 가입 유도

**주요 기능:**
- `applyLang()` — EN/KO 전환, localStorage 저장
- 플랜 가격 실시간 업데이트 (billingCycle 토글 연동)
- 서비스 계약서 팝업 (v2.1, EN/KO)

---

### 2.2 plans.html — 플랜 선택 + 결제

**접근:** 공개 (결제는 로그인 필요)

**기능:**
- 플랜 선택 (Essential / Smart / Premium)
- SH 번들 추가 구매 (1SH $99 / 4SH $340 / 8SH $640)
- Stripe Checkout 세션 생성 → `create-checkout-session` 호출
- 업그레이드 경로: 기존 구독자 → Stripe 구독 즉시 업데이트 (isUpgrade: true)
- 결제 완료 후 리다이렉트: `?payment=success` or `?sh_success=true`
- 계약 동의 체크박스 (기존 구독자 자동 체크)

**결제 플로우:**
```
사용자 플랜 선택
  → create-checkout-session 호출
  → [신규] Stripe Checkout 세션 생성 → Stripe 결제 페이지
  → [업그레이드] 기존 구독 즉시 업데이트 → plans.html 리다이렉트
  → stripe-webhook 수신 → subscriptions 업데이트 → send-notification
```

---

### 2.3 dashboard.html — 고객 대시보드

**접근:** 로그인 필요 (customer role)

**주요 섹션:**
- 온보딩 스텝 카드 (부동산 등록 → 플랜 선택 → 스케줄 설정)
- 부동산 카드 (주소, 플랜, 청소시간 진행바, SH 잔량)
- Service History 슬라이드 패널 (방문별 SR 사진·요약)
- 알림 벨 (notifications 테이블 실시간)
- 서비스 요청(Book a Job) 모달

**부동산 관리:**
- 부동산 추가·수정 (주소, 타입, 침실·욕실 수, 접근 방법)
- Google Places Autocomplete 연동
- 멀티 프로퍼티 지원 (프로퍼티별 독립 구독)

**스케줄 설정:**
- 선호 요일·시간대 설정
- 시작 월 선택 (2일 이후 날짜만 허용, Perth timezone)
- 리스케줄 요청 → 어드민 승인 필요

**Book a Job (Service Request):**
- 작업 유형, 설명, 선호 날짜·시간(30분 그리드)
- 사진 첨부 (Supabase Storage → `request-photos`)
- 긴급도 선택 (Standard: 2일 이후)

---

### 2.4 profile.html — 계정 설정 + 어드민 패널

**접근:** 로그인 필요 | 어드민 섹션은 admin role만

#### 고객 섹션 (사이드바)
| 섹션 | 기능 |
|------|------|
| Personal | 이름, 이메일, 전화번호 수정 |
| Notifications | 알림 목록 (타입 배지: Cleaning/Service/Payment) |
| Subscription | 플랜 현황, 다음 결제일, 업그레이드 CTA |
| Payment | Stripe 포털 리다이렉트 |
| Security | 비밀번호 변경, Manual Override PIN 관리 |

#### 어드민 섹션 (admin role만 표시)
| 섹션 | 기능 |
|------|------|
| Dashboard | KPI 카드 (구독 수·결제 이슈·오버듀·이번달 매출) |
| Cleanings | 전체 방문 일정 관리, 워커 배정, 상태 변경 |
| Calendar | 방문 캘린더 뷰 |
| Job Requests | 서비스 요청 목록, 승인·배정·완료 처리 |
| Workers | 워커 목록·등록·수정 |
| Subscribers | 구독자 목록 |
| Properties | 부동산 전체 관리 |
| Customers | 고객 목록 |
| Hours Log | SH 사용 이력 |
| ⚠ Manual Override | 구독·SH 수동 조정 (4자리 PIN 필요) |

---

### 2.5 haventeam.html — 워커 앱 (PWA)

**접근:** 워커 계정 로그인 | PWA 설치 가능 (manifest-team.json)

**탭 구성:**
| 탭 | 기능 |
|----|------|
| Home (Jobs) | 오늘·이번달 배정 작업 목록, 상태 필터 |
| Training | SOP·교육 자료 (현재 기본 구조) |
| Me | 개인 완료 통계, 이번달 수익, 평점 |

**작업 처리 플로우:**
```
배정된 작업 확인 → 시작 → 작업 완료 처리
  → 실제 시간 입력 → 사진 업로드 (Supabase Storage → job-photos)
  → sh_balance 차감 → SR 생성 → 고객 알림
```

**멀티워커 지원:**
- 동일 작업에 여러 워커 배정 가능 (`assigned_workers` 배열)
- 완료 시 시간 분배 계산
- Realtime 동기화 (한 워커가 완료하면 다른 워커에게 반영)

---

## 3. Edge Functions

### stripe-webhook
**트리거:** Stripe webhook 이벤트
**처리 이벤트:**
- `checkout.session.completed` → subscriptions upsert + SH 추가
- `invoice.payment_succeeded` → 갱신 처리 (cleaning_hours 리셋)
- `invoice.payment_failed` → status: past_due
- `customer.subscription.deleted` → status: cancelled

**Price ID 매핑:**
```
Essential monthly: price_1TAQ8eETHoBrxXOuBJykRrxO
Essential annual:  price_1TByOdETHoBrxXOuP5mhiRTy
Smart monthly:     price_1TAQ9ZETHoBrxXOuK0JnkQeb
Smart annual:      price_1TByPYETHoBrxXOuSOpUL7pN
Premium monthly:   price_1TAQAjETHoBrxXOuyhs48ER7
Premium annual:    price_1TByPwETHoBrxXOuwNJ9BDuH
SH 1:              price_1TAQDNETHoBrxXOu9gW5qdjC
SH 4-pack:         price_1TAQDtETHoBrxXOuCpFDkNCL
SH 8-pack:         price_1TAQEMETHoBrxXOuJ1lTGqCb
```

### send-notification
**호출처:** stripe-webhook, profile.html, haventeam.html, daily-reminder
**알림 타입:** scheduled, completed, reminder, payment_received, new_request
**수신자 타입:** customer, worker, admin (direct_emails)
**어드민 이메일:** hi@havenpluscare.com, jinhyunmail@gmail.com

### daily-reminder
**트리거:** pg_cron `0 4 * * *` UTC (Perth 정오)
**동작:** 내일 날짜 cleaning_schedule (scheduled/confirmed) 조회 → 고객 + 워커 리마인더 발송

### create-checkout-session
**입력:** planKey, billingCycle, propertyId, userId, userEmail, successParam, isUpgrade
**신규 구독:** Stripe Checkout 세션 생성
**업그레이드:** 기존 stripe_subscription_id로 즉시 플랜 변경

### create-portal-session
**동작:** Stripe Customer Portal 세션 생성 → 결제 수단·구독 관리

---

## 4. 데이터 플로우

### 신규 구독 플로우
```
plans.html → create-checkout-session
  → Stripe Checkout (사용자 결제)
  → stripe-webhook (checkout.session.completed)
    → subscriptions 생성 (plan_type, cleaning_hours_total, sh_hours_total)
    → payments 기록
    → send-notification (고객 + 어드민)
  → dashboard.html 리다이렉트
```

### 방문 완료 플로우
```
haventeam.html (완료 처리)
  → cleaning_schedule status: completed
  → sh_balance 차감
  → service_requests SR 생성
  → 사진 → Supabase Storage (job-photos)
  → send-notification (completed) → 고객 이메일 + 인앱 알림
```

### 결제 실패 플로우
```
Stripe 자동 재시도 (D+3, D+7, D+14, D+21)
  → stripe-webhook (invoice.payment_failed)
    → subscriptions status: past_due/suspended
  → D+30 → status: cancelled
```

---

## 5. 인증 구조

- Supabase Auth (이메일·비밀번호)
- `profiles.role` 컬럼으로 권한 분기: `customer` / `worker` / `admin`
- 어드민 패널: profile.html에서 role 확인 후 섹션 표시
- Manual Override: 추가 4자리 PIN 인증 (admin_settings 테이블)

---

## 6. 스토리지 구조

```
Supabase Storage
├── request-photos/   ← Book a Job 첨부 사진
└── job-photos/       ← 워커 작업 완료 사진 (SR용)
```
