# Haven Plus — 승인 권한 매트릭스

**최종 업데이트:** 2026-04-02

---

## 경영진

| 역할 | 이름 | 담당 영역 |
|------|------|-----------|
| Managing Director (MD) | Sunny | 비즈니스 운영, 결제, 마케팅, 개발 |
| Field Director (FD) | Jaden | 현장 인력, 스케줄링, SOP, 워커 관리 |

**연락처:**
- Sunny: hi@havenpluscare.com (어드민 이메일)
- Jaden: jinhyunmail@gmail.com (어드민 이메일)

---

## 승인 매트릭스

### 자율 실행 (승인 불필요)
AI 에이전트가 즉시 실행, 이후 브리핑에 포함.

| 항목 | 담당 에이전트 |
|------|--------------|
| 챗봇 일반 응답 | ai-support-agent |
| SR·MCR 초안 생성 | ai-report-generator |
| 소셜미디어 예약 포스팅 | ai-social-agent |
| Low 심각도 버그 배포 | ai-dev-agent |
| 방문 전날 리마인더 발송 | daily-reminder |
| SH 잔량 경고 알림 | ai-ceo-daily |
| 태스크 제안 생성 | ai-ceo-daily |
| 소액 크레딧 지급 ($50 이하) | ai-support-agent |

---

### Sunny 단독 승인 (24h 이내)

| 항목 | 트리거 | 타임아웃 |
|------|--------|---------|
| 환불 처리 ($100 초과) | ai-support-agent | 24h |
| Mid 심각도 버그 배포 | ai-dev-agent | 24h |
| High 심각도 버그 배포 | ai-dev-agent | 즉시 알림, 타임아웃 없음 |
| 마케팅 예산 집행 | ai-social-agent | 24h |
| stripe-webhook 코드 변경 | ai-dev-agent | 즉시 알림 |
| create-checkout-session 변경 | ai-dev-agent | 즉시 알림 |
| DB 스키마 변경 | ai-dev-agent | 즉시 알림 |

---

### Jaden 단독 승인 (24h 이내)

| 항목 | 트리거 | 타임아웃 |
|------|--------|---------|
| 노쇼 3회 누적 처리 (구독 일시정지) | ai-scheduling-agent | 24h |
| 워커 등록·제거 | ai-ceo-daily | 24h |
| SH 정책 예외 승인 | ai-support-agent | 24h |
| 대규모 스케줄 변경 | ai-scheduling-agent | 24h |
| 워커 교육 프로그램 신설 | ai-ceo-daily | 48h |

---

### 공동 승인 — Sunny + Jaden 모두 (72h 이내)

| 항목 | 비고 |
|------|------|
| 가격 정책 변경 | 플랜 가격·SH 단가 변경 |
| 플랜 구조 변경 | Essential/Smart/Premium 구조 변경 |
| 서비스 일시 중단 | 전체 또는 특정 지역 서비스 중단 |

**72h 타임아웃 규칙:** 72시간 내 양쪽 합의 없으면 보수적 기본값(현상 유지) 실행.

---

## 승인 채널

### 이메일 (기본)
- CEO 에이전트가 담당 오너에게 승인 요청 이메일 발송
- 제목 형식: `[Haven Plus 승인 요청] {태스크 제목}`
- 본문: 상황 설명 + 제안 내용 + 예상 효과 + 리스크
- 답장: "승인" 또는 "거절" (코멘트 선택)

### 대시보드 (보조)
- profile.html 어드민 섹션에 "승인 대기" 섹션 추가 (구현 예정)
- 원클릭 승인·거절·코멘트 입력
- 결정 이력 로그 보관 (`admin_approvals` 테이블)

---

## admin_approvals 테이블 상태값

| status | 의미 |
|--------|------|
| `pending` | 승인 대기 중 |
| `approved` | 승인됨 → 에이전트 실행 |
| `rejected` | 거절됨 → 에이전트 중단 |
| `modified` | 수정 요청 → 에이전트 재제안 |
| `expired` | 타임아웃 → 보수적 기본값 실행 |
