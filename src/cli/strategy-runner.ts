import { createInterface } from "node:readline/promises";
import {
  basisConfig,
  gridConfig,
  hedgeConfig,
  isBasisStrategyEnabled,
  makerConfig,
  tradingConfig,
} from "../config";
import { getExchangeDisplayName, resolveExchangeId } from "../exchanges/create-adapter";
import type { ExchangeAdapter } from "../exchanges/adapter";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import { MakerEngine, type MakerEngineSnapshot } from "../strategy/maker-engine";
import { OffsetMakerEngine, type OffsetMakerEngineSnapshot } from "../strategy/offset-maker-engine";
import { TrendEngine, type TrendEngineSnapshot } from "../strategy/trend-engine";
import { GuardianEngine, type GuardianEngineSnapshot } from "../strategy/guardian-engine";
import { BasisArbEngine, type BasisArbSnapshot } from "../strategy/basis-arb-engine";
import { GridEngine, type GridEngineSnapshot } from "../strategy/grid-engine";
import {
  GrvtBingxHedgeEngine,
  type GrvtBingxHedgeSnapshot,
} from "../strategy/grvt-bingx-hedge-engine";
import { extractMessage } from "../utils/errors";
import type { StrategyId } from "./args";

interface RunnerOptions {
  silent?: boolean;
}

type StrategyRunner = (options: RunnerOptions) => Promise<void>;

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  trend: "Trend Following",
  guardian: "Guardian",
  maker: "Maker",
  "offset-maker": "Offset Maker",
  basis: "Basis Arbitrage",
  grid: "Grid",
  "grvt-bingx-hedge": "GRVT-BingX Hedge",
};

export async function startStrategy(strategyId: StrategyId, options: RunnerOptions = {}): Promise<void> {
  const runner = STRATEGY_FACTORIES[strategyId];
  if (!runner) {
    throw new Error(`Unsupported strategy: ${strategyId}`);
  }
  await runner(options);
}

const STRATEGY_FACTORIES: Record<StrategyId, StrategyRunner> = {
  trend: async (opts) => {
    const config = tradingConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new TrendEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "trend",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  guardian: async (opts) => {
    const config = tradingConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new GuardianEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "guardian",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  maker: async (opts) => {
    const config = makerConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new MakerEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "maker",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  "offset-maker": async (opts) => {
    const config = makerConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new OffsetMakerEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "offset-maker",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  basis: async (opts) => {
    if (!isBasisStrategyEnabled()) {
      throw new Error("Basis arbitrage strategy is disabled. Set ENABLE_BASIS_STRATEGY=true to enable it.");
    }
    const exchangeId = resolveExchangeId();
    if (exchangeId !== "aster") {
      throw new Error("Basis arbitrage strategy currently only supports the Aster exchange");
    }
    const adapter = createAdapterOrThrow(basisConfig.futuresSymbol);
    const engine = new BasisArbEngine(basisConfig, adapter);
    await runEngine({
      engine,
      strategy: "basis",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  grid: async (opts) => {
    const config = gridConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new GridEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "grid",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  "grvt-bingx-hedge": async (opts) => {
    const config = await resolveHedgeRuntimeConfig(opts);
    const grvtAdapter = buildAdapterFromEnv({
      exchangeId: "grvt",
      symbol: config.grvtSymbol,
    });
    const bingxAdapter = buildAdapterFromEnv({
      exchangeId: "bingx",
      symbol: config.bingxSymbol,
    });
    if (!grvtAdapter || !bingxAdapter) {
      throw new Error("无法创建交易所适配器，请检查环境变量配置");
    }
    const engine = new GrvtBingxHedgeEngine(config, { grvtAdapter, bingxAdapter });
    await runEngine({
      engine,
      strategy: "grvt-bingx-hedge",
      silent: opts.silent,
      exchangeName: "GRVT + BingX",
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
};

interface EngineHarness<TSnapshot> {
  engine: { start(): void; stop(): void };
  strategy: StrategyId;
  silent?: boolean;
  getSnapshot: () => TSnapshot;
  onUpdate: (handler: (snapshot: TSnapshot) => void) => void;
  offUpdate: (handler: (snapshot: TSnapshot) => void) => void;
  exchangeName?: string;
}

async function runEngine<
  TSnapshot extends
    | TrendEngineSnapshot
    | GuardianEngineSnapshot
    | MakerEngineSnapshot
    | OffsetMakerEngineSnapshot
    | BasisArbSnapshot
      | GridEngineSnapshot
      | GrvtBingxHedgeSnapshot
>(
  harness: EngineHarness<TSnapshot>
): Promise<void> {
  const { engine, strategy, silent, getSnapshot, onUpdate, offUpdate, exchangeName } = harness;
  const exchangeId = resolveExchangeId();
  const resolvedExchangeName = exchangeName ?? getExchangeDisplayName(exchangeId);
  const label = STRATEGY_LABELS[strategy];

  const initial = getSnapshot();
  let lastLogKey: string | undefined;
  if (Array.isArray(initial.tradeLog) && initial.tradeLog.length > 0) {
    const lastEntry = initial.tradeLog[initial.tradeLog.length - 1]!;
    lastLogKey = createLogKey(lastEntry);
  }
  let readyLogged = initial.ready === true;

  const emitter = (snapshot: TSnapshot) => {
    if (!Array.isArray(snapshot.tradeLog)) return;
    if (!readyLogged && snapshot.ready) {
      readyLogged = true;
      console.info(`[${label}] Strategy ready. Listening for market data…`);
    }
    const pending = diffTradeLog(snapshot.tradeLog, lastLogKey);
    if (!pending.length) return;
    for (const entry of pending) {
      console.info(`[${label}] [${entry.time}] [${entry.type}] ${entry.detail}`);
    }
    const lastEntry = pending[pending.length - 1]!;
    if (lastEntry) {
      lastLogKey = createLogKey(lastEntry);
    }
  };

  onUpdate(emitter);
  engine.start();

  console.info(
    `[${label}] Starting on ${resolvedExchangeName}. Mode: ${silent ? "silent" : "interactive"}. Press Ctrl+C to exit.`
  );

  const shutdown = (signal: NodeJS.Signals) => {
    try {
      console.info(`[${label}] Received ${signal}. Shutting down…`);
      engine.stop();
      offUpdate(emitter);
    } catch (error) {
      console.error(`[${label}] Error during shutdown: ${extractMessage(error)}`);
    }
  };

  await new Promise<void>((resolve) => {
    const wrapper = (signal: NodeJS.Signals) => {
      shutdown(signal);
      process.off("SIGINT", wrapper);
      process.off("SIGTERM", wrapper);
      resolve();
    };

    process.on("SIGINT", wrapper);
    process.on("SIGTERM", wrapper);
  });
}

async function resolveHedgeRuntimeConfig(options: RunnerOptions): Promise<typeof hedgeConfig> {
  if (options.silent || !process.stdin.isTTY || !process.stdout.isTTY) {
    if (hedgeConfig.orderAmount <= 0) {
      throw new Error("对冲下单数量必须大于 0 (HEDGE_ORDER_AMOUNT)");
    }
    return hedgeConfig;
  }

  const orderAmount = await promptPositiveHedgeAmount(hedgeConfig.orderAmount);
  console.info(`[${STRATEGY_LABELS["grvt-bingx-hedge"]}] 对冲下单数量设定为 ${orderAmount}`);
  return { ...hedgeConfig, orderAmount };
}

async function promptPositiveHedgeAmount(defaultAmount: number): Promise<number> {
  const fallback = Number.isFinite(defaultAmount) && defaultAmount > 0 ? defaultAmount : null;
  const prompt =
    fallback != null
      ? `请输入对冲下单数量 (默认 ${fallback}): `
      : "请输入对冲下单数量 (必须大于 0): ";
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      let answer: string;
      try {
        answer = await rl.question(prompt);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("已取消对冲模式启动");
        }
        throw error;
      }
      const trimmed = answer.trim();
      if (!trimmed) {
        if (fallback != null) {
          return fallback;
        }
        console.info("当前默认值无效，请输入大于 0 的数字。");
        continue;
      }
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
      console.info("请输入大于 0 的数字。");
    }
  } finally {
    rl.close();
  }
}

function createAdapterOrThrow(symbol: string): ExchangeAdapter {
  return buildAdapterFromEnv({ exchangeId: resolveExchangeId(), symbol });
}

type TradeLogEntry = { time: string; type: string; detail: string };

function diffTradeLog(tradeLog: TradeLogEntry[], lastKey: string | undefined): TradeLogEntry[] {
  if (!tradeLog.length) return [];
  if (!lastKey) return tradeLog;
  const lastIndex = tradeLog.findIndex((entry) => createLogKey(entry) === lastKey);
  if (lastIndex === -1) {
    return tradeLog;
  }
  if (lastIndex === tradeLog.length - 1) return [];
  return tradeLog.slice(lastIndex + 1);
}

function createLogKey(entry: TradeLogEntry): string {
  return `${entry.time}|${entry.type}|${entry.detail}`;
}
