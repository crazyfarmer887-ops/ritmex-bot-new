import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  AccountListener,
  DepthListener,
  ExchangeAdapter,
  KlineListener,
  OrderListener,
  TickerListener,
} from "../src/exchanges/adapter";
import type { AsterAccountSnapshot, AsterDepth, AsterOrder } from "../src/exchanges/types";
import type { HedgeConfig } from "../src/config";
import { GrvtBingxHedgeEngine } from "../src/strategy/grvt-bingx-hedge-engine";

class StubAdapter implements ExchangeAdapter {
  readonly id: string;
  private readonly symbol: string;
  private accountListener: AccountListener | null = null;
  private orderListener: OrderListener | null = null;
  private depthListener: DepthListener | null = null;
  private tickerListener: TickerListener | null = null;
  private klineListener: KlineListener | null = null;

  public readonly createdOrders: AsterOrder[] = [];
  public readonly canceledOrders: Array<number | string> = [];
  public cancelAllCalled = false;

  constructor(id: string, symbol: string) {
    this.id = id;
    this.symbol = symbol;
  }

  supportsTrailingStops(): boolean {
    return false;
  }

  watchAccount(cb: AccountListener): void {
    this.accountListener = cb;
  }

  watchOrders(cb: OrderListener): void {
    this.orderListener = cb;
  }

  watchDepth(_symbol: string, cb: DepthListener): void {
    this.depthListener = cb;
  }

  watchTicker(_symbol: string, cb: TickerListener): void {
    this.tickerListener = cb;
  }

  watchKlines(_symbol: string, _interval: string, cb: KlineListener): void {
    this.klineListener = cb;
  }

  async createOrder(params: any): Promise<AsterOrder> {
    const order: AsterOrder = {
      orderId: `${this.id}-${this.createdOrders.length + 1}`,
      clientOrderId: "",
      symbol: this.symbol,
      side: params.side,
      type: params.type,
      status: "NEW",
      price: String(params.price ?? "0"),
      origQty: String(params.quantity ?? "0"),
      executedQty: "0",
      stopPrice: "0",
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: params.reduceOnly === "true",
      closePosition: params.closePosition === "true",
    };
    this.createdOrders.push(order);
    this.emitOrders();
    return order;
  }

  async cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void> {
    this.canceledOrders.push(params.orderId);
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void> {
    this.canceledOrders.push(...params.orderIdList);
  }

  async cancelAllOrders(_params: { symbol: string }): Promise<void> {
    this.cancelAllCalled = true;
    this.createdOrders.length = 0;
  }

  async getPrecision() {
    return null;
  }

  emitAccount(snapshot: Partial<AsterAccountSnapshot> = {}): void {
    const payload: AsterAccountSnapshot = {
      canTrade: true,
      canDeposit: true,
      canWithdraw: true,
      updateTime: Date.now(),
      totalWalletBalance: "0",
      totalUnrealizedProfit: "0",
      positions: snapshot.positions ?? [],
      assets: snapshot.assets ?? [],
      availableBalance: snapshot.availableBalance ?? "0",
      maxWithdrawAmount: snapshot.maxWithdrawAmount ?? "0",
      ...snapshot,
    };
    this.accountListener?.(payload);
  }

  emitOrders(orders: AsterOrder[] | null = null): void {
    if (!this.orderListener) return;
    this.orderListener(orders ?? [...this.createdOrders]);
  }

  emitDepth(bid: number, ask: number): void {
    const depth: AsterDepth = {
      lastUpdateId: Date.now(),
      bids: [[String(bid), "1"]],
      asks: [[String(ask), "1"]],
    };
    this.depthListener?.(depth);
  }

  emitTicker(price: number): void {
    this.tickerListener?.({
      symbol: this.symbol,
      lastPrice: price.toString(),
      openPrice: price.toString(),
      highPrice: price.toString(),
      lowPrice: price.toString(),
      volume: "0",
      quoteVolume: "0",
    });
  }

  emitKlines(): void {
    this.klineListener?.([]);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GrvtBingxHedgeEngine", () => {
  test("places entry orders once both legs are ready", async () => {
    vi.useFakeTimers();

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

    const grvt = new StubAdapter("grvt", config.grvtSymbol);
    const bingx = new StubAdapter("bingx", config.bingxSymbol);

    const engine = new GrvtBingxHedgeEngine(config, {
      grvtAdapter: grvt,
      bingxAdapter: bingx,
      now: () => Date.now(),
    });

    engine.start();

    const flatPositions: AsterAccountSnapshot["positions"] = [];
    grvt.emitAccount({ positions: flatPositions });
    bingx.emitAccount({ positions: flatPositions });

    grvt.emitOrders();
    bingx.emitOrders();

    grvt.emitDepth(30000, 30001);
    bingx.emitDepth(30000, 30001);

    await vi.runOnlyPendingTimersAsync();

    expect(grvt.createdOrders).toHaveLength(1);
    expect(bingx.createdOrders).toHaveLength(1);
    expect(engine.getSnapshot().status).toBe("entry-submitted");

    engine.stop();
  });
});
