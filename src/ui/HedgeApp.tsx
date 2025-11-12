import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { grvtBingxHedgeConfig } from "../config";
import { GrvtExchangeAdapter } from "../exchanges/grvt/adapter";
import { BingxExchangeAdapter } from "../exchanges/bingx/adapter";
import { GrvtBingxHedgeEngine, type GrvtBingxHedgeSnapshot } from "../strategy/grvt-bingx-hedge-engine";
import { formatNumber } from "../utils/format";
import { DataTable, type TableColumn } from "./components/DataTable";

interface HedgeAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function HedgeApp({ onExit }: HedgeAppProps) {
  const [snapshot, setSnapshot] = useState<GrvtBingxHedgeSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<GrvtBingxHedgeEngine | null>(null);

  useInput(
    (input, key) => {
      if (key.escape) {
        engineRef.current?.stop();
        onExit();
      }
    },
    { isActive: inputSupported }
  );

  useEffect(() => {
    try {
      const grvtAdapter = new GrvtExchangeAdapter({
        instrument: grvtBingxHedgeConfig.grvtInstrument,
        symbol: grvtBingxHedgeConfig.grvtSymbol,
      });
      const bingxAdapter = new BingxExchangeAdapter({
        symbol: grvtBingxHedgeConfig.bingxSymbol,
      });
      const engine = new GrvtBingxHedgeEngine(grvtBingxHedgeConfig, grvtAdapter, bingxAdapter);
      engineRef.current = engine;
      setSnapshot(engine.getSnapshot());
      const handler = (next: GrvtBingxHedgeSnapshot) => {
        setSnapshot({
          ...next,
          tradeLog: [...next.tradeLog],
          grvt: { ...next.grvt, openOrders: [...next.grvt.openOrders] },
          bingx: { ...next.bingx, openOrders: [...next.bingx.openOrders] },
        });
      };
      engine.on("update", handler);
      engine.start();
      return () => {
        engine.off("update", handler);
        engine.stop();
      };
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      setError(wrapped);
      return () => undefined;
    }
  }, []);

  const orderTable = useMemo(() => {
    if (!snapshot) return { columns: [], rows: [] };
    const columns: TableColumn[] = [
      { key: "exchange", header: "Exch", minWidth: 6 },
      { key: "side", header: "Side", minWidth: 4 },
      { key: "price", header: "Price", align: "right", minWidth: 10 },
      { key: "qty", header: "Qty", align: "right", minWidth: 10 },
      { key: "status", header: "Status", minWidth: 10 },
    ];
    const rows = [
      ...snapshot.grvt.openOrders.map((order) => ({
        exchange: "GRVT",
        side: order.side,
        price: formatNumber(Number(order.price), 2),
        qty: formatNumber(Number(order.origQty), 4),
        status: order.status,
      })),
      ...snapshot.bingx.openOrders.map((order) => ({
        exchange: "BingX",
        side: order.side,
        price: formatNumber(Number(order.price), 2),
        qty: formatNumber(Number(order.origQty), 4),
        status: order.status,
      })),
    ];
    return { columns, rows };
  }, [snapshot]);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">对冲引擎启动失败: {error.message}</Text>
        <Text color="gray">请检查 GRVT/BingX 环境变量配置是否完整。</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>正在启动 GRVT ⇄ BingX 对冲引擎…</Text>
      </Box>
    );
  }

  const lastLogs = snapshot.tradeLog.slice(-6);
  const grvtPos = snapshot.grvt.position;
  const bingxPos = snapshot.bingx.position;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">GRVT ⇄ BingX 量化对冲模式</Text>
        <Text>
          阶段: {snapshot.phase} ｜ 目标 ROI: {snapshot.targetRoiPct.toFixed(2)}% ｜ 平均入场价:{" "}
          {snapshot.averageEntryPrice != null ? formatNumber(snapshot.averageEntryPrice, 2) : "-"}
        </Text>
        <Text>
          GRVT 目标价: {snapshot.grvtExitPrice != null ? formatNumber(snapshot.grvtExitPrice, 2) : "-"} ｜ BingX
          目标价: {snapshot.bingxExitPrice != null ? formatNumber(snapshot.bingxExitPrice, 2) : "-"}
        </Text>
        <Text color="gray">
          {snapshot.ready ? "数据源已就绪" : "等待行情/账户订阅同步中"} ｜ Esc 返回上一级
        </Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">GRVT</Text>
          <Text>
            仓位: {formatNumber(grvtPos.positionAmt, 4)} ｜ 均价: {formatNumber(grvtPos.entryPrice, 2)}
          </Text>
          <Text>
            标记价: {formatNumber(grvtPos.markPrice, 2)} ｜ 最新价: {formatNumber(snapshot.grvt.lastPrice, 2)}
          </Text>
          <Text>
            订单数: {snapshot.grvt.openOrders.length} ｜ 目标价:{" "}
            {snapshot.grvtExitPrice != null ? formatNumber(snapshot.grvtExitPrice, 2) : "-"}
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">BingX</Text>
          <Text>
            仓位: {formatNumber(bingxPos.positionAmt, 4)} ｜ 均价: {formatNumber(bingxPos.entryPrice, 2)}
          </Text>
          <Text>
            标记价: {formatNumber(bingxPos.markPrice, 2)} ｜ 最新价: {formatNumber(snapshot.bingx.lastPrice, 2)}
          </Text>
          <Text>
            订单数: {snapshot.bingx.openOrders.length} ｜ 目标价:{" "}
            {snapshot.bingxExitPrice != null ? formatNumber(snapshot.bingxExitPrice, 2) : "-"}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">当前挂单</Text>
        {orderTable.rows.length > 0 ? (
          <DataTable columns={orderTable.columns} rows={orderTable.rows} />
        ) : (
          <Text color="gray">暂无活动挂单</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text color="yellow">最近事件</Text>
        {lastLogs.length > 0 ? (
          lastLogs.map((entry, index) => (
            <Text key={`${entry.time}-${index}`}>
              [{entry.time}] [{entry.type}] {entry.detail}
            </Text>
          ))
        ) : (
          <Text color="gray">尚无日志</Text>
        )}
      </Box>
    </Box>
  );
}
