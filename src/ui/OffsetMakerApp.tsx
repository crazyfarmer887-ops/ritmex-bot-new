import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { makerConfig } from "../config";
import { getExchangeDisplayName, resolveExchangeId } from "../exchanges/create-adapter";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import { OffsetMakerEngine, type OffsetMakerEngineSnapshot } from "../strategy/offset-maker-engine";
import { DataTable, type TableColumn } from "./components/DataTable";
import { formatNumber } from "../utils/format";

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
        <Text color="red">실행 실패: {error.message}</Text>
        <Text color="gray">환경 변수와 네트워크 연결을 확인하세요.</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>오프셋 메이커 초기화 중…</Text>
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
    { key: "id", header: "ID", align: "right", minWidth: 6 },
    { key: "side", header: "방향", minWidth: 4 },
    { key: "price", header: "가격", align: "right", minWidth: 10 },
    { key: "qty", header: "수량", align: "right", minWidth: 8 },
    { key: "filled", header: "체결", align: "right", minWidth: 8 },
    { key: "reduceOnly", header: "RO", minWidth: 4 },
    { key: "status", header: "상태", minWidth: 10 },
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
    { key: "side", header: "방향", minWidth: 4 },
    { key: "price", header: "가격", align: "right", minWidth: 10 },
    { key: "amount", header: "수량", align: "right", minWidth: 8 },
    { key: "reduceOnly", header: "RO", minWidth: 4 },
  ];

  const lastLogs = snapshot.tradeLog.slice(-5);
  const imbalanceLabel = snapshot.depthImbalance === "balanced"
    ? "균형"
    : snapshot.depthImbalance === "buy_dominant"
    ? "매수 우위"
    : "매도 우위";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">오프셋 메이커 대시보드</Text>
        <Text>
          거래소: {exchangeName} | 심볼: {snapshot.symbol} | 매수호가: {formatNumber(topBid, 2)} | 매도호가: {formatNumber(topAsk, 2)} | 스프레드: {spreadDisplay}
        </Text>
        <Text>
          매수 10호가 합: {formatNumber(snapshot.buyDepthSum10, 4)} | 매도 10호가 합: {formatNumber(snapshot.sellDepthSum10, 4)} | 상태: {imbalanceLabel}
        </Text>
        <Text color="gray">
          현재 주문 전략: BUY {snapshot.skipBuySide ? "중지" : "사용"} | SELL {snapshot.skipSellSide ? "중지" : "사용"} | Esc: 뒤로
        </Text>
        <Text color="gray">상태: {snapshot.ready ? "실시간" : "시세 대기"}</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">포지션</Text>
          {hasPosition ? (
            <>
              <Text>
                방향: {snapshot.position.positionAmt > 0 ? "롱" : "숏"} | 수량: {formatNumber(Math.abs(snapshot.position.positionAmt), 4)} | 진입가: {formatNumber(snapshot.position.entryPrice, 2)}
              </Text>
              <Text>
                평가손익: {formatNumber(snapshot.pnl, 4)} USDT | 계정 미실현손익: {formatNumber(snapshot.accountUnrealized, 4)} USDT
              </Text>
            </>
          ) : (
            <Text color="gray">현재 포지션 없음</Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">목표 주문</Text>
          {desiredRows.length > 0 ? (
            <DataTable columns={desiredColumns} rows={desiredRows} />
          ) : (
            <Text color="gray">목표 주문 없음</Text>
          )}
          <Text>
            누적 체결 대금: {formatNumber(snapshot.sessionVolume, 2)} USDT
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">현재 주문</Text>
        {openOrderRows.length > 0 ? (
          <DataTable columns={openOrderColumns} rows={openOrderRows} />
        ) : (
          <Text color="gray">주문 없음</Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Text color="yellow">최근 이벤트</Text>
        {lastLogs.length > 0 ? (
          lastLogs.map((item, index) => (
            <Text key={`${item.time}-${index}`}>
              [{item.time}] [{item.type}] {item.detail}
            </Text>
          ))
        ) : (
          <Text color="gray">로그 없음</Text>
        )}
      </Box>
    </Box>
  );
}
