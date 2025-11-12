import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { hedgedVolumeConfig } from "../config";
import {
  HedgedVolumeEngine,
  type HedgedVolumeSnapshot,
  type HedgedVolumeStatus,
} from "../strategy/hedged-volume-engine";
import { formatNumber } from "../utils/format";
import { DataTable, type TableColumn } from "./components/DataTable";

interface HedgedVolumeAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

const STATUS_LABELS: Record<HedgedVolumeStatus, string> = {
  idle: "等待启动",
  "waiting-market": "等待盘口数据",
  entering: "提交开仓订单",
  "waiting-fill": "等待多空仓位就绪",
  "placing-exits": "布置平仓限价单",
  monitoring: "监控仓位与挂单",
  completed: "策略完成",
  stopped: "已停止",
  error: "异常",
};

export function HedgedVolumeApp({ onExit }: HedgedVolumeAppProps) {
  const [snapshot, setSnapshot] = useState<HedgedVolumeSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<HedgedVolumeEngine | null>(null);

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
      const engine = new HedgedVolumeEngine(hedgedVolumeConfig);
      engineRef.current = engine;
      setSnapshot(engine.getSnapshot());
      const handler = (next: HedgedVolumeSnapshot) => {
        setSnapshot({ ...next, tradeLog: [...next.tradeLog] });
      };
      engine.on("update", handler);
      engine.start();
      return () => {
        engine.off("update", handler);
        engine.stop();
      };
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  const statusLabel = useMemo(() => STATUS_LABELS[snapshot?.status ?? "idle"], [snapshot?.status]);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">对冲刷量模式启动失败: {error.message}</Text>
        <Text color="gray">请检查环境变量配置 (GRVT/BingX 凭证、符号等)。</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>正在加载对冲刷量模块…</Text>
      </Box>
    );
  }

  const { grvtPosition, bingxPosition, tradeLog, grvtOpenOrders, bingxOpenOrders } = snapshot;
  const hasBothPositions =
    Math.abs(grvtPosition.positionAmt) > 1e-6 && Math.abs(bingxPosition.positionAmt) > 1e-6;
  const recentLogs = tradeLog.slice(-6);
  const openOrders = [
    ...grvtOpenOrders.map((order) => ({
      exchange: "GRVT",
      id: String(order.orderId),
      side: order.side,
      price: Number(order.price),
      qty: Number(order.origQty),
      status: order.status,
    })),
    ...bingxOpenOrders.map((order) => ({
      exchange: "BingX",
      id: String(order.orderId),
      side: order.side,
      price: Number(order.price),
      qty: Number(order.origQty),
      status: order.status,
    })),
  ].slice(0, 10);

  const orderColumns: TableColumn[] = [
    { key: "exchange", header: "Exch", minWidth: 6 },
    { key: "id", header: "OrderId", minWidth: 10 },
    { key: "side", header: "Side", minWidth: 4 },
    { key: "price", header: "Price", align: "right", minWidth: 10 },
    { key: "qty", header: "Qty", align: "right", minWidth: 8 },
    { key: "status", header: "Status", minWidth: 10 },
  ];

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">GRVT ↔ BingX 对冲刷量模式</Text>
        <Text>
          目标绝对 ROI: {formatNumber(snapshot.roiTargetPct, 2)}% ｜ 绝对杠杆: {formatNumber(snapshot.leverageAbs, 2)}x ｜ 状态:{" "}
          {statusLabel}
        </Text>
        <Text color="gray">按 Esc 返回策略选择界面。</Text>
        {snapshot.lastError ? (
          <Text color="red">最近错误: {snapshot.lastError}</Text>
        ) : null}
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">GRVT 多头</Text>
          <Text>
            符号: {snapshot.grvtSymbol} ｜ 数量: {formatNumber(grvtPosition.positionAmt, 4)} ｜ 开仓价:{" "}
            {formatNumber(grvtPosition.entryPrice, 2)}
          </Text>
          <Text>
            浮动盈亏: {formatNumber(grvtPosition.unrealizedProfit, 4)} ｜ Mark:{" "}
            {formatNumber(grvtPosition.markPrice, 2)}
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">BingX 空头</Text>
          <Text>
            符号: {snapshot.bingxSymbol} ｜ 数量: {formatNumber(bingxPosition.positionAmt, 4)} ｜ 开仓价:{" "}
            {formatNumber(bingxPosition.entryPrice, 2)}
          </Text>
          <Text>
            浮动盈亏: {formatNumber(bingxPosition.unrealizedProfit, 4)} ｜ Mark:{" "}
            {formatNumber(bingxPosition.markPrice, 2)}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">挂单与目标</Text>
        <Text>
          平均入场价: {formatNumber(snapshot.avgEntryPrice, 2)} ｜ 上轨平仓价:{" "}
          {formatNumber(snapshot.targetUpperPrice, 2)} ｜ 下轨平仓价: {formatNumber(snapshot.targetLowerPrice, 2)}
        </Text>
        {openOrders.length > 0 ? (
          <DataTable columns={orderColumns} rows={openOrders} />
        ) : (
          <Text color="gray">当前无挂单</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text color="yellow">最近事件</Text>
        {recentLogs.length > 0 ? (
          recentLogs.map((log, index) => (
            <Text key={`${log.time}-${index}`}>
              [{log.time}] [{log.type}] {log.detail}
            </Text>
          ))
        ) : (
          <Text color="gray">暂无日志</Text>
        )}
      </Box>

      {!snapshot.ready ? (
        <Box marginTop={1}>
          <Text color="gray">等待盘口数据建立中…</Text>
        </Box>
      ) : null}

      {!hasBothPositions && snapshot.entrySubmitted ? (
        <Box marginTop={1}>
          <Text color="gray">已提交开仓单，等待两侧仓位填充。</Text>
        </Box>
      ) : null}
    </Box>
  );
}
