import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { hedgeConfig } from "../config";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import {
  GrvtBingxHedgeEngine,
  type GrvtBingxHedgeSnapshot,
  type HedgeStatus,
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
  const statusLabelMap = useRef<Record<HedgeStatus, string>>({
    initializing: "初始化",
    "waiting-market": "等待盘口",
    "placing-entry": "布置入场挂单",
    "entry-working": "等待入场成交",
    "placing-exit": "布置止盈挂单",
    "exit-working": "等待止盈成交",
    "cycle-complete": "循环完成",
    stopped: "已停止",
    error: "错误",
  });

  useInput(
    (_input, key) => {
      if (key.escape) {
        engineRef.current?.stop();
        onExit();
      }
    },
    { isActive: inputSupported }
  );

  useEffect(() => {
    try {
      const grvtAdapter = buildAdapterFromEnv({
        exchangeId: "grvt",
        symbol: hedgeConfig.grvtSymbol,
      });
      const bingxAdapter = buildAdapterFromEnv({
        exchangeId: "bingx",
        symbol: hedgeConfig.bingxSymbol,
      });
      if (!grvtAdapter || !bingxAdapter) {
        throw new Error("无法创建交易所适配器，请检查环境变量配置");
      }
      const engine = new GrvtBingxHedgeEngine(hedgeConfig, { grvtAdapter, bingxAdapter });
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
  }, []);

  const roiTargetText = useMemo(() => {
    const value = snapshot?.roiTargetPercent ?? hedgeConfig.exitRoiPercent;
    return formatNumber(value, 2, "-");
  }, [snapshot]);

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
    cycle,
    autoRestart,
    ready,
    entryAverage,
    exitTargets,
    legs,
    tradeLog,
    errorMessage,
  } = snapshot;

  const lastLogs = tradeLog.slice(-6);
  const statusText = statusLabelMap.current[status] ?? status;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">GRVT-BingX 双腿对冲面板</Text>
        <Text>
          状态: {statusText} ｜ 循环: #{cycle} ｜ 自动重启: {autoRestart ? "开" : "关"} ｜ 数据就绪:{" "}
          {ready ? "是" : "否"}
        </Text>
        <Text>
          ROI 目标: {roiTargetText}% ｜ 入场均价: {formatNumber(entryAverage, 2, "-")} ｜ 预设平仓价: GRVT{" "}
          {formatNumber(exitTargets.grvt, 2, "-")} ｜ BingX {formatNumber(exitTargets.bingx, 2, "-")}
        </Text>
        <Text color="gray">
          仓位规模: {formatNumber(hedgeConfig.orderAmount, 4)} ｜ Esc 返回策略选择
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
