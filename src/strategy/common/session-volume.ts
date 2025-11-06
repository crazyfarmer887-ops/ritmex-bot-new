import type { OrderFill } from "../../exchanges/types";
import type { PositionSnapshot } from "../../utils/strategy";

const MAX_SEEN_FILLS = 1000;
const EPSILON = 1e-8;

export class SessionVolumeTracker {
  private initialized = false;
  private previousPositionAmt = 0;
  private totalQuoteNotional = 0;
  private accountedBaseDelta = 0;
  private lastReferencePrice: number | null = null;
  private readonly seenFillIds = new Set<string>();
  private readonly seenFillQueue: string[] = [];

  update(position: PositionSnapshot, referencePrice: number | null): void {
    if (!this.initialized) {
      this.initialized = true;
      this.previousPositionAmt = position.positionAmt;
      if (referencePrice != null && Number.isFinite(referencePrice)) {
        this.lastReferencePrice = referencePrice;
      }
      return;
    }

    if (referencePrice != null && Number.isFinite(referencePrice)) {
      this.lastReferencePrice = referencePrice;
    }

    const deltaBase = Math.abs(position.positionAmt - this.previousPositionAmt);
    if (deltaBase > EPSILON) {
      const accounted = Math.min(deltaBase, this.accountedBaseDelta);
      this.accountedBaseDelta = Math.max(0, this.accountedBaseDelta - accounted);
      const residual = deltaBase - accounted;
      if (residual > EPSILON) {
        const fallbackPrice = this.lastReferencePrice;
        if (fallbackPrice != null && Number.isFinite(fallbackPrice) && Math.abs(fallbackPrice) > EPSILON) {
          this.totalQuoteNotional += residual * Math.abs(fallbackPrice);
        }
      }
    }

    this.previousPositionAmt = position.positionAmt;
  }

  registerFill(fill: OrderFill): void {
    const fillId = fill.id ?? `${fill.symbol}:${fill.orderId}:${fill.timestamp}:${fill.quantity}`;
    if (!fillId) return;
    if (this.seenFillIds.has(fillId)) return;
    this.seenFillIds.add(fillId);
    this.seenFillQueue.push(fillId);
    if (this.seenFillQueue.length > MAX_SEEN_FILLS) {
      const oldest = this.seenFillQueue.shift();
      if (oldest) {
        this.seenFillIds.delete(oldest);
      }
    }

    const quantity = Number(fill.quantity);
    if (!Number.isFinite(quantity) || Math.abs(quantity) <= EPSILON) return;
    const absQty = Math.abs(quantity);

    let quote = Number(fill.quote);
    if (!Number.isFinite(quote) || quote <= 0) {
      const priceCandidate = Number(fill.price);
      const price = Number.isFinite(priceCandidate) && Math.abs(priceCandidate) > EPSILON
        ? Math.abs(priceCandidate)
        : this.lastReferencePrice != null && Number.isFinite(this.lastReferencePrice)
          ? Math.abs(this.lastReferencePrice)
          : 0;
      quote = price > EPSILON ? absQty * price : 0;
    }

    if (quote > EPSILON) {
      this.totalQuoteNotional += quote;
      this.accountedBaseDelta += absQty;
    }
  }

  get value(): number {
    return this.totalQuoteNotional;
  }
}
