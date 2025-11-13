import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ExchangeAdapter,
  AccountListener,
  OrderListener,
  DepthListener,
  TickerListener,
  KlineListener,
} from "../src/exchanges/adapter";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterOrder,
  CreateOrderParams,
} from "../src/exchanges/types";
import type { HedgeConfig } from "../src/config";
import { GrvtBingxHedgeEngine } from "../src/strategy/grvt-bingx-hedge-engine";

class MockExchangeAdapter implements ExchangeAdapter {
  readonly id: string;

  private accountCb: AccountListener | null = null;
  private ordersCb: OrderListener | null = null;
  private depthCb: DepthListener | null = null;
  private tickerCb: TickerListener | null = null;
  private klineCb: KlineListener | null = null;

  private orderSeq = 1;
  private readonly openOrders: AsterOrder[] = [];

  public readonly createdOrders: CreateOrderParams[] = [];
  public cancelAllInvoked = 0;

  constructor(id: "grvt" | "bingx") {
    this.id = id;
  }

  supportsTrailingStops(): boolean {
    return false;
  }

  watchAccount(cb: AccountListener): void {
    this.accountCb = cb;
  }

  watchOrders(cb: OrderListener): void {
    this.ordersCb = cb;
  }

  watchDepth(_symbol: string, cb: DepthListener): void {
    this.depthCb = cb;
  }

  watchTicker(_symbol: string, cb: TickerListener): void {
    this.tickerCb = cb;
  }

  watchKlines(_symbol: string, _interval: string, cb: KlineListener): void {
    this.klineCb = cb;
  }

  async createOrder(params: CreateOrderParams): Promise<AsterOrder> {
    this.createdOrders.push(params);
    const order: AsterOrder = {
      orderId: `${this.id}-order-${this.orderSeq++}`,
      clientOrderId: "",
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      status: "NEW",
      price: params.price?.toString() ?? "0",
      origQty: params.quantity?.toString() ?? "0",
      executedQty: "0",
      stopPrice: params.stopPrice?.toString() ?? "0",
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: params.reduceOnly === "true",
      closePosition: params.closePosition === "true",
    };
    this.openOrders.push(order);
    this.emitOrders();
    return order;
  }

  async cancelOrder(params: { symbol: string; orderId: string | number }): Promise<void> {
    const index = this.openOrders.findIndex(
      (order) => order.orderId === params.orderId || order.clientOrderId === params.orderId
    );
    if (index >= 0) {
      this.openOrders.splice(index, 1);
      this.emitOrders();
    }
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<string | number> }): Promise<void> {
    let modified = false;
    for (const orderId of params.orderIdList) {
      const index = this.openOrders.findIndex(
        (order) => order.orderId === orderId || order.clientOrderId === orderId
      );
      if (index >= 0) {
        this.openOrders.splice(index, 1);
        modified = true;
      }
    }
    if (modified) {
      this.emitOrders();
    }
  }

  async cancelAllOrders(_params: { symbol: string }): Promise<void> {
    this.cancelAllInvoked += 1;
    if (this.openOrders.length > 0) {
      this.openOrders.splice(0, this.openOrders.length);
    }
    this.emitOrders();
  }

  emitAccount(snapshot: AsterAccountSnapshot): void {
    this.accountCb?.(snapshot);
  }

  emitDepth(depth: AsterDepth): void {
    this.depthCb?.(depth);
  }

  emitOrders(orders: AsterOrder[] = this.openOrders): void {
    this.ordersCb?.(orders);
  }

  emitTicker(ticker: Parameters<TickerListener>[0]): void {
    this.tickerCb?.(ticker);
  }

  emitKlines(klines: Parameters<KlineListener>[0]): void {
    this.klineCb?.(klines);
  }

  async getPrecision(): Promise<null> {
    return null;
  }
}

function makeAccountSnapshot(symbol: string, positionAmt: number): AsterAccountSnapshot {
  const amt = positionAmt.toString();
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
        positionAmt: amt,
        entryPrice: "0",
        unrealizedProfit: "0",
        positionSide: "BOTH",
        updateTime: Date.now(),
      },
    ],
    assets: [
      {
        asset: "USDT",
        walletBalance: "0",
        availableBalance: "0",
        updateTime: Date.now(),
      },
    ],
    totalMarginBalance: "0",
    totalInitialMargin: "0",
    totalMaintMargin: "0",
    totalPositionInitialMargin: "0",
    totalOpenOrderInitialMargin: "0",
    totalCrossWalletBalance: "0",
    totalCrossUnPnl: "0",
    availableBalance: "0",
    maxWithdrawAmount: "0",
  };
}

function makeDepth(symbol: string, bid: number, ask: number): AsterDepth {
  return {
    symbol,
    lastUpdateId: Date.now(),
    bids: [[bid.toString(), "1"]],
    asks: [[ask.toString(), "1"]],
  };
}

describe("GrvtBingxHedgeEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("places entry orders once both legs are ready", async () => {
    const grvt = new MockExchangeAdapter("grvt");
    const bingx = new MockExchangeAdapter("bingx");

    const config: HedgeConfig = {
      grvtSymbol: "BTCUSDT",
      bingxSymbol: "BTCUSDT",
      orderAmount: 0.01,
      exitRoiPercent: 5,
      pollIntervalMs: 50,
      maxLogEntries: 100,
      grvtPriceTick: 0.1,
      grvtQtyStep: 0.001,
      bingxPriceTick: 0.1,
      bingxQtyStep: 0.001,
    };

    const engine = new GrvtBingxHedgeEngine(config, {
      grvtAdapter: grvt,
      bingxAdapter: bingx,
      now: () => Date.now(),
    });

    engine.start();

    // Simulate both legs providing initial data snapshots.
    grvt.emitAccount(makeAccountSnapshot(config.grvtSymbol, 0));
    bingx.emitAccount(makeAccountSnapshot(config.bingxSymbol, 0));

    grvt.emitOrders([]);
    bingx.emitOrders([]);

    grvt.emitDepth(makeDepth(config.grvtSymbol, 64000, 64000.2));
    bingx.emitDepth(makeDepth(config.bingxSymbol, 64000, 64000.2));

    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(grvt.createdOrders.length).toBeGreaterThanOrEqual(1);
    expect(bingx.createdOrders.length).toBeGreaterThanOrEqual(1);

    const grvtOrder = grvt.createdOrders[0];
    const bingxOrder = bingx.createdOrders[0];

    expect(grvtOrder.side).toBe("BUY");
    expect(bingxOrder.side).toBe("SELL");
    expect(grvtOrder.reduceOnly).toBe("false");
    expect(bingxOrder.reduceOnly).toBe("false");

    engine.stop();
  });
});
