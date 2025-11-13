import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { hedgeConfig, type HedgeConfig } from "../config";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import {
  GrvtBingxHedgeEngine,
  type GrvtBingxHedgeSnapshot,
} from "../strategy/grvt-bingx-hedge-engine";
import { formatNumber } from "../utils/format";

interface GrvtBingxHedgeAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function GrvtBingxHedgeApp({ onExit }: GrvtBingxHedgeAppProps) {
  const [snapshot, setSnapshot] = useState<GrvtBingxHedgeSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<GrvtBingxHedgeEngine | null>(null);
  const [phase, setPhase] = useState<"order" | "roi" | "running">(
    inputSupported ? "order" : "running"
  );
  const [inputValue, setInputValue] = useState<string>("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [draftOrderAmount, setDraftOrderAmount] = useState<number>(hedgeConfig.orderAmount);
  const [draftRoiPercent, setDraftRoiPercent] = useState<number>(hedgeConfig.exitRoiPercent);
  const [activeConfig, setActiveConfig] = useState<HedgeConfig | null>(
    inputSupported ? null : { ...hedgeConfig }
  );

  const handleSubmit = useCallback(() => {
    if (phase === "running") return;

    const defaultValue = phase === "order" ? draftOrderAmount : draftRoiPercent;
    const trimmed = inputValue.trim();
    const parsed = trimmed === "" ? defaultValue : Number(trimmed);

    if (!Number.isFinite(parsed)) {
      setInputError("请输入有效数字");
      return;
    }

    if (phase === "order") {
      if (parsed <= 0) {
        setInputError("下单数量必须大于 0");
        return;
      }
      setDraftOrderAmount(parsed);
      setInputValue("");
      setInputError(null);
      setPhase("roi");
      return;
    }

    if (parsed < 0) {
      setInputError("ROI 目标不能为负");
      return;
    }

    setDraftRoiPercent(parsed);
    setInputError(null);
    setError(null);
    setSnapshot(null);
    const nextConfig: HedgeConfig = {
      ...hedgeConfig,
      orderAmount: draftOrderAmount,
      exitRoiPercent: parsed,
    };
    setActiveConfig(nextConfig);
    setPhase("running");
  }, [phase, inputValue, draftOrderAmount, draftRoiPercent]);

  useInput(
    (_input, key) => {
      if (phase === "running") {
        if (key.escape) {
          engineRef.current?.stop();
          onExit();
        }
        return;
      }

      if (key.escape) {
        onExit();
        return;
      }

      if (key.return) {
        handleSubmit();
        return;
      }

      if (key.backspace || key.delete) {
        setInputValue((prev) => (prev.length > 0 ? prev.slice(0, -1) : ""));
        setInputError(null);
        return;
      }

      const isPrintable = typeof _input === "string" && _input.length > 0 && !key.ctrl && !key.meta;
      if (!isPrintable) {
        return;
      }

      if (/^[0-9.]$/.test(_input)) {
        setInputValue((prev) => {
          if (_input === "." && prev.includes(".")) {
            return prev;
          }
          return prev + _input;
        });
        setInputError(null);
      }
    },
    { isActive: inputSupported }
  );

  useEffect(() => {
    if (phase !== "running" || !activeConfig) {
      return;
    }

    try {
      const grvtAdapter = buildAdapterFromEnv({
        exchangeId: "grvt",
        symbol: activeConfig.grvtSymbol,
      });
      const bingxAdapter = buildAdapterFromEnv({
        exchangeId: "bingx",
        symbol: activeConfig.bingxSymbol,
      });
      if (!grvtAdapter || !bingxAdapter) {
        throw new Error("无法创建交易所适配器，请检查环境变量配置");
      }
      const engine = new GrvtBingxHedgeEngine(activeConfig, { grvtAdapter, bingxAdapter });
      engineRef.current = engine;
      setSnapshot(engine.getSnapshot());
      const handler = (next: GrvtBingxHedgeSnapshot) => {
        setSnapshot({ ...next, tradeLog: [...next.tradeLog] });
      };
      engine.on("update", handler);
      engine.start();
      return () => {
        engine.off("update", handler);
        engine.stop();
        engineRef.current = null;
      };
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [phase, activeConfig]);

  const roiTargetText = useMemo(() => {
    const value =
      snapshot?.roiTargetPercent ??
      activeConfig?.exitRoiPercent ??
      hedgeConfig.exitRoiPercent;
    return formatNumber(value, 2, "-");
  }, [snapshot, activeConfig]);

  if (phase !== "running" || !activeConfig) {
    const defaultValue = phase === "order" ? draftOrderAmount : draftRoiPercent;
    const instructions =
      phase === "order"
        ? "请输入每条腿的对冲下单数量 (基础资产)。"
        : "请输入退出 ROI 目标百分比 (0 表示按入场价退出)。";
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyanBright">GRVT-BingX 对冲配置</Text>
        <Text>{instructions}</Text>
        <Text color="gray">
          默认值: {formatNumber(defaultValue, phase === "order" ? 6 : 2)} ｜ 回车确认，Esc 返回策略选择
        </Text>
        <Box marginTop={1}>
          <Text>
            当前输入:{" "}
            <Text color="greenBright">
              {inputValue.length > 0 ? inputValue : "(按回车沿用默认值)"}
            </Text>
          </Text>
        </Box>
        {inputError ? <Text color="red">{inputError}</Text> : null}
        <Text color="gray">支持数字和小数点，Backspace 删除一位。</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">对冲模式启动失败: {error.message}</Text>
        <Text color="gray">请检查环境变量 (GRVT/BINGX) 与签名配置后重试。</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>正在初始化 GRVT-BingX 对冲引擎…</Text>
      </Box>
    );
  }

  const {
    status,
    ready,
    entryAverage,
    exitTargets,
    legs,
    tradeLog,
    errorMessage,
  } = snapshot;

  const lastLogs = tradeLog.slice(-6);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">GRVT-BingX 双腿对冲面板</Text>
        <Text>
          状态: {status} ｜ 数据就绪: {ready ? "是" : "否"} ｜ ROI 目标: {roiTargetText}%
        </Text>
        <Text>
          入场均价: {formatNumber(entryAverage, 2, "-")} ｜ 预设平仓价: GRVT{" "}
          {formatNumber(exitTargets.grvt, 2, "-")} ｜ BingX {formatNumber(exitTargets.bingx, 2, "-")}
        </Text>
        <Text color="gray">
          仓位规模: {formatNumber(activeConfig.orderAmount, 4)} ｜ Esc 返回策略选择
        </Text>
        {errorMessage ? <Text color="red">引擎提示: {errorMessage}</Text> : null}
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box marginRight={2}>
          <LegPanel title="GRVT 多头" leg={legs.grvt} />
        </Box>
        <LegPanel title="BingX 空头" leg={legs.bingx} />
      </Box>

      <Box flexDirection="column">
        <Text color="yellow">最近事件</Text>
        {lastLogs.length > 0 ? (
          lastLogs.map((item, index) => (
            <Text key={`${item.time}-${index}`}>
              [{item.time}] [{item.type}] {item.detail}
            </Text>
          ))
        ) : (
          <Text color="gray">暂无日志</Text>
        )}
      </Box>
    </Box>
  );
}

interface LegPanelProps {
  title: string;
  leg: GrvtBingxHedgeSnapshot["legs"][keyof GrvtBingxHedgeSnapshot["legs"]];
}

function LegPanel({ title, leg }: LegPanelProps) {
  const feedStatus = `账户 ${leg.feedReady.account ? "✓" : "×"} ｜ 订单 ${
    leg.feedReady.orders ? "✓" : "×"
  } ｜ 深度 ${leg.feedReady.depth ? "✓" : "×"}`;
  const positionAmt = formatNumber(leg.position.positionAmt, 4, "-");
  const entryPrice = formatNumber(leg.position.entryPrice, 2, "-");
  const markPrice = formatNumber(leg.position.markPrice, 2, "-");
  const topBid = formatNumber(leg.topBid, 2, "-");
  const topAsk = formatNumber(leg.topAsk, 2, "-");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" padding={1}>
      <Text color="greenBright">{title}</Text>
      <Text>
        交易所: {leg.exchange} ｜ 方向: {leg.direction === "long" ? "多" : "空"}
      </Text>
      <Text>
        盘口: Bid {topBid} ｜ Ask {topAsk}
      </Text>
      <Text>
        持仓: {positionAmt} ｜ 开仓价: {entryPrice} ｜ 标记价: {markPrice}
      </Text>
      <Text>入场单: {renderOrderSummary(leg.entryOrder)}</Text>
      <Text>退出单: {renderOrderSummary(leg.exitOrder)}</Text>
      <Text color="gray">数据源: {feedStatus}</Text>
    </Box>
  );
}

function renderOrderSummary(order: GrvtBingxHedgeSnapshot["legs"]["grvt"]["entryOrder"]): string {
  if (!order) return "暂无";
  const price = formatNumber(order.price, 2, "-");
  const qty = formatNumber(order.origQty, 4, "-");
  const exec = formatNumber(order.executedQty, 4, "-");
  const ro = order.reduceOnly ? " RO" : "";
  return `${order.side} ${order.status ?? "UNKNOWN"} @ ${price} qty ${qty} exec ${exec}${ro}`;
}
