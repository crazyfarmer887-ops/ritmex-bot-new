import { describe, expect, it } from "vitest";
import { SessionVolumeTracker } from "../src/strategy/common/session-volume";
import type { PositionSnapshot } from "../src/utils/strategy";

const baseSnapshot = (overrides: Partial<PositionSnapshot> = {}): PositionSnapshot => ({
  positionAmt: 0,
  entryPrice: 0,
  unrealizedProfit: 0,
  markPrice: null,
  ...overrides,
});

describe("SessionVolumeTracker", () => {
  it("does not accumulate when position stays flat", () => {
    const tracker = new SessionVolumeTracker();
    tracker.update(baseSnapshot(), null);
    tracker.update(baseSnapshot(), null);

    expect(tracker.value).toBe(0);
    expect(tracker.base).toBe(0);
  });

  it("accumulates using provided reference price", () => {
    const tracker = new SessionVolumeTracker();
    tracker.update(baseSnapshot(), null);

    tracker.update(baseSnapshot({ positionAmt: 0.5, entryPrice: 100, markPrice: 100 }), 100);

    expect(tracker.value).toBeCloseTo(50, 6);
    expect(tracker.base).toBeCloseTo(0.5, 6);
  });

  it("derives fill price from entry deltas when exposure grows", () => {
    const tracker = new SessionVolumeTracker();
    tracker.update(baseSnapshot(), null);

    tracker.update(baseSnapshot({ positionAmt: 0.5, entryPrice: 100, markPrice: 100 }), 100);
    tracker.update(baseSnapshot({ positionAmt: 1, entryPrice: 105, markPrice: 105 }), null);

    expect(tracker.value).toBeCloseTo(105, 6);
    expect(tracker.base).toBeCloseTo(1, 6);
  });

  it("falls back to last known price when closing without quotes", () => {
    const tracker = new SessionVolumeTracker();
    tracker.update(baseSnapshot(), null);

    tracker.update(baseSnapshot({ positionAmt: 0.5, entryPrice: 100, markPrice: 100 }), 100);
    tracker.update(baseSnapshot({ positionAmt: 1, entryPrice: 105, markPrice: 105 }), null);
    tracker.update(baseSnapshot({ positionAmt: 0, entryPrice: 0, markPrice: null }), null);

    expect(tracker.value).toBeCloseTo(215, 6);
    expect(tracker.base).toBeCloseTo(2, 6);
  });

  it("ignores deltas below epsilon to avoid noise", () => {
    const tracker = new SessionVolumeTracker();
    tracker.update(baseSnapshot(), null);

    tracker.update(baseSnapshot({ positionAmt: 0.5, entryPrice: 100, markPrice: 100 }), 100);
    tracker.update(baseSnapshot({ positionAmt: 0.5 + 5e-10, entryPrice: 100, markPrice: 100 }), 100);

    expect(tracker.value).toBeCloseTo(50, 6);
    expect(tracker.base).toBeCloseTo(0.5, 6);
  });
});
