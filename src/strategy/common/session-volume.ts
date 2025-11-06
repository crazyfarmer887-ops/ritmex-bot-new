import type { PositionSnapshot } from "../../utils/strategy";

const EPS = 1e-9;

export class SessionVolumeTracker {
  private initialized = false;
  private previousPositionAmt = 0;
  private previousEntryPrice = 0;
  private lastKnownPrice: number | null = null;
  private totalQuote = 0;
  private totalBase = 0;

  update(position: PositionSnapshot, referencePrice: number | null): void {
    const priceHint = this.resolveReferencePrice(referencePrice, position);
    if (priceHint != null) {
      this.lastKnownPrice = priceHint;
    }

    if (!this.initialized) {
      this.initialized = true;
      this.previousPositionAmt = position.positionAmt;
      this.previousEntryPrice = position.entryPrice;
      return;
    }

    const delta = position.positionAmt - this.previousPositionAmt;
    if (Math.abs(delta) <= EPS) {
      this.previousPositionAmt = position.positionAmt;
      this.previousEntryPrice = position.entryPrice;
      return;
    }

    const fillPrice = this.resolveFillPrice(position, delta, priceHint);
    if (fillPrice == null) {
      this.previousPositionAmt = position.positionAmt;
      this.previousEntryPrice = position.entryPrice;
      return;
    }

    const absQty = Math.abs(delta);
    this.totalBase += absQty;
    this.totalQuote += absQty * fillPrice;
    this.lastKnownPrice = fillPrice;

    this.previousPositionAmt = position.positionAmt;
    this.previousEntryPrice = position.entryPrice;
  }

  get value(): number {
    return this.totalQuote;
  }

  get base(): number {
    return this.totalBase;
  }

  private resolveReferencePrice(referencePrice: number | null, position: PositionSnapshot): number | null {
    const candidates = [referencePrice, position.markPrice, position.entryPrice, this.lastKnownPrice];
    for (const candidate of candidates) {
      const price = Number(candidate);
      if (Number.isFinite(price) && Math.abs(price) > EPS) {
        return Math.abs(price);
      }
    }
    return null;
  }

  private resolveFillPrice(position: PositionSnapshot, delta: number, priceHint: number | null): number | null {
    const derived = this.deriveFillPriceFromEntry(position, delta);
    if (derived != null) {
      return derived;
    }
    if (priceHint != null) {
      return priceHint;
    }
    if (this.lastKnownPrice != null) {
      return this.lastKnownPrice;
    }
    const fallback = Math.abs(this.previousEntryPrice);
    return Number.isFinite(fallback) && fallback > EPS ? fallback : null;
  }

  private deriveFillPriceFromEntry(position: PositionSnapshot, delta: number): number | null {
    if (Math.abs(delta) <= EPS) {
      return null;
    }
    const prevAmt = this.previousPositionAmt;
    const prevEntry = this.previousEntryPrice;
    const nextAmt = position.positionAmt;
    const nextEntry = position.entryPrice;

    if (!Number.isFinite(prevEntry) || !Number.isFinite(nextEntry)) {
      return null;
    }

    const prevSize = Math.abs(prevAmt);
    const nextSize = Math.abs(nextAmt);
    const sameDirection = Math.sign(prevAmt) === Math.sign(nextAmt) || prevSize <= EPS || nextSize <= EPS;
    const increasingExposure = nextSize - prevSize > EPS;

    if (!sameDirection || !increasingExposure) {
      return null;
    }

    const numerator = nextEntry * nextAmt - prevEntry * prevAmt;
    const fillPrice = numerator / delta;
    if (!Number.isFinite(fillPrice) || Math.abs(fillPrice) <= EPS) {
      return null;
    }
    return Math.abs(fillPrice);
  }
}
