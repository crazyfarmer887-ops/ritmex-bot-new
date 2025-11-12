import { setTimeout, clearTimeout } from "timers";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterOrder,
  AsterTicker,
  ExchangePrecision,
} from "../exchanges/types";
import type { ExchangeAdapter } from "../exchanges/adapter";
import { GrvtExchangeAdapter } from "../exchanges/grvt/adapter";
import { BingxExchangeAdapter } from "../exchanges/bingx/adapter";
import { createTradeLog, type TradeLogEntry } from "../logging/trade-log";
import { StrategyEventEmitter } from "./common/event-emitter";
import { safeSubscribe, type LogHandler } from "./common/subscriptions";
import { getPosition, type PositionSnapshot } from "../utils/strategy";
import { formatNumber } from "../utils/format";
import { extractMessage } from "../utils/errors";
import type { HedgedVolumeConfig } from "../config";

export type HedgedVolumeStatus =
  | "idle"
  | "waiting-market"
  | "entering"
  | "waiting-fill"
  | "placing-exits"
  | "monitoring"
  | "completed"
  | "stopped"
  | "error";

export interface HedgedVolumeSnapshot {
  ready: boolean;
  status: HedgedVolumeStatus;
  grvtSymbol: string;
  bingxSymbol: string;
  grvtPosition: PositionSnapshot;
  bingxPosition: PositionSnapshot;
  avgEntryPrice: number | null;
  targetUpperPrice: number | null;
  targetLowerPrice: number | null;
  roiTargetPct: number;
  leverageAbs: number;
  entrySubmitted: boolean;
  exitSubmitted: boolean;
  tradeLog: TradeLogEntry[];
  grvtOpenOrders: AsterOrder[];
  bingxOpenOrders: AsterOrder[];
  lastUpdated: number | null;
  lastError: string | null;
}

type HedgedVolumeEvent = "update";
type HedgedVolumeListener = (snapshot: HedgedVolumeSnapshot) => void;

interface HedgedVolumeAdapters {
  grvt?: ExchangeAdapter;
  bingx?: ExchangeAdapter;
}

interface OrderIdMap {
  grvt?: string;
  bingx?: string;
}

export class HedgedVolumeEngine {
  private readonly events = new StrategyEventEmitter<HedgedVolumeEvent, HedgedVolumeSnapshot>();
  private readonly tradeLog = createTradeLog(this.config.maxLogEntries);
  private readonly grvt: ExchangeAdapter;
  private readonly bingx: ExchangeAdapter;
  private readonly positionTolerance: number;
  private readonly pendingOrderIds: Record<"grvt" | "bingx", Set<string>> = {
    grvt: new Set(),
    bingx: new Set(),
  };

  private grvtAccount: AsterAccountSnapshot | null = null;
  private bingxAccount: AsterAccountSnapshot | null = null;
  private grvtDepth: AsterDepth | null = null;
  private bingxDepth: AsterDepth | null = null;
  private grvtTicker: AsterTicker | null = null;
  private bingxTicker: AsterTicker | null = null;
  private grvtOpenOrders: AsterOrder[] = [];
  private bingxOpenOrders: AsterOrder[] = [];
  private grvtPrecision: ExchangePrecision | null = null;
  private bingxPrecision: ExchangePrecision | null = null;

  private entryOrderIds: OrderIdMap = {};
  private exitOrderIds: OrderIdMap = {};
  private avgEntryPrice: number | null = null;
  private targetUpperPrice: number | null = null;
  private targetLowerPrice: number | null = null;

  private entrySubmitted = false;
  private exitSubmitted = false;
  private status: HedgedVolumeStatus = "idle";
  private lastError: string | null = null;
  private running = false;
  private processing = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdated: number | null = null;

  constructor(private readonly config: HedgedVolumeConfig, adapters?: HedgedVolumeAdapters) {
    this.grvt = adapters?.grvt ?? new GrvtExchangeAdapter({ symbol: config.grvtSymbol });
    this.bingx = adapters?.bingx ?? new BingxExchangeAdapter({ symbol: config.bingxSymbol });
    this.positionTolerance = Math.max(this.config.quantity * 0.02, 1e-6);
    this.bootstrap();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tradeLog.push("info", "Hedged volume engine started");
    this.scheduleTick(0);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    void this.cancelTrackedOrders();
    this.status = "stopped";
    this.tradeLog.push("info", "Engine stopped by user");
    this.emitUpdate();
  }

  on(event: HedgedVolumeEvent, handler: HedgedVolumeListener): void {
    this.events.on(event, handler);
  }

  off(event: HedgedVolumeEvent, handler: HedgedVolumeListener): void {
    this.events.off(event, handler);
  }

  getSnapshot(): HedgedVolumeSnapshot {
    return this.buildSnapshot();
  }

  private bootstrap(): void {
    const logGrvt: LogHandler = (type, detail) => this.tradeLog.push(type, `[GRVT] ${detail}`);
    const logBingx: LogHandler = (type, detail) => this.tradeLog.push(type, `[BingX] ${detail}`);

    safeSubscribe<AsterAccountSnapshot>(
      this.grvt.watchAccount.bind(this.grvt),
      (snapshot) => {
        this.grvtAccount = snapshot;
        this.emitUpdate();
      },
      logGrvt,
      {
        subscribeFail: (error) => `账户订阅失败: ${extractMessage(error)}`,
        processFail: (error) => `账户推送处理异常: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterAccountSnapshot>(
      this.bingx.watchAccount.bind(this.bingx),
      (snapshot) => {
        this.bingxAccount = snapshot;
        this.emitUpdate();
      },
      logBingx,
      {
        subscribeFail: (error) => `账户订阅失败: ${extractMessage(error)}`,
        processFail: (error) => `账户推送处理异常: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterOrder[]>(
      this.grvt.watchOrders.bind(this.grvt),
      (orders) => {
        this.grvtOpenOrders = Array.isArray(orders) ? orders : [];
        this.reconcileTrackedOrders("grvt", this.grvtOpenOrders);
        this.emitUpdate();
      },
      logGrvt,
      {
        subscribeFail: (error) => `订单订阅失败: ${extractMessage(error)}`,
        processFail: (error) => `订单推送处理异常: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterOrder[]>(
      this.bingx.watchOrders.bind(this.bingx),
      (orders) => {
        this.bingxOpenOrders = Array.isArray(orders) ? orders : [];
        this.reconcileTrackedOrders("bingx", this.bingxOpenOrders);
        this.emitUpdate();
      },
      logBingx,
      {
        subscribeFail: (error) => `订单订阅失败: ${extractMessage(error)}`,
        processFail: (error) => `订单推送处理异常: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterDepth>(
      this.grvt.watchDepth.bind(this.grvt, this.config.grvtSymbol),
      (depth) => {
        this.grvtDepth = depth;
        this.emitUpdate();
      },
      logGrvt,
      {
        subscribeFail: (error) => `深度订阅失败: ${extractMessage(error)}`,
        processFail: (error) => `深度推送处理异常: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterDepth>(
      this.bingx.watchDepth.bind(this.bingx, this.config.bingxSymbol),
      (depth) => {
        this.bingxDepth = depth;
        this.emitUpdate();
      },
      logBingx,
      {
        subscribeFail: (error) => `深度订阅失败: ${extractMessage(error)}`,
        processFail: (error) => `深度推送处理异常: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterTicker>(
      this.grvt.watchTicker.bind(this.grvt, this.config.grvtSymbol),
      (ticker) => {
        this.grvtTicker = ticker;
        this.emitUpdate();
      },
      logGrvt,
      {
        subscribeFail: (error) => `Ticker 订阅失败: ${extractMessage(error)}`,
        processFail: (error) => `Ticker 推送处理异常: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<AsterTicker>(
      this.bingx.watchTicker.bind(this.bingx, this.config.bingxSymbol),
      (ticker) => {
        this.bingxTicker = ticker;
        this.emitUpdate();
      },
      logBingx,
      {
        subscribeFail: (error) => `Ticker 订阅失败: ${extractMessage(error)}`,
        processFail: (error) => `Ticker 推送处理异常: ${extractMessage(error)}`,
      }
    );

    void this.syncPrecision();
  }

  private async syncPrecision(): Promise<void> {
    try {
      this.grvtPrecision = (await this.grvt.getPrecision?.()) ?? null;
    } catch (error) {
      this.tradeLog.push("warn", `[GRVT] 同步精度失败: ${extractMessage(error)}`);
    }
    try {
      this.bingxPrecision = (await this.bingx.getPrecision?.()) ?? null;
    } catch (error) {
      this.tradeLog.push("warn", `[BingX] 同步精度失败: ${extractMessage(error)}`);
    }
  }

  private scheduleTick(delay: number): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.tickTimer = setTimeout(() => void this.tick(), Math.max(0, delay));
  }

  private async tick(): Promise<void> {
    if (!this.running || this.processing) {
      this.scheduleTick(this.config.pollIntervalMs);
      return;
    }
    this.processing = true;

    try {
      const grvtPosition = getPosition(this.grvtAccount, this.config.grvtSymbol);
      const bingxPosition = getPosition(this.bingxAccount, this.config.bingxSymbol);
      const hasBothPositions = this.hasBothPositions(grvtPosition, bingxPosition);
      const bothFlat = this.isFlat(grvtPosition, bingxPosition);

      if (!this.entrySubmitted && hasBothPositions) {
        this.entrySubmitted = true;
        this.tradeLog.push("info", "检测到已有多空仓位，跳过开仓下单");
      }

      if (!this.entrySubmitted) {
        await this.trySubmitEntries();
      } else if (!this.exitSubmitted) {
        if (hasBothPositions && this.positionsReady(grvtPosition, bingxPosition)) {
          await this.trySubmitExits(grvtPosition, bingxPosition);
        } else {
          this.status = "waiting-fill";
        }
      } else {
        if (bothFlat) {
          this.status = "completed";
          this.exitSubmitted = false;
          this.tradeLog.push("close", "检测到双边仓位归零，策略完成");
        } else {
          this.status = "monitoring";
        }
      }
    } catch (error) {
      this.status = "error";
      this.lastError = extractMessage(error);
      this.tradeLog.push("error", `策略循环异常: ${this.lastError}`);
    } finally {
      this.lastUpdated = Date.now();
      this.processing = false;
      this.emitUpdate();
      if (this.running) {
        this.scheduleTick(this.config.pollIntervalMs);
      }
    }
  }

  private async trySubmitEntries(): Promise<void> {
    if (!this.marketReady()) {
      this.status = "waiting-market";
      return;
    }
    this.status = "entering";
    const plan = this.buildEntryPlan();
    let grvtOrder: AsterOrder | null = null;
    try {
      grvtOrder = await this.grvt.createOrder({
        symbol: this.config.grvtSymbol,
        side: "BUY",
        type: "LIMIT",
        quantity: this.config.quantity,
        price: plan.grvtPrice,
        timeInForce: this.config.entryTimeInForce,
      });
      this.trackOrder("grvt", grvtOrder.orderId);
      this.entryOrderIds.grvt = String(grvtOrder.orderId);
      this.tradeLog.push(
        "open",
        `GRVT 买入 ${formatNumber(this.config.quantity, 4)} @ ${formatNumber(plan.grvtPrice, 4)}`
      );
    } catch (error) {
      this.lastError = extractMessage(error);
      throw error;
    }

    try {
      const bingxOrder = await this.bingx.createOrder({
        symbol: this.config.bingxSymbol,
        side: "SELL",
        type: "LIMIT",
        quantity: this.config.quantity,
        price: plan.bingxPrice,
        timeInForce: this.config.entryTimeInForce,
      });
      this.trackOrder("bingx", bingxOrder.orderId);
      this.entryOrderIds.bingx = String(bingxOrder.orderId);
      this.tradeLog.push(
        "open",
        `BingX 卖出 ${formatNumber(this.config.quantity, 4)} @ ${formatNumber(plan.bingxPrice, 4)}`
      );
    } catch (error) {
      this.lastError = extractMessage(error);
      this.tradeLog.push("error", `BingX 开仓下单失败: ${this.lastError}`);
      if (grvtOrder) {
        await this.safeCancelOrder(this.grvt, this.config.grvtSymbol, grvtOrder.orderId);
      }
      throw error;
    }

    this.entrySubmitted = true;
    this.status = "waiting-fill";
  }

  private async trySubmitExits(grvtPosition: PositionSnapshot, bingxPosition: PositionSnapshot): Promise<void> {
    const grvtQty = Math.abs(grvtPosition.positionAmt);
    const bingxQty = Math.abs(bingxPosition.positionAmt);
    if (grvtQty < this.positionTolerance || bingxQty < this.positionTolerance) {
      this.status = "waiting-fill";
      return;
    }

    const grvtEntry = grvtPosition.entryPrice;
    const bingxEntry = Math.abs(bingxPosition.entryPrice);
    if (!Number.isFinite(grvtEntry) || !Number.isFinite(bingxEntry) || grvtEntry <= 0 || bingxEntry <= 0) {
      this.status = "waiting-fill";
      return;
    }

    const averageEntry = (grvtEntry + bingxEntry) / 2;
    if (!Number.isFinite(averageEntry) || averageEntry <= 0) {
      this.status = "waiting-fill";
      return;
    }

    const priceDeltaPct = this.config.targetAbsRoiPct / Math.max(1, this.config.leverageAbs);
    const priceDelta = averageEntry * (priceDeltaPct / 100);
    const upper = averageEntry + priceDelta;
    const lower = Math.max(1e-6, averageEntry - priceDelta);

    this.avgEntryPrice = averageEntry;
    this.targetUpperPrice = upper;
    this.targetLowerPrice = lower;

    this.status = "placing-exits";

    let grvtExit: AsterOrder | null = null;
    try {
      grvtExit = await this.grvt.createOrder({
        symbol: this.config.grvtSymbol,
        side: "SELL",
        type: "LIMIT",
        quantity: grvtQty,
        price: upper,
        timeInForce: this.config.exitTimeInForce,
        reduceOnly: "true",
      });
      this.trackOrder("grvt", grvtExit.orderId);
      this.exitOrderIds.grvt = String(grvtExit.orderId);
      this.tradeLog.push(
        "order",
        `GRVT 预设平仓单: 卖出 ${formatNumber(grvtQty, 4)} @ ${formatNumber(upper, 4)}`
      );
    } catch (error) {
      this.lastError = extractMessage(error);
      throw error;
    }

    try {
      const bingxExit = await this.bingx.createOrder({
        symbol: this.config.bingxSymbol,
        side: "BUY",
        type: "LIMIT",
        quantity: bingxQty,
        price: lower,
        timeInForce: this.config.exitTimeInForce,
        reduceOnly: "true",
      });
      this.trackOrder("bingx", bingxExit.orderId);
      this.exitOrderIds.bingx = String(bingxExit.orderId);
      this.tradeLog.push(
        "order",
        `BingX 预设平仓单: 买入 ${formatNumber(bingxQty, 4)} @ ${formatNumber(lower, 4)}`
      );
    } catch (error) {
      this.lastError = extractMessage(error);
      this.tradeLog.push("error", `BingX 平仓挂单失败: ${this.lastError}`);
      if (grvtExit) {
        await this.safeCancelOrder(this.grvt, this.config.grvtSymbol, grvtExit.orderId);
      }
      throw error;
    }

    this.exitSubmitted = true;
    this.status = "monitoring";
  }

  private marketReady(): boolean {
    const grvtPrice = this.getBestAsk(this.grvtDepth) ?? this.toNumber(this.grvtTicker?.lastPrice);
    const bingxPrice = this.getBestBid(this.bingxDepth) ?? this.toNumber(this.bingxTicker?.lastPrice);
    return Number.isFinite(grvtPrice) && grvtPrice > 0 && Number.isFinite(bingxPrice) && bingxPrice > 0;
  }

  private buildEntryPlan(): { grvtPrice: number; bingxPrice: number } {
    const slippage = Math.max(0, this.config.entrySlippageBps) / 10_000;
    const grvtBase = this.getBestAsk(this.grvtDepth) ?? this.toNumber(this.grvtTicker?.lastPrice);
    const bingxBase = this.getBestBid(this.bingxDepth) ?? this.toNumber(this.bingxTicker?.lastPrice);
    if (!Number.isFinite(grvtBase) || grvtBase <= 0 || !Number.isFinite(bingxBase) || bingxBase <= 0) {
      throw new Error("无法获取有效的盘口价格，无法提交开仓单");
    }
    const grvtPrice = grvtBase * (1 + slippage);
    const bingxPrice = bingxBase * (1 - slippage);
    return {
      grvtPrice: this.applyPricePrecision(grvtPrice, this.grvtPrecision),
      bingxPrice: this.applyPricePrecision(bingxPrice, this.bingxPrecision),
    };
  }

  private hasBothPositions(grvt: PositionSnapshot, bingx: PositionSnapshot): boolean {
    const grvtLong = grvt.positionAmt > this.positionTolerance;
    const bingxShort = bingx.positionAmt < -this.positionTolerance;
    return grvtLong && bingxShort;
  }

  private positionsReady(grvt: PositionSnapshot, bingx: PositionSnapshot): boolean {
    if (!this.hasBothPositions(grvt, bingx)) return false;
    return Number.isFinite(grvt.entryPrice) && grvt.entryPrice > 0 && Number.isFinite(bingx.entryPrice) && Math.abs(bingx.entryPrice) > 0;
  }

  private isFlat(grvt: PositionSnapshot, bingx: PositionSnapshot): boolean {
    return (
      Math.abs(grvt.positionAmt) < this.positionTolerance &&
      Math.abs(bingx.positionAmt) < this.positionTolerance
    );
  }

  private applyPricePrecision(price: number, precision: ExchangePrecision | null): number {
    if (!precision || !Number.isFinite(price)) return price;
    const tick = Number(precision.priceTick);
    if (!Number.isFinite(tick) || tick <= 0) return price;
    return Math.round(price / tick) * tick;
  }

  private getBestAsk(depth: AsterDepth | null): number | null {
    const price = this.toNumber(depth?.asks?.[0]?.[0]);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  private getBestBid(depth: AsterDepth | null): number | null {
    const price = this.toNumber(depth?.bids?.[0]?.[0]);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  private toNumber(value: unknown): number {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    return NaN;
  }

  private buildSnapshot(): HedgedVolumeSnapshot {
    const grvtPosition = getPosition(this.grvtAccount, this.config.grvtSymbol);
    const bingxPosition = getPosition(this.bingxAccount, this.config.bingxSymbol);
    return {
      ready: this.marketReady(),
      status: this.status,
      grvtSymbol: this.config.grvtSymbol,
      bingxSymbol: this.config.bingxSymbol,
      grvtPosition,
      bingxPosition,
      avgEntryPrice: this.avgEntryPrice,
      targetUpperPrice: this.targetUpperPrice,
      targetLowerPrice: this.targetLowerPrice,
      roiTargetPct: this.config.targetAbsRoiPct,
      leverageAbs: this.config.leverageAbs,
      entrySubmitted: this.entrySubmitted,
      exitSubmitted: this.exitSubmitted,
      tradeLog: this.tradeLog.all(),
      grvtOpenOrders: this.grvtOpenOrders,
      bingxOpenOrders: this.bingxOpenOrders,
      lastUpdated: this.lastUpdated,
      lastError: this.lastError,
    };
  }

  private emitUpdate(): void {
    const snapshot = this.buildSnapshot();
    this.events.emit("update", snapshot, (error) => {
      this.tradeLog.push("error", `更新通知失败: ${extractMessage(error)}`);
    });
  }

  private trackOrder(key: "grvt" | "bingx", orderId: number | string): void {
    const set = this.pendingOrderIds[key];
    if (!set) return;
    set.add(String(orderId));
  }

  private reconcileTrackedOrders(key: "grvt" | "bingx", orders: AsterOrder[]): void {
    const set = this.pendingOrderIds[key];
    if (!set) return;
    const openIds = new Set(orders.map((order) => String(order.orderId)));
    for (const id of Array.from(set)) {
      if (!openIds.has(id)) {
        set.delete(id);
      }
    }
  }

  private async cancelTrackedOrders(): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const [key, ids] of Object.entries(this.pendingOrderIds) as Array<[ "grvt" | "bingx", Set<string> ]>) {
      const adapter = key === "grvt" ? this.grvt : this.bingx;
      for (const id of ids) {
        tasks.push(this.safeCancelOrder(adapter, key === "grvt" ? this.config.grvtSymbol : this.config.bingxSymbol, id));
      }
      ids.clear();
    }
    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  private async safeCancelOrder(
    adapter: ExchangeAdapter,
    symbol: string,
    orderId: number | string
  ): Promise<void> {
    try {
      await adapter.cancelOrder({ symbol, orderId });
      this.tradeLog.push("order", `撤销订单 ${orderId}`);
    } catch (error) {
      const message = extractMessage(error);
      this.tradeLog.push("warn", `撤销订单 ${orderId} 失败: ${message}`);
    }
  }
}
