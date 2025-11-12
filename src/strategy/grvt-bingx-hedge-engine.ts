import type { GrvtBingxHedgeConfig } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import { routeLimitOrder, routeMarketOrder } from "../exchanges/order-router";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterOrder,
  AsterTicker,
} from "../exchanges/types";
import { createTradeLog, type TradeLogEntry } from "../logging/trade-log";
import { extractMessage } from "../utils/errors";
import { roundQtyDownToStep } from "../utils/math";
import { getTopPrices, getMidOrLast } from "../utils/price";
import { getPosition, type PositionSnapshot } from "../utils/strategy";
import { StrategyEventEmitter } from "./common/event-emitter";
import { safeSubscribe, type LogHandler } from "./common/subscriptions";

type HedgePhase = "idle" | "entering" | "hedged" | "exiting" | "closed" | "error";
type HedgeEvent = "update";
type HedgeListener = (snapshot: GrvtBingxHedgeSnapshot) => void;

interface HedgeLegRuntimeState {
  symbol: string;
  account: AsterAccountSnapshot | null;
  depth: AsterDepth | null;
  ticker: AsterTicker | null;
  openOrders: AsterOrder[];
  topBid: number | null;
  topAsk: number | null;
  precision: {
    priceTick: number;
    qtyStep: number;
    decimals: number;
    qtyDecimals: number;
  };
}

interface HedgeLegSnapshot {
  symbol: string;
  position: PositionSnapshot;
  topBid: number | null;
  topAsk: number | null;
  openOrders: AsterOrder[];
  exitOrderId: string | null;
  markPrice: number | null;
  lastPrice: number | null;
}

export interface GrvtBingxHedgeSnapshot {
  ready: boolean;
  phase: HedgePhase;
  tradeAmount: number;
  targetRoiPct: number;
  averageEntryPrice: number | null;
  grvtExitPrice: number | null;
  bingxExitPrice: number | null;
  grvt: HedgeLegSnapshot;
  bingx: HedgeLegSnapshot;
  tradeLog: TradeLogEntry[];
  feedStatus: {
    grvtAccount: boolean;
    grvtOrders: boolean;
    grvtDepth: boolean;
    bingxAccount: boolean;
    bingxOrders: boolean;
    bingxDepth: boolean;
  };
  lastUpdated: number;
}

const POSITION_EPS = 1e-6;
const MIN_REFRESH_MS = 200;

export class GrvtBingxHedgeEngine {
  private readonly config: GrvtBingxHedgeConfig;
  private readonly tradeLog: ReturnType<typeof createTradeLog>;
  private readonly events = new StrategyEventEmitter<HedgeEvent, GrvtBingxHedgeSnapshot>();

  private readonly grvtState: HedgeLegRuntimeState;
  private readonly bingxState: HedgeLegRuntimeState;

  private readonly feedReady = {
    grvtAccount: false,
    grvtOrders: false,
    grvtDepth: false,
    bingxAccount: false,
    bingxOrders: false,
    bingxDepth: false,
  };

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private phase: HedgePhase = "idle";
  private averageEntryPrice: number | null = null;
  private exitTargets = { grvt: null as number | null, bingx: null as number | null };
  private closingRemainder = false;
  private lastError: string | null = null;

  private exitOrderIds = { grvt: null as string | null, bingx: null as string | null };

  constructor(
    config: GrvtBingxHedgeConfig,
    private readonly grvt: ExchangeAdapter,
    private readonly bingx: ExchangeAdapter
  ) {
    if (config.tradeAmount <= 0) {
      throw new Error("Hedge trade amount must be positive");
    }
    this.config = {
      ...config,
      refreshIntervalMs: Math.max(config.refreshIntervalMs, MIN_REFRESH_MS),
    };
    this.tradeLog = createTradeLog(config.maxLogEntries);
    this.grvtState = this.createLegState(config.grvtSymbol);
    this.bingxState = this.createLegState(config.bingxSymbol);
    this.bootstrap();
    void this.syncPrecisions();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.refreshIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  on(event: HedgeEvent, handler: HedgeListener): void {
    this.events.on(event, handler);
  }

  off(event: HedgeEvent, handler: HedgeListener): void {
    this.events.off(event, handler);
  }

  getSnapshot(): GrvtBingxHedgeSnapshot {
    return this.buildSnapshot();
  }

  private createLegState(symbol: string): HedgeLegRuntimeState {
    return {
      symbol,
      account: null,
      depth: null,
      ticker: null,
      openOrders: [],
      topBid: null,
      topAsk: null,
      precision: {
        priceTick: 0.1,
        qtyStep: 0.001,
        decimals: 1,
        qtyDecimals: 3,
      },
    };
  }

  private bootstrap(): void {
    const log: LogHandler = (type, detail) => this.tradeLog.push(type, detail);

    safeSubscribe<AsterAccountSnapshot>(
      this.grvt.watchAccount.bind(this.grvt),
      (snapshot) => {
        this.grvtState.account = snapshot;
        if (!this.feedReady.grvtAccount) {
          this.tradeLog.push("info", "GRVT account feed ready");
          this.feedReady.grvtAccount = true;
        }
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 GRVT 账户失败: ${extractMessage(error)}`,
        processFail: (error) => `处理 GRVT 账户数据失败: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterAccountSnapshot>(
      this.bingx.watchAccount.bind(this.bingx),
      (snapshot) => {
        this.bingxState.account = snapshot;
        if (!this.feedReady.bingxAccount) {
          this.tradeLog.push("info", "BingX account feed ready");
          this.feedReady.bingxAccount = true;
        }
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 BingX 账户失败: ${extractMessage(error)}`,
        processFail: (error) => `处理 BingX 账户数据失败: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterOrder[]>(
      this.grvt.watchOrders.bind(this.grvt),
      (orders) => {
        this.grvtState.openOrders = Array.isArray(orders)
          ? orders.filter((order) => order.symbol === this.grvtState.symbol)
          : [];
        if (!this.feedReady.grvtOrders) {
          this.tradeLog.push("info", "GRVT order feed ready");
          this.feedReady.grvtOrders = true;
        }
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 GRVT 订单失败: ${extractMessage(error)}`,
        processFail: (error) => `处理 GRVT 订单失败: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterOrder[]>(
      this.bingx.watchOrders.bind(this.bingx),
      (orders) => {
        this.bingxState.openOrders = Array.isArray(orders)
          ? orders.filter((order) => order.symbol === this.bingxState.symbol)
          : [];
        if (!this.feedReady.bingxOrders) {
          this.tradeLog.push("info", "BingX order feed ready");
          this.feedReady.bingxOrders = true;
        }
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 BingX 订单失败: ${extractMessage(error)}`,
        processFail: (error) => `处理 BingX 订单失败: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterDepth>(
      this.grvt.watchDepth.bind(this.grvt, this.grvtState.symbol),
      (depth) => {
        this.grvtState.depth = depth;
        const { topBid, topAsk } = getTopPrices(depth);
        this.grvtState.topBid = topBid;
        this.grvtState.topAsk = topAsk;
        if (!this.feedReady.grvtDepth) {
          this.tradeLog.push("info", "GRVT depth feed ready");
          this.feedReady.grvtDepth = true;
        }
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 GRVT 深度失败: ${extractMessage(error)}`,
        processFail: (error) => `处理 GRVT 深度失败: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterDepth>(
      this.bingx.watchDepth.bind(this.bingx, this.bingxState.symbol),
      (depth) => {
        this.bingxState.depth = depth;
        const { topBid, topAsk } = getTopPrices(depth);
        this.bingxState.topBid = topBid;
        this.bingxState.topAsk = topAsk;
        if (!this.feedReady.bingxDepth) {
          this.tradeLog.push("info", "BingX depth feed ready");
          this.feedReady.bingxDepth = true;
        }
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 BingX 深度失败: ${extractMessage(error)}`,
        processFail: (error) => `处理 BingX 深度失败: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterTicker>(
      this.grvt.watchTicker.bind(this.grvt, this.grvtState.symbol),
      (ticker) => {
        this.grvtState.ticker = ticker;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 GRVT ticker 失败: ${extractMessage(error)}`,
        processFail: (error) => `处理 GRVT ticker 失败: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterTicker>(
      this.bingx.watchTicker.bind(this.bingx, this.bingxState.symbol),
      (ticker) => {
        this.bingxState.ticker = ticker;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 BingX ticker 失败: ${extractMessage(error)}`,
        processFail: (error) => `处理 BingX ticker 失败: ${extractMessage(error)}`,
      }
    );
  }

  private async syncPrecisions(): Promise<void> {
    await Promise.all([
      this.syncLegPrecision(this.grvt, this.grvtState),
      this.syncLegPrecision(this.bingx, this.bingxState),
    ]);
  }

  private async syncLegPrecision(adapter: ExchangeAdapter, leg: HedgeLegRuntimeState): Promise<void> {
    const getPrecision = adapter.getPrecision?.bind(adapter);
    if (!getPrecision) return;
    try {
      const precision = await getPrecision();
      if (!precision) return;
      if (Number.isFinite(precision.priceTick) && precision.priceTick! > 0) {
        leg.precision.priceTick = precision.priceTick!;
        leg.precision.decimals = this.estimateDecimals(precision.priceTick!);
      }
      if (Number.isFinite(precision.qtyStep) && precision.qtyStep! > 0) {
        leg.precision.qtyStep = precision.qtyStep!;
        leg.precision.qtyDecimals = this.estimateDecimals(precision.qtyStep!);
      }
      this.tradeLog.push(
        "info",
        `${leg.symbol} 精度同步: priceTick=${leg.precision.priceTick} qtyStep=${leg.precision.qtyStep}`
      );
    } catch (error) {
      this.tradeLog.push("warn", `同步 ${leg.symbol} 精度失败: ${extractMessage(error)}`);
    }
  }

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      switch (this.phase) {
        case "idle":
          await this.handleIdle();
          break;
        case "entering":
          await this.handleEntering();
          break;
        case "hedged":
          await this.prepareExitOrders();
          break;
        case "exiting":
          await this.monitorExit();
          break;
        case "closed":
        case "error":
        default:
          break;
      }
    } catch (error) {
      const detail = extractMessage(error);
      this.lastError = detail;
      this.tradeLog.push("error", `Hedge tick error: ${detail}`);
      this.phase = "error";
    } finally {
      this.emitUpdate();
      this.processing = false;
    }
  }

  private async handleIdle(): Promise<void> {
    if (!this.isReady()) return;
    if (!this.isFlat()) {
      if (!this.lastError) {
        this.tradeLog.push("warn", "Existing exposure detected, awaiting manual flattening");
      }
      return;
    }
    await this.openHedge();
  }

  private async openHedge(): Promise<void> {
    const grvtQty = this.normalizeQuantity(this.config.tradeAmount, this.grvtState.precision.qtyStep, this.grvtState.precision.qtyDecimals);
    const bingxQty = this.normalizeQuantity(this.config.tradeAmount, this.bingxState.precision.qtyStep, this.bingxState.precision.qtyDecimals);
    if (grvtQty <= 0 || bingxQty <= 0) {
      throw new Error("Calculated quantity is zero, check trade amount or precision");
    }

    this.tradeLog.push(
      "order",
      `Opening hedge: GRVT BUY ${grvtQty} ｜ BingX SELL ${bingxQty}`
    );

    let grvtFilled = false;
    try {
      await routeMarketOrder({
        adapter: this.grvt,
        symbol: this.grvtState.symbol,
        side: "BUY",
        quantity: grvtQty,
        reduceOnly: false,
      });
      grvtFilled = true;
      await routeMarketOrder({
        adapter: this.bingx,
        symbol: this.bingxState.symbol,
        side: "SELL",
        quantity: bingxQty,
        reduceOnly: false,
      });
      this.phase = "entering";
      this.tradeLog.push("info", "Entry orders submitted");
    } catch (error) {
      const detail = extractMessage(error);
      this.tradeLog.push("error", `开仓失败: ${detail}`);
      if (grvtFilled) {
        await this.safeClosePosition("grvt");
      }
      throw error;
    }
  }

  private async handleEntering(): Promise<void> {
    const grvtPosition = getPosition(this.grvtState.account, this.grvtState.symbol);
    const bingxPosition = getPosition(this.bingxState.account, this.bingxState.symbol);
    const grvtReady =
      grvtPosition.positionAmt > POSITION_EPS &&
      Math.abs(grvtPosition.positionAmt) >= this.minFilledThreshold();
    const bingxReady =
      bingxPosition.positionAmt < -POSITION_EPS &&
      Math.abs(bingxPosition.positionAmt) >= this.minFilledThreshold();

    if (!grvtReady || !bingxReady) {
      return;
    }

    const grvtEntry = Number(grvtPosition.entryPrice);
    const bingxEntry = Number(bingxPosition.entryPrice);
    if (!Number.isFinite(grvtEntry) || grvtEntry <= 0 || !Number.isFinite(bingxEntry) || bingxEntry <= 0) {
      this.tradeLog.push("info", "Waiting for entry price synchronization");
      return;
    }

    this.averageEntryPrice = (grvtEntry + bingxEntry) / 2;
    this.exitTargets.grvt = this.averageEntryPrice * (1 + this.config.targetRoiPct / 100);
    this.exitTargets.bingx = this.averageEntryPrice * (1 - this.config.targetRoiPct / 100);
    this.tradeLog.push(
      "info",
      `Entry filled: avg=${this.averageEntryPrice.toFixed(2)} ｜ targets: GRVT ${this.exitTargets.grvt.toFixed(2)} / BingX ${this.exitTargets.bingx.toFixed(2)}`
    );
    this.phase = "hedged";
  }

  private async prepareExitOrders(): Promise<void> {
    if (this.exitOrderIds.grvt && this.exitOrderIds.bingx) {
      this.phase = "exiting";
      return;
    }
    if (this.averageEntryPrice == null || this.exitTargets.grvt == null || this.exitTargets.bingx == null) {
      return;
    }
    const grvtPosition = getPosition(this.grvtState.account, this.grvtState.symbol);
    const bingxPosition = getPosition(this.bingxState.account, this.bingxState.symbol);
    const grvtQty = this.normalizeQuantity(
      Math.abs(grvtPosition.positionAmt),
      this.grvtState.precision.qtyStep,
      this.grvtState.precision.qtyDecimals
    );
    const bingxQty = this.normalizeQuantity(
      Math.abs(bingxPosition.positionAmt),
      this.bingxState.precision.qtyStep,
      this.bingxState.precision.qtyDecimals
    );

    if (grvtQty <= 0 || bingxQty <= 0) {
      this.tradeLog.push("warn", "Cannot place exit orders: zero exposure detected");
      this.phase = "exiting";
      return;
    }

    const grvtPrice = this.normalizePrice(
      this.exitTargets.grvt,
      this.grvtState.precision.priceTick,
      "SELL",
      this.grvtState.precision.decimals
    );
    const bingxPrice = this.normalizePrice(
      this.exitTargets.bingx,
      this.bingxState.precision.priceTick,
      "BUY",
      this.bingxState.precision.decimals
    );

    try {
      if (!this.exitOrderIds.grvt) {
        const order = await routeLimitOrder({
          adapter: this.grvt,
          symbol: this.grvtState.symbol,
          side: "SELL",
          price: grvtPrice,
          quantity: grvtQty,
          reduceOnly: true,
          closePosition: true,
          timeInForce: "GTC",
        });
        this.exitOrderIds.grvt = String(order.orderId);
        this.tradeLog.push("order", `Placed GRVT exit limit: SELL @ ${grvtPrice} qty=${grvtQty}`);
      }
      if (!this.exitOrderIds.bingx) {
        const order = await routeLimitOrder({
          adapter: this.bingx,
          symbol: this.bingxState.symbol,
          side: "BUY",
          price: bingxPrice,
          quantity: bingxQty,
          reduceOnly: true,
          closePosition: true,
          timeInForce: "GTC",
        });
        this.exitOrderIds.bingx = String(order.orderId);
        this.tradeLog.push("order", `Placed BingX exit limit: BUY @ ${bingxPrice} qty=${bingxQty}`);
      }
      this.phase = "exiting";
    } catch (error) {
      this.tradeLog.push("error", `Exit order placement failed: ${extractMessage(error)}`);
      throw error;
    }
  }

  private async monitorExit(): Promise<void> {
    const grvtPosition = getPosition(this.grvtState.account, this.grvtState.symbol);
    const bingxPosition = getPosition(this.bingxState.account, this.bingxState.symbol);
    const grvtQty = Math.abs(grvtPosition.positionAmt);
    const bingxQty = Math.abs(bingxPosition.positionAmt);
    const grvtDone = grvtQty <= this.positionTolerance();
    const bingxDone = bingxQty <= this.positionTolerance();

    if (grvtDone && bingxDone) {
      await this.cleanupAfterClose();
      this.phase = "closed";
      this.tradeLog.push("info", "Hedge cycle completed");
      return;
    }

    if (this.closingRemainder) return;

    if (grvtDone && !bingxDone) {
      this.closingRemainder = true;
      await this.closeRemainingLeg("bingx", bingxPosition);
      this.closingRemainder = false;
    } else if (bingxDone && !grvtDone) {
      this.closingRemainder = true;
      await this.closeRemainingLeg("grvt", grvtPosition);
      this.closingRemainder = false;
    }
  }

  private async closeRemainingLeg(
    leg: "grvt" | "bingx",
    position: PositionSnapshot
  ): Promise<void> {
    const adapter = leg === "grvt" ? this.grvt : this.bingx;
    const state = leg === "grvt" ? this.grvtState : this.bingxState;
    const orderId = this.exitOrderIds[leg];

    if (orderId) {
      try {
        await adapter.cancelOrder({ symbol: state.symbol, orderId });
        this.tradeLog.push("order", `${state.symbol} exit order cancelled after counterpart filled`);
      } catch (error) {
        this.tradeLog.push("warn", `Cancel ${state.symbol} exit failed: ${extractMessage(error)}`);
      }
      this.exitOrderIds[leg] = null;
    }

    const qty = this.normalizeQuantity(Math.abs(position.positionAmt), state.precision.qtyStep, state.precision.qtyDecimals);
    if (qty <= 0) {
      return;
    }
    const side = position.positionAmt > 0 ? "SELL" : "BUY";
    try {
      await routeMarketOrder({
        adapter,
        symbol: state.symbol,
        side,
        quantity: qty,
        reduceOnly: true,
        closePosition: true,
      });
      this.tradeLog.push("close", `Closed remaining ${state.symbol} leg via market (${side} ${qty})`);
    } catch (error) {
      this.tradeLog.push("error", `Market close for ${state.symbol} failed: ${extractMessage(error)}`);
      throw error;
    }
  }

  private async cleanupAfterClose(): Promise<void> {
    await Promise.all([
      this.cancelOutstandingIfNeeded("grvt"),
      this.cancelOutstandingIfNeeded("bingx"),
    ]);
    this.exitOrderIds.grvt = null;
    this.exitOrderIds.bingx = null;
    this.averageEntryPrice = null;
    this.exitTargets = { grvt: null, bingx: null };
  }

  private async cancelOutstandingIfNeeded(leg: "grvt" | "bingx"): Promise<void> {
    const adapter = leg === "grvt" ? this.grvt : this.bingx;
    const state = leg === "grvt" ? this.grvtState : this.bingxState;
    const orderId = this.exitOrderIds[leg];
    if (!orderId) return;
    try {
      await adapter.cancelOrder({ symbol: state.symbol, orderId });
      this.tradeLog.push("order", `Cancelled outstanding ${state.symbol} exit order`);
    } catch (error) {
      this.tradeLog.push("warn", `cancelOrder for ${state.symbol} failed: ${extractMessage(error)}`);
    }
  }

  private async safeClosePosition(leg: "grvt" | "bingx"): Promise<void> {
    const state = leg === "grvt" ? this.grvtState : this.bingxState;
    const adapter = leg === "grvt" ? this.grvt : this.bingx;
    const position = getPosition(state.account, state.symbol);
    const qty = this.normalizeQuantity(Math.abs(position.positionAmt), state.precision.qtyStep, state.precision.qtyDecimals);
    if (qty <= 0) return;
    const side = position.positionAmt > 0 ? "SELL" : "BUY";
    try {
      await routeMarketOrder({
        adapter,
        symbol: state.symbol,
        side,
        quantity: qty,
        reduceOnly: true,
        closePosition: true,
      });
      this.tradeLog.push("close", `安全关闭 ${state.symbol} 仓位: ${side} ${qty}`);
    } catch (error) {
      this.tradeLog.push("error", `安全平仓 ${state.symbol} 失败: ${extractMessage(error)}`);
    }
  }

  private isReady(): boolean {
    return (
      this.feedReady.grvtAccount &&
      this.feedReady.grvtOrders &&
      this.feedReady.grvtDepth &&
      this.feedReady.bingxAccount &&
      this.feedReady.bingxOrders &&
      this.feedReady.bingxDepth
    );
  }

  private isFlat(): boolean {
    const grvtPosition = getPosition(this.grvtState.account, this.grvtState.symbol);
    const bingxPosition = getPosition(this.bingxState.account, this.bingxState.symbol);
    return (
      Math.abs(grvtPosition.positionAmt) <= this.positionTolerance() &&
      Math.abs(bingxPosition.positionAmt) <= this.positionTolerance()
    );
  }

  private minFilledThreshold(): number {
    return this.config.tradeAmount * 0.8;
  }

  private positionTolerance(): number {
    return Math.max(this.config.tradeAmount * 0.05, POSITION_EPS);
  }

  private normalizeQuantity(amount: number, step: number, decimals: number): number {
    if (!Number.isFinite(amount)) return 0;
    if (amount <= 0) return 0;
    if (!Number.isFinite(step) || step <= 0) {
      return Number(amount.toFixed(decimals));
    }
    let normalized = roundQtyDownToStep(amount, step);
    if (normalized <= 0) {
      normalized = step;
    }
    return Number(normalized.toFixed(decimals));
  }

  private normalizePrice(price: number, tick: number, side: "BUY" | "SELL", decimals: number): number {
    if (!Number.isFinite(price)) return price;
    if (!Number.isFinite(tick) || tick <= 0) {
      return Number(price.toFixed(decimals));
    }
    const scaled = price / tick;
    let units = side === "BUY" ? Math.ceil(scaled) : Math.floor(scaled);
    if (units <= 0) {
      units = 1;
    }
    const normalized = units * tick;
    return Number(normalized.toFixed(decimals));
  }

  private estimateDecimals(step: number): number {
    if (!Number.isFinite(step)) return 4;
    const text = step.toString();
    if (!text.includes(".")) return 0;
    return Math.min(12, text.split(".")[1]?.length ?? 0);
  }

  private buildSnapshot(): GrvtBingxHedgeSnapshot {
    const grvtPosition = getPosition(this.grvtState.account, this.grvtState.symbol);
    const bingxPosition = getPosition(this.bingxState.account, this.bingxState.symbol);
    const grvtLast = getMidOrLast(this.grvtState.depth, this.grvtState.ticker);
    const bingxLast = getMidOrLast(this.bingxState.depth, this.bingxState.ticker);

    return {
      ready: this.isReady(),
      phase: this.phase,
      tradeAmount: this.config.tradeAmount,
      targetRoiPct: this.config.targetRoiPct,
      averageEntryPrice: this.averageEntryPrice,
      grvtExitPrice: this.exitTargets.grvt,
      bingxExitPrice: this.exitTargets.bingx,
      grvt: {
        symbol: this.grvtState.symbol,
        position: grvtPosition,
        topBid: this.grvtState.topBid,
        topAsk: this.grvtState.topAsk,
        openOrders: [...this.grvtState.openOrders],
        exitOrderId: this.exitOrderIds.grvt,
        markPrice: grvtPosition.markPrice,
        lastPrice: grvtLast,
      },
      bingx: {
        symbol: this.bingxState.symbol,
        position: bingxPosition,
        topBid: this.bingxState.topBid,
        topAsk: this.bingxState.topAsk,
        openOrders: [...this.bingxState.openOrders],
        exitOrderId: this.exitOrderIds.bingx,
        markPrice: bingxPosition.markPrice,
        lastPrice: bingxLast,
      },
      tradeLog: this.tradeLog.all(),
      feedStatus: { ...this.feedReady },
      lastUpdated: Date.now(),
    };
  }

  private emitUpdate(): void {
    const snapshot = this.buildSnapshot();
    this.events.emit("update", snapshot, (error) => {
      this.tradeLog.push("error", `Hedge update listener failed: ${extractMessage(error)}`);
    });
  }
}
