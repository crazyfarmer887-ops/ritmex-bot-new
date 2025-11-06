import { describe, expect, it, vi } from "vitest";
import type { ExchangeAdapter } from "../src/exchanges/adapter";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterKline,
  AsterOrder,
  AsterTicker,
  CreateOrderParams,
} from "../src/exchanges/types";
import type { MakerConfig } from "../src/config";
import { MakerEngine } from "../src/strategy/maker-engine";

class StubAdapter implements ExchangeAdapter {
  id = "aster" as const;

  private accountHandler: ((snapshot: AsterAccountSnapshot) => void) | null = null;
  private orderHandler: ((orders: AsterOrder[]) => void) | null = null;
  private depthHandler: ((depth: AsterDepth) => void) | null = null;
  private tickerHandler: ((ticker: AsterTicker) => void) | null = null;
  private klineHandler: ((klines: AsterKline[]) => void) | null = null;

  private nextOrderId = 1;

  createOrder = vi.fn(async (params: CreateOrderParams): Promise<AsterOrder> => {
    const orderId = this.nextOrderId++;
    const price = params.price ?? 0;
    const stopPrice = params.stopPrice ?? 0;
    const quantity = params.quantity ?? 0;
    return {
      orderId,
      clientOrderId: `test-${orderId}`,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      status: "NEW",
      price: Number.isFinite(price) ? String(price) : "0",
      origQty: Number.isFinite(quantity) ? String(quantity) : "0",
      executedQty: "0",
      stopPrice: Number.isFinite(stopPrice) ? String(stopPrice) : "0",
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: params.reduceOnly === "true",
      closePosition: params.closePosition === "true",
    };
  });

  cancelOrder = vi.fn(async () => {
    /* no-op */
  });

  cancelOrders = vi.fn(async () => {
    /* no-op */
  });

  cancelAllOrders = vi.fn(async () => {
    /* no-op */
  });

  supportsTrailingStops(): boolean {
    return false;
  }

  watchAccount(cb: (snapshot: AsterAccountSnapshot) => void): void {
    this.accountHandler = cb;
  }

  watchOrders(cb: (orders: AsterOrder[]) => void): void {
    this.orderHandler = cb;
  }

  watchDepth(_symbol: string, cb: (depth: AsterDepth) => void): void {
    this.depthHandler = cb;
  }

  watchTicker(_symbol: string, cb: (ticker: AsterTicker) => void): void {
    this.tickerHandler = cb;
  }

  watchKlines(_symbol: string, _interval: string, cb: (klines: AsterKline[]) => void): void {
    this.klineHandler = cb;
  }

  emitAccount(snapshot: AsterAccountSnapshot): void {
    this.accountHandler?.(snapshot);
  }

  emitOrders(orders: AsterOrder[]): void {
    this.orderHandler?.(orders);
  }

  emitDepth(depth: AsterDepth): void {
    this.depthHandler?.(depth);
  }

  emitTicker(ticker: AsterTicker): void {
    this.tickerHandler?.(ticker);
  }

  emitKlines(klines: AsterKline[]): void {
    this.klineHandler?.(klines);
  }
}

function createConfig(overrides: Partial<MakerConfig> = {}): MakerConfig {
  return {
    symbol: "BTCUSDT",
    tradeAmount: 0.1,
    lossLimit: 0,
    bidOffset: 0,
    askOffset: 0,
    refreshIntervalMs: 250,
    maxLogEntries: 32,
    maxCloseSlippagePct: 0.05,
    priceTick: 0.1,
    strictLimitOnly: false,
    volumeBoost: 1,
    ...overrides,
  };
}

function buildAccountSnapshot(symbol: string, positionAmt: number): AsterAccountSnapshot {
  const now = Date.now();
  return {
    canTrade: true,
    canDeposit: true,
    canWithdraw: true,
    updateTime: now,
    totalWalletBalance: "1000",
    totalUnrealizedProfit: "0",
    positions: [
      {
        symbol,
        positionAmt: positionAmt.toString(),
        entryPrice: "100",
        unrealizedProfit: "0",
        positionSide: "BOTH",
        updateTime: now,
        markPrice: "100",
      },
    ],
    assets: [
      {
        asset: "USDT",
        walletBalance: "1000",
        availableBalance: "1000",
        updateTime: now,
      },
    ],
  };
}

function bootstrapEngine(positionAmt: number, overrides: Partial<MakerConfig> = {}) {
  const adapter = new StubAdapter();
  const config = createConfig(overrides);
  const engine = new MakerEngine(config, adapter);

  adapter.emitOrders([]);
  adapter.emitAccount(buildAccountSnapshot(config.symbol, positionAmt));
  adapter.emitDepth({
    lastUpdateId: 1,
    bids: [["100.0", "5"]],
    asks: [["100.1", "5"]],
  });
  adapter.emitTicker({
    symbol: config.symbol,
    lastPrice: "100.05",
    openPrice: "100.00",
    highPrice: "101.00",
    lowPrice: "99.00",
    volume: "100",
    quoteVolume: "10000",
  });

  return { engine, adapter, config };
}

describe("MakerEngine bidirectional quoting", () => {
  it("posts both sides when flat", async () => {
    const { engine } = bootstrapEngine(0);

    await (engine as unknown as { tick: () => Promise<void> }).tick();

    const snapshot = engine.getSnapshot();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.desiredOrders).toHaveLength(2);
    expect(snapshot.desiredOrders.every((order) => order.reduceOnly === false)).toBe(true);
    expect(snapshot.desiredOrders.map((order) => order.side).sort()).toEqual(["BUY", "SELL"]);
  });

  it("keeps exit order and quotes both sides when long", async () => {
    const { engine } = bootstrapEngine(0.2);

    await (engine as unknown as { tick: () => Promise<void> }).tick();

    const desired = engine.getSnapshot().desiredOrders;
    expect(desired.length).toBe(3);

    const closeOrder = desired.find((order) => order.reduceOnly);
    expect(closeOrder).toBeDefined();
    expect(closeOrder?.side).toBe("SELL");
    expect(closeOrder?.amount ?? 0).toBeCloseTo(0.2, 6);

    const entryOrders = desired.filter((order) => !order.reduceOnly);
    expect(entryOrders).toHaveLength(2);
    expect(entryOrders.map((order) => order.side).sort()).toEqual(["BUY", "SELL"]);
  });
});
