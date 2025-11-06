import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ExchangeAdapter } from "../src/exchanges/adapter";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterOrder,
  AsterTicker,
  CreateOrderParams,
} from "../src/exchanges/types";
import type { MakerConfig } from "../src/config";
import { MakerEngine } from "../src/strategy/maker-engine";

class StubAdapter implements ExchangeAdapter {
  public id = "aster";

  private accountHandler: ((snapshot: AsterAccountSnapshot) => void) | null = null;
  private orderHandler: ((orders: AsterOrder[]) => void) | null = null;
  private depthHandler: ((depth: AsterDepth) => void) | null = null;
  private tickerHandler: ((ticker: AsterTicker) => void) | null = null;
  private sequence = 0;
  private currentOrders: AsterOrder[] = [];

  public createdOrders: CreateOrderParams[] = [];

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

  watchKlines(): void {
    /* maker engine does not consume klines */
  }

  emitAccount(snapshot: AsterAccountSnapshot): void {
    this.accountHandler?.(snapshot);
  }

  emitOrders(orders: AsterOrder[]): void {
    this.currentOrders = orders;
    this.orderHandler?.(orders);
  }

  emitDepth(depth: AsterDepth): void {
    this.depthHandler?.(depth);
  }

  emitTicker(ticker: AsterTicker): void {
    this.tickerHandler?.(ticker);
  }

  async createOrder(params: CreateOrderParams): Promise<AsterOrder> {
    this.createdOrders.push(params);
    const order: AsterOrder = {
      orderId: `${++this.sequence}`,
      clientOrderId: `${this.sequence}`,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      status: params.type === "MARKET" ? "FILLED" : "NEW",
      price: params.price != null ? String(params.price) : "0",
      origQty: params.quantity != null ? String(params.quantity) : "0",
      executedQty: "0",
      stopPrice: params.stopPrice != null ? String(params.stopPrice) : "0",
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: params.reduceOnly === "true",
      closePosition: params.closePosition === "true",
    } as unknown as AsterOrder;

    if (params.type !== "MARKET") {
      this.currentOrders = [...this.currentOrders, order];
      this.emitOrders(this.currentOrders);
    }

    return order;
  }

  async cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void> {
    const remaining = this.currentOrders.filter((o) => String(o.orderId) !== String(params.orderId));
    this.emitOrders(remaining);
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void> {
    const ids = new Set(params.orderIdList.map((id) => String(id)));
    const remaining = this.currentOrders.filter((o) => !ids.has(String(o.orderId)));
    this.emitOrders(remaining);
  }

  async cancelAllOrders(): Promise<void> {
    this.emitOrders([]);
  }
}

const baseConfig: MakerConfig = {
  symbol: "BTCUSDT",
  tradeAmount: 0.4,
  lossLimit: 0.05,
  bidOffset: 0.1,
  askOffset: 0.1,
  refreshIntervalMs: 50,
  maxLogEntries: 50,
  maxCloseSlippagePct: 0.05,
  priceTick: 0.1,
  strictLimitOnly: true,
  volumeBoost: 1,
  repriceDwellMs: 500,
  minRepriceTicks: 1,
};

function createAccount(symbol: string, positionAmt: number): AsterAccountSnapshot {
  return {
    canTrade: true,
    canDeposit: true,
    canWithdraw: true,
    updateTime: Date.now(),
    totalWalletBalance: "0",
    totalUnrealizedProfit: "0",
    positions: [
      {
        symbol,
        positionAmt: positionAmt.toString(),
        entryPrice: "100",
        markPrice: "100",
        unrealizedProfit: "0",
        positionSide: "BOTH",
        updateTime: Date.now(),
      },
    ],
    assets: [],
  } as unknown as AsterAccountSnapshot;
}

function createDepth(bid: number, ask: number): AsterDepth {
  return {
    lastUpdateId: 1,
    bids: [[bid.toFixed(1), "1"]],
    asks: [[ask.toFixed(1), "1"]],
    eventTime: Date.now(),
  } as AsterDepth;
}

function createTicker(price: number): AsterTicker {
  return {
    symbol: baseConfig.symbol,
    lastPrice: price.toFixed(1),
    openPrice: price.toFixed(1),
    highPrice: price.toFixed(1),
    lowPrice: price.toFixed(1),
    volume: "1",
    quoteVolume: "1",
  } as AsterTicker;
}

async function runTick(engine: MakerEngine): Promise<void> {
  await (engine as unknown as { tick: () => Promise<void> }).tick();
}

describe("MakerEngine bidirectional quoting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts buy and sell quotes when flat", async () => {
    const adapter = new StubAdapter();
    const engine = new MakerEngine(baseConfig, adapter);

    adapter.emitAccount(createAccount(baseConfig.symbol, 0));
    adapter.emitOrders([]);
    adapter.emitDepth(createDepth(100, 100.2));
    adapter.emitTicker(createTicker(100.1));

    await runTick(engine);

    const desired = engine.getSnapshot().desiredOrders;
    expect(desired).toHaveLength(2);
    const buy = desired.find((order) => order.side === "BUY" && !order.reduceOnly);
    const sell = desired.find((order) => order.side === "SELL" && !order.reduceOnly);
    expect(buy).toBeTruthy();
    expect(sell).toBeTruthy();
  });

  it("keeps entry quotes while holding inventory", async () => {
    const adapter = new StubAdapter();
    const engine = new MakerEngine(baseConfig, adapter);

    adapter.emitAccount(createAccount(baseConfig.symbol, baseConfig.tradeAmount));
    adapter.emitOrders([]);
    adapter.emitDepth(createDepth(100, 100.2));
    adapter.emitTicker(createTicker(100.1));

    await runTick(engine);

    const desired = engine.getSnapshot().desiredOrders;
    const entryBuy = desired.find((order) => order.side === "BUY" && !order.reduceOnly);
    const entrySell = desired.find((order) => order.side === "SELL" && !order.reduceOnly);
    const closeSell = desired.find((order) => order.side === "SELL" && order.reduceOnly);

    expect(entryBuy).toBeTruthy();
    expect(entrySell).toBeTruthy();
    expect(closeSell).toBeTruthy();
    expect(closeSell!.amount).toBeCloseTo(baseConfig.tradeAmount, 6);
  });

  it("suspends new entries when balance guard is active", async () => {
    const adapter = new StubAdapter();
    const engine = new MakerEngine(baseConfig, adapter);

    adapter.emitAccount(createAccount(baseConfig.symbol, baseConfig.tradeAmount));
    adapter.emitOrders([]);
    adapter.emitDepth(createDepth(100, 100.2));
    adapter.emitTicker(createTicker(100.1));

    (engine as unknown as { insufficientBalanceCooldownUntil: number }).insufficientBalanceCooldownUntil =
      Date.now() + 10_000;

    await runTick(engine);

    const desired = engine.getSnapshot().desiredOrders;
    const entries = desired.filter((order) => !order.reduceOnly);
    expect(entries).toHaveLength(0);
    const closeOrder = desired.find((order) => order.reduceOnly);
    expect(closeOrder).toBeTruthy();
    expect(closeOrder!.side).toBe("SELL");
  });
});
