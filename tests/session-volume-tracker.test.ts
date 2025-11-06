import { describe, expect, it } from "vitest";
import { SessionVolumeTracker, SESSION_VOLUME_MAX_PRICE_STALENESS_MS } from "../src/strategy/common/session-volume";
import type { PositionSnapshot } from "../src/utils/strategy";

function makePosition(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    positionAmt: overrides.positionAmt ?? 0,
    entryPrice: overrides.entryPrice ?? 0,
    unrealizedProfit: overrides.unrealizedProfit ?? 0,
    markPrice: overrides.markPrice ?? null,
  };
}

describe("SessionVolumeTracker", () => {
  it("accumulates notional when reference price available", () => {
    const tracker = new SessionVolumeTracker();
    tracker.update(makePosition({ positionAmt: 0 }), 100, 0);
    tracker.update(makePosition({ positionAmt: 1, entryPrice: 101 }), 110, 1);
    expect(tracker.value).toBeCloseTo(110, 6);
    tracker.update(makePosition({ positionAmt: 0 }), 95, 2);
    expect(tracker.value).toBeCloseTo(205, 6);
  });

  it("falls back to mark price when reference unavailable", () => {
    const tracker = new SessionVolumeTracker();
    tracker.update(makePosition(), null, 0);
    tracker.update(makePosition({ positionAmt: 2, markPrice: 105 }), null, 1);
    expect(tracker.value).toBeCloseTo(210, 6);
  });

  it("flushes pending base when price arrives later", () => {
    const tracker = new SessionVolumeTracker();
    tracker.update(makePosition(), null, 0);
    tracker.update(makePosition({ positionAmt: 1, entryPrice: 0, markPrice: null }), null, 1);
    expect(tracker.value).toBe(0);
    tracker.update(makePosition({ positionAmt: 1 }), 100, 2);
    expect(tracker.value).toBeCloseTo(100, 6);
  });

  it("ignores repeated updates without position delta", () => {
    const tracker = new SessionVolumeTracker();
    tracker.update(makePosition(), 100, 0);
    tracker.update(makePosition({ positionAmt: 1, entryPrice: 100 }), 101, 1);
    tracker.update(makePosition({ positionAmt: 1, entryPrice: 100 }), 120, 2);
    expect(tracker.value).toBeCloseTo(101, 6);
  });

  it("drops stale last price beyond the allowed window", () => {
    const tracker = new SessionVolumeTracker();
    const start = 0;
    tracker.update(makePosition(), 100, start);
    const afterStale = start + SESSION_VOLUME_MAX_PRICE_STALENESS_MS + 10;
    tracker.update(makePosition({ positionAmt: 1 }), null, afterStale);
    expect(tracker.value).toBe(0);
    tracker.update(makePosition({ positionAmt: 1 }), 90, afterStale + 10);
    expect(tracker.value).toBeCloseTo(90, 6);
  });
});
