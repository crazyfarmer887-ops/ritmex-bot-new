# 거래 지연 버그 수정 문서

## 개요

이 문서는 재현 가능하고 예측 가능한 거래 지연 버그들을 식별하고 수정한 내용을 설명합니다.

## 발견된 버그들

### 버그 #1: 주문 생성 후 락 미해제로 인한 3초 지연

**위치**: `src/core/order-coordinator.ts`

**문제점**:
모든 주문 생성 함수들(`placeOrder`, `placeMarketOrder`, `placeStopLossOrder`, `placeTrailingStopOrder`, `marketClose`)이 주문 생성 전에 락을 걸지만, 성공적인 주문 생성 후에는 락을 해제하지 않았습니다. 대신 3000ms 타임아웃에 의존하여 자동으로 락이 해제되기를 기다렸습니다.

**영향**:
- 같은 타입의 주문을 연속으로 생성할 때 최대 3초의 불필요한 지연 발생
- 빠른 시장 상황에서 주문 실행이 지연되어 기회 손실 가능
- 전략의 반응 속도 저하

**재현 방법**:
1. `placeOrder`로 LIMIT 주문 생성
2. 즉시 같은 타입의 다른 LIMIT 주문 생성 시도
3. 두 번째 주문은 첫 번째 주문의 타임아웃(3초)까지 대기

**수정 내용**:
각 주문 생성 함수에서 성공적인 주문 생성 직후 `unlockOperating()`을 호출하도록 수정:

```typescript
// 수정 전
lockOperating(locks, timers, pendings, type, log);
try {
  const order = await adapter.createOrder(params);
  pendings[type] = String(order.orderId);
  log("order", `...`);
  return order; // 락이 해제되지 않음
} catch (err) {
  unlockOperating(locks, timers, pendings, type);
  // ...
}

// 수정 후
lockOperating(locks, timers, pendings, type, log);
try {
  const order = await adapter.createOrder(params);
  pendings[type] = String(order.orderId);
  log("order", `...`);
  // 성공 시 즉시 락 해제
  unlockOperating(locks, timers, pendings, type);
  return order;
} catch (err) {
  unlockOperating(locks, timers, pendings, type);
  // ...
}
```

**수정된 함수들**:
- `placeOrder()` - LIMIT 주문
- `placeMarketOrder()` - MARKET 주문
- `placeStopLossOrder()` - STOP_LOSS 주문
- `placeTrailingStopOrder()` - TRAILING_STOP 주문
- `marketClose()` - 시장가 평仓

**기대 효과**:
- 주문 생성 후 즉시 다음 주문 생성 가능 (3초 → 0초)
- 전략의 반응 속도 향상
- 빠른 시장 상황에서의 기회 손실 감소

## 추가 고려사항

### 기존 안전장치 유지

수정 후에도 다음 안전장치들은 그대로 유지됩니다:

1. **타임아웃 락 (3000ms)**: 주문 생성이 실패하거나 예외가 발생했을 때를 대비한 안전장치로 계속 작동합니다.

2. **웹소켓 기반 락 해제**: 전략 엔진들이 주문 상태 업데이트를 받으면 최종 상태(FILLED, CANCELED 등)에서 락을 해제하는 로직도 그대로 작동합니다.

3. **중복 방지 로직**: `deduplicateOrders()` 함수를 통한 중복 주문 방지 로직은 변경되지 않았습니다.

### 락의 목적

락(`lockOperating`)의 주요 목적은:
- 동시에 같은 타입의 주문을 여러 개 생성하는 것을 방지
- 주문 생성 중 발생할 수 있는 경쟁 조건 방지

주문이 성공적으로 생성된 후에는 락을 유지할 필요가 없으므로, 즉시 해제하는 것이 올바른 동작입니다.

## 테스트 권장사항

다음 시나리오들을 테스트하는 것을 권장합니다:

1. **연속 주문 생성**: 같은 타입의 주문을 빠르게 연속으로 생성하여 지연 없이 처리되는지 확인
2. **에러 처리**: 주문 생성 실패 시 락이 올바르게 해제되는지 확인
3. **동시성**: 여러 전략이 동시에 실행될 때 락이 올바르게 작동하는지 확인

## 관련 파일

- `src/core/order-coordinator.ts` - 주문 생성 및 락 관리 로직
- `src/strategy/grid-engine.ts` - 그리드 전략 엔진
- `src/strategy/maker-engine.ts` - 메이커 전략 엔진
- `src/strategy/trend-engine.ts` - 트렌드 전략 엔진
- `src/strategy/offset-maker-engine.ts` - 오프셋 메이커 전략 엔진
