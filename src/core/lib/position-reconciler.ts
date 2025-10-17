import type { ExchangeAdapter } from "../../exchanges/adapter";
import type { AsterOrder } from "../../exchanges/types";
import { formatPriceToString } from "../../utils/math";
import type { PositionSnapshot } from "../../utils/strategy";
import { placeOrder } from "../order-coordinator";
import type { LogHandler, OrderLockMap, OrderPendingMap, OrderTimerMap } from "../order-coordinator";

const EPS = 1e-5;

export interface ReconcilePrices {
  topBid?: number | null;
  topAsk?: number | null;
  lastPrice?: number | null;
}

export interface ReconcileOptions {
  priceTick: number;
  qtyStep: number;
  strictLimitOnly: boolean;
  maxCloseSlippagePct: number;
}

function hasClosingProtection(openOrders: AsterOrder[], closeSide: "BUY" | "SELL"): boolean {
  // Consider reduce-only LIMITs or STOP(-like) orders on the closing side as protection present
  const has = openOrders.some((o) => {
    const sideMatches = o.side === closeSide;
    if (!sideMatches) return false;
    const type = String(o.type || "").toUpperCase();
    const hasStopPrice = Number.isFinite(Number(o.stopPrice)) && Number(o.stopPrice) > 0;
    const reduceOnly = o.reduceOnly === true;
    return reduceOnly || type === "STOP_MARKET" || hasStopPrice;
  });
  return has;
}

function buildClosePrice(
  side: "BUY" | "SELL",
  prices: ReconcilePrices,
  priceTick: number
): string | null {
  const { topBid, topAsk, lastPrice } = prices;
  const priceDecimals = Math.max(0, Math.floor(Math.log10(1 / Math.max(priceTick, 1e-9))));
  if (side === "SELL") {
    if (Number.isFinite(topAsk)) return formatPriceToString(Number(topAsk), priceDecimals);
    if (Number.isFinite(lastPrice)) return formatPriceToString(Number(lastPrice), priceDecimals);
  } else {
    if (Number.isFinite(topBid)) return formatPriceToString(Number(topBid), priceDecimals);
    if (Number.isFinite(lastPrice)) return formatPriceToString(Number(lastPrice), priceDecimals);
  }
  return null;
}

/**
 * Ensure that when a net position exists without any protective closing order present,
 * we place a reduce-only cover order at the top-of-book (or last price), with optional IOC.
 */
export async function reconcileOrphanedPosition(params: {
  exchange: ExchangeAdapter;
  symbol: string;
  position: PositionSnapshot;
  openOrders: AsterOrder[];
  locks: OrderLockMap;
  timers: OrderTimerMap;
  pendings: OrderPendingMap;
  prices: ReconcilePrices;
  opts: ReconcileOptions;
  ioc?: boolean;
  log: LogHandler;
}): Promise<{ tookAction: boolean }> {
  const { exchange, symbol, position, openOrders, locks, timers, pendings, prices, opts, ioc, log } = params;
  const absPos = Math.abs(position.positionAmt);
  if (absPos < EPS) return { tookAction: false };

  const closeSide: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
  if (hasClosingProtection(openOrders, closeSide)) {
    return { tookAction: false };
  }

  const price = buildClosePrice(closeSide, prices, opts.priceTick);
  if (price == null) return { tookAction: false };

  try {
    await placeOrder(
      exchange,
      symbol,
      openOrders,
      locks,
      timers,
      pendings,
      closeSide,
      price,
      absPos,
      log,
      true,
      {
        markPrice: position.markPrice,
        expectedPrice: Number(price),
        maxPct: opts.maxCloseSlippagePct,
      },
      {
        priceTick: opts.priceTick,
        qtyStep: opts.qtyStep,
        timeInForce: (ioc || opts.strictLimitOnly) ? "IOC" : undefined,
      }
    );
    log(
      "stop",
      `安全保护：检测到孤立持仓，挂出保护性${closeSide} 平仓单 @ ${price} 数量 ${absPos}`
    );
    return { tookAction: true };
  } catch (error) {
    log("error", `孤立持仓保护下单失败: ${String(error)}`);
    return { tookAction: false };
  }
}

import type { ExchangeAdapter } from "../../exchanges/adapter";
import type { AsterOrder } from "../../exchanges/types";
import { formatPriceToString } from "../../utils/math";
import type { PositionSnapshot } from "../../utils/strategy";
import { placeOrder } from "../order-coordinator";
import type { LogHandler, OrderLockMap, OrderPendingMap, OrderTimerMap } from "../order-coordinator";

const EPS = 1e-5;

export interface ReconcilePrices {
  topBid?: number | null;
  topAsk?: number | null;
  lastPrice?: number | null;
}

export interface ReconcileOptions {
  priceTick: number;
  qtyStep: number;
  strictLimitOnly: boolean;
  maxCloseSlippagePct: number;
}

function hasClosingProtection(openOrders: AsterOrder[], closeSide: "BUY" | "SELL"): boolean {
  // Consider reduce-only LIMITs or STOP(-like) orders on the closing side as protection present
  const has = openOrders.some((o) => {
    const sideMatches = o.side === closeSide;
    if (!sideMatches) return false;
    const type = String(o.type || "").toUpperCase();
    const hasStopPrice = Number.isFinite(Number(o.stopPrice)) && Number(o.stopPrice) > 0;
    const reduceOnly = o.reduceOnly === true;
    return reduceOnly || type === "STOP_MARKET" || hasStopPrice;
  });
  return has;
}

function buildClosePrice(
  side: "BUY" | "SELL",
  prices: ReconcilePrices,
  priceTick: number
): string | null {
  const { topBid, topAsk, lastPrice } = prices;
  const priceDecimals = Math.max(0, Math.floor(Math.log10(1 / Math.max(priceTick, 1e-9))));
  if (side === "SELL") {
    if (Number.isFinite(topAsk)) return formatPriceToString(Number(topAsk), priceDecimals);
    if (Number.isFinite(lastPrice)) return formatPriceToString(Number(lastPrice), priceDecimals);
  } else {
    if (Number.isFinite(topBid)) return formatPriceToString(Number(topBid), priceDecimals);
    if (Number.isFinite(lastPrice)) return formatPriceToString(Number(lastPrice), priceDecimals);
  }
  return null;
}

/**
 * Ensure that when a net position exists without any protective closing order present,
 * we place a reduce-only cover order at the top-of-book (or last price), with optional IOC.
 */
export async function reconcileOrphanedPosition(params: {
  exchange: ExchangeAdapter;
  symbol: string;
  position: PositionSnapshot;
  openOrders: AsterOrder[];
  locks: OrderLockMap;
  timers: OrderTimerMap;
  pendings: OrderPendingMap;
  prices: ReconcilePrices;
  opts: ReconcileOptions;
  ioc?: boolean;
  log: LogHandler;
}): Promise<{ tookAction: boolean }> {
  const { exchange, symbol, position, openOrders, locks, timers, pendings, prices, opts, ioc, log } = params;
  const absPos = Math.abs(position.positionAmt);
  if (absPos < EPS) return { tookAction: false };

  const closeSide: "BUY" | "SELL" = position.positionAmt > 0 ? "SELL" : "BUY";
  if (hasClosingProtection(openOrders, closeSide)) {
    return { tookAction: false };
  }

  const price = buildClosePrice(closeSide, prices, opts.priceTick);
  if (price == null) return { tookAction: false };

  try {
    await placeOrder(
      exchange,
      symbol,
      openOrders,
      locks,
      timers,
      pendings,
      closeSide,
      price,
      absPos,
      log,
      true,
      {
        markPrice: position.markPrice,
        expectedPrice: Number(price),
        maxPct: opts.maxCloseSlippagePct,
      },
      {
        priceTick: opts.priceTick,
        qtyStep: opts.qtyStep,
        timeInForce: (ioc || opts.strictLimitOnly) ? "IOC" : undefined,
      }
    );
    log(
      "stop",
      `安全保护：检测到孤立持仓，挂出保护性${closeSide} 平仓单 @ ${price} 数量 ${absPos}`
    );
    return { tookAction: true };
  } catch (error) {
    log("error", `孤立持仓保护下单失败: ${String(error)}`);
    return { tookAction: false };
  }
}
