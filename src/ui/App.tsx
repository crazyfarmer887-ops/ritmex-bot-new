import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TrendApp } from "./TrendApp";
import { MakerApp } from "./MakerApp";
import { OffsetMakerApp } from "./OffsetMakerApp";
import { GridApp } from "./GridApp";
import { BasisApp } from "./BasisApp";
import { isBasisStrategyEnabled } from "../config";
import { loadCopyrightFragments, verifyCopyrightIntegrity } from "../utils/copyright";
import { resolveExchangeId } from "../exchanges/create-adapter";

interface StrategyOption {
  id: "trend" | "maker" | "offset-maker" | "basis" | "grid";
  label: string;
  description: string;
  component: React.ComponentType<{ onExit: () => void }>;
}

const BASE_STRATEGIES: StrategyOption[] = [
  {
    id: "trend",
    label: "트렌드 전략 (SMA30)",
    description: "이동평균 신호를 감시하여 자동 진입·청산 및 리스크 관리",
    component: TrendApp,
  },
  {
    id: "maker",
    label: "메이커 전략",
    description: "양방향 지정가로 유동성 제공, 자동 추격/리스크 관리",
    component: MakerApp,
  },
  {
    id: "grid",
    label: "그리드 전략",
    description: "상·하단 사이에 기하 그리드를 배치, 자동 증감포",
    component: GridApp,
  },
  {
    id: "offset-maker",
    label: "오프셋 메이커",
    description: "호가 깊이에 따라 자동으로 오더 오프셋/불균형 시 철수",
    component: OffsetMakerApp,
  },
];

const inputSupported = Boolean(process.stdin && (process.stdin as any).isTTY);

export function App() {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<StrategyOption | null>(null);
  const copyright = useMemo(() => loadCopyrightFragments(), []);
  const integrityOk = useMemo(() => verifyCopyrightIntegrity(), []);
  const exchangeId = useMemo(() => resolveExchangeId(), []);
  const strategies = useMemo(() => {
    if (!isBasisStrategyEnabled()) {
      return BASE_STRATEGIES;
    }
    return [
      ...BASE_STRATEGIES,
      {
        id: "basis" as const,
        label: "베이시스 차익",
        description: "선물·현물 호가 차이를 모니터링하여 기회 탐지",
        component: BasisApp,
      },
    ];
  }, []);

  useInput(
    (input, key) => {
      if (selected) return;
      if (key.upArrow) {
        setCursor((prev) => (prev - 1 + strategies.length) % strategies.length);
      } else if (key.downArrow) {
        setCursor((prev) => (prev + 1) % strategies.length);
      } else if (key.return) {
        const strategy = strategies[cursor];
        if (strategy) {
          setSelected(strategy);
        }
      }
    },
    { isActive: inputSupported && !selected }
  );

  if (selected) {
    const Selected = selected.component;
    return <Selected onExit={() => setSelected(null)} />;
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color="gray">{copyright.bannerText}</Text>
      {integrityOk ? null : (
        <Text color="red">경고: 저작권 검증 실패, 변조 가능성이 있습니다.</Text>
      )}
      <Box height={1}>
        <Text color="gray">────────────────────────────────────────────────────</Text>
      </Box>
      <Text color="cyanBright">실행할 전략을 선택하세요</Text>
      <Text color="gray">↑/↓ 선택, Enter 시작, Ctrl+C 종료</Text>
      <Box flexDirection="column" marginTop={1}>
        {strategies.map((strategy, index) => {
          const active = index === cursor;
          return (
            <Box key={strategy.id} flexDirection="column" marginBottom={1}>
              <Text color={active ? "greenBright" : undefined}>
                {active ? ">" : "  "} {strategy.label}
              </Text>
              <Text color="gray">    {strategy.description}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
