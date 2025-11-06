import { describe, expect, it } from "vitest";

import { SessionVolumeTracker } from "../src/strategy/common/session-volume";
import type { PositionSnapshot } from "../src/utils/strategy";
import type { AsterOrder } from "../src/exchanges/types";

function makeOrder(overrides: Partial<AsterOrder> = {}): AsterOrder {
  return {
    orderId: overrides.orderId ?? 1,
    clientOrderId: overrides.clientOrderId ?? "test",
    symbol: overrides.symbol ?? "BTCUSDT",
    side: overrides.side ?? "BUY",
    type: overrides.type ?? "LIMIT",
    status: overrides.status ?? "NEW",
    price: overrides.price ?? "1",
    origQty: overrides.origQty ?? "1",
    executedQty: overrides.executedQty ?? "0",
    stopPrice: overrides.stopPrice ?? "0",
    time: overrides.time ?? 0,
    updateTime: overrides.updateTime ?? 0,
    reduceOnly: overrides.reduceOnly ?? false,
    closePosition: overrides.closePosition ?? false,
    workingType: overrides.workingType,
    activationPrice: overrides.activationPrice,
    avgPrice: overrides.avgPrice,
    cumQuote: overrides.cumQuote,
    origType: overrides.origType,
    positionSide: overrides.positionSide,
    timeInForce: overrides.timeInForce,
    activatePrice: overrides.activatePrice,
    priceRate: overrides.priceRate,
    priceProtect: overrides.priceProtect,
  };
}

const basePosition: PositionSnapshot = {
  positionAmt: 0,
  entryPrice: 0,
  unrealizedProfit: 0,
  markPrice: null,
};

describe("SessionVolumeTracker", () => {
  it("falls back to position deltas before order stream is active", () => {
    const tracker = new SessionVolumeTracker();

    tracker.update(basePosition, null);
    tracker.update({ ...basePosition, positionAmt: 1 }, 100);
    tracker.update({ ...basePosition, positionAmt: 2 }, 110);

    expect(tracker.value).toBeCloseTo(210);
  });

  it("tracks executed quote volume once order stream is observed", () => {
    const tracker = new SessionVolumeTracker();

    tracker.update(basePosition, null);

    tracker.observeOrders([
      makeOrder({ orderId: 1, cumQuote: "0" }),
    ], "BTCUSDT");
    expect(tracker.value).toBe(0);

    tracker.observeOrders([
      makeOrder({ orderId: 1, cumQuote: "50" }),
    ], "BTCUSDT");
    expect(tracker.value).toBeCloseTo(50, 6);

    tracker.observeOrders([
      makeOrder({ orderId: 1, cumQuote: "75" }),
    ], "BTCUSDT");
    expect(tracker.value).toBeCloseTo(75, 6);

    tracker.observeOrders(
      [
        makeOrder({ orderId: 1, cumQuote: "75" }),
        makeOrder({ orderId: 2, cumQuote: undefined, executedQty: "0.5", avgPrice: "60" }),
      ],
      "BTCUSDT"
    );
    expect(tracker.value).toBeCloseTo(105, 6);

    tracker.update({ ...basePosition, positionAmt: 3 }, 200);
    expect(tracker.value).toBeCloseTo(105, 6);
  });
});
