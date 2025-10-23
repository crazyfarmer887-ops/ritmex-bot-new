import type { PositionSnapshot } from "./strategy";

export function computePositionPnl(
  position: PositionSnapshot,
  bestBid?: number | null,
  bestAsk?: number | null
): number {
  // If both prices are provided and equal (e.g., mid/last passed for both), use that price directly.
  // Otherwise, fall back to side-aware bid/ask selection.
  let priceForPnl: number | null | undefined;
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid === bestAsk) {
    priceForPnl = bestBid as number;
  } else {
    priceForPnl = position.positionAmt > 0 ? bestBid : bestAsk;
  }
  if (!Number.isFinite(priceForPnl as number)) return 0;
  const absAmt = Math.abs(position.positionAmt);
  return position.positionAmt > 0
    ? ((priceForPnl as number) - position.entryPrice) * absAmt
    : (position.entryPrice - (priceForPnl as number)) * absAmt;
}


