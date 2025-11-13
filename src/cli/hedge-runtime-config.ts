import { createInterface, type Interface } from "node:readline";
import type { HedgeConfig } from "../config";
import { isValidOrderAmount, isValidRoiPercent, parseNumericInput } from "../strategy/hedge-config-utils";

interface ResolveOptions {
  silent?: boolean;
}

export async function resolveHedgeRuntimeConfig(
  baseConfig: HedgeConfig,
  options: ResolveOptions = {}
): Promise<HedgeConfig> {
  const config = { ...baseConfig };
  const interactive = !options.silent && Boolean(process.stdin?.isTTY && process.stdout?.isTTY);

  if (!interactive) {
    assertConfigValidity(config);
    return config;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\n[GRVT-BingX Hedge] 请输入启动参数 (留空使用当前值，输入 'q' 退出)：");
    const orderAmount = await promptNumber(
      rl,
      `- 对冲仓位数量（当前 ${config.orderAmount}）: `,
      config.orderAmount,
      isValidOrderAmount,
      "仓位数量必须是大于 0 的数字。"
    );
    const exitRoiPercent = await promptNumber(
      rl,
      `- 退出 ROI 百分比（当前 ${config.exitRoiPercent}%）: `,
      config.exitRoiPercent,
      isValidRoiPercent,
      "ROI 百分比必须大于等于 0。"
    );

    return {
      ...config,
      orderAmount,
      exitRoiPercent,
    };
  } finally {
    rl.close();
  }
}

function assertConfigValidity(config: HedgeConfig): void {
  if (!isValidOrderAmount(config.orderAmount)) {
    throw new Error("HEDGE_ORDER_AMOUNT 必须大于 0，或者使用交互模式输入有效仓位规模。");
  }
  if (!isValidRoiPercent(config.exitRoiPercent)) {
    throw new Error("HEDGE_EXIT_ROI_PERCENT 必须大于等于 0。");
  }
}

async function promptNumber(
  rl: Interface,
  promptText: string,
  fallback: number,
  validator: (value: number) => boolean,
  invalidMessage: string
): Promise<number> {
  while (true) {
    const answer = await askQuestion(rl, promptText);
    const trimmed = answer.trim();
    if (!trimmed) {
      if (!validator(fallback)) {
        console.log(invalidMessage);
        continue;
      }
      return fallback;
    }

    const lowered = trimmed.toLowerCase();
    if (lowered === "q" || lowered === "quit" || lowered === "exit") {
      throw new Error("用户取消了对冲参数输入。");
    }

    const parsed = parseNumericInput(trimmed, fallback);
    if (parsed == null) {
      console.log("请输入有效数字 (支持小数)。");
      continue;
    }

    if (!validator(parsed)) {
      console.log(invalidMessage);
      continue;
    }

    return parsed;
  }
}

function askQuestion(rl: Interface, promptText: string): Promise<string> {
  return new Promise((resolve) => rl.question(promptText, resolve));
}
