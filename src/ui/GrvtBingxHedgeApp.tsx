import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatNumber } from "../utils/format";
import { grvtBingxHedgeConfig } from "../config";
import { GrvtBingxHedgeEngine, type GrvtBingxHedgeSnapshot } from "../strategy/grvt-bingx-hedge-engine";

interface HedgeAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function GrvtBingxHedgeApp({ onExit }: HedgeAppProps) {
  const [snapshot, setSnapshot] = useState<GrvtBingxHedgeSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<GrvtBingxHedgeEngine | null>(null);

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
      const engine = new GrvtBingxHedgeEngine(grvtBingxHedgeConfig);
      engineRef.current = engine;
      setSnapshot(engine.getSnapshot());
      const handler = (next: GrvtBingxHedgeSnapshot) => {
        setSnapshot({
          ...next,
          grvtExitOrders: next.grvtExitOrders.map((item) => ({ ...item })),
          bingxExitOrders: next.bingxExitOrders.map((item) => ({ ...item })),
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
      setError(err instanceof Error ? err : new Error(String(err)));
    }
    return () => {};
  }, []);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">GRVT-BingX 헷지 모드를 시작하지 못했습니다: {error.message}</Text>
        <Text color="gray">환경 변수와 인증 정보를 확인한 뒤 다시 시도해 주세요. Esc 키로 돌아가기.</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>헷지 엔진을 초기화하고 있습니다…</Text>
      </Box>
    );
  }

  const lastLogs = snapshot.tradeLog.slice(-6);
  const renderFeedStatus = (feeds: GrvtBingxHedgeSnapshot["grvtFeeds"]) => (
    <>
      <Text color={feeds.account ? "green" : "red"}>账户</Text>
      <Text> </Text>
      <Text color={feeds.orders ? "green" : "red"}>订单</Text>
      <Text> </Text>
      <Text color={feeds.depth ? "green" : "red"}>深度</Text>
      <Text> </Text>
      <Text color={feeds.ticker ? "green" : "red"}>Ticker</Text>
    </>
  );

  const formatPrice = (value: number | null, decimals = 2) =>
    value != null && Number.isFinite(value) ? formatNumber(value, decimals) : "N/A";
  const formatQty = (value: number) => formatNumber(value, 6);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">GRVT-BingX 헷지 모드 대시보드</Text>
        <Text color="gray">Esc 키로 메뉴로 돌아가기 · 현재 상태: {snapshot.status} · 자동 진입: {grvtBingxHedgeConfig.autoEnter ? "ON" : "OFF"}</Text>
        <Text>
          목표 ROI: {snapshot.targetRoiPct.toFixed(2)}% ｜ 기준 평균가: {formatPrice(snapshot.entryAveragePrice, 2)} ｜ 목표 차이: {formatPrice(snapshot.targetOffsetPrice, 2)}
        </Text>
        <Text color="gray">
          GRVT 심볼: {snapshot.grvtSymbol} ｜ BingX 심볼: {snapshot.bingxSymbol} ｜ 로직 준비 여부: {snapshot.ready ? "OK" : "대기중"}
        </Text>
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">GRVT 포지션</Text>
          <Text>
            수량: {formatQty(snapshot.grvtPosition.positionAmt)} ｜ 진입가: {formatPrice(snapshot.grvtPosition.entryPrice, 2)} ｜ 마크: {formatPrice(snapshot.grvtPosition.markPrice, 2)}
          </Text>
          <Text>실현 전 PnL: {formatNumber(snapshot.grvtPosition.unrealizedProfit, 4)}</Text>
          <Text color="gray">
            데이터: {renderFeedStatus(snapshot.grvtFeeds)}
          </Text>
          <Text color="yellow">종료 주문</Text>
          {snapshot.grvtExitOrders.length ? (
            snapshot.grvtExitOrders.map((order, idx) => (
              <Text key={`grvt-${idx}`}>
                [{order.tag === "take-profit" ? "TP" : "SL"}] {order.side} @ {formatPrice(order.price, 2)} ｜ 수량 {formatQty(order.quantity)}
              </Text>
            ))
          ) : (
            <Text color="gray">등록된 종료 주문이 없습니다.</Text>
          )}
        </Box>

        <Box flexDirection="column" marginLeft={4}>
          <Text color="greenBright">BingX 포지션</Text>
          <Text>
            수량: {formatQty(snapshot.bingxPosition.positionAmt)} ｜ 진입가: {formatPrice(snapshot.bingxPosition.entryPrice, 2)} ｜ 마크: {formatPrice(snapshot.bingxPosition.markPrice, 2)}
          </Text>
          <Text>실현 전 PnL: {formatNumber(snapshot.bingxPosition.unrealizedProfit, 4)}</Text>
          <Text color="gray">
            데이터: {renderFeedStatus(snapshot.bingxFeeds)}
          </Text>
          <Text color="yellow">종료 주문</Text>
          {snapshot.bingxExitOrders.length ? (
            snapshot.bingxExitOrders.map((order, idx) => (
              <Text key={`bingx-${idx}`}>
                [{order.tag === "take-profit" ? "TP" : "SL"}] {order.side} @ {formatPrice(order.price, 2)} ｜ 수량 {formatQty(order.quantity)}
              </Text>
            ))
          ) : (
            <Text color="gray">등록된 종료 주문이 없습니다.</Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">최근 이벤트</Text>
        {lastLogs.length ? (
          lastLogs.map((item, index) => (
            <Text key={`${item.time}-${index}`}>
              [{item.time}] [{item.type}] {item.detail}
            </Text>
          ))
        ) : (
          <Text color="gray">표시할 로그가 없습니다.</Text>
        )}
      </Box>
    </Box>
  );
}
