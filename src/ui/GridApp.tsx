import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { gridConfig } from "../config";
import { getExchangeDisplayName, resolveExchangeId } from "../exchanges/create-adapter";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import { GridEngine, type GridEngineSnapshot } from "../strategy/grid-engine";
import { DataTable, type TableColumn } from "./components/DataTable";
import { formatNumber } from "../utils/format";

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
        <Text color="red">실행 실패: {error.message}</Text>
        <Text color="gray">환경 변수와 네트워크 연결을 확인하세요.</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>그리드 전략 초기화 중…</Text>
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
    { key: "price", header: "가격", align: "right", minWidth: 10 },
    { key: "side", header: "방향", minWidth: 4 },
    { key: "active", header: "활성", minWidth: 6 },
    { key: "hasOrder", header: "주문", minWidth: 5 },
  ];
  const gridRows = snapshot.gridLines.map((line) => ({
    level: line.level,
    price: formatNumber(line.price, 4),
    side: line.side,
    active: line.active ? "yes" : "no",
    hasOrder: line.hasOrder ? "yes" : "no",
  }));

  const desiredColumns: TableColumn[] = [
    { key: "level", header: "#", align: "right", minWidth: 3 },
    { key: "side", header: "방향", minWidth: 4 },
    { key: "price", header: "가격", align: "right", minWidth: 10 },
    { key: "amount", header: "수량", align: "right", minWidth: 8 },
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
        <Text color="cyanBright">그리드 전략 대시보드</Text>
        <Text>
          거래소: {exchangeName} | 심볼: {snapshot.symbol} | 상태: {snapshot.running ? "실행" : "정지"} | 방향: {snapshot.direction}
        </Text>
        <Text>
          실시간가: {formatNumber(snapshot.lastPrice, 4)} | 하단: {formatNumber(snapshot.lowerPrice, 4)} | 상단: {formatNumber(snapshot.upperPrice, 4)} | 그리드 수: {snapshot.gridLines.length}
        </Text>
        <Text color="gray">데이터 상태:
          {feedEntries.map((entry, index) => (
            <Text key={entry.key} color={feedStatus[entry.key] ? "green" : "red"}>
              {index === 0 ? " " : " "}
              {entry.label}
            </Text>
          ))}
          | Esc: 뒤로
        </Text>
        {stopReason ? <Text color="yellow">정지 사유: {stopReason}</Text> : null}
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">그리드 설정</Text>
          <Text>
            1회 수량: {formatNumber(gridConfig.orderSize, 6)} | 최대 포지션: {formatNumber(gridConfig.maxPositionSize, 6)}
          </Text>
          <Text>
            손절 임계치: {(gridConfig.stopLossPct * 100).toFixed(2)}% | 재시작 임계치: {(gridConfig.restartTriggerPct * 100).toFixed(2)}% | 자동 재시작: {gridConfig.autoRestart ? "사용" : "해제"}
          </Text>
          <Text>
            새로고침 간격: {gridConfig.refreshIntervalMs} ms
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">포지션</Text>
          {hasPosition ? (
            <>
              <Text>
                현재 포지션: {position.positionAmt > 0 ? "롱" : "숏"} | 수량: {formatNumber(Math.abs(position.positionAmt), 6)} | 평균가: {formatNumber(position.entryPrice, 4)}
              </Text>
              <Text>
                미실현손익: {formatNumber(position.unrealizedProfit, 4)} | 마크 가격: {formatNumber(position.markPrice, 4)}
              </Text>
            </>
          ) : (
            <Text color="gray">현재 포지션 없음</Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">그리드 라인</Text>
        {gridRows.length > 0 ? <DataTable columns={gridColumns} rows={gridRows} /> : <Text color="gray">그리드 없음</Text>}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">목표 주문</Text>
        {desiredRows.length > 0 ? <DataTable columns={desiredColumns} rows={desiredRows} /> : <Text color="gray">목표 주문 없음</Text>}
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
