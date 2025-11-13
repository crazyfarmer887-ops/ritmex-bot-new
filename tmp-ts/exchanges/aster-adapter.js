import { extractMessage } from "../utils/errors";
import { AsterGateway } from "./aster/client";
export class AsterExchangeAdapter {
    id = "aster";
    gateway;
    symbol;
    initPromise = null;
    lastInitErrorAt = 0;
    initContexts = new Set();
    retryTimer = null;
    retryDelayMs = 3000;
    constructor(credentials = {}) {
        this.gateway = new AsterGateway({ apiKey: credentials.apiKey, apiSecret: credentials.apiSecret });
        this.symbol = (credentials.symbol ?? process.env.TRADE_SYMBOL ?? "BTCUSDT").toUpperCase();
    }
    supportsTrailingStops() {
        return true;
    }
    safeInvoke(context, cb) {
        const wrapped = ((...args) => {
            try {
                cb(...args);
            }
            catch (error) {
                console.error(`[AsterExchangeAdapter] ${context} handler failed: ${extractMessage(error)}`);
            }
        });
        return wrapped;
    }
    ensureInitialized(context) {
        if (!this.initPromise) {
            this.initContexts.clear();
            this.initPromise = this.gateway.ensureInitialized(this.symbol).then((value) => {
                this.clearRetry();
                return value;
            }).catch((error) => {
                this.handleInitError("initialize", error);
                this.initPromise = null;
                this.scheduleRetry();
                throw error;
            });
        }
        if (context && !this.initContexts.has(context)) {
            this.initContexts.add(context);
            this.initPromise.catch((error) => {
                this.handleInitError(context, error);
                this.scheduleRetry();
            });
        }
        return this.initPromise;
    }
    scheduleRetry() {
        if (this.retryTimer)
            return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.initPromise)
                return;
            this.retryDelayMs = Math.min(this.retryDelayMs * 2, 60_000);
            void this.ensureInitialized("retry");
        }, this.retryDelayMs);
    }
    clearRetry() {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.retryDelayMs = 3000;
    }
    handleInitError(context, error) {
        const now = Date.now();
        if (now - this.lastInitErrorAt < 5000)
            return;
        this.lastInitErrorAt = now;
        console.error(`[AsterExchangeAdapter] ${context} failed`, error);
    }
    watchAccount(cb) {
        void this.ensureInitialized("watchAccount");
        this.gateway.onAccount(this.safeInvoke("watchAccount", (snapshot) => {
            cb(snapshot);
        }));
    }
    watchOrders(cb) {
        void this.ensureInitialized("watchOrders");
        this.gateway.onOrders(this.safeInvoke("watchOrders", (orders) => {
            cb(orders);
        }));
    }
    watchDepth(symbol, cb) {
        void this.ensureInitialized("watchDepth");
        this.gateway.onDepth(symbol, this.safeInvoke("watchDepth", (depth) => {
            cb(depth);
        }));
    }
    watchTicker(symbol, cb) {
        void this.ensureInitialized("watchTicker");
        this.gateway.onTicker(symbol, this.safeInvoke("watchTicker", (ticker) => {
            cb(ticker);
        }));
    }
    watchKlines(symbol, interval, cb) {
        void this.ensureInitialized("watchKlines");
        this.gateway.onKlines(symbol, interval, this.safeInvoke("watchKlines", (klines) => {
            cb(klines);
        }));
    }
    async createOrder(params) {
        await this.ensureInitialized("createOrder");
        return this.gateway.createOrder(params);
    }
    async cancelOrder(params) {
        await this.ensureInitialized("cancelOrder");
        await this.gateway.cancelOrder({ symbol: params.symbol, orderId: Number(params.orderId) });
    }
    async cancelOrders(params) {
        await this.ensureInitialized("cancelOrders");
        await this.gateway.cancelOrders({ symbol: params.symbol, orderIdList: params.orderIdList });
    }
    async cancelAllOrders(params) {
        await this.ensureInitialized("cancelAllOrders");
        await this.gateway.cancelAllOrders(params);
    }
    async getPrecision() {
        try {
            const precision = await this.gateway.getPrecision(this.symbol);
            if (!precision)
                return null;
            return {
                priceTick: precision.priceTick,
                qtyStep: precision.qtyStep,
                priceDecimals: precision.priceDecimals,
                sizeDecimals: precision.sizeDecimals,
            };
        }
        catch (error) {
            console.error("[AsterExchangeAdapter] getPrecision failed", error);
            return null;
        }
    }
}
