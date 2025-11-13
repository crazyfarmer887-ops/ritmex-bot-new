import { AsterExchangeAdapter } from "./aster-adapter";
import { GrvtExchangeAdapter } from "./grvt/adapter";
import { LighterExchangeAdapter } from "./lighter/adapter";
import { BackpackExchangeAdapter } from "./backpack/adapter";
import { ParadexExchangeAdapter } from "./paradex/adapter";
import { BingxExchangeAdapter } from "./bingx/adapter";
export function resolveExchangeId(value) {
    const fallback = (value ?? process.env.EXCHANGE ?? process.env.TRADE_EXCHANGE ?? "aster")
        .toString()
        .trim()
        .toLowerCase();
    if (fallback === "grvt")
        return "grvt";
    if (fallback === "lighter")
        return "lighter";
    if (fallback === "backpack")
        return "backpack";
    if (fallback === "paradex")
        return "paradex";
    if (fallback === "bingx")
        return "bingx";
    return "aster";
}
export function getExchangeDisplayName(id) {
    if (id === "grvt")
        return "GRVT";
    if (id === "lighter")
        return "Lighter";
    if (id === "backpack")
        return "Backpack";
    if (id === "paradex")
        return "Paradex";
    if (id === "bingx")
        return "BingX";
    return "AsterDex";
}
export function createExchangeAdapter(options) {
    const id = resolveExchangeId(options.exchange);
    if (id === "grvt") {
        return new GrvtExchangeAdapter({ ...options.grvt, symbol: options.symbol });
    }
    if (id === "lighter") {
        return new LighterExchangeAdapter({ ...options.lighter, displaySymbol: options.symbol });
    }
    if (id === "backpack") {
        return new BackpackExchangeAdapter({ ...options.backpack, symbol: options.symbol });
    }
    if (id === "paradex") {
        return new ParadexExchangeAdapter({ ...options.paradex, symbol: options.symbol });
    }
    if (id === "bingx") {
        return new BingxExchangeAdapter({ ...options.bingx, symbol: options.symbol });
    }
    return new AsterExchangeAdapter({ ...options.aster, symbol: options.symbol });
}
