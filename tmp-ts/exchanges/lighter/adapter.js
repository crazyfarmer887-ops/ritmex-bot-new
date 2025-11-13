import { extractMessage } from "../../utils/errors";
import { LighterGateway } from "./gateway";
export class LighterExchangeAdapter {
    id = "lighter";
    gateway;
    initPromise = null;
    initContexts = new Set();
    constructor(credentials = {}) {
        const displaySymbolSource = credentials.displaySymbol ?? process.env.TRADE_SYMBOL ?? "";
        if (!displaySymbolSource) {
            throw new Error("TRADE_SYMBOL environment variable is required");
        }
        const displaySymbol = displaySymbolSource;
        const marketSymbolSource = credentials.marketSymbol ?? credentials.symbol ?? process.env.LIGHTER_SYMBOL ?? displaySymbol;
        const marketSymbol = marketSymbolSource.toUpperCase();
        const accountIndex = credentials.accountIndex ?? parseInt(process.env.LIGHTER_ACCOUNT_INDEX ?? "", 10);
        if (!Number.isFinite(accountIndex)) {
            throw new Error("LIGHTER_ACCOUNT_INDEX environment variable is required");
        }
        const apiKeys = resolveApiKeys(credentials);
        const environment = credentials.environment ?? process.env.LIGHTER_ENV;
        const marketId = credentials.marketId ?? (process.env.LIGHTER_MARKET_ID ? Number(process.env.LIGHTER_MARKET_ID) : undefined);
        const priceDecimals = credentials.priceDecimals ?? (process.env.LIGHTER_PRICE_DECIMALS ? Number(process.env.LIGHTER_PRICE_DECIMALS) : undefined);
        const sizeDecimals = credentials.sizeDecimals ?? (process.env.LIGHTER_SIZE_DECIMALS ? Number(process.env.LIGHTER_SIZE_DECIMALS) : undefined);
        const l1Address = credentials.l1Address ?? process.env.LIGHTER_L1_ADDRESS ?? null;
        const gatewayOptions = {
            symbol: displaySymbol,
            marketSymbol,
            accountIndex,
            apiKeys,
            baseUrl: credentials.baseUrl ?? process.env.LIGHTER_BASE_URL,
            environment: environment,
            marketId,
            priceDecimals,
            sizeDecimals,
            chainId: credentials.chainId ?? (process.env.LIGHTER_CHAIN_ID ? Number(process.env.LIGHTER_CHAIN_ID) : undefined),
            tickerPollMs: credentials.tickerPollMs,
            klinePollMs: credentials.klinePollMs,
            logger: (context, error) => this.logError(context, error),
            l1Address: l1Address ?? undefined,
        };
        this.gateway = new LighterGateway(gatewayOptions);
    }
    supportsTrailingStops() {
        return false;
    }
    watchAccount(handler) {
        void this.ensureInitialized("watchAccount");
        this.gateway.onAccount(handler);
    }
    watchOrders(handler) {
        void this.ensureInitialized("watchOrders");
        this.gateway.onOrders(handler);
    }
    watchDepth(_symbol, handler) {
        void this.ensureInitialized("watchDepth");
        this.gateway.onDepth(handler);
    }
    watchTicker(_symbol, handler) {
        void this.ensureInitialized("watchTicker");
        this.gateway.onTicker(handler);
    }
    watchKlines(_symbol, interval, handler) {
        void this.ensureInitialized(`watchKlines:${interval}`);
        this.gateway.watchKlines(interval, handler);
    }
    async createOrder(params) {
        await this.ensureInitialized("createOrder");
        return this.gateway.createOrder(params);
    }
    async cancelOrder(params) {
        await this.ensureInitialized("cancelOrder");
        // Accept both clientOrderId and order_index as strings; forward as-is to preserve precision
        await this.gateway.cancelOrder({ orderId: String(params.orderId) });
    }
    async cancelOrders(params) {
        await this.ensureInitialized("cancelOrders");
        for (const orderId of params.orderIdList) {
            await this.gateway.cancelOrder({ orderId: String(orderId) });
        }
    }
    async cancelAllOrders(_params) {
        await this.ensureInitialized("cancelAllOrders");
        await this.gateway.cancelAllOrders();
    }
    async getPrecision() {
        try {
            const precision = await this.gateway.getPrecision();
            return {
                priceTick: precision.priceTick,
                qtyStep: precision.qtyStep,
                priceDecimals: precision.priceDecimals,
                sizeDecimals: precision.sizeDecimals,
                marketId: precision.marketId ?? undefined,
            };
        }
        catch (error) {
            this.logError("precision", error);
            return null;
        }
    }
    ensureInitialized(context) {
        if (!this.initPromise) {
            this.initContexts.clear();
            this.initPromise = this.gateway.ensureInitialized().catch((error) => {
                this.logError("initialize", error);
                this.initPromise = null;
                throw error;
            });
        }
        if (context && !this.initContexts.has(context)) {
            this.initContexts.add(context);
            this.initPromise.catch((error) => this.logError(context, error));
        }
        return this.initPromise;
    }
    logError(context, error) {
        if (process.env.LIGHTER_DEBUG === "1" || process.env.LIGHTER_DEBUG === "true") {
            console.error(`[LighterExchangeAdapter] ${context} failed: ${extractMessage(error)}`);
        }
    }
}
function resolveApiKeys(credentials) {
    if (credentials.apiKeys && Object.keys(credentials.apiKeys).length) {
        return credentials.apiKeys;
    }
    const privateKey = credentials.apiPrivateKey ?? process.env.LIGHTER_API_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error("LIGHTER_API_PRIVATE_KEY environment variable is required");
    }
    const apiKeyIndex = credentials.apiKeyIndex ?? (process.env.LIGHTER_API_KEY_INDEX ? Number(process.env.LIGHTER_API_KEY_INDEX) : 0);
    if (!Number.isInteger(apiKeyIndex) || apiKeyIndex < 0) {
        throw new Error("Invalid LIGHTER_API_KEY_INDEX value");
    }
    return { [apiKeyIndex]: privateKey };
}
