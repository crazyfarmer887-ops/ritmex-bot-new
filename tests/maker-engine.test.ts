import { describe, expect, it } from "vitest";
import { computeMakerDesiredOrders } from "../src/strategy/maker-engine";

const DEFAULT_INPUT = {
  bidPrice: "100.0",
  askPrice: "100.1",
  closeBidPrice: "100.0",
  closeAskPrice: "100.1",
};

describe("computeMakerDesiredOrders", () => {
  it("returns bid and ask entries when flat and entries allowed", () => {
    const orders = computeMakerDesiredOrders({
      positionAmt: 0,
      entryOrderSize: 0.1,
      inventoryCap: 1,
      allowEntries: true,
      ...DEFAULT_INPUT,
    });

    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ side: "BUY", reduceOnly: false, amount: 0.1 });
    expect(orders[1]).toMatchObject({ side: "SELL", reduceOnly: false, amount: 0.1 });
  });

  it("includes reduce-only close and both entries when position under cap", () => {
    const orders = computeMakerDesiredOrders({
      positionAmt: 0.2,
      entryOrderSize: 0.1,
      inventoryCap: 1,
      allowEntries: true,
      ...DEFAULT_INPUT,
    });

    expect(orders).toHaveLength(3);
    expect(orders[0]).toMatchObject({ side: "SELL", reduceOnly: true, amount: 0.2 });
    expect(orders[1]).toMatchObject({ side: "BUY", reduceOnly: false, amount: 0.1 });
    expect(orders[2]).toMatchObject({ side: "SELL", reduceOnly: false, amount: 0.1 });
  });

  it("skips entry on side that would exceed inventory cap", () => {
    const orders = computeMakerDesiredOrders({
      positionAmt: 0.5,
      entryOrderSize: 0.1,
      inventoryCap: 0.5,
      allowEntries: true,
      ...DEFAULT_INPUT,
    });

    const reduceOnly = orders.find((order) => order.reduceOnly);
    const buyEntry = orders.find((order) => order.side === "BUY" && !order.reduceOnly);
    const sellEntry = orders.find((order) => order.side === "SELL" && !order.reduceOnly);

    expect(reduceOnly).toMatchObject({ side: "SELL", amount: 0.5 });
    expect(buyEntry).toBeUndefined();
    expect(sellEntry).toMatchObject({ amount: 0.1 });
  });

  it("caps entry order size to remaining headroom", () => {
    const orders = computeMakerDesiredOrders({
      positionAmt: 0,
      entryOrderSize: 0.2,
      inventoryCap: 0.05,
      allowEntries: true,
      ...DEFAULT_INPUT,
    });

    expect(orders).toEqual([
      { side: "BUY", price: DEFAULT_INPUT.bidPrice, amount: 0.05, reduceOnly: false },
      { side: "SELL", price: DEFAULT_INPUT.askPrice, amount: 0.05, reduceOnly: false },
    ]);
  });

  it("only returns reduce-only orders when entries not allowed", () => {
    const orders = computeMakerDesiredOrders({
      positionAmt: -0.3,
      entryOrderSize: 0.1,
      inventoryCap: 1,
      allowEntries: false,
      ...DEFAULT_INPUT,
    });

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ side: "BUY", reduceOnly: true, amount: 0.3 });
  });

  it("limits additional entry in the direction reaching the cap", () => {
    const orders = computeMakerDesiredOrders({
      positionAmt: -0.48,
      entryOrderSize: 0.2,
      inventoryCap: 0.5,
      allowEntries: true,
      ...DEFAULT_INPUT,
    });

    expect(orders).toHaveLength(3);
    const reduceOnly = orders.find((order) => order.reduceOnly);
    const buyEntry = orders.find((order) => order.side === "BUY" && !order.reduceOnly);
    const sellEntry = orders.find((order) => order.side === "SELL" && !order.reduceOnly);

    expect(reduceOnly).toMatchObject({ side: "BUY", amount: 0.48 });
    expect(buyEntry).toMatchObject({ amount: 0.2 });
    expect(sellEntry).toBeTruthy();
    expect(sellEntry).toMatchObject({ amount: 0.02 });
  });
});

