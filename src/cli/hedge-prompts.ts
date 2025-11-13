import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { HedgeConfig } from "../config";

interface HedgeOverrides {
  orderAmount: number;
  exitRoiPercent: number;
}

function isInteractive(): boolean {
  return Boolean(input?.isTTY && output?.isTTY);
}

async function askNumber(
  rl: readline.Interface,
  prompt: string,
  defaultValue: number,
  options: { allowZero?: boolean }
): Promise<number> {
  const allowZero = options.allowZero === true;

  const ask = (): Promise<number> =>
    new Promise((resolve) => {
      rl.question(`${prompt} [默认 ${defaultValue}]: `, (answer) => {
        const trimmed = answer.trim();
        if (!trimmed) {
          resolve(defaultValue);
          return;
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) {
          console.info("请输入有效数字。");
          resolve(ask());
          return;
        }
        if (!allowZero && parsed <= 0) {
          console.info("请输入大于 0 的数值。");
          resolve(ask());
          return;
        }
        if (allowZero && parsed < 0) {
          console.info("请输入不小于 0 的数值。");
          resolve(ask());
          return;
        }
        resolve(parsed);
      });
    });

  return ask();
}

export async function promptHedgeOverrides(
  baseConfig: HedgeConfig
): Promise<HedgeOverrides | null> {
  if (!isInteractive()) {
    return null;
  }

  const rl = readline.createInterface({ input, output });
  rl.on("SIGINT", () => {
    rl.close();
  });

  try {
    const orderAmount = await askNumber(
      rl,
      "请输入对冲下单数量 (base asset)",
      baseConfig.orderAmount,
      { allowZero: false }
    );
    const exitRoiPercent = await askNumber(
      rl,
      "请输入退出 ROI 目标百分比 (0 表示按入场价退出)",
      baseConfig.exitRoiPercent,
      { allowZero: true }
    );
    console.info(
      `对冲配置已更新: 下单数量 ${orderAmount} ｜ ROI 目标 ${exitRoiPercent}%`
    );
    return { orderAmount, exitRoiPercent };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Hedge Prompt] 读取输入失败: ${message}`);
    return null;
  } finally {
    rl.close();
  }
}
