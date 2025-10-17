import { describe, it, expect, vi } from "vitest";
import type { ExchangeAdapter } from "../src/exchanges/adapter";
import type { AsterOrder } from "../src/exchanges/types";
import { reconcileOrphanedPosition } from "../src/core/lib/position-reconciler";

const makeAdapter = () => {
  const createOrder = vi.fn(async (params: any) => ({
    orderId: 1,
    clientOrderId: "test",
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
  }));
  const adapter: Partial<ExchangeAdapter> = {
    id: "mock",
    supportsTrailingStops: () => false,
    createOrder: createOrder as any,
  };
  return { adapter: adapter as ExchangeAdapter, createOrder };
};

describe("position reconciler", () => {
  it("places reduce-only cover when position exists and no protection", async () => {
    const { adapter, createOrder } = makeAdapter();
    const res = await reconcileOrphanedPosition({
      exchange: adapter,
      symbol: "BTCUSDT",
      position: { positionAmt: 0.5, entryPrice: 100, unrealizedProfit: 0, markPrice: 100 },
      openOrders: [],
      locks: {},
      timers: {},
      pendings: {},
      prices: { topBid: 99.9, topAsk: 100.1, lastPrice: 100 },
      opts: { priceTick: 0.1, qtyStep: 0.001, strictLimitOnly: false, maxCloseSlippagePct: 0.05 },
      ioc: true,
      log: () => {},
    });
    expect(res.tookAction).toBe(true);
    expect(createOrder).toHaveBeenCalled();
    const args = (createOrder as any).mock.calls[0][0];
    expect(args.reduceOnly).toBe("true");
  });

  it("skips when no position", async () => {
    const { adapter, createOrder } = makeAdapter();
    const res = await reconcileOrphanedPosition({
      exchange: adapter,
      symbol: "BTCUSDT",
      position: { positionAmt: 0, entryPrice: 0, unrealizedProfit: 0, markPrice: null },
      openOrders: [],
      locks: {},
      timers: {},
      pendings: {},
      prices: { topBid: 100, topAsk: 101, lastPrice: 100.5 },
      opts: { priceTick: 0.1, qtyStep: 0.001, strictLimitOnly: false, maxCloseSlippagePct: 0.05 },
      log: () => {},
    });
    expect(res.tookAction).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("skips when protection already exists", async () => {
    const { adapter, createOrder } = makeAdapter();
    const res = await reconcileOrphanedPosition({
      exchange: adapter,
      symbol: "BTCUSDT",
      position: { positionAmt: -0.2, entryPrice: 100, unrealizedProfit: 0, markPrice: 100 },
      openOrders: [
        {
          orderId: 2,
          clientOrderId: "x",
          symbol: "BTCUSDT",
          side: "BUY",
          type: "LIMIT",
          status: "NEW",
          price: "99.9",
          origQty: "0.2",
          executedQty: "0",
          stopPrice: "0",
          time: Date.now(),
          updateTime: Date.now(),
          reduceOnly: true,
          closePosition: true,
        } as unknown as AsterOrder,
      ],
      locks: {},
      timers: {},
      pendings: {},
      prices: { topBid: 99.9, topAsk: 100.1, lastPrice: 100 },
      opts: { priceTick: 0.1, qtyStep: 0.001, strictLimitOnly: false, maxCloseSlippagePct: 0.05 },
      log: () => {},
    });
    expect(res.tookAction).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
  });
});
