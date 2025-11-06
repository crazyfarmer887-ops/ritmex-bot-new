import type { PositionSnapshot } from "../../utils/strategy";

const EPSILON = 1e-9;
export const SESSION_VOLUME_MAX_PRICE_STALENESS_MS = 5000;

export class SessionVolumeTracker {
  private initialized = false;
  private previousPositionAmt = 0;
  private total = 0;
  private pendingBaseDelta = 0;
  private lastKnownPrice: number | null = null;
  private lastKnownPriceAt = 0;
  private lastEntryPrice: number | null = null;

  update(position: PositionSnapshot, referencePrice: number | null, timestamp = Date.now()): void {
    this.trackEntryPrice(position);

    if (!this.initialized) {
      this.initialized = true;
      this.previousPositionAmt = position.positionAmt;
      this.registerPrice(this.resolvePrice(position, referencePrice, timestamp), timestamp);
      this.pendingBaseDelta = 0;
      return;
    }

    const price = this.resolvePrice(position, referencePrice, timestamp);
    const delta = Math.abs(position.positionAmt - this.previousPositionAmt);

    if (price != null && this.pendingBaseDelta > 0) {
      this.total += this.pendingBaseDelta * price;
      this.pendingBaseDelta = 0;
    }

    if (delta > 0) {
      if (price != null) {
        this.total += delta * price;
      } else {
        this.pendingBaseDelta += delta;
      }
    }

    this.previousPositionAmt = position.positionAmt;
    this.registerPrice(price, timestamp);
    this.maybeResetEntryPrice(position);
  }

  get value(): number {
    return this.total;
  }

  private resolvePrice(position: PositionSnapshot, referencePrice: number | null, timestamp: number): number | null {
    const candidates: Array<number | null> = [
      this.normalize(referencePrice),
      this.normalize(position.markPrice),
    ];

    if (Math.abs(position.positionAmt) > EPSILON) {
      candidates.push(this.normalize(position.entryPrice));
    }

    candidates.push(this.lastEntryPrice);

    for (const candidate of candidates) {
      const price = this.normalize(candidate);
      if (price != null) {
        return price;
      }
    }

    if (this.lastKnownPrice != null && timestamp - this.lastKnownPriceAt <= SESSION_VOLUME_MAX_PRICE_STALENESS_MS) {
      return this.lastKnownPrice;
    }

    return null;
  }

  private trackEntryPrice(position: PositionSnapshot): void {
    const entry = this.normalize(position.entryPrice);
    if (entry != null && Math.abs(position.positionAmt) > EPSILON) {
      this.lastEntryPrice = entry;
    }
  }

  private maybeResetEntryPrice(position: PositionSnapshot): void {
    if (Math.abs(position.positionAmt) <= EPSILON && this.pendingBaseDelta === 0) {
      this.lastEntryPrice = null;
    }
  }

  private registerPrice(price: number | null, timestamp: number): void {
    if (price == null) return;
    this.lastKnownPrice = price;
    this.lastKnownPriceAt = timestamp;
  }

  private normalize(value: number | null | undefined): number | null {
    const price = Number(value);
    return Number.isFinite(price) && price > 0 ? price : null;
  }
}
