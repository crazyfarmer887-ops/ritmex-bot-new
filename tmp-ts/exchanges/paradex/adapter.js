import { setTimeout, clearTimeout } from "timers";
import { extractMessage } from "../../utils/errors";
import { ParadexGateway } from "./gateway";
export class ParadexExchangeAdapter {
    id = "paradex";
    gateway;
    symbol;
    initPromise = null;
    initContexts = new Set();
    retryTimer = null;
    retryDelayMs = 3000;
    lastInitErrorAt = 0;
    constructor(credentials = {}) {
        const privateKey = credentials.privateKey ?? process.env.PARADEX_PRIVATE_KEY;
        const walletAddress = credentials.walletAddress ?? process.env.PARADEX_WALLET_ADDRESS;
        const sandbox = credentials.sandbox ?? (process.env.PARADEX_SANDBOX === "true");
        const symbol = credentials.symbol ?? process.env.PARADEX_SYMBOL ?? process.env.TRADE_SYMBOL ?? "BTC/USDC";
        const usePro = credentials.usePro ?? this.parseBooleanEnv(process.env.PARADEX_USE_PRO);
        const watchReconnectDelayMs = credentials.watchReconnectDelayMs ?? this.parseNumberEnv(process.env.PARADEX_RECONNECT_DELAY_MS);
        this.gateway = new ParadexGateway({
            symbol,
            displaySymbol: symbol,
            privateKey,
            walletAddress,
            sandbox,
            pollIntervals: credentials.pollIntervals,
            watchReconnectDelayMs,
            usePro,
            logger: (context, error) => this.logError(context, error),
        });
        this.symbol = symbol;
    }
    supportsTrailingStops() {
        return false;
    }
    watchAccount(cb) {
        void this.ensureInitialized("watchAccount");
        this.gateway.onAccount(this.safeInvoke("watchAccount", cb));
    }
    watchOrders(cb) {
        void this.ensureInitialized("watchOrders");
        this.gateway.onOrders(this.safeInvoke("watchOrders", cb));
    }
    watchDepth(symbol, cb) {
        void this.ensureInitialized(`watchDepth:${symbol}`);
        this.gateway.onDepth(this.safeInvoke("watchDepth", cb));
    }
    watchTicker(symbol, cb) {
        void this.ensureInitialized(`watchTicker:${symbol}`);
        this.gateway.onTicker(this.safeInvoke("watchTicker", cb));
    }
    watchKlines(symbol, interval, cb) {
        void this.ensureInitialized(`watchKlines:${symbol}:${interval}`);
        this.gateway.watchKlines(interval, this.safeInvoke("watchKlines", cb));
    }
    async createOrder(params) {
        await this.ensureInitialized("createOrder");
        return this.gateway.createOrder(params);
    }
    async cancelOrder(params) {
        await this.ensureInitialized("cancelOrder");
        await this.gateway.cancelOrder(params);
    }
    async cancelOrders(params) {
        await this.ensureInitialized("cancelOrders");
        await this.gateway.cancelOrders(params);
    }
    async cancelAllOrders(params) {
        await this.ensureInitialized("cancelAllOrders");
        await this.gateway.cancelAllOrders(params);
    }
    safeInvoke(context, cb) {
        const wrapped = ((...args) => {
            try {
                cb(...args);
            }
            catch (error) {
                console.error(`[ParadexExchangeAdapter] ${context} handler failed: ${extractMessage(error)}`);
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
        console.error(`[ParadexExchangeAdapter] ${context} failed`, error);
    }
    logError(context, error) {
        const detail = extractMessage(error);
        if (context === "initialize" && typeof error === "string" && /initialized/i.test(error)) {
            if (process.env.PARADEX_DEBUG === "1" || process.env.PARADEX_DEBUG === "true") {
                console.info(`[ParadexExchangeAdapter] ${error}`);
            }
            return;
        }
        const message = `[ParadexExchangeAdapter] ${context} failed: ${detail}`;
        const criticalContexts = [
            "initialize",
            "accountPoll",
            "watchBalanceLoop",
            "orderPoll",
            "orderPollOpen",
            "orderPollClosed",
        ];
        if (criticalContexts.some((prefix) => context.startsWith(prefix)) ||
            process.env.PARADEX_DEBUG === "1" ||
            process.env.PARADEX_DEBUG === "true") {
            console.error(message);
        }
    }
    parseBooleanEnv(value) {
        if (value === undefined)
            return undefined;
        const normalized = value.trim().toLowerCase();
        if (["false", "0", "no", "off", ""].includes(normalized))
            return false;
        return true;
    }
    parseNumberEnv(value) {
        if (!value)
            return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
}
