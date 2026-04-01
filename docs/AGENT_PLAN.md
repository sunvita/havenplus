# Haven Plus — AI 에이전트 시스템 설계

**최종 업데이트:** 2026-04-02
**상태:** 설계 완료, 구현 미시작

---

## 개요

Polsia 모델 참고. 물리적 서비스(현장 작업)는 사람이 담당하고,
운영 레이어 전체(스케줄링·고객지원·리포팅·마케팅·개발)를 AI 에이전트로 자동화.

**목표:** 운영 업무의 80% AI 처리, Sunny·Jaden은 방향 설정과 승인에 집중.

---

## 경영진 구조

```
         ┌─────────────────────┐
         │    CEO 에이전트       │  (ai-ceo-daily)
         │  매일 KPI 분석·태스크  │
         └────────┬────────────┘
                  │ 보고 + 승인 요청
        ┌─────────┴──────────┐
        │                    │
   ┌────▼────┐          ┌────▼────┐
   │  Sunny  │          │  Jaden  │
   │   MD    │          │   FD    │
   └────┬────┘          └────┬────┘
        │                    │
   비즈니스 운영            현장 운영
```

### Sunny (MD) 담당 에이전트
- ai-support-agent (고객지원 + 챗봇)
- ai-dev-agent (오류감지·수정·배포)
- ai-social-agent (소셜미디어)
- ai-conversion-agent (전환 이메일)

### Jaden (FD) 담당 에이전트
- ai-scheduling-agent (방문 배정)
- ai-report-generator (SR·MCR)

---

## 에이전트 상세 설계

### 1. ai-ceo-daily

**역할:** 단순 리포팅이 아닌 능동적 경영 판단 + 태스크 생성

**트리거:** pg_cron `0 20 * * *` UTC (Perth 자정)

**6단계 루프:**
1. 전체 KPI 스캔 (구독·결제·방문·SH·전환율)
2. 이상 감지 + 태스크 생성 → `admin_tasks` 기록
3. 문제별 대응 방안 2~3가지 생성 (예상 효과·리스크·실행 난이도 포함)
4. 담당 오너에게 이메일 + 대시보드 알림 (추가 인풋 필요 시 명시적 질문)
5. 승인 수신 → 해당 에이전트에 태스크 위임
6. 실행 후 효과 측정 → 다음 브리핑에 결과 포함

**브리핑 구조:**
- 공통 섹션: 전체 KPI 요약
- Sunny 섹션: 고객지원·결제·마케팅 현황 + 승인 요청
- Jaden 섹션: 방문·워커·SH 현황 + 승인 요청

**태스크 유형 예시:**
| 감지 | 심각도 | 담당 | 제안 |
|------|--------|------|------|
| 신규 가입 3주 연속 감소 | 긴급 | Sunny | 마케팅 강화 or 프로모션 |
| MCR 미기재율 34% | 일반 | Jaden | 필수 항목 강제화 + 워커 교육 |
| 같은 suburb 방문 분산 | 장기 | Jaden | 클러스터링 스케줄 최적화 |
| 결제 실패 D+7 고객 3명 | 긴급 | Sunny | 개인화 리마인더 발송 |

**DB:** `admin_tasks`, `admin_approvals`

---

### 2. ai-support-agent

**역할:** 고객 문의 자율 처리 (이메일 + 챗봇 2채널)

**트리거:**
- 이메일 수신 (Resend inbound webhook)
- 챗봇 메시지 (dashboard.html, profile.html 위젯)

**자율 처리 범위:**
- 일반 문의, FAQ 응답
- SH 잔량·방문 일정 확인
- 소액 크레딧 지급 ($50 이하)
- 방문 재조정 안내 (실제 변경은 ai-scheduling-agent)

**에스컬레이션 조건:**
- 환불 $100 초과 → Sunny 승인 요청
- 법적 클레임·계약 분쟁 → Sunny 즉시 알림
- 워커 관련 불만 → Jaden 알림

**오류 감지 → ai-dev-agent 연결:**
- "결제가 안 돼요", "이메일이 안 왔어요" 등 기술적 오류 언급 시
- → `bug_reports` 테이블 자동 기록
- → ai-dev-agent 트리거

**챗봇 위젯:**
- 임베드 위치: dashboard.html, profile.html
- 대화 이력: `chat_sessions` 테이블 저장
- 고객 컨텍스트 자동 로드 (구독 현황, 최근 방문, SH 잔량)

**모델:** Claude Opus 4.6 (고객 응대 품질 최우선)

**DB:** `chat_sessions` (신규), `bug_reports` (신규), `notifications`

---

### 3. ai-dev-agent

**역할:** 오류 감지 → 검증 → 수정 → 테스트 → 배포 (Sunny 승인 연동)

**트리거:**
- `bug_reports` 테이블 신규 레코드
- ai-ceo-daily의 시스템 이상 감지
- 수동 호출

**5단계 파이프라인:**

```
[1] 오류 수신 (bug_reports)
      ↓
[2] 검증 (재현 시도 + 로그 분석 + 코드 리뷰)
      ↓
[3] 수정 (GitHub API로 코드 변경)
      ↓
[4] 테스트 (Supabase 스테이징 또는 샌드박스 실행)
      ↓
[5] 배포 (Supabase Management API)
         → Low: 자율 배포 후 Sunny 알림
         → Mid: Sunny 승인 후 배포
         → High/결제영역: 항상 Sunny 승인
```

**심각도 분류:**
| 심각도 | 기준 | 배포 |
|--------|------|------|
| Low | UI 텍스트·스타일, 알림 문구 | 자율 배포 |
| Mid | 비결제 로직 버그, 알림 미발송 | Sunny 단독 승인 |
| High | 결제·인증·데이터 손실 위험 | Sunny 필수 승인 |

**자율 배포 금지 영역 (항상 Sunny 승인):**
- stripe-webhook
- create-checkout-session
- 인증 로직
- DB 스키마 변경

**주요 오류 패턴:** `docs/ai-dev-agent/ERROR_PATTERNS.md` 참조

**도구:** GitHub API, Supabase Management API, Claude Opus 4.6

**DB:** `bug_reports` (신규), `admin_approvals`

---

### 4. ai-scheduling-agent

**역할:** 방문 배정 최적화, 워커 매칭

**트리거:**
- 신규 구독 확정 (stripe-webhook 후)
- 노쇼 감지 (cleaning_schedule 모니터링)
- Jaden 수동 호출

**기능:**
- 워커 area 매칭 (`enhancedAreaMatch()` 로직 활용)
- 노쇼 3회 누적 → 구독 일시정지 처리 (Jaden 알림)
- suburb 클러스터링으로 이동거리 최적화 제안
- 48h 노쇼 → 대체 일정 자동 제안 → 고객 확인

**연계:** `daily-reminder`가 전날 알림 담당 (이 에이전트는 배정 로직만)

**승인:** 대규모 스케줄 변경은 Jaden 단독 승인

**DB:** `cleaning_schedule`, `workers`, `properties`

---

### 5. ai-report-generator

**역할:** 방문 완료 후 SR·MCR 자동 초안 생성

**트리거:** `cleaning_schedule.status` → 'completed' 업데이트

**출력물:**
- SR (Service Report): 작업 요약, 사진 첨부, 소요 시간, SH 차감 기록
- MCR (Maintenance Checkup Report): 점검 항목별 상태, 권고사항

**워크플로우:**
```
작업 완료 (haventeam.html)
  → 워커 메모 + 사진 (job-photos)
  → ai-report-generator 트리거
  → Claude가 SR·MCR 초안 생성
  → send-notification → 고객 이메일 + 인앱 알림
```

**DB:** `cleaning_schedule`, `service_requests`, Supabase Storage

---

### 6. ai-social-agent

**역할:** Instagram·Facebook 자율 운영

**트리거:** 주 1회 월요일 오전 + SR 완료 이벤트

**콘텐츠 소스:**
- SR 완료 사진 (Supabase Storage) → Before/After 포스트
- MCR 데모 스크린샷
- 대시보드 UX 화면

**포스팅 전략:**
- 영어·한국어 이중 포스팅
- Perth 계절·지역 이벤트 반영
- 댓글 1차 자동 응답

**API:** Instagram Graph API, Facebook Pages API (Phase 2, 별도 세팅 필요)

**승인:** Sunny 마케팅 예산 집행 승인 필요

---

### 7. ai-conversion-agent

**역할:** 이메일 시퀀스로 가입·전환 유도

**트리거 4가지:**
1. 신규 가입 D+1 → 온보딩 이메일
2. SH 미사용 30일 → 활용 독려
3. 구독 갱신 D-7 → 업그레이드 제안
4. 결제 실패 복구 직후 → 감사 + 서비스 안내

**개인화 기준:**
- 플랜 티어, SH 잔량, 방문 이력, 마지막 SR 내용

**도구:** Resend (기존 인프라)

**DB:** `profiles`, `subscriptions`, `sh_balance`, `cleaning_schedule`

---

## 신규 DB 테이블

### admin_tasks
```sql
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
type text  -- 'revenue_alert' | 'sop_issue' | 'scheduling' | 'payment_failure' | ...
severity text  -- 'urgent' | 'normal' | 'longterm'
owner text  -- 'sunny' | 'jaden' | 'both'
status text  -- 'detected' | 'proposed' | 'approved' | 'executing' | 'done'
title text
description text
proposals jsonb  -- [{option, effect, risk, effort}]
selected_proposal int
created_at timestamptz DEFAULT now()
resolved_at timestamptz
```

### admin_approvals
```sql
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
task_id uuid REFERENCES admin_tasks(id)
requester text  -- 에이전트 함수명
owner_target text  -- 'sunny' | 'jaden' | 'both'
action text
payload jsonb
status text  -- 'pending' | 'approved' | 'rejected' | 'modified'
decided_by text
decided_at timestamptz
comment text
expires_at timestamptz  -- 타임아웃 기준
```

### chat_sessions
```sql
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
user_id uuid REFERENCES profiles(id)
channel text  -- 'chatbot' | 'email'
messages jsonb  -- [{role, content, timestamp}]
resolved boolean DEFAULT false
bug_reported boolean DEFAULT false
created_at timestamptz DEFAULT now()
updated_at timestamptz DEFAULT now()
```

### bug_reports
```sql
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
source text  -- 'chatbot' | 'email' | 'ceo_agent' | 'manual'
chat_session_id uuid REFERENCES chat_sessions(id)
description text
error_type text  -- 'payment' | 'notification' | 'ui' | 'data' | 'auth'
severity text  -- 'low' | 'mid' | 'high'
status text  -- 'new' | 'investigating' | 'fixing' | 'testing' | 'deployed' | 'closed'
related_function text  -- 'stripe-webhook' | 'send-notification' | ...
fix_description text
deployed_at timestamptz
created_at timestamptz DEFAULT now()
```

---

## 구현 우선순위

| 순서 | 작업 | 담당 오너 | 예상 소요 |
|------|------|-----------|-----------|
| 1 | DB 테이블 4개 생성 | Sunny | 1일 |
| 2 | ai-ceo-daily 함수 | Sunny | 2일 |
| 3 | 대시보드 승인 UI | Sunny | 1일 |
| 4 | ai-support-agent + 챗봇 | Sunny | 2일 |
| 5 | ai-dev-agent | Sunny | 3일 |
| 6 | ai-scheduling-agent | Jaden | 2일 |
| 7 | ai-report-generator | Jaden | 1일 |
| 8 | ai-social-agent | Sunny | 3일 (API 세팅 포함) |
| 9 | ai-conversion-agent | Sunny | 1일 |
