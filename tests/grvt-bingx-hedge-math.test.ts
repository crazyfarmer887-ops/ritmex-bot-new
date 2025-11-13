import { describe, expect, it } from "vitest";

import {
  adjustHedgePrice,
  adjustHedgeQuantity,
  computeHedgeExitPrice,
} from "../src/strategy/grvt-bingx-hedge-engine";

describe("GRVT-BingX hedge math helpers", () => {
  it("rounds price upwards respecting tick size", () => {
    const price = adjustHedgePrice(12345.12345, 0.5, "up");
    expect(price).toBeCloseTo(12345.5, 10);
  });

  it("rounds price downwards respecting tick size", () => {
    const price = adjustHedgePrice(12345.98765, 0.25, "down");
    expect(price).toBeCloseTo(12345.75, 10);
  });

  it("rounds quantity down to the allowed step", () => {
    const qty = adjustHedgeQuantity(0.987654, 0.001);
    expect(qty).toBeCloseTo(0.987, 10);
  });

  it("computes long leg exit price with ROI applied", () => {
    const exit = computeHedgeExitPrice(20000, 0.05, "long", 0.5);
    expect(exit).toBeCloseTo(21000, 10);
  });

  it("computes short leg exit price with ROI applied", () => {
    const exit = computeHedgeExitPrice(20000, 0.05, "short", 0.5);
    expect(exit).toBeCloseTo(19000, 10);
  });
});
