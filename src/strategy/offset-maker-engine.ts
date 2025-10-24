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
import { createTradeLog } from "../logging/trade-log";
import { isUnknownOrderError, isRateLimitError } from "../utils/errors";
import { getPosition, calcStopLossPrice } from "../utils/strategy";
import type { PositionSnapshot } from "../utils/strategy";
import { computeDepthStats } from "../utils/depth";
import { computePositionPnl } from "../utils/pnl";
import { getTopPrices, getMidOrLast } from "../utils/price";
import { shouldStopLoss } from "../utils/risk";
import {
  marketClose,
  placeOrder,
  placeStopLossOrder,
  unlockOperating,
} from "../core/order-coordinator";
import type { OrderLockMap, OrderPendingMap, OrderTimerMap } from "../core/order-coordinator";
import type { MakerEngineSnapshot } from "./maker-engine";
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

export interface OffsetMakerEngineSnapshot extends MakerEngineSnapshot {
  buyDepthSum10: number;
  sellDepthSum10: number;
  depthImbalance: "balanced" | "buy_dominant" | "sell_dominant";
  skipBuySide: boolean;
  skipSellSide: boolean;
}

type MakerEvent = "update";
type MakerListener = (snapshot: OffsetMakerEngineSnapshot) => void;

const EPS = 1e-5;

export class OffsetMakerEngine {
  private accountSnapshot: AsterAccountSnapshot | null = null;
  private depthSnapshot: AsterDepth | null = null;
  private tickerSnapshot: AsterTicker | null = null;
  private openOrders: AsterOrder[] = [];

  private readonly locks: OrderLockMap = {};
  private readonly timers: OrderTimerMap = {};
  private readonly pending: OrderPendingMap = {};
  private readonly pendingCancelOrders = new Set<string>();

  private readonly tradeLog: ReturnType<typeof createTradeLog>;
  private readonly events = new StrategyEventEmitter<MakerEvent, OffsetMakerEngineSnapshot>();
  private readonly sessionVolume = new SessionVolumeTracker();

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private desiredOrders: DesiredOrder[] = [];
  private accountUnrealized = 0;
  private initialOrderSnapshotReady = false;
  private initialOrderResetDone = false;
  private entryPricePendingLogged = false;
  private readonly rateLimit: RateLimitController;

  private lastBuyDepthSum10 = 0;
  private lastSellDepthSum10 = 0;
  private lastSkipBuy = false;
  private lastSkipSell = false;
  private lastImbalance: "balanced" | "buy_dominant" | "sell_dominant" = "balanced";

  // Cooldown after position fully closes before allowing new entries
  private postCloseCooldownUntil = 0;
  private postCloseCooldownNotified = false;
  private lastAbsPositionForCooldown = 0;

  // Reprice suppression for fast-ticking order book
  private readonly repriceDwellMs: number;
  private readonly minRepriceTicks: number;
  private lastEntryOrderBySide: Record<"BUY" | "SELL", { price: string; ts: number } | null> = {
    BUY: null,
    SELL: null,
  };

  constructor(private readonly config: MakerConfig, private readonly exchange: ExchangeAdapter) {
    this.tradeLog = createTradeLog(this.config.maxLogEntries);
    this.rateLimit = new RateLimitController(this.config.refreshIntervalMs, (type, detail) =>
      this.tradeLog.push(type, detail)
    );
    // Use configurable dwell window (default 1500ms) and min reprice ticks (default 1)
    const cfgDwell = Number(this.config.repriceDwellMs);
    this.repriceDwellMs = Number.isFinite(cfgDwell) && cfgDwell! > 0
      ? cfgDwell!
      : Math.max(1500, this.config.refreshIntervalMs * 3);
    const cfgMinTicks = Number(this.config.minRepriceTicks);
    this.minRepriceTicks = Number.isFinite(cfgMinTicks) && cfgMinTicks! > 0 ? cfgMinTicks! : 1;
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

  getSnapshot(): OffsetMakerEngineSnapshot {
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
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅Ticker失败: ${String(error)}`,
        processFail: (error) => `价格推送处理异常: ${String(error)}`,
      }
    );

    safeSubscribe<AsterKline[]>(
      this.exchange.watchKlines.bind(this.exchange, this.config.symbol, "1m"),
      (_klines) => {
        /* no-op */
      },
      log,
      {
        subscribeFail: (error) => `订阅K线失败: ${String(error)}`,
        processFail: (error) => `K线推送处理异常: ${String(error)}`,
      }
    );
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
    return Boolean(this.accountSnapshot && this.depthSnapshot);
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
        this.emitUpdate();
        return;
      }
      if (!(await this.ensureStartupOrderReset())) {
        this.emitUpdate();
        return;
      }

      // 确保使用最新的深度数据
      const depth = this.depthSnapshot!;
      const { topBid, topAsk } = getTopPrices(depth);
      if (topBid == null || topAsk == null) {
        this.emitUpdate();
        return;
      }

      const { buySum, sellSum, skipBuySide, skipSellSide, imbalance } = this.evaluateDepth(depth);
      this.lastBuyDepthSum10 = buySum;
      this.lastSellDepthSum10 = sellSum;
      this.lastSkipBuy = skipBuySide;
      this.lastSkipSell = skipSellSide;
      this.lastImbalance = imbalance;

      const position = getPosition(this.accountSnapshot, this.config.symbol);
      const handledImbalance = await this.handleImbalanceExit(position, buySum, sellSum);
      if (handledImbalance) {
        this.emitUpdate();
        return;
      }

      // 在计算挂单价格前，重新获取最新的深度数据以确保价格同步
      const latestDepth = this.depthSnapshot!;
      const { topBid: latestBid, topAsk: latestAsk } = getTopPrices(latestDepth);
      const finalBid = latestBid ?? topBid!;
      const finalAsk = latestAsk ?? topAsk!;

      // 直接使用orderbook价格，格式化为字符串避免精度问题
      const priceDecimals = Math.max(0, Math.floor(Math.log10(1 / this.config.priceTick)));
      const closeBidPrice = formatPriceToString(finalBid, priceDecimals);
      const closeAskPrice = formatPriceToString(finalAsk, priceDecimals);
      const bidPrice = formatPriceToString(finalBid - this.config.bidOffset, priceDecimals);
      const askPrice = formatPriceToString(finalAsk + this.config.askOffset, priceDecimals);
      const absPosition = Math.abs(position.positionAmt);
      const desired: DesiredOrder[] = [];
      const nowTs = Date.now();
      const postCloseActive = this.applyPostCloseCooldownState(nowTs);
      const canEnter = !this.rateLimit.shouldBlockEntries() && !postCloseActive;

      if (absPosition < EPS) {
        this.entryPricePendingLogged = false;
        if (!skipBuySide && canEnter) {
          const boost = Math.max(1, Number(this.config.volumeBoost ?? 1));
          desired.push({ side: "BUY", price: bidPrice, amount: this.config.tradeAmount * boost, reduceOnly: false });
        }
        if (!skipSellSide && canEnter) {
          const boost = Math.max(1, Number(this.config.volumeBoost ?? 1));
          desired.push({ side: "SELL", price: askPrice, amount: this.config.tradeAmount * boost, reduceOnly: false });
        }
      } else {
        const closeSide: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
        const closePrice = closeSide === "SELL" ? closeAskPrice : closeBidPrice;
        desired.push({ side: closeSide, price: closePrice, amount: absPosition, reduceOnly: true });
      }

      this.desiredOrders = desired;
      this.sessionVolume.update(position, this.getReferencePrice());
      await this.syncOrders(desired);
      // Ensure a protective stop exists during cancel/replace gaps
      const closeSidePx = position.positionAmt > 0 ? Number(closeBidPrice) : Number(closeAskPrice);
      if (Number.isFinite(closeSidePx)) {
        await this.ensureProtectiveStop(position, Number(closeSidePx));
      }
      // Refresh existing stop-loss to current quote (limit==trigger at quote)
      await this.refreshStopToQuoteIfOpen(position, Number(closeBidPrice), Number(closeAskPrice));
      await this.checkRisk(position, Number(closeBidPrice), Number(closeAskPrice));
      this.emitUpdate();
    } catch (error) {
      if (isRateLimitError(error)) {
        hadRateLimit = true;
        this.rateLimit.registerRateLimit("offset-maker");
        await this.enforceRateLimitStop();
        this.tradeLog.push("warn", `OffsetMakerEngine 429: ${String(error)}`);
      } else {
        this.tradeLog.push("error", `偏移做市循环异常: ${String(error)}`);
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
    await this.flushOrders();
    const absPosition = Math.abs(position.positionAmt);
    const side: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
    const { topBid, topAsk } = getTopPrices(this.depthSnapshot);
    const priceDecimals = Math.max(0, Math.floor(Math.log10(1 / this.config.priceTick)));
    const closeBidPrice = topBid != null ? formatPriceToString(topBid, priceDecimals) : null;
    const closeAskPrice = topAsk != null ? formatPriceToString(topAsk, priceDecimals) : null;
    try {
      await marketClose(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        absPosition,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: position.markPrice,
          expectedPrice:
            side === "SELL"
              ? (closeAskPrice != null ? Number(closeAskPrice) : null)
              : (closeBidPrice != null ? Number(closeBidPrice) : null),
          maxPct: this.config.maxCloseSlippagePct,
        }
      );
    } catch (error) {
      if (isUnknownOrderError(error)) {
        this.tradeLog.push("order", "限频强制平仓时订单已不存在");
      } else {
        this.tradeLog.push("error", `限频强制平仓失败: ${String(error)}`);
      }
    }
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

  private evaluateDepth(depth: AsterDepth): {
    buySum: number;
    sellSum: number;
    skipBuySide: boolean;
    skipSellSide: boolean;
    imbalance: "balanced" | "buy_dominant" | "sell_dominant";
  } {
    // Keep existing behavior: 10 levels, ratio threshold 3x
    return computeDepthStats(depth, 10, 3);
  }

  private async handleImbalanceExit(
    position: PositionSnapshot,
    buySum: number,
    sellSum: number
  ): Promise<boolean> {
    const absPosition = Math.abs(position.positionAmt);
    if (absPosition < EPS) return false;

    const longExitRequired = position.positionAmt > 0 && (buySum === 0 || buySum * 6 < sellSum);
    const shortExitRequired = position.positionAmt < 0 && (sellSum === 0 || sellSum * 6 < buySum);

    if (!longExitRequired && !shortExitRequired) return false;

    const side: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
    const bid = Number(this.depthSnapshot?.bids?.[0]?.[0]);
    const ask = Number(this.depthSnapshot?.asks?.[0]?.[0]);
    const closeSidePrice = side === "SELL" ? bid : ask;
    this.tradeLog.push(
      "stop",
      `深度极端不平衡(${buySum.toFixed(4)} vs ${sellSum.toFixed(4)}), 市价平仓 ${side}`
    );
    try {
      await this.flushOrders();
      await marketClose(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pending,
        side,
        absPosition,
        (type, detail) => this.tradeLog.push(type, detail),
        {
          markPrice: position.markPrice,
          expectedPrice: Number(closeSidePrice) || null,
          maxPct: this.config.maxCloseSlippagePct,
        }
      );
    } catch (error) {
      if (isUnknownOrderError(error)) {
        this.tradeLog.push("order", "深度不平衡平仓时订单已不存在");
      } else {
        this.tradeLog.push("error", `深度不平衡平仓失败: ${String(error)}`);
      }
    }
    return true;
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

    // Coalesce reprices for entry orders: if within tick threshold or within dwell window, keep existing order
    const adjustedTargets: DesiredOrder[] = targets.map((t) => ({ ...t }));
    for (let i = 0; i < adjustedTargets.length; i++) {
      const t = adjustedTargets[i];
      if (!t || t.reduceOnly) continue; // only suppress entry orders
      const existing = availableOrders.find((o) => o.side === t.side && o.reduceOnly !== true);
      if (!existing) continue;
      const newPrice = Number(t.price);
      const oldPrice = Number(existing.price);
      if (!Number.isFinite(newPrice) || !Number.isFinite(oldPrice)) continue;
      const ticksDiff = Math.abs(newPrice - oldPrice) / this.config.priceTick;
      const recentPlaced = this.lastEntryOrderBySide[t.side]?.ts ?? 0;
      const withinDwell = Date.now() - recentPlaced < this.repriceDwellMs;
      if (ticksDiff < this.minRepriceTicks || withinDwell) {
        // Keep the existing resting order to avoid cancel/place churn
        adjustedTargets[i] = {
          side: t.side,
          price: String(existing.price),
          amount: t.amount,
          reduceOnly: false,
        };
      }
    }

    const { toCancel, toPlace } = makeOrderPlan(openOrders, adjustedTargets);

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
          // 保持与原逻辑一致：成功撤销不立即修改本地 openOrders，等待订单流重建
        },
        () => {
          this.tradeLog.push("order", "撤销时发现订单已被成交/取消，忽略");
          this.pendingCancelOrders.delete(String(order.orderId));
          this.openOrders = this.openOrders.filter((existing) => existing.orderId !== order.orderId);
        },
        (error) => {
          this.tradeLog.push("error", `撤销订单失败: ${String(error)}`);
          this.pendingCancelOrders.delete(String(order.orderId));
          // 避免同一轮内重复操作同一张已出错的本地挂单，直接从本地缓存移除，等待下一次订单推送重建
          this.openOrders = this.openOrders.filter((existing) => existing.orderId !== order.orderId);
        }
      );
    }

    for (const target of toPlace) {
      if (!target) continue;
      if (target.amount < EPS) continue;
      try {
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
            // Prefer maker for reduce-only closes under normal operation
            timeInForce: undefined,
          }
        );
        // Pre-bid protective stop: if quoting at top-of-book (bidOffset=0, askOffset=0),
        // place a reduce-only stop-limit SELL at the current ask for a BUY entry.
        if (
          !target.reduceOnly &&
          target.side === "BUY" &&
          this.config.bidOffset === 0 &&
          this.config.askOffset === 0
        ) {
          const { topAsk } = getTopPrices(this.depthSnapshot);
          if (Number.isFinite(topAsk)) {
            try {
              await placeStopLossOrder(
                this.exchange,
                this.config.symbol,
                this.openOrders,
                this.locks,
                this.timers,
                this.pending,
                "SELL",
                Number(topAsk),
                target.amount,
                null,
                (type, detail) => this.tradeLog.push(type, detail),
                undefined,
                { priceTick: this.config.priceTick, qtyStep: 0.001, exactLimitAtStop: true }
              );
            } catch (err) {
              this.tradeLog.push("error", `预挂止损失败: ${String(err)}`);
            }
          }
        }
        // Record last placed entry order timing and price
        if (!target.reduceOnly) {
          this.lastEntryOrderBySide[target.side] = { price: target.price, ts: Date.now() };
        }
      } catch (error) {
        this.tradeLog.push("error", `挂单失败(${target.side} ${target.price}): ${String(error)}`);
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
      this.tradeLog.push(
        "stop",
        `触发止损，方向=${position.positionAmt > 0 ? "多" : "空"} 当前亏损=${pnl.toFixed(4)} USDT`
      );
      try {
        await this.flushOrders();
        await marketClose(
          this.exchange,
          this.config.symbol,
          this.openOrders,
          this.locks,
          this.timers,
          this.pending,
          position.positionAmt > 0 ? "SELL" : "BUY",
          absPosition,
          (type, detail) => this.tradeLog.push(type, detail),
          {
            markPrice: position.markPrice,
            expectedPrice: Number(position.positionAmt > 0 ? bidPrice : askPrice) || null,
            maxPct: this.config.maxCloseSlippagePct,
          }
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
          // 与原逻辑保持一致：成功撤销不记录日志且不修改本地 openOrders
        },
        () => {
          this.tradeLog.push("order", "订单已不存在，撤销跳过");
          this.pendingCancelOrders.delete(String(order.orderId));
          this.openOrders = this.openOrders.filter((existing) => existing.orderId !== order.orderId);
        },
        (error) => {
          this.tradeLog.push("error", `撤销订单失败: ${String(error)}`);
          this.pendingCancelOrders.delete(String(order.orderId));
          // 与同步撤单路径保持一致，移除本地异常订单，等待订单流重建
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
    const canImprove =
      (stopSide === "SELL" && rawStop >= existing + tick) ||
      (stopSide === "BUY" && rawStop <= existing - tick);
    if (canImprove) {
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
        { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
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
    const invalidForSide = (side === "SELL" && nextStopPrice > lastPrice) || (side === "BUY" && nextStopPrice < lastPrice);
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
        { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
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
            { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep }
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

  // 自动将现有止损单刷新到最新对手价（limit==trigger）
  private async refreshStopToQuoteIfOpen(position: PositionSnapshot, closeBidPrice: number, closeAskPrice: number): Promise<void> {
    const absPosition = Math.abs(position.positionAmt);
    if (absPosition < EPS) return;
    const hasEntry = Number.isFinite(position.entryPrice) && Math.abs(position.entryPrice) > 1e-8;
    if (!hasEntry) return;
    const stopSide: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
    const current = this.findCurrentStop(stopSide);
    if (!current) return;
    const lastPrice = stopSide === "SELL" ? Number(closeBidPrice) : Number(closeAskPrice);
    if (!Number.isFinite(lastPrice)) return;
    const tick = Math.max(1e-9, this.config.priceTick);
    const priceDecimals = Math.max(0, Math.floor(Math.log10(1 / this.config.priceTick)));
    const desired = Number(formatPriceToString(lastPrice, priceDecimals));
    const existing = Number(current.stopPrice);
    if (!Number.isFinite(existing)) return;
    if (Math.abs(desired - existing) < tick) return;
    await this.replaceStopExact(stopSide, current, desired, lastPrice, absPosition);
  }

  private async replaceStopExact(
    side: "BUY" | "SELL",
    currentOrder: AsterOrder,
    nextStopPrice: number,
    lastPrice: number,
    quantity: number
  ): Promise<void> {
    const invalidForSide = (side === "SELL" && nextStopPrice > lastPrice) || (side === "BUY" && nextStopPrice < lastPrice);
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
        { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep, exactLimitAtStop: true }
      );
      if (order) {
        this.tradeLog.push(
          "stop",
          `移动止损到 ${formatPriceToString(nextStopPrice, Math.max(0, Math.floor(Math.log10(1 / this.config.priceTick))))}`
        );
      }
    } catch (err) {
      this.tradeLog.push("error", `移动止损失败: ${String(err)}`);
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

  private buildSnapshot(): OffsetMakerEngineSnapshot {
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
      buyDepthSum10: this.lastBuyDepthSum10,
      sellDepthSum10: this.lastSellDepthSum10,
      depthImbalance: this.lastImbalance,
      skipBuySide: this.lastSkipBuy,
      skipSellSide: this.lastSkipSell,
    };
  }

  private getReferencePrice(): number | null {
    return getMidOrLast(this.depthSnapshot, this.tickerSnapshot);
  }

  private applyPostCloseCooldownState(now: number): boolean {
    const active = now < this.postCloseCooldownUntil;
    if (!active && this.postCloseCooldownNotified) {
      this.tradeLog.push("info", "平仓冷却结束，恢复开仓");
      this.postCloseCooldownNotified = false;
    }
    if (active && !this.postCloseCooldownNotified) {
      this.postCloseCooldownNotified = true;
    }
    return active;
  }
}
