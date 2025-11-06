# 거래 지연 버그 수정 문서

이 문서는 재현 가능하고 예측 가능한 거래 지연 버그들을 수정한 내용을 설명합니다.

## 수정된 버그 목록

### 1. Order Coordinator 타임아웃 버그 (Race Condition)

**문제점:**
- `lockOperating` 함수의 기본 타임아웃이 3000ms로 너무 짧았습니다
- 네트워크 지연이나 거래소 응답이 느릴 경우, 주문 작업이 완료되기 전에 자동으로 잠금이 해제되어 race condition이 발생할 수 있었습니다
- 이로 인해 동일한 주문이 중복으로 생성되거나, 주문 상태 추적이 어긋날 수 있었습니다

**수정 내용:**
- 기본 타임아웃을 3000ms에서 10000ms로 증가
- 파일: `src/core/order-coordinator.ts` (line 54)

**영향:**
- 주문 작업이 완료될 때까지 충분한 시간을 확보하여 race condition 방지
- 네트워크 지연이 있는 환경에서도 안정적인 주문 처리

---

### 2. Grid Engine 중복 LIMIT 체크 제거

**문제점:**
- `syncGridSimple` 함수에서 `this.pendings["LIMIT"]` 체크가 두 번 연속으로 수행되었습니다 (line 910-912, 923-925)
- 불필요한 중복 체크로 인해 코드 가독성이 떨어지고, 미세한 성능 저하가 있었습니다

**수정 내용:**
- 중복된 두 번째 체크 제거
- 파일: `src/strategy/grid-engine.ts` (line 910-922)

**영향:**
- 코드 간소화 및 가독성 향상
- 불필요한 조건 체크 제거

---

### 3. Grid Engine Cooldown 시간 최적화

**문제점:**
- `LIMIT_COOLDOWN_MS`가 3000ms로 설정되어 있어, 정당한 재시도도 불필요하게 지연되었습니다
- `PENDING_TTL_MS`가 10000ms로 너무 길어, 주문 키 억제 시간이 과도했습니다
- `awaitingByLevel` 타임아웃이 8000ms로 길어, 주문 분류 지연이 발생했습니다

**수정 내용:**
- `LIMIT_COOLDOWN_MS`: 3000ms → 1000ms
- `PENDING_TTL_MS`: 10000ms → 5000ms
- `awaitingByLevel` 타임아웃: 8000ms → 3000ms
- 파일: `src/strategy/grid-engine.ts` (line 104, 148, 729)

**영향:**
- 주문 재시도 지연 감소 (3초 → 1초)
- 주문 키 억제 시간 단축 (10초 → 5초)
- 주문 분류 대기 시간 단축 (8초 → 3초)
- 전체적으로 더 빠른 주문 반응 속도

---

### 4. Post-Close Cooldown 시간 최적화

**문제점:**
- 모든 전략 엔진에서 포지션 종료 후 새 진입을 막는 cooldown이 10초로 설정되어 있었습니다
- 이는 불필요하게 긴 대기 시간으로, 시장 기회를 놓칠 수 있었습니다
- 실제로는 웹소켓 지연을 고려해 2-3초면 충분합니다

**수정 내용:**
- Post-close cooldown: 10000ms → 2000ms
- 수정된 파일:
  - `src/strategy/grid-engine.ts` (line 242)
  - `src/strategy/maker-engine.ts` (line 168)
  - `src/strategy/offset-maker-engine.ts` (line 154)
  - `src/strategy/trend-engine.ts` (line 182)

**영향:**
- 포지션 종료 후 새 진입까지의 대기 시간 단축 (10초 → 2초)
- 시장 기회 포착 속도 향상
- 웹소켓 지연을 고려한 최적화된 대기 시간

---

### 5. Rate Limit Recovery 시간 최적화

**문제점:**
- Rate limit 발생 시 pause 시간이 30초, recovery 시간이 60초로 설정되어 있었습니다
- 이는 과도하게 긴 대기 시간으로, 실제로는 더 짧은 시간으로도 충분히 복구 가능합니다

**수정 내용:**
- `DEFAULT_PAUSE_MS`: 30000ms → 15000ms
- `DEFAULT_RECOVERY_MS`: 60000ms → 30000ms
- 파일: `src/core/lib/rate-limit.ts` (line 7-8)

**영향:**
- Rate limit 발생 시 대기 시간 단축 (30초 → 15초)
- 정상 상태 복구 시간 단축 (60초 → 30초)
- 전체적으로 더 빠른 거래 재개

---

### 6. Startup Order Reset 블로킹 문제 해결

**문제점:**
- Grid engine의 startup order reset이 완료될 때까지 무한정 대기할 수 있었습니다
- 네트워크 문제나 거래소 응답 지연 시 영구적으로 블로킹될 수 있었습니다

**수정 내용:**
- `syncGridSimple`와 `tryHandleInitialClose`에 5초 타임아웃 추가
- `Promise.race`를 사용하여 startup cancel promise와 timeout promise 중 먼저 완료되는 것을 기다림
- 타임아웃 발생 시 경고 로그를 남기고 계속 진행
- 파일: `src/strategy/grid-engine.ts` (line 535-551, 1285-1290)

**영향:**
- Startup 단계에서 무한 블로킹 방지
- 네트워크 문제 시에도 5초 후 자동으로 진행
- 더 안정적인 시작 프로세스

---

## 전체적인 개선 효과

### 지연 시간 감소 요약

| 항목 | 수정 전 | 수정 후 | 개선 |
|------|---------|---------|------|
| Order lock timeout | 3초 | 10초 | 안정성 향상 |
| Limit cooldown | 3초 | 1초 | **67% 감소** |
| Pending TTL | 10초 | 5초 | **50% 감소** |
| Awaiting timeout | 8초 | 3초 | **62.5% 감소** |
| Post-close cooldown | 10초 | 2초 | **80% 감소** |
| Rate limit pause | 30초 | 15초 | **50% 감소** |
| Rate limit recovery | 60초 | 30초 | **50% 감소** |

### 예측 가능성 향상

1. **타임아웃 기반 블로킹 방지**: 모든 대기 작업에 타임아웃을 추가하여 무한 대기 방지
2. **명확한 지연 시간**: 각 cooldown과 timeout 값이 명확히 정의되어 예측 가능한 동작
3. **로그 개선**: 타임아웃 발생 시 경고 로그를 남겨 디버깅 용이

### 안정성 향상

1. **Race condition 방지**: Order coordinator 타임아웃 증가로 주문 중복 방지
2. **블로킹 방지**: Startup 단계에서 무한 대기 방지
3. **복구 시간 단축**: Rate limit 발생 시 더 빠른 복구

---

## 테스트 권장 사항

다음 시나리오에서 테스트를 권장합니다:

1. **네트워크 지연 환경**: 느린 네트워크에서 주문 처리 안정성 확인
2. **Rate limit 시뮬레이션**: Rate limit 발생 시 복구 시간 확인
3. **빠른 포지션 전환**: 포지션 종료 후 즉시 새 진입 시도
4. **Startup 시나리오**: 다양한 네트워크 조건에서 startup 프로세스 확인

---

## 추가 고려 사항

### 향후 개선 가능 사항

1. **동적 타임아웃 조정**: 네트워크 상태에 따라 타임아웃을 동적으로 조정
2. **Cooldown 최적화**: 시장 변동성에 따라 cooldown 시간을 조정
3. **모니터링 강화**: 각 지연 시간에 대한 메트릭 수집 및 알림

### 주의 사항

- Post-close cooldown을 너무 짧게 설정하면 웹소켓 지연으로 인한 중복 주문이 발생할 수 있습니다
- Rate limit recovery 시간을 너무 짧게 설정하면 연속적인 rate limit이 발생할 수 있습니다
- 현재 설정값은 대부분의 거래소와 네트워크 환경에서 안정적으로 동작하도록 최적화되었습니다

---

## 변경 이력

- 2024: 초기 버그 수정 및 문서화
  - Order coordinator timeout 증가
  - Grid engine cooldown 최적화
  - Post-close cooldown 단축
  - Rate limit recovery 시간 단축
  - Startup 블로킹 방지
