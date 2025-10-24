import type { MakerConfig } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterKline,
  AsterOrder,
  AsterTicker,
} from "../exchanges/types";
import { formatPriceToString } from "../utils/math";
import { createTradeLog, type TradeLogEntry } from "../logging/trade-log";
import { extractMessage, isInsufficientBalanceError, isUnknownOrderError, isRateLimitError } from "../utils/errors";
import { getPosition, calcStopLossPrice } from "../utils/strategy";
import type { PositionSnapshot } from "../utils/strategy";
import { computePositionPnl } from "../utils/pnl";
import { getTopPrices, getMidOrLast } from "../utils/price";
import { shouldStopLoss } from "../utils/risk";
import {
  marketClose,
  placeOrder,
  placeStopLossOrder,
    placePreemptiveStopLimitOrder,
  unlockOperating,
} from "../core/order-coordinator";
import type { OrderLockMap, OrderPendingMap, OrderTimerMap } from "../core/order-coordinator";
import { makeOrderPlan } from "../core/lib/order-plan";
import { safeCancelOrder } from "../core/lib/orders";
import { RateLimitController } from "../core/lib/rate-limit";
import { StrategyEventEmitter } from "./common/event-emitter";
import { safeSubscribe, type LogHandler } from "./common/subscriptions";
import { SessionVolumeTracker } from "./common/session-volume";

interface DesiredOrder {
  side: "BUY" | "SELL";
  price: string; // 改为字符串价格
  amount: number;
  reduceOnly: boolean;
}

export interface MakerEngineSnapshot {
  ready: boolean;
  symbol: string;
  topBid: number | null;
  topAsk: number | null;
  spread: number | null;
  position: PositionSnapshot;
  pnl: number;
  accountUnrealized: number;
  sessionVolume: number;
  openOrders: AsterOrder[];
  desiredOrders: DesiredOrder[];
  tradeLog: TradeLogEntry[];
  lastUpdated: number | null;
  feedStatus: {
    account: boolean;
    orders: boolean;
    depth: boolean;
    ticker: boolean;
  };
}

type MakerEvent = "update";
type MakerListener = (snapshot: MakerEngineSnapshot) => void;

const EPS = 1e-5;
const INSUFFICIENT_BALANCE_COOLDOWN_MS = 15_000;

export class MakerEngine {
  private accountSnapshot: AsterAccountSnapshot | null = null;
  private depthSnapshot: AsterDepth | null = null;
  private tickerSnapshot: AsterTicker | null = null;
  private openOrders: AsterOrder[] = [];

  private readonly locks: OrderLockMap = {};
  private readonly timers: OrderTimerMap = {};
  private readonly pending: OrderPendingMap = {};
  private readonly pendingCancelOrders = new Set<string>();

  private readonly tradeLog: ReturnType<typeof createTradeLog>;
  private readonly events = new StrategyEventEmitter<MakerEvent, MakerEngineSnapshot>();
  private readonly sessionVolume = new SessionVolumeTracker();

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private desiredOrders: DesiredOrder[] = [];
  private accountUnrealized = 0;
  private initialOrderSnapshotReady = false;
  private initialOrderResetDone = false;
  private entryPricePendingLogged = false;
  private readinessLogged = {
    account: false,
    depth: false,
    ticker: false,
    orders: false,
  };
  private feedArrived = {
    account: false,
    depth: false,
    ticker: false,
    orders: false,
  };
  private feedStatus = {
    account: false,
    depth: false,
    ticker: false,
    orders: false,
  };
  private insufficientBalanceCooldownUntil = 0;
  private insufficientBalanceNotified = false;
  private lastInsufficientMessage: string | null = null;
  private lastDesiredSummary: string | null = null;
  private readonly rateLimit: RateLimitController;

  // Cooldown after position fully closes before allowing new entries
  private postCloseCooldownUntil = 0;
  private postCloseCooldownNotified = false;
  private lastAbsPositionForCooldown = 0;

  constructor(private readonly config: MakerConfig, private readonly exchange: ExchangeAdapter) {
    this.tradeLog = createTradeLog(this.config.maxLogEntries);
    this.rateLimit = new RateLimitController(this.config.refreshIntervalMs, (type, detail) =>
      this.tradeLog.push(type, detail)
    );
    this.bootstrap();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.refreshIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  on(event: MakerEvent, handler: MakerListener): void {
    this.events.on(event, handler);
  }

  off(event: MakerEvent, handler: MakerListener): void {
    this.events.off(event, handler);
  }

  getSnapshot(): MakerEngineSnapshot {
    return this.buildSnapshot();
  }

  private bootstrap(): void {
    const log: LogHandler = (type, detail) => this.tradeLog.push(type, detail);

    safeSubscribe<AsterAccountSnapshot>(
      this.exchange.watchAccount.bind(this.exchange),
      (snapshot) => {
        this.accountSnapshot = snapshot;
        const totalUnrealized = Number(snapshot.totalUnrealizedProfit ?? "0");
        if (Number.isFinite(totalUnrealized)) {
          this.accountUnrealized = totalUnrealized;
        }
        const position = getPosition(snapshot, this.config.symbol);
        // Detect transition from exposure to flat to start post-close cooldown
        const absNow = Math.abs(position.positionAmt);
        const wasExposed = this.lastAbsPositionForCooldown > EPS;
        if (wasExposed && absNow <= EPS) {
          this.postCloseCooldownUntil = Date.now() + 10_000;
          this.postCloseCooldownNotified = false;
          this.tradeLog.push("info", "平仓完成，暂停新开仓 10s");
        }
        this.lastAbsPositionForCooldown = absNow;
        this.sessionVolume.update(position, this.getReferencePrice());
        if (!this.feedArrived.account) {
          this.tradeLog.push("info", "账户快照已同步");
          this.feedArrived.account = true;
        }
        this.feedStatus.account = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅账户失败: ${String(error)}`,
        processFail: (error) => `账户推送处理异常: ${String(error)}`,
      }
    );

    safeSubscribe<AsterOrder[]>(
      this.exchange.watchOrders.bind(this.exchange),
      (orders) => {
        this.syncLocksWithOrders(orders);
        this.openOrders = Array.isArray(orders)
          ? orders.filter((order) => order.type !== "MARKET" && order.symbol === this.config.symbol)
          : [];
        const currentIds = new Set(this.openOrders.map((order) => String(order.orderId)));
        for (const id of Array.from(this.pendingCancelOrders)) {
          if (!currentIds.has(id)) {
            this.pendingCancelOrders.delete(id);
          }
        }
        this.initialOrderSnapshotReady = true;
        if (!this.feedArrived.orders) {
          this.tradeLog.push("info", "订单快照已返回");
          this.feedArrived.orders = true;
        }
        this.feedStatus.orders = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅订单失败: ${String(error)}`,
        processFail: (error) => `订单推送处理异常: ${String(error)}`,
      }
    );

    safeSubscribe<AsterDepth>(
      this.exchange.watchDepth.bind(this.exchange, this.config.symbol),
      (depth) => {
        this.depthSnapshot = depth;
        if (!this.feedArrived.depth) {
          this.tradeLog.push("info", "获得最新深度行情");
          this.feedArrived.depth = true;
        }
        this.feedStatus.depth = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅深度失败: ${String(error)}`,
        processFail: (error) => `深度推送处理异常: ${String(error)}`,
      }
    );

    safeSubscribe<AsterTicker>(
      this.exchange.watchTicker.bind(this.exchange, this.config.symbol),
      (ticker) => {
        this.tickerSnapshot = ticker;
        if (!this.feedArrived.ticker) {
          this.tradeLog.push("info", "Ticker 已就绪");
          this.feedArrived.ticker = true;
        }
        this.feedStatus.ticker = true;
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅Ticker失败: ${String(error)}`,
        processFail: (error) => `价格推送处理异常: ${String(error)}`,
      }
    );

    // Maker strategy does not require realtime klines.
  }

  private syncLocksWithOrders(orders: AsterOrder[] | null | undefined): void {
    const list = Array.isArray(orders) ? orders : [];
    Object.keys(this.pending).forEach((type) => {
      const pendingId = this.pending[type];
      if (!pendingId) return;
      const match = list.find((order) => String(order.orderId) === pendingId);
      if (!match || (match.status && match.status !== "NEW" && match.status !== "PARTIALLY_FILLED")) {
        unlockOperating(this.locks, this.timers, this.pending, type);
      }
    });
  }

  private isReady(): boolean {
    return Boolean(
      this.feedStatus.account &&
        this.feedStatus.depth &&
        this.feedStatus.ticker &&
        this.feedStatus.orders
    );
  }

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    let hadRateLimit = false;
    try {
      const decision = this.rateLimit.beforeCycle();
      if (decision === "paused") {
        this.emitUpdate();
        return;
      }
      if (decision === "skip") {
        return;
      }
      if (!this.isReady()) {
        this.logReadinessBlockers();
        this.emitUpdate();
        return;
      }
      this.resetReadinessFlags();
      if (!(await this.ensureStartupOrderReset())) {
        this.emitUpdate();
        return;
      }

      const depth = this.depthSnapshot!;
      const { topBid, topAsk } = getTopPrices(depth);
      if (topBid == null || topAsk == null) {
        this.emitUpdate();
        return;
      }

      // 直接使用orderbook价格，格式化为字符串避免精度问题
      const priceDecimals = Math.max(0, Math.floor(Math.log10(1 / this.config.priceTick)));
      const closeBidPrice = formatPriceToString(topBid, priceDecimals);
      const closeAskPrice = formatPriceToString(topAsk, priceDecimals);
      const bidPrice = formatPriceToString(topBid - this.config.bidOffset, priceDecimals);
      const askPrice = formatPriceToString(topAsk + this.config.askOffset, priceDecimals);
      const position = getPosition(this.accountSnapshot, this.config.symbol);
      const absPosition = Math.abs(position.positionAmt);
      const desired: DesiredOrder[] = [];
      const nowTs = Date.now();
      const insufficientActive = this.applyInsufficientBalanceState(nowTs);
      const postCloseActive = this.applyPostCloseCooldownState(nowTs);
      const canEnter = !this.rateLimit.shouldBlockEntries() && !insufficientActive && !postCloseActive;

      if (absPosition < EPS) {
        this.entryPricePendingLogged = false;
        if (canEnter) {
          const boost = Math.max(1, Number(this.config.volumeBoost ?? 1));
          desired.push({ side: "BUY", price: bidPrice, amount: this.config.tradeAmount * boost, reduceOnly: false });
          desired.push({ side: "SELL", price: askPrice, amount: this.config.tradeAmount * boost, reduceOnly: false });
        }
      } else {
        const closeSide: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
        const closePrice = closeSide === "SELL" ? closeAskPrice : closeBidPrice;
        desired.push({ side: closeSide, price: closePrice, amount: absPosition, reduceOnly: true });
      }

      this.desiredOrders = desired;
      this.logDesiredOrders(desired);
      this.sessionVolume.update(position, this.getReferencePrice());
      await this.syncOrders(desired);
      // Ensure a protective stop exists during cancel/replace gaps
      const closeSidePx = position.positionAmt > 0 ? Number(closeBidPrice) : Number(closeAskPrice);
      if (Number.isFinite(closeSidePx)) {
        await this.ensureProtectiveStop(position, Number(closeSidePx));
      }
      await this.checkRisk(position, Number(closeBidPrice), Number(closeAskPrice));
      this.emitUpdate();
    } catch (error) {
      if (isRateLimitError(error)) {
        hadRateLimit = true;
        this.rateLimit.registerRateLimit("maker");
        await this.enforceRateLimitStop();
        this.tradeLog.push("warn", `MakerEngine 429: ${String(error)}`);
      } else {
        this.tradeLog.push("error", `做市循环异常: ${String(error)}`);
      }
      this.emitUpdate();
    } finally {
      this.rateLimit.onCycleComplete(hadRateLimit);
      this.processing = false;
    }
  }

  private async enforceRateLimitStop(): Promise<void> {
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    if (Math.abs(position.positionAmt) < EPS) return;
    const { topBid, topAsk } = getTopPrices(this.depthSnapshot);
    if (topBid == null || topAsk == null) return;
    const priceDecimals = Math.max(0, Math.floor(Math.log10(1 / this.config.priceTick)));
    const closeBidPrice = formatPriceToString(topBid, priceDecimals);
    const closeAskPrice = formatPriceToString(topAsk, priceDecimals);
    await this.checkRisk(position, Number(closeBidPrice), Number(closeAskPrice));
    await this.flushOrders();
  }

  private async ensureStartupOrderReset(): Promise<boolean> {
    if (this.initialOrderResetDone) return true;
    if (!this.initialOrderSnapshotReady) return false;
    if (!this.openOrders.length) {
      this.initialOrderResetDone = true;
      return true;
    }
    try {
      await this.exchange.cancelAllOrders({ symbol: this.config.symbol });
      this.pendingCancelOrders.clear();
      unlockOperating(this.locks, this.timers, this.pending, "LIMIT");
      this.openOrders = [];
      this.emitUpdate();
      this.tradeLog.push("order", "启动时清理历史挂单");
      this.initialOrderResetDone = true;
      return true;
    } catch (error) {
      if (isUnknownOrderError(error)) {
        this.tradeLog.push("order", "历史挂单已消失，跳过启动清理");
        this.initialOrderResetDone = true;
        this.openOrders = [];
        this.emitUpdate();
        return true;
      }
      this.tradeLog.push("error", `启动撤单失败: ${String(error)}`);
      return false;
    }
  }

  private async syncOrders(targets: DesiredOrder[]): Promise<void> {
    const availableOrders = this.openOrders.filter((o) => !this.pendingCancelOrders.has(String(o.orderId)));
    const openOrders = availableOrders.filter((order) => {
      const status = (order.status ?? "").toUpperCase();
      const isStopLike = Number.isFinite(Number(order.stopPrice)) && Number(order.stopPrice) > 0;
      const type = String(order.type ?? "").toUpperCase();
      const isStopType = type.includes("STOP");
      // Exclude stop/stop-like orders from the maker quote plan
      return (
        !status.includes("CLOSED") &&
        !status.includes("FILLED") &&
        !status.includes("CANCELED") &&
        !isStopLike &&
        !isStopType
      );
    });
    const { toCancel, toPlace } = makeOrderPlan(openOrders, targets);

    for (const order of toCancel) {
      if (this.pendingCancelOrders.has(String(order.orderId))) continue;
      this.pendingCancelOrders.add(String(order.orderId));
      await safeCancelOrder(
        this.exchange,
        this.config.symbol,
        order,
        () => {
          this.tradeLog.push(
            "order",
            `撤销不匹配订单 ${order.side} @ ${order.price} reduceOnly=${order.reduceOnly}`
          );
        },
        () => {
          this.tradeLog.push("order", "撤销时发现订单已被成交/取消，忽略");
          this.pendingCancelOrders.delete(String(order.orderId));
          this.openOrders = this.openOrders.filter((existing) => existing.orderId !== order.orderId);
        },
        (error) => {
          this.tradeLog.push("error", `撤销订单失败: ${String(error)}`);
          this.pendingCancelOrders.delete(String(order.orderId));
          this.openOrders = this.openOrders.filter((existing) => existing.orderId !== order.orderId);
        }
      );
    }

    for (const target of toPlace) {
      if (!target) continue;
      if (target.amount < EPS) continue;
      try {
        // Pre-emptive stop-limit: before placing a new entry, arm a reduce-only stop at the opposite TOB
        if (!target.reduceOnly) {
          const { topBid, topAsk } = getTopPrices(this.depthSnapshot);
          const trigger = target.side === "BUY" ? topAsk : topBid;
          const stopSide: "BUY" | "SELL" = target.side === "BUY" ? "SELL" : "BUY";
          if (Number.isFinite(trigger)) {
            await placePreemptiveStopLimitOrder(
              this.exchange,
              this.config.symbol,
              this.openOrders,
              this.locks,
              this.timers,
              this.pending,
              stopSide,
              Number(trigger),
              target.amount,
              (type, detail) => this.tradeLog.push(type, detail),
              {
                markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
                maxPct: this.config.maxCloseSlippagePct,
              },
              { priceTick: this.config.priceTick, qtyStep: 0.001 }
            );
          }
        }
        await placeOrder(
          this.exchange,
          this.config.symbol,
          this.openOrders,
          this.locks,
          this.timers,
          this.pending,
          target.side,
          target.price, // 已经是字符串价格
          target.amount,
          (type, detail) => this.tradeLog.push(type, detail),
          target.reduceOnly,
          {
            markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
            maxPct: this.config.maxCloseSlippagePct,
          },
          {
            priceTick: this.config.priceTick,
            qtyStep: 0.001, // 默认数量步长
            // For normal reduce-only closes, prefer maker (GTX default). Use IOC only in risk paths.
            timeInForce: undefined,
          }
        );
      } catch (error) {
        if (isInsufficientBalanceError(error)) {
          this.registerInsufficientBalance(error);
          break;
        }
        this.tradeLog.push(
          "error",
          `挂单失败(${target.side} ${target.price}): ${extractMessage(error)}`
        );
      }
    }
  }

  private async checkRisk(position: PositionSnapshot, bidPrice: number, askPrice: number): Promise<void> {
    const absPosition = Math.abs(position.positionAmt);
    if (absPosition < EPS) return;

    const hasEntryPrice = Number.isFinite(position.entryPrice) && Math.abs(position.entryPrice) > 1e-8;
    if (!hasEntryPrice) {
      if (!this.entryPricePendingLogged) {
        this.tradeLog.push("info", "做市持仓均价未同步，等待账户快照刷新后再执行止损判断");
        this.entryPricePendingLogged = true;
      }
      return;
    }
    this.entryPricePendingLogged = false;

    const pnl = computePositionPnl(position, bidPrice, askPrice);
    const triggerStop = shouldStopLoss(position, bidPrice, askPrice, this.config.lossLimit);

    if (triggerStop) {
      // 价格操纵保护：只有平仓方向价格与标记价格在阈值内才允许市价平仓
      const closeSideIsSell = position.positionAmt > 0;
      const closeSidePrice = closeSideIsSell ? bidPrice : askPrice;
      this.tradeLog.push(
        "stop",
        `触发止损，方向=${position.positionAmt > 0 ? "多" : "空"} 当前亏损=${pnl.toFixed(4)} USDT`
      );
      try {
        await this.flushOrders();
        const side: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
        const priceDecimals = Math.max(0, Math.floor(Math.log10(1 / this.config.priceTick)));
        const pxStr = formatPriceToString(closeSidePrice, priceDecimals);
        await placeOrder(
          this.exchange,
          this.config.symbol,
          this.openOrders,
          this.locks,
          this.timers,
          this.pending,
          side,
          pxStr,
          absPosition,
          (type, detail) => this.tradeLog.push(type, detail),
          true,
          {
            markPrice: position.markPrice,
            expectedPrice: Number(closeSidePrice),
            maxPct: this.config.maxCloseSlippagePct,
          },
          { priceTick: this.config.priceTick, qtyStep: 0.001, timeInForce: this.config.strictLimitOnly ? "IOC" : undefined }
        );
      } catch (error) {
        if (isUnknownOrderError(error)) {
          this.tradeLog.push("order", "止损平仓时订单已不存在");
        } else {
          this.tradeLog.push("error", `止损平仓失败: ${String(error)}`);
        }
      }
    }
  }

  private async flushOrders(): Promise<void> {
    if (!this.openOrders.length) return;
    for (const order of this.openOrders) {
      if (this.pendingCancelOrders.has(String(order.orderId))) continue;
      this.pendingCancelOrders.add(String(order.orderId));
      await safeCancelOrder(
        this.exchange,
        this.config.symbol,
        order,
        () => {
          // 成功撤销不记录日志，保持现有行为
        },
        () => {
          this.tradeLog.push("order", "订单已不存在，撤销跳过");
          this.pendingCancelOrders.delete(String(order.orderId));
          this.openOrders = this.openOrders.filter((existing) => existing.orderId !== order.orderId);
        },
        (error) => {
          this.tradeLog.push("error", `撤销订单失败: ${String(error)}`);
          this.pendingCancelOrders.delete(String(order.orderId));
          this.openOrders = this.openOrders.filter((existing) => existing.orderId !== order.orderId);
        }
      );
    }
  }

  private findCurrentStop(stopSide: "BUY" | "SELL"): AsterOrder | undefined {
    return this.openOrders.find((o) => {
      const hasStopPrice = Number.isFinite(Number(o.stopPrice)) && Number(o.stopPrice) > 0;
      const type = String(o.type ?? "").toUpperCase();
      const isStopType = type === "STOP_MARKET" || type === "TRAILING_STOP_MARKET";
      return o.side === stopSide && (isStopType || hasStopPrice);
    });
  }

  private async ensureProtectiveStop(position: PositionSnapshot, lastPrice: number): Promise<void> {
    const absPosition = Math.abs(position.positionAmt);
    if (absPosition < 1e-5) return;
    const hasEntry = Number.isFinite(position.entryPrice) && Math.abs(position.entryPrice) > 1e-8;
    if (!hasEntry) return;
    const direction: "long" | "short" = position.positionAmt > 0 ? "long" : "short";
    const stopSide: "BUY" | "SELL" = direction === "long" ? "SELL" : "BUY";
    const rawStop = calcStopLossPrice(position.entryPrice, absPosition, direction, this.config.lossLimit);
    const tick = Math.max(1e-9, this.config.priceTick);
    // SELL stop must be below current price; BUY stop must be above current price
    if ((stopSide === "SELL" && !(rawStop <= lastPrice - tick)) || (stopSide === "BUY" && !(rawStop >= lastPrice + tick))) {
      return;
    }
    const current = this.findCurrentStop(stopSide);
    if (!current) {
      await this.tryPlaceStopLoss(stopSide, rawStop, lastPrice, absPosition);
      return;
    }
    const existing = Number(current.stopPrice);
    const invalidPlacement =
      (stopSide === "SELL" && existing >= lastPrice - tick) ||
      (stopSide === "BUY" && existing <= lastPrice + tick);
    const canTighten =
      (stopSide === "SELL" && rawStop >= existing + tick) ||
      (stopSide === "BUY" && rawStop <= existing - tick);
    // Replace if existing stop is invalid (e.g., pre-emptive at ask/bid) or we can tighten risk
    if (invalidPlacement || canTighten) {
      await this.tryReplaceStop(stopSide, current, rawStop, lastPrice, absPosition);
    }
  }

  private async tryPlaceStopLoss(
    side: "BUY" | "SELL",
    stopPrice: number,
    lastPrice: number,
    quantity: number
  ): Promise<void> {
    try {
      await placeStopLossOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        stopPrice,
        quantity,
        lastPrice,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
          maxPct: this.config.maxCloseSlippagePct,
        },
        { priceTick: this.config.priceTick, qtyStep: 0.001 }
      );
    } catch (err) {
      this.tradeLog.push("error", `挂止损单失败: ${String(err)}`);
    }
  }

  private async tryReplaceStop(
    side: "BUY" | "SELL",
    currentOrder: AsterOrder,
    nextStopPrice: number,
    lastPrice: number,
    quantity: number
  ): Promise<void> {
    const invalidForSide = (side === "SELL" && nextStopPrice >= lastPrice) || (side === "BUY" && nextStopPrice <= lastPrice);
    if (invalidForSide) return;
    try {
      await this.exchange.cancelOrder({ symbol: this.config.symbol, orderId: currentOrder.orderId });
    } catch (err) {
      if (isUnknownOrderError(err)) {
        this.tradeLog.push("order", "原止损单已不存在，跳过撤销");
        this.openOrders = this.openOrders.filter((o) => o.orderId !== currentOrder.orderId);
      } else {
        this.tradeLog.push("error", `取消原止损单失败: ${String(err)}`);
      }
    }
    try {
      const order = await placeStopLossOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        nextStopPrice,
        quantity,
        lastPrice,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
          maxPct: this.config.maxCloseSlippagePct,
        },
        { priceTick: this.config.priceTick, qtyStep: 0.001 }
      );
      if (order) {
        this.tradeLog.push(
          "stop",
          `移动止损到 ${formatPriceToString(nextStopPrice, Math.max(0, Math.floor(Math.log10(1 / this.config.priceTick))))}`
        );
      }
    } catch (err) {
      this.tradeLog.push("error", `移动止损失败: ${String(err)}`);
      const existingStopPrice = Number(currentOrder.stopPrice);
      const restoreInvalid = (side === "SELL" && existingStopPrice >= lastPrice) || (side === "BUY" && existingStopPrice <= lastPrice);
      if (!restoreInvalid && Number.isFinite(existingStopPrice)) {
        try {
          await placeStopLossOrder(
            this.exchange,
            this.config.symbol,
            this.openOrders,
            this.locks,
            this.timers,
            this.pending,
            side,
            existingStopPrice,
            quantity,
            lastPrice,
            (t, d) => this.tradeLog.push(t, d),
            {
              markPrice: getPosition(this.accountSnapshot, this.config.symbol).markPrice,
              maxPct: this.config.maxCloseSlippagePct,
            },
            { priceTick: this.config.priceTick, qtyStep: 0.001 }
          );
          this.tradeLog.push(
            "order",
            `恢复原止损 @ ${formatPriceToString(existingStopPrice, Math.max(0, Math.floor(Math.log10(1 / this.config.priceTick))))}`
          );
        } catch (recoverErr) {
          this.tradeLog.push("error", `恢复原止损失败: ${String(recoverErr)}`);
        }
      }
    }
  }

  private emitUpdate(): void {
    try {
      const snapshot = this.buildSnapshot();
      this.events.emit("update", snapshot, (error) => {
        this.tradeLog.push("error", `更新回调处理异常: ${String(error)}`);
      });
    } catch (err) {
      this.tradeLog.push("error", `快照或更新分发异常: ${String(err)}`);
    }
  }

  private buildSnapshot(): MakerEngineSnapshot {
    const position = getPosition(this.accountSnapshot, this.config.symbol);
    const { topBid, topAsk } = getTopPrices(this.depthSnapshot);
    const spread = topBid != null && topAsk != null ? topAsk - topBid : null;
    const pnl = computePositionPnl(position, topBid, topAsk);

    return {
      ready: this.isReady(),
      symbol: this.config.symbol,
      topBid: topBid,
      topAsk: topAsk,
      spread,
      position,
      pnl,
      accountUnrealized: this.accountUnrealized,
      sessionVolume: this.sessionVolume.value,
      openOrders: this.openOrders,
      desiredOrders: this.desiredOrders,
      tradeLog: this.tradeLog.all(),
      lastUpdated: Date.now(),
      feedStatus: { ...this.feedStatus },
    };
  }

  private getReferencePrice(): number | null {
    return getMidOrLast(this.depthSnapshot, this.tickerSnapshot);
  }

  private logReadinessBlockers(): void {
    if (!this.feedStatus.account && !this.readinessLogged.account) {
      this.tradeLog.push("info", "等待账户快照同步，尚未开始做市");
      this.readinessLogged.account = true;
    }
    if (!this.feedStatus.depth && !this.readinessLogged.depth) {
      this.tradeLog.push("info", "等待深度行情推送，尚未开始做市");
      this.readinessLogged.depth = true;
    }
    if (!this.feedStatus.ticker && !this.readinessLogged.ticker) {
      this.tradeLog.push("info", "等待Ticker推送，尚未开始做市");
      this.readinessLogged.ticker = true;
    }
    if (!this.feedStatus.orders && !this.readinessLogged.orders) {
      this.tradeLog.push("info", "等待订单快照返回，尚未执行初始化撤单");
      this.readinessLogged.orders = true;
    }
  }

  private resetReadinessFlags(): void {
    this.readinessLogged = {
      account: false,
      depth: false,
      ticker: false,
      orders: false,
    };
  }

  private logDesiredOrders(desired: DesiredOrder[]): void {
    if (!desired.length) {
      if (this.lastDesiredSummary !== "none") {
        this.tradeLog.push("info", "当前无目标挂单，等待下一次刷新");
        this.lastDesiredSummary = "none";
      }
      return;
    }
    const summary = desired
      .map((order) => `${order.side}@${order.price}${order.reduceOnly ? "(RO)" : ""}`)
      .join(" | ");
    if (summary !== this.lastDesiredSummary) {
      this.tradeLog.push("info", `目标挂单: ${summary}`);
      this.lastDesiredSummary = summary;
    }
  }

  private registerInsufficientBalance(error: unknown): void {
    const now = Date.now();
    const detail = extractMessage(error);
    const alreadyActive = now < this.insufficientBalanceCooldownUntil;
    if (alreadyActive && detail === this.lastInsufficientMessage) {
      this.insufficientBalanceCooldownUntil = now + INSUFFICIENT_BALANCE_COOLDOWN_MS;
      return;
    }
    this.insufficientBalanceCooldownUntil = now + INSUFFICIENT_BALANCE_COOLDOWN_MS;
    this.lastInsufficientMessage = detail;
    const seconds = Math.ceil(INSUFFICIENT_BALANCE_COOLDOWN_MS / 1000);
    this.tradeLog.push("warn", `余额不足，暂停新挂单 ${seconds}s: ${detail}`);
    this.insufficientBalanceNotified = true;
  }

  private applyInsufficientBalanceState(now: number): boolean {
    const active = now < this.insufficientBalanceCooldownUntil;
    if (!active && this.insufficientBalanceNotified) {
      this.tradeLog.push("info", "余额检测恢复，重新尝试挂单");
      this.insufficientBalanceNotified = false;
      this.lastInsufficientMessage = null;
    }
    return active;
  }

  private applyPostCloseCooldownState(now: number): boolean {
    const active = now < this.postCloseCooldownUntil;
    if (!active && this.postCloseCooldownNotified) {
      this.tradeLog.push("info", "平仓冷却结束，恢复开仓");
      this.postCloseCooldownNotified = false;
    }
    if (active && !this.postCloseCooldownNotified) {
      // mark notified to avoid repeated end logs later without a start
      this.postCloseCooldownNotified = true;
    }
    return active;
  }
}
