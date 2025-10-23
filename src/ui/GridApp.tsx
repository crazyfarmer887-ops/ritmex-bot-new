import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { gridConfig } from "../config";
import { getExchangeDisplayName, resolveExchangeId } from "../exchanges/create-adapter";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import { GridEngine, type GridEngineSnapshot } from "../strategy/grid-engine";
import { DataTable, type TableColumn } from "./components/DataTable";
import { formatNumber } from "../utils/format";
import { t } from "../utils/i18n";

interface GridAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function GridApp({ onExit }: GridAppProps) {
  const [snapshot, setSnapshot] = useState<GridEngineSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<GridEngine | null>(null);
  const exchangeId = useMemo(() => resolveExchangeId(), []);
  const exchangeName = useMemo(() => getExchangeDisplayName(exchangeId), [exchangeId]);

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
      const adapter = buildAdapterFromEnv({ exchangeId, symbol: gridConfig.symbol });
      const engine = new GridEngine(gridConfig, adapter);
      engineRef.current = engine;
      setSnapshot(engine.getSnapshot());
      const handler = (next: GridEngineSnapshot) => {
        setSnapshot({
          ...next,
          desiredOrders: [...next.desiredOrders],
          gridLines: [...next.gridLines],
          tradeLog: [...next.tradeLog],
        });
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
  }, [exchangeId]);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">{t("启动失败:")} {error.message}</Text>
        <Text color="gray">{t("请检查环境变量和网络连通性。")}</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>{t("正在初始化网格策略…")}</Text>
      </Box>
    );
  }

  const feedStatus = snapshot.feedStatus;
  const feedEntries: Array<{ key: keyof typeof feedStatus; label: string }> = [
    { key: "account", label: "账户" },
    { key: "orders", label: "订单" },
    { key: "depth", label: "深度" },
    { key: "ticker", label: "行情" },
  ];
  const stopReason = snapshot.running ? null : snapshot.stopReason;
  const lastLogs = snapshot.tradeLog.slice(-5);
  const position = snapshot.position;
  const hasPosition = Math.abs(position.positionAmt) > 1e-5;

  const gridColumns: TableColumn[] = [
    { key: "level", header: "#", align: "right", minWidth: 3 },
    { key: "price", header: t("Price"), align: "right", minWidth: 10 },
    { key: "side", header: t("Side"), minWidth: 4 },
    { key: "active", header: t("Active"), minWidth: 6 },
    { key: "hasOrder", header: t("Order"), minWidth: 5 },
  ];
  const gridRows = snapshot.gridLines.map((line) => ({
    level: line.level,
    price: formatNumber(line.price, 4),
    side: line.side,
    active: line.active ? t("yes") : t("no"),
    hasOrder: line.hasOrder ? t("yes") : t("no"),
  }));

  const desiredColumns: TableColumn[] = [
    { key: "level", header: "#", align: "right", minWidth: 3 },
    { key: "side", header: t("Side"), minWidth: 4 },
    { key: "price", header: t("Price"), align: "right", minWidth: 10 },
    { key: "amount", header: t("Qty"), align: "right", minWidth: 8 },
  ];
  const desiredRows = snapshot.desiredOrders.map((order) => ({
    level: order.level,
    side: order.side,
    price: order.price,
    amount: formatNumber(order.amount, 4),
  }));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">{t("Grid Strategy Dashboard")}</Text>
        <Text>
          {t("交易所:")} {exchangeName} ｜ {t("交易对:")} {snapshot.symbol} ｜ {t("状态:")} {snapshot.running ? t("运行中") : t("暂停")} ｜ {t("方向:")} {snapshot.direction}
        </Text>
        <Text>
          {t("实时价格:")} {formatNumber(snapshot.lastPrice, 4)} ｜ {t("下界:")} {formatNumber(snapshot.lowerPrice, 4)} ｜ {t("上界:")} {formatNumber(snapshot.upperPrice, 4)} ｜ {t("网格数量:")} {snapshot.gridLines.length}
        </Text>
        <Text color="gray">{t("数据状态:")}
          {feedEntries.map((entry, index) => (
            <Text key={entry.key} color={feedStatus[entry.key] ? "green" : "red"}>
              {index === 0 ? " " : " "}
              {entry.label}
            </Text>
          ))}
          ｜ {t("按 Esc 返回策略选择")}
        </Text>
        {stopReason ? <Text color="yellow">{t("暂停原因:")} {stopReason}</Text> : null}
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">{t("网格配置")}</Text>
          <Text>
            {t("单笔数量:")} {formatNumber(gridConfig.orderSize, 6)} ｜ {t("最大仓位:")} {formatNumber(gridConfig.maxPositionSize, 6)}
          </Text>
          <Text>
            {t("止损阈值:")} {(gridConfig.stopLossPct * 100).toFixed(2)}% ｜ {t("重启阈值:")} {(gridConfig.restartTriggerPct * 100).toFixed(2)}% ｜ {t("自动重启:")} {gridConfig.autoRestart ? t("启用") : t("关闭")}
          </Text>
          <Text>
            {t("刷新间隔:")} {gridConfig.refreshIntervalMs} ms
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">{t("持仓")}</Text>
          {hasPosition ? (
            <>
              <Text>
                {t("当前持仓:")} {position.positionAmt > 0 ? t("多") : t("空")} ｜ {t("数量:")} {formatNumber(Math.abs(position.positionAmt), 6)} ｜ {t("均价:")} {formatNumber(position.entryPrice, 4)}
              </Text>
              <Text>
                {t("未实现盈亏:")} {formatNumber(position.unrealizedProfit, 4)} ｜ {t("标记价:")} {formatNumber(position.markPrice, 4)}
              </Text>
            </>
          ) : (
            <Text color="gray">{t("当前无持仓")}</Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">{t("网格线")}</Text>
        {gridRows.length > 0 ? <DataTable columns={gridColumns} rows={gridRows} /> : <Text color="gray">{t("暂无网格线")}</Text>}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">{t("目标挂单")}</Text>
        {desiredRows.length > 0 ? <DataTable columns={desiredColumns} rows={desiredRows} /> : <Text color="gray">{t("暂无目标挂单")}</Text>}
      </Box>

      <Box flexDirection="column">
        <Text color="yellow">{t("最近事件")}</Text>
        {lastLogs.length > 0 ? (
          lastLogs.map((item, index) => (
            <Text key={`${item.time}-${index}`}>
              [{item.time}] [{item.type}] {item.detail}
            </Text>
          ))
        ) : (
          <Text color="gray">{t("暂无日志")}</Text>
        )}
      </Box>
    </Box>
  );
}
