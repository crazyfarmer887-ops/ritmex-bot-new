import { extractMessage } from "../../utils/errors";
import { BackpackGateway } from "./gateway";
export class BackpackExchangeAdapter {
    id = "backpack";
    gateway;
    symbol;
    initPromise = null;
    initContexts = new Set();
    retryTimer = null;
    retryDelayMs = 3000;
    lastInitErrorAt = 0;
    constructor(credentials = {}) {
        const apiKey = credentials.apiKey ?? process.env.BACKPACK_API_KEY;
        const apiSecret = credentials.apiSecret ?? process.env.BACKPACK_API_SECRET;
        const password = credentials.password ?? process.env.BACKPACK_PASSWORD;
        const subaccount = credentials.subaccount ?? process.env.BACKPACK_SUBACCOUNT;
        const sandbox = credentials.sandbox ?? (process.env.BACKPACK_SANDBOX === "true");
        const symbol = credentials.symbol ?? process.env.BACKPACK_SYMBOL ?? process.env.TRADE_SYMBOL ?? "BTCUSDC";
        if (!apiKey || !apiSecret) {
            throw new Error("BACKPACK_API_KEY and BACKPACK_API_SECRET environment variables are required");
        }
        const gatewayOptions = {
            apiKey,
            apiSecret,
            password,
            subaccount,
            symbol,
            sandbox,
            logger: (context, error) => this.logError(context, error),
        };
        this.gateway = new BackpackGateway(gatewayOptions);
        this.symbol = symbol;
    }
    supportsTrailingStops() {
        return false; // TODO: Check if Backpack supports trailing stops via ccxt
    }
    watchAccount(cb) {
        void this.ensureInitialized("watchAccount");
        this.gateway.onAccount(this.safeInvoke("watchAccount", cb));
    }
    watchOrders(cb) {
        void this.ensureInitialized("watchOrders");
        this.gateway.onOrders(this.safeInvoke("watchOrders", cb));
    }
    watchDepth(_symbol, cb) {
        void this.ensureInitialized("watchDepth");
        this.gateway.onDepth(this.safeInvoke("watchDepth", cb));
    }
    watchTicker(_symbol, cb) {
        void this.ensureInitialized("watchTicker");
        this.gateway.onTicker(this.safeInvoke("watchTicker", cb));
    }
    watchKlines(_symbol, interval, cb) {
        void this.ensureInitialized(`watchKlines:${interval}`);
        this.gateway.watchKlines(interval, this.safeInvoke("watchKlines", cb));
    }
    async createOrder(params) {
        await this.ensureInitialized("createOrder");
        return this.gateway.createOrder(params);
    }
    async cancelOrder(params) {
        await this.ensureInitialized("cancelOrder");
        await this.gateway.cancelOrder({ orderId: params.orderId });
    }
    async cancelOrders(params) {
        await this.ensureInitialized("cancelOrders");
        await this.gateway.cancelOrders({ orderIdList: params.orderIdList });
    }
    async cancelAllOrders(_params) {
        await this.ensureInitialized("cancelAllOrders");
        await this.gateway.cancelAllOrders();
    }
    safeInvoke(context, cb) {
        const wrapped = ((...args) => {
            try {
                cb(...args);
            }
            catch (error) {
                console.error(`[BackpackExchangeAdapter] ${context} handler failed: ${extractMessage(error)}`);
            }
        });
        return wrapped;
    }
    ensureInitialized(context) {
        if (!this.initPromise) {
            this.initContexts.clear();
            this.initPromise = this.gateway
                .ensureInitialized(this.symbol)
                .then((value) => {
                if (process.env.BACKPACK_DEBUG === "1") {
                    console.error(`[BackpackExchangeAdapter] initialize succeeded`);
                }
                if (process.env.BACKPACK_DEBUG === "1") {
                    console.error(`[BackpackExchangeAdapter] initialize succeeded`);
                }
                this.clearRetry();
                return value;
            })
                .catch((error) => {
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
        console.error(`[BackpackExchangeAdapter] ${context} failed`, error);
    }
    logError(context, error) {
        if (process.env.BACKPACK_DEBUG === "1" || process.env.BACKPACK_DEBUG === "true") {
            console.error(`[BackpackExchangeAdapter] ${context} failed: ${extractMessage(error)}`);
        }
    }
}
