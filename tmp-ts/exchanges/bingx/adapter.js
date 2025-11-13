import { extractMessage } from "../../utils/errors";
import { BingxGateway } from "./gateway";
export class BingxExchangeAdapter {
    id = "bingx";
    gateway;
    symbol;
    constructor(credentials = {}) {
        const apiKey = credentials.apiKey ?? process.env.BINGX_API_KEY;
        const apiSecret = credentials.apiSecret ?? process.env.BINGX_API_SECRET;
        if (!apiKey || !apiSecret) {
            throw new Error("BINGX_API_KEY and BINGX_API_SECRET environment variables are required");
        }
        const leverage = credentials.leverage ??
            parseOptionalNumber(process.env.BINGX_LEVERAGE) ??
            50;
        const marginMode = credentials.marginMode ?? process.env.BINGX_MARGIN_MODE ?? "ISOLATED";
        const positionMode = normalizePositionMode(credentials.positionMode) ??
            parsePositionMode(process.env.BINGX_POSITION_MODE) ??
            "ONE_WAY";
        const symbol = credentials.symbol ?? process.env.BINGX_SYMBOL ?? process.env.TRADE_SYMBOL ?? "BTCUSDT";
        const normalizedSymbol = symbol.trim().toUpperCase();
        if (!normalizedSymbol.includes("BTC")) {
            throw new Error(`BingX adapter currently supports only BTC instruments, received ${symbol}`);
        }
        this.symbol = normalizedSymbol;
        const gatewayOptions = {
            apiKey,
            apiSecret,
            symbol: normalizedSymbol,
            leverage: leverage > 0 ? leverage : 50,
            marginMode,
            positionMode,
            testnet: credentials.testnet ?? parseOptionalBoolean(process.env.BINGX_TESTNET),
            logger: (context, error) => this.logError(context, error),
        };
        this.gateway = new BingxGateway(gatewayOptions);
    }
    supportsTrailingStops() {
        return false;
    }
    watchAccount(cb) {
        this.gateway.onAccount(this.safeInvoke("watchAccount", cb));
    }
    watchOrders(cb) {
        this.gateway.onOrders(this.safeInvoke("watchOrders", cb));
    }
    watchDepth(symbol, cb) {
        this.assertSymbol(symbol);
        this.gateway.onDepth(this.safeInvoke("watchDepth", cb));
    }
    watchTicker(symbol, cb) {
        this.assertSymbol(symbol);
        this.gateway.onTicker(this.safeInvoke("watchTicker", cb));
    }
    watchKlines(symbol, interval, cb) {
        this.assertSymbol(symbol);
        this.gateway.watchKlines(interval, this.safeInvoke("watchKlines", cb));
    }
    async createOrder(params) {
        this.assertSymbol(params.symbol);
        return this.gateway.createOrder({ ...params, symbol: this.symbol });
    }
    async cancelOrder(params) {
        this.assertSymbol(params.symbol);
        await this.gateway.cancelOrder({ orderId: params.orderId });
    }
    async cancelOrders(params) {
        this.assertSymbol(params.symbol);
        await this.gateway.cancelOrders({ orderIdList: params.orderIdList });
    }
    async cancelAllOrders(params) {
        this.assertSymbol(params.symbol);
        await this.gateway.cancelAllOrders();
    }
    async getPrecision() {
        await this.gateway.ensureInitialized();
        const market = this.gateway.getMarketInfo();
        if (!market)
            return null;
        const priceTick = this.resolveStepSize(market?.limits?.price?.min, market?.precision?.price, 0.5);
        const qtyStep = this.resolveStepSize(market?.limits?.amount?.min, market?.precision?.amount, 0.001);
        const priceDecimals = this.extractDecimals(market?.precision?.price);
        const sizeDecimals = this.extractDecimals(market?.precision?.amount);
        return {
            priceTick,
            qtyStep,
            priceDecimals: Number.isFinite(priceDecimals) ? priceDecimals : undefined,
            sizeDecimals: Number.isFinite(sizeDecimals) ? sizeDecimals : undefined,
        };
    }
    assertSymbol(symbol) {
        if (!symbol)
            return;
        const normalized = symbol.trim().toUpperCase();
        if (normalized !== this.symbol) {
            throw new Error(`BingX adapter initialized for ${this.symbol} but received ${symbol}`);
        }
    }
    safeInvoke(context, cb) {
        const wrapped = ((...args) => {
            try {
                cb(...args);
            }
            catch (error) {
                this.logError(context, error);
            }
        });
        return wrapped;
    }
    logError(context, error) {
        if (process.env.BINGX_DEBUG === "1" || process.env.BINGX_DEBUG === "true") {
            console.error(`[BingxExchangeAdapter] ${context} failed: ${extractMessage(error)}`);
        }
    }
    toNumber(value) {
        if (typeof value === "number")
            return value;
        if (typeof value === "string") {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : 0;
        }
        return 0;
    }
    resolveStepSize(limitValue, precisionValue, fallback) {
        const limit = this.toNumber(limitValue);
        if (limit > 0)
            return limit;
        const decimals = this.extractDecimals(precisionValue);
        if (Number.isFinite(decimals) && decimals >= 0 && decimals <= 12) {
            const step = Math.pow(10, -decimals);
            if (Number.isFinite(step) && step > 0)
                return step;
        }
        return fallback;
    }
    extractDecimals(value) {
        if (typeof value === "number")
            return value;
        if (typeof value === "string") {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : NaN;
        }
        return NaN;
    }
}
function parseOptionalBoolean(value) {
    if (value == null)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (!normalized)
        return undefined;
    if (["1", "true", "yes", "on"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    return undefined;
}
function parseOptionalNumber(value) {
    if (value == null)
        return undefined;
    const parsed = Number(value);
    if (Number.isFinite(parsed))
        return parsed;
    return undefined;
}
function normalizePositionMode(value) {
    if (value == null)
        return undefined;
    const normalized = value.toString().trim().toUpperCase().replace(/[-\s]/g, "_");
    if (!normalized)
        return undefined;
    if (normalized === "ONE_WAY" || normalized === "ONEWAY")
        return "ONE_WAY";
    if (normalized === "HEDGE" || normalized === "HEDGE_MODE" || normalized === "DUAL")
        return "HEDGE";
    return undefined;
}
function parsePositionMode(value) {
    return normalizePositionMode(value);
}
