import { describe, expect, it, vi } from "vitest";
import type { CreateOrderParams } from "../src/exchanges/types";
import { BingxGateway } from "../src/exchanges/bingx/gateway";

const mockCcxt = vi.hoisted(() => {
  class StubExchange {
    constructor(_: unknown) {}
  }

  return {
    __esModule: true,
    default: {
      bingx: StubExchange,
    },
  };
});

vi.mock("ccxt", () => mockCcxt);

function createGateway(positionMode: "HEDGE" | "ONE_WAY") {
  return new BingxGateway({
    apiKey: "key",
    apiSecret: "secret",
    symbol: "BTCUSDT",
    leverage: 10,
    marginMode: "ISOLATED",
    positionMode,
  });
}

describe("BingxGateway position side resolution", () => {
  it("defaults to LONG for opening buy orders in hedge mode", () => {
    const gateway = createGateway("HEDGE") as unknown as {
      resolvePositionSide(params: CreateOrderParams): string | undefined;
    };

    const side = gateway.resolvePositionSide({
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
    });

    expect(side).toBe("LONG");
  });

  it("returns SHORT for hedge-mode reduce-only buy orders", () => {
    const gateway = createGateway("HEDGE") as unknown as {
      resolvePositionSide(params: CreateOrderParams): string | undefined;
    };

    const side = gateway.resolvePositionSide({
      symbol: "BTCUSDT",
      side: "BUY",
      type: "MARKET",
      reduceOnly: "true",
    });

    expect(side).toBe("SHORT");
  });

  it("respects explicit positionSide overrides", () => {
    const gateway = createGateway("HEDGE") as unknown as {
      resolvePositionSide(params: CreateOrderParams): string | undefined;
    };

    const side = gateway.resolvePositionSide({
      symbol: "BTCUSDT",
      side: "SELL",
      type: "LIMIT",
      positionSide: "SHORT",
    });

    expect(side).toBe("SHORT");
  });

  it("does not force positionSide in one-way mode", () => {
    const gateway = createGateway("ONE_WAY") as unknown as {
      resolvePositionSide(params: CreateOrderParams): string | undefined;
    };

    const side = gateway.resolvePositionSide({
      symbol: "BTCUSDT",
      side: "SELL",
      type: "LIMIT",
      quantity: 1,
    });

    expect(side).toBeUndefined();
  });
});
