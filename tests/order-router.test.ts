import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { routeLimitOrder } from "../src/exchanges/order-router";
import type { ExchangeAdapter } from "../src/exchanges/adapter";
import type { CreateOrderParams, AsterOrder } from "../src/exchanges/types";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function createStubAdapter() {
  const createOrder = vi.fn(
    async (params: CreateOrderParams): Promise<AsterOrder> => ({
      orderId: "123",
      clientOrderId: "",
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      status: "NEW",
      price: String(params.price ?? 0),
      origQty: String(params.quantity ?? 0),
      executedQty: "0",
      stopPrice: String(params.stopPrice ?? 0),
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: params.reduceOnly === "true",
      closePosition: params.closePosition === "true",
    })
  );

  const adapter: ExchangeAdapter = {
    id: "bingx",
    supportsTrailingStops: () => false,
    watchAccount: () => {},
    watchOrders: () => {},
    watchDepth: () => {},
    watchTicker: () => {},
    watchKlines: () => {},
    createOrder,
    cancelOrder: async () => {},
    cancelOrders: async () => {},
    cancelAllOrders: async () => {},
  };

  return { adapter, createOrder };
}

describe("order-router resolveExchangeKey", () => {
  it("prefers adapter id over EXCHANGE env when routing orders", async () => {
    process.env.EXCHANGE = "grvt";
    const { adapter, createOrder } = createStubAdapter();

    await routeLimitOrder({
      adapter,
      symbol: "BTCUSDT",
      side: "SELL",
      quantity: 0.01,
      price: 50000,
    });

    expect(createOrder).toHaveBeenCalledTimes(1);
    const params = createOrder.mock.calls[0][0] as CreateOrderParams;
    expect(params.timeInForce).toBe("GTC");
  });
});
