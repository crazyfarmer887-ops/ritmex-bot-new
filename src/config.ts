/**
 * Trading Configuration
 * 
 */

import { resolveExchangeId, type SupportedExchangeId } from "./exchanges/create-adapter";
import type { TimeInForce } from "./exchanges/types";

export interface TradingConfig {
  symbol: string;
  tradeAmount: number;
  lossLimit: number;
  trailingProfit: number;
  trailingCallbackRate: number;
  profitLockTriggerUsd: number;
  profitLockOffsetUsd: number;
  pollIntervalMs: number;
  maxLogEntries: number;
  klineInterval: string;
  maxCloseSlippagePct: number;
  priceTick: number; // price tick size, e.g. 0.1 for BTCUSDT
  qtyStep: number;   // quantity step size, e.g. 0.001 BTC
  bollingerLength: number;
  bollingerStdMultiplier: number;
  minBollingerBandwidth: number;
}

const SYMBOL_PRIORITY_BY_EXCHANGE: Record<SupportedExchangeId, { envKeys: string[]; fallback: string }> = {
  aster: { envKeys: ["ASTER_SYMBOL", "TRADE_SYMBOL"], fallback: "BTCUSDT" },
  grvt: { envKeys: ["GRVT_SYMBOL", "TRADE_SYMBOL"], fallback: "BTCUSDT" },
  lighter: { envKeys: ["LIGHTER_SYMBOL", "TRADE_SYMBOL"], fallback: "BTCUSDT" },
  backpack: { envKeys: ["BACKPACK_SYMBOL", "TRADE_SYMBOL"], fallback: "BTCUSDC" },
  paradex: { envKeys: ["PARADEX_SYMBOL", "TRADE_SYMBOL"], fallback: "BTC/USDC" },
  bingx: { envKeys: ["BINGX_SYMBOL", "TRADE_SYMBOL"], fallback: "BTCUSDT" },
};

export function resolveSymbolFromEnv(explicitExchangeId?: SupportedExchangeId | string | null): string {
  const exchangeId = explicitExchangeId
    ? resolveExchangeId(explicitExchangeId)
    : resolveExchangeId();
  const { envKeys, fallback } = SYMBOL_PRIORITY_BY_EXCHANGE[exchangeId];
  for (const key of envKeys) {
    const value = process.env[key];
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  return fallback;
}

function parseTimeInForce(value: string | undefined, fallback: TimeInForce): TimeInForce {
  if (!value) return fallback;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return fallback;
  if (normalized === "IOC" || normalized === "IMMEDIATE_OR_CANCEL") return "IOC";
  if (normalized === "FOK" || normalized === "FILL_OR_KILL") return "FOK";
  if (normalized === "GTX" || normalized === "POST_ONLY" || normalized === "GOOD_TILL_TIME") return "GTX";
  if (normalized === "GTC" || normalized === "GOOD_TILL_CANCEL" || normalized === "GOOD_TIL_CANCELLED") return "GTC";
  return fallback;
}

export const tradingConfig: TradingConfig = {
  symbol: resolveSymbolFromEnv(),
  tradeAmount: parseNumber(process.env.TRADE_AMOUNT, 0.001),
  lossLimit: parseNumber(process.env.LOSS_LIMIT, 0.03),
  trailingProfit: parseNumber(process.env.TRAILING_PROFIT, 0.2),
  trailingCallbackRate: parseNumber(process.env.TRAILING_CALLBACK_RATE, 0.2),
  profitLockTriggerUsd: parseNumber(process.env.PROFIT_LOCK_TRIGGER_USD, 0.1),
  profitLockOffsetUsd: parseNumber(process.env.PROFIT_LOCK_OFFSET_USD, 0.05),
  pollIntervalMs: parseNumber(process.env.POLL_INTERVAL_MS, 500),
  maxLogEntries: parseNumber(process.env.MAX_LOG_ENTRIES, 200),
  klineInterval: process.env.KLINE_INTERVAL ?? "1m",
  maxCloseSlippagePct: parseNumber(process.env.MAX_CLOSE_SLIPPAGE_PCT, 0.05),
  priceTick: parseNumber(process.env.PRICE_TICK, 0.1),
  qtyStep: parseNumber(process.env.QTY_STEP, 0.001),
  bollingerLength: parseNumber(process.env.BOLLINGER_LENGTH, 20),
  bollingerStdMultiplier: parseNumber(process.env.BOLLINGER_STD_MULTIPLIER, 2),
  minBollingerBandwidth: parseNumber(process.env.MIN_BOLLINGER_BANDWIDTH, 0.001),
};

export interface MakerConfig {
  symbol: string;
  tradeAmount: number;
  lossLimit: number;
  bidOffset: number;
  askOffset: number;
  refreshIntervalMs: number;
  maxLogEntries: number;
  maxCloseSlippagePct: number;
  priceTick: number;
}

export const makerConfig: MakerConfig = {
  symbol: resolveSymbolFromEnv(),
  tradeAmount: parseNumber(process.env.TRADE_AMOUNT, 0.001),
  lossLimit: parseNumber(process.env.MAKER_LOSS_LIMIT, parseNumber(process.env.LOSS_LIMIT, 0.03)),
  bidOffset: parseNumber(process.env.MAKER_BID_OFFSET, 0),
  askOffset: parseNumber(process.env.MAKER_ASK_OFFSET, 0),
  refreshIntervalMs: parseNumber(process.env.MAKER_REFRESH_INTERVAL_MS, 500),
  maxLogEntries: parseNumber(process.env.MAKER_MAX_LOG_ENTRIES, 200),
  maxCloseSlippagePct: parseNumber(
    process.env.MAKER_MAX_CLOSE_SLIPPAGE_PCT ?? process.env.MAX_CLOSE_SLIPPAGE_PCT,
    0.05
  ),
  priceTick: parseNumber(process.env.MAKER_PRICE_TICK ?? process.env.PRICE_TICK, 0.1),
};

export interface BasisArbConfig {
  futuresSymbol: string;
  spotSymbol: string;
  refreshIntervalMs: number;
  maxLogEntries: number;
  takerFeeRate: number;
  arbAmount: number; // base asset amount to arb (e.g., ASTER amount when ASTERUSDT)
}

export type GridDirection = "both" | "long" | "short";

export interface GridConfig {
  symbol: string;
  lowerPrice: number;
  upperPrice: number;
  gridLevels: number;
  orderSize: number;
  maxPositionSize: number;
  refreshIntervalMs: number;
  maxLogEntries: number;
  priceTick: number;
  qtyStep: number;
  direction: GridDirection;
  stopLossPct: number;
  restartTriggerPct: number;
  autoRestart: boolean;
  gridMode: "geometric";
  maxCloseSlippagePct: number;
}

const resolveBasisSymbol = (envKeys: string[], fallback: string): string => {
  for (const key of envKeys) {
    const value = process.env[key];
    if (value && value.trim()) {
      return value.trim().toUpperCase();
    }
  }
  return fallback.toUpperCase();
};

export const basisConfig: BasisArbConfig = {
  futuresSymbol: resolveBasisSymbol(
    ["BASIS_FUTURES_SYMBOL", "ASTER_FUTURES_SYMBOL", "ASTER_SYMBOL", "TRADE_SYMBOL"],
    "ASTERUSDT"
  ),
  spotSymbol: resolveBasisSymbol(
    ["BASIS_SPOT_SYMBOL", "ASTER_SPOT_SYMBOL", "ASTER_SYMBOL", "TRADE_SYMBOL"],
    "ASTERUSDT"
  ),
  refreshIntervalMs: parseNumber(process.env.BASIS_REFRESH_INTERVAL_MS, 1000),
  maxLogEntries: parseNumber(process.env.BASIS_MAX_LOG_ENTRIES, 200),
  takerFeeRate: parseNumber(process.env.BASIS_TAKER_FEE_RATE, 0.0004),
  arbAmount: parseNumber(process.env.ARB_AMOUNT, parseNumber(process.env.TRADE_AMOUNT, 0)),
};

const resolveGridDirection = (raw: string | undefined, fallback: GridDirection): GridDirection => {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "long" || normalized === "long-only") return "long";
  if (normalized === "short" || normalized === "short-only") return "short";
  if (normalized === "both" || normalized === "dual" || normalized === "bi" || normalized === "two-way") return "both";
  return fallback;
};

const resolveGridMaxPosition = (orderSize: number, levels: number): number => {
  const fallback = Math.max(orderSize * Math.max(levels - 1, 1), orderSize);
  const raw = process.env.GRID_MAX_POSITION_SIZE ?? process.env.GRID_MAX_POSITION ?? process.env.GRID_POSITION_CAP;
  const parsed = parseNumber(raw, fallback);
  return parsed > 0 ? parsed : fallback;
};

export const gridConfig: GridConfig = {
  symbol: resolveSymbolFromEnv(),
  lowerPrice: parseNumber(process.env.GRID_LOWER_PRICE ?? process.env.GRID_LOWER_BOUND, 0),
  upperPrice: parseNumber(process.env.GRID_UPPER_PRICE ?? process.env.GRID_UPPER_BOUND, 0),
  gridLevels: Math.max(2, Math.floor(parseNumber(process.env.GRID_LEVELS, 10))),
  orderSize: parseNumber(process.env.GRID_ORDER_SIZE, parseNumber(process.env.TRADE_AMOUNT, 0.001)),
  maxPositionSize: 0, // placeholder, replaced below
  refreshIntervalMs: parseNumber(process.env.GRID_REFRESH_INTERVAL_MS, 1_000),
  maxLogEntries: parseNumber(process.env.GRID_MAX_LOG_ENTRIES, 200),
  priceTick: parseNumber(process.env.GRID_PRICE_TICK ?? process.env.PRICE_TICK, 0.1),
  qtyStep: parseNumber(process.env.GRID_QTY_STEP ?? process.env.QTY_STEP, 0.001),
  direction: resolveGridDirection(process.env.GRID_DIRECTION, "both"),
  stopLossPct: Math.max(0, parseNumber(process.env.GRID_STOP_LOSS_PCT, 0.01)),
  restartTriggerPct: Math.max(0, parseNumber(process.env.GRID_RESTART_TRIGGER_PCT, 0.01)),
  autoRestart: parseBoolean(process.env.GRID_AUTO_RESTART_ENABLED ?? process.env.GRID_ENABLE_AUTO_RESTART, true),
  gridMode: "geometric",
  maxCloseSlippagePct: Math.max(
    0,
    parseNumber(
      process.env.GRID_MAX_CLOSE_SLIPPAGE_PCT ?? process.env.MAX_CLOSE_SLIPPAGE_PCT,
      0.05
    )
  ),
};

gridConfig.maxPositionSize = resolveGridMaxPosition(gridConfig.orderSize, gridConfig.gridLevels);

export function isBasisStrategyEnabled(): boolean {
  const raw = process.env.ENABLE_BASIS_STRATEGY;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export interface HedgedVolumeConfig {
  grvtSymbol: string;
  bingxSymbol: string;
  quantity: number;
  entrySlippageBps: number;
  targetAbsRoiPct: number;
  leverageAbs: number;
  entryTimeInForce: TimeInForce;
  exitTimeInForce: TimeInForce;
  pollIntervalMs: number;
  maxLogEntries: number;
}

const resolveGrvtSymbol = (): string => {
  const candidate =
    process.env.HEDGED_VOLUME_GRVT_SYMBOL ??
    process.env.GRVT_SYMBOL ??
    process.env.GRVT_INSTRUMENT ??
    process.env.TRADE_SYMBOL;
  if (candidate && candidate.trim()) {
    return candidate.trim();
  }
  return resolveSymbolFromEnv("grvt");
};

const resolveBingxSymbol = (): string => {
  const candidate =
    process.env.HEDGED_VOLUME_BINGX_SYMBOL ??
    process.env.BINGX_SYMBOL ??
    process.env.TRADE_SYMBOL;
  if (candidate && candidate.trim()) {
    return candidate.trim().toUpperCase();
  }
  return resolveSymbolFromEnv("bingx");
};

const parsePositive = (value: number, fallback: number, min: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return Math.max(fallback, min);
  }
  return Math.max(value, min);
};

export const hedgedVolumeConfig: HedgedVolumeConfig = {
  grvtSymbol: resolveGrvtSymbol(),
  bingxSymbol: resolveBingxSymbol(),
  quantity: parsePositive(
    parseNumber(
      process.env.HEDGED_VOLUME_ORDER_SIZE ??
        process.env.HEDGED_VOLUME_AMOUNT ??
        process.env.TRADE_AMOUNT,
      0.001
    ),
    0.001,
    Number.EPSILON
  ),
  entrySlippageBps: Math.max(0, parseNumber(process.env.HEDGED_VOLUME_ENTRY_SLIPPAGE_BPS, 5)),
  targetAbsRoiPct: Math.max(0.01, parseNumber(process.env.HEDGED_VOLUME_TARGET_ROI ?? process.env.HEDGED_VOLUME_TARGET_ROI_PCT, 5)),
  leverageAbs: Math.max(
    1,
    parseNumber(
      process.env.HEDGED_VOLUME_LEVERAGE,
      parseNumber(process.env.BINGX_LEVERAGE ?? process.env.GRVT_LEVERAGE, 1)
    )
  ),
  entryTimeInForce: parseTimeInForce(
    process.env.HEDGED_VOLUME_ENTRY_TIF ?? process.env.HEDGED_VOLUME_TIF,
    "IOC"
  ),
  exitTimeInForce: parseTimeInForce(
    process.env.HEDGED_VOLUME_EXIT_TIF ?? process.env.HEDGED_VOLUME_EXIT_TIME_IN_FORCE,
    "GTC"
  ),
  pollIntervalMs: parsePositive(
    parseNumber(process.env.HEDGED_VOLUME_POLL_INTERVAL_MS, 1000),
    1000,
    200
  ),
  maxLogEntries: Math.max(50, Math.floor(parseNumber(process.env.HEDGED_VOLUME_MAX_LOG_ENTRIES, 200))),
};
