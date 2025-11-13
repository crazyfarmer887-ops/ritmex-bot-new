import { setTimeout, clearTimeout } from "timers";
import path from "path";
import { createRequire } from "module";
import { extractMessage } from "../../utils/errors";
import { GrvtGateway, } from "./gateway";
export class GrvtExchangeAdapter {
    id = "grvt";
    gateway;
    symbol;
    instrument;
    initPromise = null;
    initContexts = new Set();
    retryTimer = null;
    retryDelayMs = 3000;
    lastInitErrorAt = 0;
    klineInterval = "1m";
    constructor(credentials = {}) {
        const apiKey = credentials.apiKey ?? process.env.GRVT_API_KEY;
        const apiSecret = credentials.apiSecret ?? process.env.GRVT_API_SECRET;
        const cookie = credentials.cookie ?? process.env.GRVT_COOKIE;
        const accountId = credentials.accountId ?? process.env.GRVT_ACCOUNT_ID;
        if (!cookie || !accountId) {
            if (!apiKey) {
                throw new Error("Missing GRVT_API_KEY environment variable for authentication");
            }
        }
        const subAccountId = requireValue(credentials.subAccountId ?? process.env.GRVT_SUB_ACCOUNT_ID, "GRVT_SUB_ACCOUNT_ID");
        const instrument = requireValue(credentials.instrument ?? process.env.GRVT_INSTRUMENT, "GRVT_INSTRUMENT");
        const symbol = normalizeSymbol(credentials.symbol ?? process.env.GRVT_SYMBOL, instrument);
        this.symbol = symbol;
        this.instrument = instrument;
        const signatureProvider = credentials.signatureProvider ?? loadSignatureProviderFromEnv(credentials.logger);
        if (!signatureProvider && !apiSecret) {
            throw new Error("GRVT_API_SECRET is required when no external signature provider is configured");
        }
        this.gateway = new GrvtGateway({
            apiKey: apiKey ?? undefined,
            apiSecret: apiSecret ?? undefined,
            cookie: cookie ?? undefined,
            accountId: accountId ?? undefined,
            subAccountId,
            instrument,
            symbol,
            env: (credentials.env ?? process.env.GRVT_ENV),
            hosts: credentials.hosts,
            signatureProvider,
            pollIntervals: credentials.pollIntervals,
            logger: credentials.logger,
        });
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
    watchDepth(_symbol, cb) {
        void this.ensureInitialized("watchDepth");
        this.gateway.onDepth(this.safeInvoke("watchDepth", cb));
    }
    watchTicker(_symbol, cb) {
        void this.ensureInitialized("watchTicker");
        this.gateway.onTicker(this.safeInvoke("watchTicker", cb));
    }
    watchKlines(_symbol, interval, cb) {
        this.klineInterval = interval ?? this.klineInterval;
        void this.ensureInitialized("watchKlines", this.klineInterval);
        this.gateway.onKlines(this.safeInvoke("watchKlines", cb));
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
                console.error(`[GrvtExchangeAdapter] ${context} handler failed: ${extractMessage(error)}`);
            }
        });
        return wrapped;
    }
    ensureInitialized(context, interval) {
        if (interval) {
            this.klineInterval = interval;
        }
        if (!this.initPromise) {
            this.initContexts.clear();
            this.initPromise = this.gateway
                .ensureInitialized(this.klineInterval)
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
        console.error(`[GrvtExchangeAdapter] ${context} failed`, error);
    }
}
function requireValue(value, key) {
    if (value == null || value === "") {
        throw new Error(`Missing required environment variable ${key}`);
    }
    return value;
}
function normalizeSymbol(symbol, instrument) {
    if (symbol)
        return symbol.toUpperCase();
    return instrument.replace(/[_-]/g, "").toUpperCase();
}
function loadSignatureProviderFromEnv(logger) {
    const signerModule = process.env.GRVT_SIGNER_PATH;
    if (!signerModule)
        return undefined;
    try {
        const require = createRequire(import.meta.url);
        const resolved = signerModule.startsWith(".") || signerModule.startsWith("/")
            ? path.resolve(process.cwd(), signerModule)
            : signerModule;
        const loaded = require(resolved);
        if (typeof loaded === "function") {
            return loaded;
        }
        if (loaded && typeof loaded.default === "function") {
            return loaded.default;
        }
        console.warn(`[GrvtExchangeAdapter] 模块 ${resolved} 未导出签名函数 (function default export)`);
    }
    catch (error) {
        const log = logger ?? ((ctx, err) => console.error(`[GrvtExchangeAdapter] ${ctx}`, err));
        log("loadSignatureProvider", error);
    }
    return undefined;
}
