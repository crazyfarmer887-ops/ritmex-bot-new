import React, { useEffect, useMemo, useRef, useState } from "react";
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
  const [resolvedConfig, setResolvedConfig] = useState<HedgeConfig | null>(
    inputSupported ? null : hedgeConfig
  );
  const [orderAmountInput, setOrderAmountInput] = useState(() =>
    hedgeConfig.orderAmount > 0 ? String(hedgeConfig.orderAmount) : ""
  );
  const [promptError, setPromptError] = useState<string | null>(null);

  useInput(
    (input, key) => {
      if (!resolvedConfig) {
        if (key.escape) {
          onExit();
          return;
        }
        if (key.return) {
          const trimmed = orderAmountInput.trim();
          const fallback = hedgeConfig.orderAmount > 0 ? hedgeConfig.orderAmount : null;
          let amount: number | null = null;
          if (trimmed) {
            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed) || parsed <= 0) {
              setPromptError("请输入大于 0 的数字");
              return;
            }
            amount = parsed;
          } else {
            if (fallback == null) {
              setPromptError("当前默认值无效，请输入大于 0 的数字");
              return;
            }
            amount = fallback;
          }
          setPromptError(null);
          setResolvedConfig({ ...hedgeConfig, orderAmount: amount });
          setOrderAmountInput(String(amount));
          return;
        }
        if (key.backspace || key.delete) {
          setOrderAmountInput((prev) => prev.slice(0, -1));
          setPromptError(null);
          return;
        }
        if (input) {
          let didChange = false;
          setOrderAmountInput((prev) => {
            let next = prev;
            for (const char of input) {
              if ((char >= "0" && char <= "9") || char === ".") {
                if (char === "." && next.includes(".")) {
                  continue;
                }
                if (char === "." && next === "") {
                  next = "0.";
                } else if (next === "0" && char !== "." && !next.includes(".")) {
                  next = char;
                } else {
                  next += char;
                }
                didChange = true;
              }
            }
            return next;
          });
          if (didChange) {
            setPromptError(null);
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
    if (!resolvedConfig) return;
    setError(null);
    try {
      if (!Number.isFinite(resolvedConfig.orderAmount) || resolvedConfig.orderAmount <= 0) {
        throw new Error("对冲下单数量必须大于 0，请检查配置或输入值");
      }
      const grvtAdapter = buildAdapterFromEnv({
        exchangeId: "grvt",
        symbol: resolvedConfig.grvtSymbol,
      });
      const bingxAdapter = buildAdapterFromEnv({
        exchangeId: "bingx",
        symbol: resolvedConfig.bingxSymbol,
      });
      if (!grvtAdapter || !bingxAdapter) {
        throw new Error("无法创建交易所适配器，请检查环境变量配置");
      }
      const engine = new GrvtBingxHedgeEngine(resolvedConfig, { grvtAdapter, bingxAdapter });
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
  }, [resolvedConfig]);

  const roiTargetText = useMemo(() => {
    const fallback = resolvedConfig?.exitRoiPercent ?? hedgeConfig.exitRoiPercent;
    const value = snapshot?.roiTargetPercent ?? fallback;
    return formatNumber(value, 2, "-");
  }, [resolvedConfig, snapshot]);
  const activeConfig = resolvedConfig ?? hedgeConfig;

  if (inputSupported && !resolvedConfig) {
    const hasDefault = hedgeConfig.orderAmount > 0;
    const defaultText = hasDefault ? String(hedgeConfig.orderAmount) : "无有效默认值";
    const inputText =
      orderAmountInput.length > 0
        ? orderAmountInput
        : hasDefault
          ? "(使用默认值)"
          : "(空)";
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyanBright">GRVT-BingX 对冲模式</Text>
        <Text>请输入对冲下单数量以启动策略。</Text>
        <Text color="gray">
          默认值: {hasDefault ? defaultText : "无效 — 必须手动输入大于 0 的数字"}
        </Text>
        <Box marginTop={1} marginBottom={1}>
          <Text>当前输入: {inputText}</Text>
        </Box>
        {promptError ? <Text color="red">{promptError}</Text> : null}
        <Text color="gray">数字/小数点输入，Backspace 删除，Enter 确认，Esc 返回</Text>
        {hasDefault ? <Text color="gray">直接回车可使用默认值。</Text> : null}
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
