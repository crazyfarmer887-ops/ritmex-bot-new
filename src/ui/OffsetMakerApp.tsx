import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { makerConfig } from "../config";
import { getExchangeDisplayName, resolveExchangeId } from "../exchanges/create-adapter";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import { OffsetMakerEngine, type OffsetMakerEngineSnapshot } from "../strategy/offset-maker-engine";
import { DataTable, type TableColumn } from "./components/DataTable";
import { formatNumber } from "../utils/format";
import { t } from "../utils/i18n";

interface OffsetMakerAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function OffsetMakerApp({ onExit }: OffsetMakerAppProps) {
  const [snapshot, setSnapshot] = useState<OffsetMakerEngineSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<OffsetMakerEngine | null>(null);
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
      const adapter = buildAdapterFromEnv({ exchangeId, symbol: makerConfig.symbol });
      const engine = new OffsetMakerEngine(makerConfig, adapter);
      engineRef.current = engine;
      setSnapshot(engine.getSnapshot());
      const handler = (next: OffsetMakerEngineSnapshot) => {
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
        <Text>{t("正在初始化偏移做市策略…")}</Text>
      </Box>
    );
  }

  const topBid = snapshot.topBid;
  const topAsk = snapshot.topAsk;
  const spreadDisplay = snapshot.spread != null ? `${snapshot.spread.toFixed(4)} USDT` : "-";
  const hasPosition = Math.abs(snapshot.position.positionAmt) > 1e-5;
  const sortedOrders = [...snapshot.openOrders].sort((a, b) =>
    (Number(b.updateTime ?? 0) - Number(a.updateTime ?? 0)) || Number(b.orderId) - Number(a.orderId)
  );
  const openOrderRows = sortedOrders.slice(0, 8).map((order) => ({
    id: order.orderId,
    side: order.side,
    price: order.price,
    qty: order.origQty,
    filled: order.executedQty,
    reduceOnly: order.reduceOnly ? "yes" : "no",
    status: order.status,
  }));
  const openOrderColumns: TableColumn[] = [
    { key: "id", header: t("ID"), align: "right", minWidth: 6 },
    { key: "side", header: t("Side"), minWidth: 4 },
    { key: "price", header: t("Price"), align: "right", minWidth: 10 },
    { key: "qty", header: t("Qty"), align: "right", minWidth: 8 },
    { key: "filled", header: t("Filled"), align: "right", minWidth: 8 },
    { key: "reduceOnly", header: t("RO"), minWidth: 4 },
    { key: "status", header: t("Status"), minWidth: 10 },
  ];

  const desiredRows = snapshot.desiredOrders.map((order, index) => ({
    index: index + 1,
    side: order.side,
    price: order.price,
    amount: order.amount,
    reduceOnly: order.reduceOnly ? "yes" : "no",
  }));
  const desiredColumns: TableColumn[] = [
    { key: "index", header: "#", align: "right", minWidth: 2 },
    { key: "side", header: t("Side"), minWidth: 4 },
    { key: "price", header: t("Price"), align: "right", minWidth: 10 },
    { key: "amount", header: t("Qty"), align: "right", minWidth: 8 },
    { key: "reduceOnly", header: t("RO"), minWidth: 4 },
  ];

  const lastLogs = snapshot.tradeLog.slice(-5);
  const imbalanceLabel = snapshot.depthImbalance === "balanced"
    ? t("均衡")
    : snapshot.depthImbalance === "buy_dominant"
    ? t("买盘占优")
    : t("卖盘占优");

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">{t("Offset Maker Strategy Dashboard")}</Text>
        <Text>
          {t("交易所:")} {exchangeName} ｜ {t("交易对:")} {snapshot.symbol} ｜ {t("买一价:")} {formatNumber(topBid, 2)} ｜ {t("卖一价:")} {formatNumber(topAsk, 2)} ｜ {t("点差:")} {spreadDisplay}
        </Text>
        <Text>
          {t("买10档累计:")} {formatNumber(snapshot.buyDepthSum10, 4)} ｜ {t("卖10档累计:")} {formatNumber(snapshot.sellDepthSum10, 4)} ｜ {t("状态:")} {imbalanceLabel}
        </Text>
        <Text color="gray">
          {t("当前挂单策略:")} BUY {snapshot.skipBuySide ? t("暂停") : t("启用")} ｜ SELL {snapshot.skipSellSide ? t("暂停") : t("启用")} ｜ {t("按 Esc 返回策略选择")}
        </Text>
        <Text color="gray">{t("状态:")} {snapshot.ready ? t("实时运行") : t("等待市场数据")}</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">{t("持仓")}</Text>
          {hasPosition ? (
            <>
              <Text>
                {t("方向:")} {snapshot.position.positionAmt > 0 ? t("多") : t("空")} ｜ {t("数量:")} {formatNumber(Math.abs(snapshot.position.positionAmt), 4)} ｜ {t("开仓价:")} {formatNumber(snapshot.position.entryPrice, 2)}
              </Text>
              <Text>
                {t("浮动盈亏:")} {formatNumber(snapshot.pnl, 4)} USDT ｜ {t("账户未实现盈亏:")} {formatNumber(snapshot.accountUnrealized, 4)} USDT
              </Text>
            </>
          ) : (
            <Text color="gray">{t("当前无持仓")}</Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">{t("目标挂单")}</Text>
          {desiredRows.length > 0 ? (
            <DataTable columns={desiredColumns} rows={desiredRows} />
          ) : (
            <Text color="gray">{t("暂无目标挂单")}</Text>
          )}
          <Text>
            {t("累计成交量:")} {formatNumber(snapshot.sessionVolume, 2)} USDT
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">{t("当前挂单")}</Text>
        {openOrderRows.length > 0 ? (
          <DataTable columns={openOrderColumns} rows={openOrderRows} />
        ) : (
          <Text color="gray">{t("暂无挂单")}</Text>
        )}
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
