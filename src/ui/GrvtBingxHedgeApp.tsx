import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { hedgeConfig, type HedgeConfig } from "../config";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import {
  GrvtBingxHedgeEngine,
  type GrvtBingxHedgeSnapshot,
} from "../strategy/grvt-bingx-hedge-engine";
import { formatNumber } from "../utils/format";
import { isValidOrderAmount, isValidRoiPercent, parseNumericInput } from "../strategy/hedge-config-utils";

interface GrvtBingxHedgeAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function GrvtBingxHedgeApp({ onExit }: GrvtBingxHedgeAppProps) {
  const [snapshot, setSnapshot] = useState<GrvtBingxHedgeSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<GrvtBingxHedgeEngine | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<HedgeConfig | null>(null);
  const [promptStage, setPromptStage] = useState<"order" | "roi">("order");
  const [inputBuffer, setInputBuffer] = useState<string>("");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [orderAmount, setOrderAmount] = useState<number>(hedgeConfig.orderAmount);
  const [exitRoiPercent, setExitRoiPercent] = useState<number>(hedgeConfig.exitRoiPercent);

  useInput(
    (input, key) => {
      if (!runtimeConfig) {
        if (key.escape || (key.ctrl && input === "c")) {
          onExit();
          return;
        }

        if (key.return) {
          const fallback = promptStage === "order" ? orderAmount : exitRoiPercent;
          const parsed = parseNumericInput(inputBuffer, fallback);

          if (parsed == null) {
            setPromptError("请输入有效数字。");
            return;
          }

          if (promptStage === "order") {
            if (!isValidOrderAmount(parsed)) {
              setPromptError("仓位数量必须大于 0。");
              return;
            }
            setOrderAmount(parsed);
            setPromptStage("roi");
            setInputBuffer("");
            setPromptError(null);
            return;
          }

          if (!isValidRoiPercent(parsed)) {
            setPromptError("ROI 百分比必须大于等于 0。");
            return;
          }

          setExitRoiPercent(parsed);
          setPromptError(null);
          setRuntimeConfig({
            ...hedgeConfig,
            orderAmount,
            exitRoiPercent: parsed,
          });
          setInputBuffer("");
          return;
        }

        if (key.backspace || key.delete) {
          if (inputBuffer.length > 0) {
            setInputBuffer((prev) => prev.slice(0, -1));
          }
          if (promptError) {
            setPromptError(null);
          }
          return;
        }

        if (input && input.length === 1) {
          if (input === "." && inputBuffer.includes(".")) {
            return;
          }
          if (/[0-9.]/.test(input)) {
            setInputBuffer((prev) => prev + input);
            if (promptError) {
              setPromptError(null);
            }
          }
        }
        return;
      }

      if (key.escape) {
        engineRef.current?.stop();
        onExit();
      }
    },
    { isActive: inputSupported }
  );

  useEffect(() => {
    if (!runtimeConfig) return;
    setError(null);
    setSnapshot(null);
    try {
      const grvtAdapter = buildAdapterFromEnv({
        exchangeId: "grvt",
        symbol: runtimeConfig.grvtSymbol,
      });
      const bingxAdapter = buildAdapterFromEnv({
        exchangeId: "bingx",
        symbol: runtimeConfig.bingxSymbol,
      });
      if (!grvtAdapter || !bingxAdapter) {
        throw new Error("无法创建交易所适配器，请检查环境变量配置");
      }
      const engine = new GrvtBingxHedgeEngine(runtimeConfig, { grvtAdapter, bingxAdapter });
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
      };
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [runtimeConfig]);

  const roiTargetText = useMemo(() => {
    const configValue = runtimeConfig?.exitRoiPercent ?? hedgeConfig.exitRoiPercent;
    const value = snapshot?.roiTargetPercent ?? configValue;
    return formatNumber(value, 2, "-");
  }, [snapshot, runtimeConfig]);

  if (!runtimeConfig) {
    const isOrderStage = promptStage === "order";
    const defaultValue = isOrderStage ? orderAmount : exitRoiPercent;
    const defaultFormatted = isOrderStage
      ? formatNumber(defaultValue, 4, "-")
      : formatNumber(defaultValue, 2, "-");
    const defaultValid = isOrderStage
      ? isValidOrderAmount(defaultValue)
      : isValidRoiPercent(defaultValue);

    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyanBright">GRVT-BingX 对冲模式</Text>
        <Text>
          {isOrderStage
            ? `请输入对冲单腿仓位数量 (默认 ${defaultFormatted})`
            : `请输入退出 ROI 百分比 (默认 ${defaultFormatted}%)`}
        </Text>
        <Text color="gray">按回车确认，留空使用默认值，Esc/Ctrl+C 返回策略选择。</Text>
        {!defaultValid ? <Text color="yellow">当前默认值无效，请输入新的数值。</Text> : null}
        {promptError ? <Text color="red">{promptError}</Text> : null}
        <Box marginTop={1}>
          <Text>当前输入: {inputBuffer || "<默认>"}</Text>
        </Box>
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

  const { status, ready, entryAverage, exitTargets, legs, tradeLog, errorMessage } = snapshot;

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
          仓位规模: {formatNumber(runtimeConfig.orderAmount, 4)} ｜ Esc 返回策略选择
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
