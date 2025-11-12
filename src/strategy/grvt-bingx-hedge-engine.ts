import { grvtBingxHedgeConfig, type GrvtBingxHedgeConfig } from "../config";
import { GrvtExchangeAdapter } from "../exchanges/grvt/adapter";
import { BingxExchangeAdapter } from "../exchanges/bingx/adapter";
import type { ExchangeAdapter } from "../exchanges/adapter";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterOrder,
  AsterTicker,
  ExchangePrecision,
  OrderSide,
} from "../exchanges/types";
import { createTradeLog, type TradeLogEntry } from "../logging/trade-log";
import { StrategyEventEmitter } from "./common/event-emitter";
import { safeSubscribe, type LogHandler } from "./common/subscriptions";
import { extractMessage } from "../utils/errors";
import { getPosition, type PositionSnapshot } from "../utils/strategy";
import { isNearlyZero, roundDownToTick, roundQtyDownToStep } from "../utils/math";

export interface HedgeExitOrderSnapshot {
  side: OrderSide;
  price: number;
  quantity: number;
  tag: "take-profit" | "stop-loss";
}

export interface HedgeFeedStatus {
  account: boolean;
  orders: boolean;
  depth: boolean;
  ticker: boolean;
}

export interface GrvtBingxHedgeSnapshot {
  ready: boolean;
  status: "initializing" | "entering" | "hedging" | "flat";
  grvtSymbol: string;
  bingxSymbol: string;
  grvtPosition: PositionSnapshot;
  bingxPosition: PositionSnapshot;
  entryAveragePrice: number | null;
  targetRoiPct: number;
  targetOffsetPrice: number | null;
  grvtExitOrders: HedgeExitOrderSnapshot[];
  bingxExitOrders: HedgeExitOrderSnapshot[];
  grvtFeeds: HedgeFeedStatus;
  bingxFeeds: HedgeFeedStatus;
  tradeLog: TradeLogEntry[];
  lastUpdated: number | null;
}

type HedgeEvent = "update";
type HedgeListener = (snapshot: GrvtBingxHedgeSnapshot) => void;

interface ExchangeState {
  account: AsterAccountSnapshot | null;
  orders: AsterOrder[];
  depth: AsterDepth | null;
  ticker: AsterTicker | null;
  feedReady: HedgeFeedStatus;
  precision: ExchangePrecision | null;
  precisionSync: Promise<void> | null;
  entryInFlight: boolean;
  lastDesiredOrders: HedgeExitOrderSnapshot[];
}

interface ExitOrderPlan {
  side: OrderSide;
  price: number;
  quantity: number;
  tag: "take-profit" | "stop-loss";
}

const EPSILON = 1e-8;
const PRICE_TOLERANCE = 1e-8;

export class GrvtBingxHedgeEngine {
  private readonly config: GrvtBingxHedgeConfig;
  private readonly grvt: GrvtExchangeAdapter;
  private readonly bingx: BingxExchangeAdapter;
  private readonly events = new StrategyEventEmitter<HedgeEvent, GrvtBingxHedgeSnapshot>();
  private readonly tradeLog: ReturnType<typeof createTradeLog>;

  private readonly grvtState: ExchangeState = {
    account: null,
    orders: [],
    depth: null,
    ticker: null,
    feedReady: { account: false, orders: false, depth: false, ticker: false },
    precision: null,
    precisionSync: null,
    entryInFlight: false,
    lastDesiredOrders: [],
  };

  private readonly bingxState: ExchangeState = {
    account: null,
    orders: [],
    depth: null,
    ticker: null,
    feedReady: { account: false, orders: false, depth: false, ticker: false },
    precision: null,
    precisionSync: null,
    entryInFlight: false,
    lastDesiredOrders: [],
  };

  private entryAveragePrice: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private lastStatus: GrvtBingxHedgeSnapshot["status"] = "initializing";

  constructor(config: GrvtBingxHedgeConfig = grvtBingxHedgeConfig) {
    this.config = config;
    this.tradeLog = createTradeLog(this.config.maxLogEntries);
    this.grvt = new GrvtExchangeAdapter({ symbol: this.config.grvtSymbol });
    this.bingx = new BingxExchangeAdapter({ symbol: this.config.bingxSymbol });
    this.bootstrap();
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

  private bootstrap(): void {
    this.syncPrecisions();
    this.attachGrvtStreams();
    this.attachBingxStreams();
  }

  private syncPrecisions(): void {
    const sync = async (state: ExchangeState, adapter: { getPrecision?: () => Promise<ExchangePrecision | null> }, label: string) => {
      if (!adapter.getPrecision || state.precisionSync) return;
      state.precisionSync = adapter
        .getPrecision()
        .then((precision) => {
          if (precision) {
            state.precision = precision;
            this.tradeLog.push("info", `${label} precision synced: priceTick=${precision.priceTick} qtyStep=${precision.qtyStep}`);
          }
        })
        .catch((error) => {
          this.tradeLog.push("error", `${label} precision sync failed: ${extractMessage(error)}`);
        })
        .finally(() => {
          state.precisionSync = null;
        });
    };
    void sync(this.grvtState, this.grvt, "GRVT");
    void sync(this.bingxState, this.bingx, "BingX");
  }

  private attachGrvtStreams(): void {
    const log: LogHandler = (type, detail) => this.tradeLog.push(type, detail);
    const symbol = this.config.grvtSymbol;

    safeSubscribe<AsterAccountSnapshot>(
      this.grvt.watchAccount.bind(this.grvt),
      (snapshot) => {
        this.grvtState.account = snapshot;
        if (!this.grvtState.feedReady.account) {
          this.tradeLog.push("info", "GRVT account ready");
        }
        this.grvtState.feedReady.account = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 GRVT 账户失败: ${String(error)}`,
        processFail: (error) => `处理 GRVT 账户推送异常: ${String(error)}`,
      }
    );

    safeSubscribe<AsterOrder[]>(
      this.grvt.watchOrders.bind(this.grvt),
      (orders) => {
        this.grvtState.orders = Array.isArray(orders) ? orders.filter((order) => order.symbol === symbol) : [];
        if (!this.grvtState.feedReady.orders) {
          this.tradeLog.push("info", "GRVT orders stream ready");
        }
        this.grvtState.feedReady.orders = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 GRVT 订单失败: ${String(error)}`,
        processFail: (error) => `处理 GRVT 订单推送异常: ${String(error)}`,
      }
    );

    safeSubscribe<AsterDepth>(
      this.grvt.watchDepth.bind(this.grvt, symbol),
      (depth) => {
        this.grvtState.depth = depth;
        if (!this.grvtState.feedReady.depth) {
          this.tradeLog.push("info", "GRVT depth ready");
        }
        this.grvtState.feedReady.depth = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 GRVT 深度失败: ${String(error)}`,
        processFail: (error) => `处理 GRVT 深度推送异常: ${String(error)}`,
      }
    );

    safeSubscribe<AsterTicker>(
      this.grvt.watchTicker.bind(this.grvt, symbol),
      (ticker) => {
        this.grvtState.ticker = ticker;
        if (!this.grvtState.feedReady.ticker) {
          this.tradeLog.push("info", "GRVT ticker ready");
        }
        this.grvtState.feedReady.ticker = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 GRVT Ticker 失败: ${String(error)}`,
        processFail: (error) => `处理 GRVT Ticker 推送异常: ${String(error)}`,
      }
    );
  }

  private attachBingxStreams(): void {
    const log: LogHandler = (type, detail) => this.tradeLog.push(type, detail);
    const symbol = this.config.bingxSymbol;

    safeSubscribe<AsterAccountSnapshot>(
      this.bingx.watchAccount.bind(this.bingx),
      (snapshot) => {
        this.bingxState.account = snapshot;
        if (!this.bingxState.feedReady.account) {
          this.tradeLog.push("info", "BingX account ready");
        }
        this.bingxState.feedReady.account = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 BingX 账户失败: ${String(error)}`,
        processFail: (error) => `处理 BingX 账户推送异常: ${String(error)}`,
      }
    );

    safeSubscribe<AsterOrder[]>(
      this.bingx.watchOrders.bind(this.bingx),
      (orders) => {
        this.bingxState.orders = Array.isArray(orders) ? orders.filter((order) => order.symbol === symbol) : [];
        if (!this.bingxState.feedReady.orders) {
          this.tradeLog.push("info", "BingX orders stream ready");
        }
        this.bingxState.feedReady.orders = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 BingX 订单失败: ${String(error)}`,
        processFail: (error) => `处理 BingX 订单推送异常: ${String(error)}`,
      }
    );

    safeSubscribe<AsterDepth>(
      this.bingx.watchDepth.bind(this.bingx, symbol),
      (depth) => {
        this.bingxState.depth = depth;
        if (!this.bingxState.feedReady.depth) {
          this.tradeLog.push("info", "BingX depth ready");
        }
        this.bingxState.feedReady.depth = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 BingX 深度失败: ${String(error)}`,
        processFail: (error) => `处理 BingX 深度推送异常: ${String(error)}`,
      }
    );

    safeSubscribe<AsterTicker>(
      this.bingx.watchTicker.bind(this.bingx, symbol),
      (ticker) => {
        this.bingxState.ticker = ticker;
        if (!this.bingxState.feedReady.ticker) {
          this.tradeLog.push("info", "BingX ticker ready");
        }
        this.bingxState.feedReady.ticker = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅 BingX Ticker 失败: ${String(error)}`,
        processFail: (error) => `处理 BingX Ticker 推送异常: ${String(error)}`,
      }
    );
  }

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const grvtReady = this.isFeedReady(this.grvtState.feedReady);
      const bingxReady = this.isFeedReady(this.bingxState.feedReady);
      if (!grvtReady || !bingxReady) {
        this.updateStatus("initializing");
        this.emitUpdate();
        return;
      }

      const grvtPosition = getPosition(this.grvtState.account, this.config.grvtSymbol);
      const bingxPosition = getPosition(this.bingxState.account, this.config.bingxSymbol);

      if (this.config.autoEnter) {
        await this.ensureGrvtPosition(grvtPosition);
        await this.ensureBingxPosition(bingxPosition);
      }

      const refreshedGrvtPosition = getPosition(this.grvtState.account, this.config.grvtSymbol);
      const refreshedBingxPosition = getPosition(this.bingxState.account, this.config.bingxSymbol);

      const hasGrvtExposure = !isNearlyZero(refreshedGrvtPosition.positionAmt, this.config.positionTolerance);
      const hasBingxExposure = !isNearlyZero(refreshedBingxPosition.positionAmt, this.config.positionTolerance);

      if (hasGrvtExposure && hasBingxExposure) {
        this.entryAveragePrice = this.computeEntryAverage(refreshedGrvtPosition.entryPrice, refreshedBingxPosition.entryPrice);
        await this.syncExitOrders(refreshedGrvtPosition, refreshedBingxPosition);
        this.updateStatus("hedging");
      } else {
        this.entryAveragePrice = null;
        await Promise.all([this.clearReduceOnlyOrders("GRVT"), this.clearReduceOnlyOrders("BingX")]);
        this.updateStatus("flat");
      }

      this.emitUpdate();
    } catch (error) {
      this.tradeLog.push("error", `Hedge tick failed: ${extractMessage(error)}`);
    } finally {
      this.processing = false;
    }
  }

  private async ensureGrvtPosition(position: PositionSnapshot): Promise<void> {
    if (this.grvtState.entryInFlight) return;
    const target = this.config.orderSize;
    const tolerance = Math.max(this.config.positionTolerance, EPSILON);
    const current = position.positionAmt;
    const diff = target - current;
    if (diff > tolerance) {
      await this.placeGrvtOrder("BUY", diff);
      this.updateStatus("entering");
    } else if (diff < -tolerance) {
      await this.placeGrvtOrder("SELL", Math.abs(diff));
      this.updateStatus("entering");
    }
  }

  private async ensureBingxPosition(position: PositionSnapshot): Promise<void> {
    if (this.bingxState.entryInFlight) return;
    const target = -this.config.orderSize;
    const tolerance = Math.max(this.config.positionTolerance, EPSILON);
    const current = position.positionAmt;
    const diff = current - target;
    if (diff > tolerance) {
      await this.placeBingxOrder("SELL", diff);
      this.updateStatus("entering");
    } else if (diff < -tolerance) {
      await this.placeBingxOrder("BUY", Math.abs(diff));
      this.updateStatus("entering");
    }
  }

  private async placeGrvtOrder(side: OrderSide, quantity: number): Promise<void> {
    const qty = this.normalizeQuantity(quantity, this.grvtState.precision?.qtyStep);
    if (!Number.isFinite(qty) || qty <= 0) return;
    this.grvtState.entryInFlight = true;
    try {
      await this.grvt.createOrder({
        symbol: this.config.grvtSymbol,
        side,
        type: "MARKET",
        quantity: qty,
      });
      this.tradeLog.push("order", `GRVT ${side} MARKET ${qty}`);
    } catch (error) {
      this.tradeLog.push("error", `GRVT ${side} failed: ${extractMessage(error)}`);
    } finally {
      this.grvtState.entryInFlight = false;
    }
  }

  private async placeBingxOrder(side: OrderSide, quantity: number): Promise<void> {
    const qty = this.normalizeQuantity(quantity, this.bingxState.precision?.qtyStep);
    if (!Number.isFinite(qty) || qty <= 0) return;
    this.bingxState.entryInFlight = true;
    try {
      await this.bingx.createOrder({
        symbol: this.config.bingxSymbol,
        side,
        type: "MARKET",
        quantity: qty,
      });
      this.tradeLog.push("order", `BingX ${side} MARKET ${qty}`);
    } catch (error) {
      this.tradeLog.push("error", `BingX ${side} failed: ${extractMessage(error)}`);
    } finally {
      this.bingxState.entryInFlight = false;
    }
  }

  private async syncExitOrders(grvtPosition: PositionSnapshot, bingxPosition: PositionSnapshot): Promise<void> {
    if (!this.entryAveragePrice || this.entryAveragePrice <= 0) return;
    const targetOffset = this.entryAveragePrice * (this.config.targetRoiPct / 100);
    const grvtDesired = this.buildGrvtExitOrders(grvtPosition, targetOffset);
    const bingxDesired = this.buildBingxExitOrders(bingxPosition, targetOffset);
    await Promise.all([
      this.syncReduceOnlyOrders(
        "GRVT",
        this.grvt,
        this.config.grvtSymbol,
        this.grvtState,
        grvtDesired
      ),
      this.syncReduceOnlyOrders(
        "BingX",
        this.bingx,
        this.config.bingxSymbol,
        this.bingxState,
        bingxDesired
      ),
    ]);
  }

  private buildGrvtExitOrders(position: PositionSnapshot, offset: number): ExitOrderPlan[] {
    const quantityRaw = Math.abs(position.positionAmt);
    const quantity = this.normalizeQuantity(quantityRaw, this.grvtState.precision?.qtyStep);
    if (quantity <= 0 || !Number.isFinite(this.entryAveragePrice ?? NaN)) return [];
    const tick = this.grvtState.precision?.priceTick ?? 0;
    const profitPrice = this.adjustPrice((this.entryAveragePrice ?? 0) + offset, tick, "up");
    const stopPrice = this.adjustPrice(Math.max(0, (this.entryAveragePrice ?? 0) - offset), tick, "down");
    const orders: ExitOrderPlan[] = [];
    if (profitPrice > 0) {
      orders.push({ side: "SELL", price: profitPrice, quantity, tag: "take-profit" });
    }
    if (stopPrice > 0) {
      orders.push({ side: "SELL", price: stopPrice, quantity, tag: "stop-loss" });
    }
    return orders;
  }

  private buildBingxExitOrders(position: PositionSnapshot, offset: number): ExitOrderPlan[] {
    const quantityRaw = Math.abs(position.positionAmt);
    const quantity = this.normalizeQuantity(quantityRaw, this.bingxState.precision?.qtyStep);
    if (quantity <= 0 || !Number.isFinite(this.entryAveragePrice ?? NaN)) return [];
    const tick = this.bingxState.precision?.priceTick ?? 0;
    const profitPrice = this.adjustPrice(Math.max(0, (this.entryAveragePrice ?? 0) - offset), tick, "down");
    const stopPrice = this.adjustPrice((this.entryAveragePrice ?? 0) + offset, tick, "up");
    const orders: ExitOrderPlan[] = [];
    if (profitPrice > 0) {
      orders.push({ side: "BUY", price: profitPrice, quantity, tag: "take-profit" });
    }
    if (stopPrice > 0) {
      orders.push({ side: "BUY", price: stopPrice, quantity, tag: "stop-loss" });
    }
    return orders;
  }

  private async syncReduceOnlyOrders(
    label: "GRVT" | "BingX",
    adapter: Pick<ExchangeAdapter, "createOrder" | "cancelOrder">,
    symbol: string,
    state: ExchangeState,
    desired: ExitOrderPlan[]
  ): Promise<void> {
    const existing = state.orders.filter((order) => order.symbol === symbol && order.reduceOnly);
    const matched = new Set<number>();
    const tolerance = state.precision?.priceTick ?? PRICE_TOLERANCE;
    const qtyTolerance = state.precision?.qtyStep ?? this.config.positionTolerance;

    for (const plan of desired) {
      const idx = existing.findIndex((order, index) => {
        if (matched.has(index)) return false;
        if (order.side !== plan.side) return false;
        const orderPrice = Number(order.price);
        const planPrice = plan.price;
        if (!Number.isFinite(orderPrice) || !Number.isFinite(planPrice)) return false;
        if (Math.abs(orderPrice - planPrice) > tolerance + PRICE_TOLERANCE) return false;
        const orderQty = Number(order.origQty);
        if (!Number.isFinite(orderQty)) return false;
        if (Math.abs(orderQty - plan.quantity) > qtyTolerance + EPSILON) return false;
        return true;
      });
      if (idx >= 0) {
        matched.add(idx);
      }
    }

    const cancelPromises = existing
      .filter((_order, index) => !matched.has(index))
      .map(async (order) => {
        try {
          await adapter.cancelOrder({ symbol, orderId: order.orderId });
          this.tradeLog.push("order", `${label} cancel ${order.side} @ ${order.price}`);
        } catch (error) {
          this.tradeLog.push("error", `${label} cancel failed: ${extractMessage(error)}`);
        }
      });

    if (cancelPromises.length) {
      await Promise.all(cancelPromises);
    }

    for (const plan of desired) {
      const exists = existing.some((order) => {
        const orderPrice = Number(order.price);
        if (order.side !== plan.side) return false;
        if (!Number.isFinite(orderPrice) || Math.abs(orderPrice - plan.price) > tolerance + PRICE_TOLERANCE) {
          return false;
        }
        const orderQty = Number(order.origQty);
        if (!Number.isFinite(orderQty)) return false;
        return Math.abs(orderQty - plan.quantity) <= qtyTolerance + EPSILON;
      });
      if (exists) continue;
      try {
        await adapter.createOrder({
          symbol,
          side: plan.side,
          type: "LIMIT",
          quantity: plan.quantity,
          price: plan.price,
          timeInForce: "GTC",
          reduceOnly: "true",
        });
        this.tradeLog.push("order", `${label} place ${plan.tag} ${plan.side} @ ${plan.price} qty=${plan.quantity}`);
      } catch (error) {
        this.tradeLog.push("error", `${label} place ${plan.tag} failed: ${extractMessage(error)}`);
      }
    }

    state.lastDesiredOrders = desired.map((item) => ({ ...item }));
  }

  private async clearReduceOnlyOrders(label: "GRVT" | "BingX"): Promise<void> {
    const state = label === "GRVT" ? this.grvtState : this.bingxState;
    const adapter = label === "GRVT" ? this.grvt : this.bingx;
    const symbol = label === "GRVT" ? this.config.grvtSymbol : this.config.bingxSymbol;
    const reduceOnlyOrders = state.orders.filter((order) => order.symbol === symbol && order.reduceOnly);
    if (!reduceOnlyOrders.length) {
      state.lastDesiredOrders = [];
      return;
    }
    const tasks = reduceOnlyOrders.map(async (order) => {
      try {
        await adapter.cancelOrder({ symbol, orderId: order.orderId });
        this.tradeLog.push("order", `${label} cleared reduce-only order ${order.side} @ ${order.price}`);
      } catch (error) {
        this.tradeLog.push("error", `${label} clear reduce-only failed: ${extractMessage(error)}`);
      }
    });
    await Promise.all(tasks);
    state.lastDesiredOrders = [];
  }

  private computeEntryAverage(grvtEntry: number, bingxEntry: number): number | null {
    if (!Number.isFinite(grvtEntry) || grvtEntry <= 0) return null;
    if (!Number.isFinite(bingxEntry) || bingxEntry <= 0) return null;
    const average = (grvtEntry + bingxEntry) / 2;
    if (!Number.isFinite(average) || average <= 0) return null;
    return average;
  }

  private normalizeQuantity(quantity: number, step?: number): number {
    const STEP_EPS = 1e-12;
    if (!Number.isFinite(quantity) || quantity <= 0) return 0;
    if (!Number.isFinite(step) || (step ?? 0) <= STEP_EPS) {
      return Number(quantity.toFixed(8));
    }
    const rounded = roundQtyDownToStep(quantity, step!);
    if (rounded <= 0) {
      return 0;
    }
    return Number(rounded.toFixed(8));
  }

  private adjustPrice(price: number, tick: number, direction: "up" | "down"): number {
    if (!Number.isFinite(price) || price <= 0) return 0;
    if (!Number.isFinite(tick) || tick <= 0) {
      return Number(price.toFixed(8));
    }
    if (direction === "down") {
      const rounded = roundDownToTick(price, tick);
      return Math.max(0, Number(rounded.toFixed(8)));
    }
    const steps = Math.ceil(price / tick);
    const adjusted = steps * tick;
    return Math.max(0, Number(adjusted.toFixed(8)));
  }

  private isFeedReady(status: HedgeFeedStatus): boolean {
    return status.account && status.orders && status.depth && status.ticker;
  }

  private updateStatus(next: GrvtBingxHedgeSnapshot["status"]): void {
    if (this.lastStatus !== next) {
      this.lastStatus = next;
      this.tradeLog.push("info", `状态切换: ${next}`);
    }
  }

  private buildSnapshot(): GrvtBingxHedgeSnapshot {
    const grvtPosition = getPosition(this.grvtState.account, this.config.grvtSymbol);
    const bingxPosition = getPosition(this.bingxState.account, this.config.bingxSymbol);
    const ready = this.isFeedReady(this.grvtState.feedReady) && this.isFeedReady(this.bingxState.feedReady);
    const targetOffset = this.entryAveragePrice != null
      ? this.entryAveragePrice * (this.config.targetRoiPct / 100)
      : null;

    return {
      ready,
      status: this.lastStatus,
      grvtSymbol: this.config.grvtSymbol,
      bingxSymbol: this.config.bingxSymbol,
      grvtPosition,
      bingxPosition,
      entryAveragePrice: this.entryAveragePrice,
      targetRoiPct: this.config.targetRoiPct,
      targetOffsetPrice: targetOffset,
      grvtExitOrders: this.grvtState.lastDesiredOrders.map((order) => ({ ...order })),
      bingxExitOrders: this.bingxState.lastDesiredOrders.map((order) => ({ ...order })),
      grvtFeeds: { ...this.grvtState.feedReady },
      bingxFeeds: { ...this.bingxState.feedReady },
      tradeLog: this.tradeLog.all(),
      lastUpdated: Date.now(),
    };
  }

  private emitUpdate(): void {
    const snapshot = this.buildSnapshot();
    this.events.emit("update", snapshot, (error) => {
      this.tradeLog.push("error", `Update notification failed: ${extractMessage(error)}`);
    });
  }
}
