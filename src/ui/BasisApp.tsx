import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { basisConfig } from "../config";
import { getExchangeDisplayName, resolveExchangeId } from "../exchanges/create-adapter";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import { BasisArbEngine, type BasisArbSnapshot } from "../strategy/basis-arb-engine";
import { formatNumber } from "../utils/format";
import { t } from "../utils/i18n";

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
      setError(new Error(t("期现套利策略目前仅支持 Aster 交易所。请设置 EXCHANGE=aster 后重试。")));
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
        <Text color="red">{t("无法启动期现套利策略:")} {error.message}</Text>
        <Text color="gray">{t("按 Esc 返回菜单。")}</Text>
      </Box>
    );
  }

  if (!snapshot) {
    return (
      <Box padding={1}>
        <Text>{t("正在初始化期现套利监控…")}</Text>
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
  const fundingCountToBreakeven = snapshot.fundingCountToBreakeven != null ? `${formatNumber(snapshot.fundingCountToBreakeven, 2)} 次` : "-";
  const feedStatus = snapshot.feedStatus;
  const lastLogs = snapshot.tradeLog.slice(-5);
  const spotBalances = (snapshot.spotBalances ?? []).filter((b) => Math.abs(b.free) > 0 || Math.abs(b.locked) > 0);
  const futuresBalances = (snapshot.futuresBalances ?? []).filter((b) => Math.abs(b.wallet) > 0);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyanBright">{t("Basis Arbitrage Dashboard")}</Text>
        <Text>
          {t("交易所:")} {exchangeName} ｜ {t("期货合约:")} {snapshot.futuresSymbol} ｜ {t("现货交易对:")} {snapshot.spotSymbol}
        </Text>
        <Text color="gray">{t("按 Esc 返回策略选择 ｜ 数据状态:")} {t("期货")}({feedStatus.futures ? "OK" : "--"}) {t("现货")}({feedStatus.spot ? "OK" : "--"}) {t("资金费率")}({feedStatus.funding ? "OK" : "--"})</Text>
        <Text color="gray">{t("最近更新时间:")} {lastUpdated}</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="greenBright">{t("期货盘口")}</Text>
          <Text>{t("买一:")} {futuresBid} ｜ {t("卖一:")} {futuresAsk}</Text>
          <Text color="gray">{t("更新时间:")} {futuresUpdated}</Text>
        </Box>
        <Box flexDirection="column">
          <Text color="greenBright">{t("现货盘口")}</Text>
          <Text>{t("买一:")} {spotBid} ｜ {t("卖一:")} {spotAsk}</Text>
          <Text color="gray">{t("更新时间:")} {spotUpdated}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">{t("资金费率")}</Text>
        <Text>{t("当前资金费率:")} {fundingRatePct}</Text>
        <Text color="gray">{t("资金费率更新时间:")} {fundingUpdated} ｜ {t("下次结算时间:")} {nextFundingTime}</Text>
        <Text>{t("单次资金费率收益(估):")} {fundingIncomePerFunding} ｜ {t("日收益(估):")} {fundingIncomePerDay}</Text>
        <Text>{t("双边吃单手续费(估):")} {takerFeesPerRoundTrip} ｜ {t("回本所需资金费率次数:")} {fundingCountToBreakeven}</Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text color="cyan">{t("现货账户余额（非0）")}</Text>
          {spotBalances.length ? (
            spotBalances.map((b) => (
              <Text key={`spot-${b.asset}`}>
                {b.asset}: {t("可用")} {formatNumber(b.free, 8)} ｜ {t("冻结")} {formatNumber(b.locked, 8)}
              </Text>
            ))
          ) : (
            <Text color="gray">{t("无")}</Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text color="cyan">{t("合约账户余额（非0）")}</Text>
          {futuresBalances.length ? (
            futuresBalances.map((b) => (
              <Text key={`fut-${b.asset}`}>
                {b.asset}: {t("钱包")} {formatNumber(b.wallet, 8)} ｜ {t("可用")} {formatNumber(b.available, 8)}
              </Text>
            ))
          ) : (
            <Text color="gray">{t("无")}</Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color={snapshot.opportunity ? "greenBright" : "redBright"}>{t("套利差价（卖期货 / 买现货）")}</Text>
        <Text color={snapshot.opportunity ? "green" : undefined}>{t("毛价差:")} {spread} USDT ｜ {spreadBps} bp</Text>
        <Text color={snapshot.opportunity ? "green" : "red"}>
          {t("扣除 taker 手续费")} ({(basisConfig.takerFeeRate * 100).toFixed(4)}% × {t("双边")}): {netSpread} USDT ｜ {netSpreadBps} bp
        </Text>
      </Box>

      <Box flexDirection="column">
        <Text color="yellow">{t("最近事件")}</Text>
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
          <Text color="gray">{t("暂无日志")}</Text>
        )}
      </Box>
    </Box>
  );
}
