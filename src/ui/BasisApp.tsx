import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { basisConfig } from "../config";
import { getExchangeDisplayName, resolveExchangeId } from "../exchanges/create-adapter";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import { BasisArbEngine, type BasisArbSnapshot } from "../strategy/basis-arb-engine";
import { formatNumber } from "../utils/format";

interface BasisAppProps {
  onExit: () => void;
}

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function BasisApp({ onExit }: BasisAppProps) {
  const [snapshot, setSnapshot] = useState<BasisArbSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const engineRef = useRef<BasisArbEngine | null>(null);
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
    if (exchangeId !== "aster") {
      setError(new Error("베이시스 차익은 현재 Aster 거래소만 지원합니다. EXCHANGE=aster 로 설정 후 다시 시도하세요."));
      return;
    }
    try {
      const adapter = buildAdapterFromEnv({ exchangeId, symbol: basisConfig.futuresSymbol });
      const engine = new BasisArbEngine(basisConfig, adapter);
      engineRef.current = engine;
      setSnapshot(engine.getSnapshot());
      const handler = (next: BasisArbSnapshot) => {
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
        <Text color="red">기초-선물 차익 대시보드를 시작할 수 없습니다: {error.message}</Text>
        <Text color="gray">Esc: 뒤로</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>차익 모니터 초기화 중…</Text>
      </Box>
    );
  }

  const futuresBid = formatNumber(snapshot.futuresBid, 4);
  const futuresAsk = formatNumber(snapshot.futuresAsk, 4);
  const spotBid = formatNumber(snapshot.spotBid, 4);
  const spotAsk = formatNumber(snapshot.spotAsk, 4);
  const spread = formatNumber(snapshot.spread, 4);
  const spreadBps = formatNumber(snapshot.spreadBps, 2);
  const netSpread = formatNumber(snapshot.netSpread, 4);
  const netSpreadBps = formatNumber(snapshot.netSpreadBps, 2);
  const lastUpdated = snapshot.lastUpdated ? new Date(snapshot.lastUpdated).toLocaleTimeString() : "-";
  const futuresUpdated = snapshot.futuresLastUpdate ? new Date(snapshot.futuresLastUpdate).toLocaleTimeString() : "-";
  const spotUpdated = snapshot.spotLastUpdate ? new Date(snapshot.spotLastUpdate).toLocaleTimeString() : "-";
  const fundingRatePct = snapshot.fundingRate != null ? `${(snapshot.fundingRate * 100).toFixed(4)}%` : "-";
  const fundingUpdated = snapshot.fundingLastUpdate ? new Date(snapshot.fundingLastUpdate).toLocaleTimeString() : "-";
  const nextFundingTime = snapshot.nextFundingTime ? new Date(snapshot.nextFundingTime).toLocaleTimeString() : "-";
  const fundingIncomePerFunding = snapshot.fundingIncomePerFunding != null ? `${formatNumber(snapshot.fundingIncomePerFunding, 4)} USDT` : "-";
  const fundingIncomePerDay = snapshot.fundingIncomePerDay != null ? `${formatNumber(snapshot.fundingIncomePerDay, 4)} USDT` : "-";
  const takerFeesPerRoundTrip = snapshot.takerFeesPerRoundTrip != null ? `${formatNumber(snapshot.takerFeesPerRoundTrip, 4)} USDT` : "-";
  const fundingCountToBreakeven = snapshot.fundingCountToBreakeven != null ? `${formatNumber(snapshot.fundingCountToBreakeven, 2)} 회` : "-";
  const feedStatus = snapshot.feedStatus;
  const lastLogs = snapshot.tradeLog.slice(-5);
  const spotBalances = (snapshot.spotBalances ?? []).filter((b) => Math.abs(b.free) > 0 || Math.abs(b.locked) > 0);
  const futuresBalances = (snapshot.futuresBalances ?? []).filter((b) => Math.abs(b.wallet) > 0);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">베이시스 차익 대시보드</Text>
        <Text>
          거래소: {exchangeName} | 선물: {snapshot.futuresSymbol} | 현물: {snapshot.spotSymbol}
        </Text>
        <Text color="gray">Esc: 뒤로 | 데이터: 선물({feedStatus.futures ? "OK" : "--"}) 현물({feedStatus.spot ? "OK" : "--"}) 펀딩({feedStatus.funding ? "OK" : "--"})</Text>
        <Text color="gray">업데이트: {lastUpdated}</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">선물 호가</Text>
          <Text>매수: {futuresBid} | 매도: {futuresAsk}</Text>
          <Text color="gray">업데이트: {futuresUpdated}</Text>
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">현물 호가</Text>
          <Text>매수: {spotBid} | 매도: {spotAsk}</Text>
          <Text color="gray">업데이트: {spotUpdated}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">펀딩</Text>
        <Text>현재 펀딩율: {fundingRatePct}</Text>
        <Text color="gray">업데이트: {fundingUpdated} | 다음 산정: {nextFundingTime}</Text>
        <Text>1회 펀딩 수익(추정): {fundingIncomePerFunding} | 일간(추정): {fundingIncomePerDay}</Text>
        <Text>양측 테이커 수수료(추정): {takerFeesPerRoundTrip} | 손익분기 펀딩 횟수: {fundingCountToBreakeven}</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="cyan">현물 잔고(0 제외)</Text>
          {spotBalances.length ? (
            spotBalances.map((b) => (
              <Text key={`spot-${b.asset}`}>
                {b.asset}: 가용 {formatNumber(b.free, 8)} | 동결 {formatNumber(b.locked, 8)}
              </Text>
            ))
          ) : (
            <Text color="gray">없음</Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text color="cyan">선물 잔고(0 제외)</Text>
          {futuresBalances.length ? (
            futuresBalances.map((b) => (
              <Text key={`fut-${b.asset}`}>
                {b.asset}: 지갑 {formatNumber(b.wallet, 8)} | 가용 {formatNumber(b.available, 8)}
              </Text>
            ))
          ) : (
            <Text color="gray">없음</Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color={snapshot.opportunity ? "greenBright" : "redBright"}>차익(선물 매도 / 현물 매수)</Text>
        <Text color={snapshot.opportunity ? "green" : undefined}>스프레드(총): {spread} USDT | {spreadBps} bp</Text>
        <Text color={snapshot.opportunity ? "green" : "red"}>
          테이커 수수료 차감 ({(basisConfig.takerFeeRate * 100).toFixed(4)}% × 양쪽): {netSpread} USDT | {netSpreadBps} bp
        </Text>
      </Box>

      <Box flexDirection="column">
        <Text color="yellow">최근 이벤트</Text>
        {lastLogs.length ? (
          lastLogs.map((entry, index) => {
            const color = entry.type === "entry" ? "green" : entry.type === "exit" ? "red" : undefined;
            return (
              <Text key={`${entry.time}-${index}`} color={color}>
                [{entry.time}] [{entry.type}] {entry.detail}
              </Text>
            );
          })
        ) : (
          <Text color="gray">로그 없음</Text>
        )}
      </Box>
    </Box>
  );
}
