import type { AsterOrder } from "../../exchanges/types";
import type { PositionSnapshot } from "../../utils/strategy";

export class SessionVolumeTracker {
  private initialized = false;
  private previousPositionAmt = 0;
  private positionFallbackTotal = 0;
  private orderTotal = 0;
  private orderStreamActive = false;
  private readonly orderQuoteSnapshots = new Map<string, number>();

  update(position: PositionSnapshot, referencePrice: number | null): void {
    if (!this.initialized) {
      this.previousPositionAmt = position.positionAmt;
      this.initialized = true;
      return;
    }
    if (referencePrice == null) {
      this.previousPositionAmt = position.positionAmt;
      return;
    }
    const delta = Math.abs(position.positionAmt - this.previousPositionAmt);
    if (delta > 0 && !this.orderStreamActive) {
      this.positionFallbackTotal += delta * referencePrice;
    }
    this.previousPositionAmt = position.positionAmt;
  }

  observeOrders(orders: AsterOrder[] | null | undefined, symbol: string): void {
    if (!Array.isArray(orders) || !symbol) {
      return;
    }
    this.orderStreamActive = true;
    const seen = new Set<string>();
    for (const order of orders) {
      if (!order || order.symbol !== symbol) continue;
      const orderId = String(order.orderId);
      seen.add(orderId);
      const current = this.extractQuoteVolume(order);
      if (current == null) {
        continue;
      }
      const previous = this.orderQuoteSnapshots.get(orderId) ?? 0;
      if (current < previous) {
        // Treat as a new sequence: order replaced or reset by exchange
        if (current > 0) {
          this.orderTotal += current;
        }
        this.orderQuoteSnapshots.set(orderId, current);
        continue;
      }
      const delta = current - previous;
      if (delta > 0) {
        this.orderTotal += delta;
      }
      this.orderQuoteSnapshots.set(orderId, current);
    }
    for (const [orderId] of this.orderQuoteSnapshots) {
      if (!seen.has(orderId)) {
        this.orderQuoteSnapshots.delete(orderId);
      }
    }
  }

  get value(): number {
    return this.orderStreamActive ? this.orderTotal : this.positionFallbackTotal;
  }

  private extractQuoteVolume(order: AsterOrder): number | null {
    const quoteRaw = this.parseNumber(order.cumQuote);
    if (quoteRaw != null) {
      return quoteRaw;
    }
    const executedQty = this.parseNumber(order.executedQty);
    if (executedQty == null || executedQty <= 0) {
      return 0;
    }
    const price = this.parseNumber(order.avgPrice) ?? this.parseNumber(order.price);
    if (price == null || price <= 0) {
      return null;
    }
    return executedQty * price;
  }

  private parseNumber(value: string | number | null | undefined): number | null {
    if (value == null) return null;
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) return null;
    return num;
  }
}
