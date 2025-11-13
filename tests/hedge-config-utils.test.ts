import { describe, expect, it } from "vitest";
import { isValidOrderAmount, isValidRoiPercent, parseNumericInput } from "../src/strategy/hedge-config-utils";

describe("hedge-config-utils", () => {
  describe("parseNumericInput", () => {
    it("returns the fallback when input is empty", () => {
      expect(parseNumericInput("", 1.23)).toBe(1.23);
      expect(parseNumericInput("   ", 0.5)).toBe(0.5);
      expect(parseNumericInput(undefined, 0.7)).toBe(0.7);
    });

    it("parses valid numeric strings", () => {
      expect(parseNumericInput("0.001", 0)).toBeCloseTo(0.001);
      expect(parseNumericInput("  12.5 ", 0)).toBeCloseTo(12.5);
    });

    it("returns null for invalid numbers", () => {
      expect(parseNumericInput("abc", 1)).toBeNull();
      expect(parseNumericInput("1.2.3", 1)).toBeNull();
    });
  });

  describe("isValidOrderAmount", () => {
    it("accepts finite positive values", () => {
      expect(isValidOrderAmount(0.0001)).toBe(true);
      expect(isValidOrderAmount(5)).toBe(true);
    });

    it("rejects zero, negatives, and non-finite numbers", () => {
      expect(isValidOrderAmount(0)).toBe(false);
      expect(isValidOrderAmount(-0.1)).toBe(false);
      expect(isValidOrderAmount(Number.NaN)).toBe(false);
      expect(isValidOrderAmount(Number.POSITIVE_INFINITY)).toBe(false);
    });
  });

  describe("isValidRoiPercent", () => {
    it("accepts zero and positive numbers", () => {
      expect(isValidRoiPercent(0)).toBe(true);
      expect(isValidRoiPercent(12.5)).toBe(true);
    });

    it("rejects negatives and non-finite numbers", () => {
      expect(isValidRoiPercent(-0.01)).toBe(false);
      expect(isValidRoiPercent(Number.NaN)).toBe(false);
      expect(isValidRoiPercent(Number.NEGATIVE_INFINITY)).toBe(false);
    });
  });
});
