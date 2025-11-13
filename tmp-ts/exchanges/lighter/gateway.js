import { setInterval, clearInterval, setTimeout } from "timers";
import WebSocket from "ws";
import { LighterHttpClient } from "./http-client";
import { HttpNonceManager } from "./nonce-manager";
import { LighterSigner } from "./signer";
import { DEFAULT_AUTH_TOKEN_BUFFER_MS, DEFAULT_LIGHTER_ENVIRONMENT, LIGHTER_HOSTS, LIGHTER_ORDER_TYPE, LIGHTER_TIME_IN_FORCE, IMMEDIATE_OR_CANCEL_EXPIRY_PLACEHOLDER, } from "./constants";
import { decimalToScaled, scaledToDecimalString, scaleQuantityWithMinimum } from "./decimal";
import { lighterOrderToAster, toAccountSnapshot, toDepth, toKlines, toOrders, toTicker } from "./mappers";
function createEvent() {
    const listeners = new Set();
    return {
        add(handler) {
            listeners.add(handler);
        },
        remove(handler) {
            listeners.delete(handler);
        },
        emit(value) {
            for (const handler of Array.from(listeners)) {
                try {
                    handler(value);
                }
                catch (error) {
                    console.error("[LighterGateway] listener error", error);
                }
            }
        },
        listenerCount() {
            return listeners.size;
        },
    };
}
function isLighterEnvironment(value) {
    if (!value)
        return false;
    return Object.prototype.hasOwnProperty.call(LIGHTER_HOSTS, value);
}
function detectEnvironmentFromUrl(baseUrl) {
    if (!baseUrl)
        return null;
    const matchHost = (host) => {
        for (const [env, config] of Object.entries(LIGHTER_HOSTS)) {
            try {
                const restHost = new URL(config.rest).hostname.toLowerCase();
                if (restHost === host) {
                    return env;
                }
            }
            catch {
                // ignore invalid config URLs
            }
        }
        if (host.includes("mainnet"))
            return "mainnet";
        if (host.includes("testnet"))
            return "testnet";
        if (host.includes("staging"))
            return "staging";
        if (host.includes("dev"))
            return "dev";
        return null;
    };
    try {
        const parsed = new URL(baseUrl);
        return matchHost(parsed.hostname.toLowerCase());
    }
    catch {
        return matchHost(baseUrl.toLowerCase());
    }
}
function inferEnvironment(envOption, baseUrl) {
    if (isLighterEnvironment(envOption)) {
        return envOption;
    }
    const detected = detectEnvironmentFromUrl(baseUrl ?? undefined);
    return detected ?? DEFAULT_LIGHTER_ENVIRONMENT;
}
const KLINE_DEFAULT_COUNT = 120;
const DEFAULT_TICKER_POLL_MS = 3000;
const DEFAULT_KLINE_POLL_MS = 15000;
const WS_HEARTBEAT_INTERVAL_MS = 5_000;
const WS_STALE_TIMEOUT_MS = 20_000;
const ACCOUNT_POLL_INTERVAL_MS = 5_000;
const ACCOUNT_HTTP_EMPTY_CONFIRM_MS = 15_000;
const POSITION_EPSILON = 1e-12;
const RESOLUTION_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
};
const TERMINAL_ORDER_STATUSES = new Set(["filled", "canceled", "cancelled", "expired"]);
export class LighterGateway {
    displaySymbol;
    marketSymbol;
    http;
    signer;
    nonceManager;
    logger;
    apiKeyIndices;
    environment;
    pollers = { ticker: undefined, klines: new Map() };
    accountPoller = null;
    accountPollInFlight = false;
    klineCache = new Map();
    accountEvent = createEvent();
    ordersEvent = createEvent();
    depthEvent = createEvent();
    tickerEvent = createEvent();
    klinesEvent = createEvent();
    auth = { token: null, expiresAt: 0 };
    l1Address;
    loggedCreateOrderPayload = false;
    httpEmptySince = null;
    lastWsPositionUpdateAt = 0;
    marketId = null;
    priceDecimals = null;
    sizeDecimals = null;
    ws = null;
    reconnectTimer = null;
    wsUrl;
    connectPromise = null;
    heartbeatTimer = null;
    lastMessageAt = 0;
    accountDetails = null;
    positions = [];
    orders = [];
    orderMap = new Map();
    orderBook = null;
    ticker = null;
    initialized = false;
    tickerPollMs;
    klinePollMs;
    // Track last applied order book sequence to drop stale WS messages
    lastOrderBookOffset = 0;
    lastOrderBookTimestamp = 0;
    constructor(options) {
        this.displaySymbol = options.symbol;
        this.marketSymbol = (options.marketSymbol ?? options.symbol).toUpperCase();
        this.environment = inferEnvironment(options.environment, options.baseUrl);
        const host = options.baseUrl ?? LIGHTER_HOSTS[this.environment]?.rest;
        if (!host) {
            throw new Error(`Unknown Lighter environment ${this.environment}`);
        }
        const wsHost = LIGHTER_HOSTS[this.environment]?.ws;
        if (!wsHost) {
            throw new Error(`WebSocket endpoint not configured for env ${this.environment}`);
        }
        this.wsUrl = wsHost;
        this.http = new LighterHttpClient({ baseUrl: host });
        this.signer = new LighterSigner({
            accountIndex: options.accountIndex,
            chainId: options.chainId ?? (this.environment === "mainnet" ? 304 : 300),
            apiKeys: options.apiKeys,
            baseUrl: host,
        });
        this.apiKeyIndices = options.apiKeyIndices ?? Object.keys(options.apiKeys).map(Number);
        this.nonceManager = new HttpNonceManager({
            accountIndex: options.accountIndex,
            apiKeyIndices: this.apiKeyIndices,
            http: this.http,
        });
        const debugEnabled = process.env.LIGHTER_DEBUG === "1" || process.env.LIGHTER_DEBUG === "true";
        this.logger = options.logger ?? ((context, error) => {
            if (debugEnabled) {
                // eslint-disable-next-line no-console
                console.error(`[LighterGateway] ${context}`, error);
            }
        });
        this.marketId = options.marketId != null ? Number(options.marketId) : null;
        this.priceDecimals = options.priceDecimals ?? null;
        this.sizeDecimals = options.sizeDecimals ?? null;
        this.tickerPollMs = options.tickerPollMs ?? DEFAULT_TICKER_POLL_MS;
        this.klinePollMs = options.klinePollMs ?? DEFAULT_KLINE_POLL_MS;
        this.l1Address = options.l1Address ?? null;
    }
    async ensureInitialized() {
        if (this.initialized)
            return;
        if (!this.connectPromise) {
            this.connectPromise = this.initialize().catch((error) => {
                this.connectPromise = null;
                throw error;
            });
        }
        await this.connectPromise;
        this.initialized = true;
    }
    onAccount(handler) {
        this.accountEvent.add(handler);
    }
    onOrders(handler) {
        this.ordersEvent.add(handler);
    }
    onDepth(handler) {
        this.depthEvent.add(handler);
    }
    onTicker(handler) {
        this.tickerEvent.add(handler);
    }
    onKlines(handler) {
        this.klinesEvent.add(handler);
    }
    async createOrder(params) {
        await this.ensureInitialized();
        const conversion = this.mapCreateOrderParams(params);
        const { baseAmountScaledString, priceScaledString, triggerPriceScaledString, ...signParams } = conversion;
        const { apiKeyIndex, nonce } = this.nonceManager.next();
        try {
            const signed = await this.signer.signCreateOrder({
                ...signParams,
                apiKeyIndex,
                nonce,
            });
            if (!this.loggedCreateOrderPayload) {
                if (process.env.LIGHTER_DEBUG === "1" || process.env.LIGHTER_DEBUG === "true") {
                    this.logger("createOrder.txInfo", signed.txInfo);
                }
                this.loggedCreateOrderPayload = true;
            }
            const auth = await this.ensureAuthToken();
            const response = await this.http.sendTransaction(signed.txType, signed.txInfo, {
                authToken: auth,
                priceProtection: false,
            });
            if (process.env.LIGHTER_DEBUG === "1" || process.env.LIGHTER_DEBUG === "true") {
                this.logger("createOrder.sendTx.response", response);
            }
            return lighterOrderToAster(this.displaySymbol, {
                order_index: Number(signParams.clientOrderIndex % 1000000000n),
                client_order_index: Number(signParams.clientOrderIndex),
                market_index: signParams.marketIndex,
                initial_base_amount: baseAmountScaledString,
                remaining_base_amount: baseAmountScaledString,
                price: priceScaledString,
                trigger_price: triggerPriceScaledString,
                is_ask: signParams.isAsk === 1,
                side: signParams.isAsk === 1 ? "sell" : "buy",
                type: params.type?.toLowerCase(),
                reduce_only: signParams.reduceOnly === 1,
                status: "NEW",
                created_at: Date.now(),
            });
        }
        catch (error) {
            this.nonceManager.acknowledgeFailure(apiKeyIndex);
            this.logger("createOrder", error);
            throw error;
        }
    }
    async cancelOrder(params) {
        await this.ensureInitialized();
        const marketIndex = params.marketIndex ?? this.marketId;
        if (marketIndex == null)
            throw new Error("Market index unknown");
        // Parse order id to BigInt without precision loss; prefer string input
        let indexValue;
        if (typeof params.orderId === "string") {
            indexValue = BigInt(params.orderId);
        }
        else {
            // Fallback for numeric ids (may be unsafe if beyond 2^53-1)
            indexValue = BigInt(Math.trunc(params.orderId));
        }
        const { apiKeyIndex, nonce } = this.nonceManager.next();
        try {
            const signed = await this.signer.signCancelOrder({
                marketIndex,
                orderIndex: indexValue,
                nonce,
                apiKeyIndex,
            });
            const auth = await this.ensureAuthToken();
            await this.http.sendTransaction(signed.txType, signed.txInfo, { authToken: auth });
            // Optimistically remove the order locally to avoid stale duplicates until WS confirms
            const key = String(params.orderId);
            this.orderMap.delete(key);
            this.orders = Array.from(this.orderMap.values());
            this.emitOrders();
        }
        catch (error) {
            this.nonceManager.acknowledgeFailure(apiKeyIndex);
            throw error;
        }
    }
    async cancelAllOrders(params) {
        await this.ensureInitialized();
        const timeInForce = params?.timeInForce ?? 0;
        const time = params?.scheduleMs != null ? BigInt(params.scheduleMs) : 0n;
        const { apiKeyIndex, nonce } = this.nonceManager.next();
        try {
            const signed = await this.signer.signCancelAll({
                timeInForce,
                scheduledTime: time,
                nonce,
                apiKeyIndex,
            });
            const auth = await this.ensureAuthToken();
            await this.http.sendTransaction(signed.txType, signed.txInfo, { authToken: auth });
        }
        catch (error) {
            this.nonceManager.acknowledgeFailure(apiKeyIndex);
            throw error;
        }
    }
    async initialize() {
        await this.loadMetadata();
        await this.nonceManager.init(true);
        await this.refreshAccountSnapshot();
        await this.openWebSocket();
        // Emit an initial empty orders snapshot so strategies depending on an order
        // snapshot at startup can proceed even if the websocket does not publish
        // orders until there is activity.
        this.emitOrders();
        this.startPolling();
    }
    async loadMetadata() {
        if (this.marketId != null && this.priceDecimals != null && this.sizeDecimals != null)
            return;
        const books = await this.http.getOrderBooks();
        const desiredSymbol = this.marketSymbol;
        let target = books.find((book) => (book.symbol ? String(book.symbol).toUpperCase() : "") === desiredSymbol);
        if (!target && this.marketId != null) {
            target = books.find((book) => Number(book.market_id) === Number(this.marketId));
        }
        if (!target) {
            if (this.marketId != null && this.priceDecimals != null && this.sizeDecimals != null) {
                return;
            }
            throw new Error(`Symbol ${desiredSymbol} not listed on Lighter order books`);
        }
        this.marketId = Number(target.market_id);
        if (this.priceDecimals == null) {
            this.priceDecimals = target.supported_price_decimals;
        }
        if (this.sizeDecimals == null) {
            this.sizeDecimals = target.supported_size_decimals;
        }
    }
    async refreshAccountSnapshot() {
        try {
            const auth = await this.ensureAuthToken();
            let details = null;
            if (this.l1Address) {
                details = await this.http.getAccountDetails(Number(this.signer.accountIndex), auth, {
                    by: "l1_address",
                    value: this.l1Address,
                });
            }
            if (!details) {
                details = await this.http.getAccountDetails(Number(this.signer.accountIndex), auth, {
                    by: "index",
                    value: Number(this.signer.accountIndex),
                });
            }
            if (!details) {
                if (!this.accountDetails) {
                    this.accountDetails = {
                        account_index: Number(this.signer.accountIndex),
                        status: 1,
                        collateral: "0",
                        available_balance: "0",
                    };
                    this.positions = [];
                    this.emitAccount();
                }
                return;
            }
            this.accountDetails = details;
            this.applyHttpPositions(details);
            this.emitAccount();
        }
        catch (error) {
            this.logger("refreshAccount", error);
        }
    }
    applyHttpPositions(details) {
        if (!Object.prototype.hasOwnProperty.call(details, "positions")) {
            return;
        }
        const normalized = this.normalizePositions(details.positions);
        if (normalized.length) {
            this.replacePositions(normalized);
            this.recordHttpPositionUpdate();
            this.httpEmptySince = null;
            return;
        }
        if (!this.isEmptyPositionsPayload(details.positions)) {
            return;
        }
        this.handleHttpEmptyPositions();
    }
    handleHttpEmptyPositions() {
        if (this.positions.length === 0) {
            this.httpEmptySince = null;
            return;
        }
        if (this.httpEmptySince == null) {
            this.httpEmptySince = Date.now();
            return;
        }
        const now = Date.now();
        const sinceEmpty = now - this.httpEmptySince;
        const sinceWs = now - this.lastWsPositionUpdateAt;
        if (sinceEmpty >= ACCOUNT_HTTP_EMPTY_CONFIRM_MS && sinceWs >= ACCOUNT_HTTP_EMPTY_CONFIRM_MS) {
            this.positions = [];
            this.recordHttpPositionUpdate();
            this.httpEmptySince = null;
        }
    }
    recordWsPositionUpdate() {
        this.lastWsPositionUpdateAt = Date.now();
        this.httpEmptySince = null;
    }
    recordHttpPositionUpdate() {
        this.httpEmptySince = null;
    }
    async openWebSocket() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl);
            this.ws = ws;
            let settled = false;
            const cleanup = () => {
                ws.removeAllListeners();
                this.stopHeartbeat();
                if (this.ws === ws) {
                    this.ws = null;
                }
            };
            const fail = (error) => {
                if (settled)
                    return;
                settled = true;
                reject(error instanceof Error ? error : new Error(String(error)));
            };
            ws.on("open", async () => {
                try {
                    this.lastMessageAt = Date.now();
                    this.startHeartbeat();
                    await this.subscribeChannels();
                    settled = true;
                    resolve();
                }
                catch (error) {
                    cleanup();
                    fail(error);
                    return;
                }
            });
            ws.on("message", (data) => {
                this.lastMessageAt = Date.now();
                this.handleMessage(data);
            });
            ws.on("pong", () => {
                this.lastMessageAt = Date.now();
            });
            ws.on("close", (code, reason) => {
                cleanup();
                const normalizedReason = Buffer.isBuffer(reason) && reason.length > 0 ? reason.toString("utf8") : undefined;
                if (!settled) {
                    fail(new Error(`WebSocket closed before ready (code=${code}${normalizedReason ? `, reason=${normalizedReason}` : ""})`));
                    return;
                }
                this.scheduleReconnect();
            });
            ws.on("error", (error) => {
                this.logger("ws:error", error);
                cleanup();
                if (!settled) {
                    fail(error);
                    return;
                }
                this.scheduleReconnect();
            });
        });
    }
    async subscribeChannels() {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        const marketId = this.marketId;
        if (marketId == null)
            throw new Error("Market ID unknown");
        ws.send(JSON.stringify({ type: "subscribe", channel: `order_book/${marketId}` }));
        ws.send(JSON.stringify({ type: "subscribe", channel: `account_all/${Number(this.signer.accountIndex)}` }));
        const auth = await this.ensureAuthToken();
        // Subscribe to per-market account updates to receive timely position changes
        ws.send(JSON.stringify({
            type: "subscribe",
            channel: `account_market/${Number(marketId)}/${Number(this.signer.accountIndex)}`,
            auth,
        }));
        ws.send(JSON.stringify({
            type: "subscribe",
            channel: `account_all_orders/${Number(this.signer.accountIndex)}`,
            auth,
        }));
    }
    async ensureAuthToken() {
        const now = Date.now();
        if (this.auth.token && now < this.auth.expiresAt - DEFAULT_AUTH_TOKEN_BUFFER_MS) {
            return this.auth.token;
        }
        const deadline = now + 10 * 60 * 1000; // 10 minutes horizon
        const token = await this.signer.createAuthToken(deadline);
        this.auth.token = token;
        this.auth.expiresAt = deadline;
        return token;
    }
    scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.openWebSocket().catch((error) => this.logger("reconnect", error));
        }, 2000);
    }
    startHeartbeat() {
        if (this.heartbeatTimer)
            return;
        this.heartbeatTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN)
                return;
            const now = Date.now();
            if (now - this.lastMessageAt > WS_STALE_TIMEOUT_MS) {
                try {
                    ws.terminate();
                }
                catch (error) {
                    this.logger("ws:terminate", error);
                }
                finally {
                    this.stopHeartbeat();
                    this.scheduleReconnect();
                }
                return;
            }
            try {
                ws.ping();
            }
            catch (error) {
                this.logger("ws:ping", error);
            }
        }, WS_HEARTBEAT_INTERVAL_MS);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    handleMessage(data) {
        try {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const message = JSON.parse(text);
            const type = message?.type;
            switch (type) {
                case "connected":
                    break;
                case "subscribed/order_book":
                    this.handleOrderBookSnapshot(message);
                    break;
                case "update/order_book":
                    this.handleOrderBookUpdate(message);
                    break;
                case "subscribed/account_all":
                case "update/account_all":
                    this.handleAccountAll(message);
                    break;
                case "subscribed/account_market":
                case "update/account_market":
                    this.handleAccountMarket(message);
                    break;
                case "subscribed/account_all_orders":
                case "update/account_all_orders":
                    this.handleAccountOrders(message);
                    break;
                default:
                    break;
            }
        }
        catch (error) {
            this.logger("ws:message", error);
        }
    }
    handleOrderBookSnapshot(message) {
        if (!message?.order_book)
            return;
        const incomingOffset = Number(message.offset ?? message.order_book?.offset ?? 0);
        const incomingTs = Number(message.timestamp ?? 0);
        if (this.lastOrderBookOffset && incomingOffset && incomingOffset < this.lastOrderBookOffset) {
            return;
        }
        if (incomingOffset === this.lastOrderBookOffset && incomingTs && incomingTs <= this.lastOrderBookTimestamp) {
            return;
        }
        const snapshot = {
            market_id: this.marketId ?? 0,
            offset: message.order_book.offset ?? Date.now(),
            bids: sortAndTrimLevels(normalizeLevels(message.order_book.bids ?? []), "bid"),
            asks: sortAndTrimLevels(normalizeLevels(message.order_book.asks ?? []), "ask"),
        };
        this.orderBook = snapshot;
        this.lastOrderBookOffset = snapshot.offset ?? incomingOffset ?? this.lastOrderBookOffset;
        this.lastOrderBookTimestamp = incomingTs || Date.now();
        this.emitDepth();
    }
    handleOrderBookUpdate(message) {
        if (!this.orderBook)
            return;
        const incomingOffset = Number(message.offset ?? message.order_book?.offset ?? 0);
        const incomingTs = Number(message.timestamp ?? 0);
        if (this.lastOrderBookOffset && incomingOffset && incomingOffset < this.lastOrderBookOffset) {
            return;
        }
        if (incomingOffset === this.lastOrderBookOffset && incomingTs && incomingTs <= this.lastOrderBookTimestamp) {
            return;
        }
        const update = message?.order_book;
        if (!update)
            return;
        if (Array.isArray(update.asks)) {
            const asks = normalizeLevels(update.asks);
            this.orderBook.asks = sortAndTrimLevels(mergeLevels(this.orderBook.asks ?? [], asks), "ask");
        }
        if (Array.isArray(update.bids)) {
            const bids = normalizeLevels(update.bids);
            this.orderBook.bids = sortAndTrimLevels(mergeLevels(this.orderBook.bids ?? [], bids), "bid");
        }
        this.orderBook.offset = update.offset ?? this.orderBook.offset;
        this.lastOrderBookOffset = Number(this.orderBook.offset ?? incomingOffset ?? this.lastOrderBookOffset);
        this.lastOrderBookTimestamp = incomingTs || Date.now();
        this.emitDepth();
    }
    handleAccountAll(message) {
        if (!message)
            return;
        if (Object.prototype.hasOwnProperty.call(message, "positions")) {
            const positionsObject = message.positions ?? {};
            const incoming = this.normalizePositions(positionsObject);
            if (incoming.length) {
                this.mergePositions(incoming);
                this.recordWsPositionUpdate();
            }
            else if (this.isEmptyPositionsPayload(positionsObject)) {
                if (this.positions.length) {
                    this.positions = [];
                }
                this.recordWsPositionUpdate();
            }
        }
        this.emitAccount();
    }
    handleAccountMarket(message) {
        if (!message)
            return;
        const type = typeof message.type === "string" ? message.type : "";
        const position = message.position;
        const channelMarketId = this.extractMarketIdFromChannel(message.channel);
        if (position && Number.isFinite(Number(position.market_id))) {
            this.mergePositions([position]);
            this.recordWsPositionUpdate();
        }
        if (Array.isArray(message.orders) && message.orders.length) {
            const marketId = Number(position?.market_id ?? channelMarketId ?? this.marketId ?? NaN);
            this.applyOrderList(message.orders, Number.isFinite(marketId) ? Number(marketId) : null, type === "subscribed/account_market");
        }
        else if (type === "subscribed/account_market" && channelMarketId != null) {
            this.clearOrdersForMarket(channelMarketId);
            this.emitOrders();
        }
        if (Object.prototype.hasOwnProperty.call(message, "position") &&
            !position &&
            this.isEmptyPositionsPayload(message.position) &&
            channelMarketId != null &&
            this.positions.length) {
            const target = Number(channelMarketId);
            this.positions = this.positions.filter((entry) => Number(entry.market_id) !== target);
            this.recordWsPositionUpdate();
        }
        this.emitAccount();
    }
    handleAccountOrders(message) {
        if (!message)
            return;
        const snapshot = message.type === "subscribed/account_all_orders";
        const ordersObject = message.orders ?? {};
        this.applyOrderBuckets(ordersObject, snapshot);
    }
    normalizePositions(source) {
        if (!source)
            return [];
        if (Array.isArray(source)) {
            return source.filter((entry) => this.isPosition(entry));
        }
        if (isPlainObject(source)) {
            return Object.values(source).filter((entry) => this.isPosition(entry));
        }
        if (this.isPosition(source))
            return [source];
        return [];
    }
    isPosition(value) {
        return typeof value === "object" && value != null && Number.isFinite(Number(value.market_id));
    }
    mergePositions(updates) {
        if (!updates.length)
            return;
        const byMarket = new Map();
        for (const existing of this.positions ?? []) {
            const mid = Number(existing.market_id);
            if (Number.isFinite(mid)) {
                byMarket.set(mid, existing);
            }
        }
        for (const update of updates) {
            const marketId = Number(update.market_id);
            if (!Number.isFinite(marketId))
                continue;
            if (this.shouldRemovePosition(update)) {
                byMarket.delete(marketId);
            }
            else {
                byMarket.set(marketId, update);
            }
        }
        this.positions = Array.from(byMarket.values());
    }
    replacePositions(positions) {
        if (!positions.length) {
            this.positions = [];
            return;
        }
        const filtered = this.filterPositions(positions);
        this.positions = filtered;
    }
    filterPositions(positions) {
        const byMarket = new Map();
        for (const entry of positions) {
            const marketId = Number(entry.market_id);
            if (!Number.isFinite(marketId))
                continue;
            if (this.shouldRemovePosition(entry)) {
                byMarket.delete(marketId);
            }
            else {
                byMarket.set(marketId, entry);
            }
        }
        return Array.from(byMarket.values());
    }
    shouldRemovePosition(position) {
        const size = Number(position.position ?? 0);
        return !Number.isFinite(size) || Math.abs(size) < POSITION_EPSILON;
    }
    removePositionsForMarkets(markets) {
        if (!markets.length)
            return;
        const targets = new Set(markets.filter((value) => Number.isFinite(value)).map((value) => Number(value)));
        if (!targets.size)
            return;
        this.positions = (this.positions ?? []).filter((position) => !targets.has(Number(position.market_id)));
    }
    applyOrderBuckets(rawOrders, snapshot) {
        const ordersObject = isPlainObject(rawOrders) ? rawOrders : {};
        const marketKeys = Object.keys(ordersObject);
        if (snapshot && marketKeys.length === 0) {
            this.orderMap.clear();
            this.orders = [];
            this.emitOrders();
            return;
        }
        if (snapshot) {
            this.orderMap.clear();
        }
        for (const [market, bucket] of Object.entries(ordersObject)) {
            const marketId = Number(market);
            const normalized = this.normalizeOrders(bucket);
            if (Number.isFinite(marketId)) {
                this.clearOrdersForMarket(marketId);
            }
            if (!normalized.length)
                continue;
            for (const order of normalized) {
                this.applyOrderUpdate(order);
            }
        }
        this.orders = Array.from(this.orderMap.values());
        this.emitOrders();
    }
    normalizeOrders(source) {
        if (!source)
            return [];
        if (Array.isArray(source)) {
            return source.filter((entry) => this.isOrder(entry));
        }
        if (isPlainObject(source) && this.isOrder(source)) {
            return [source];
        }
        return [];
    }
    isOrder(value) {
        return typeof value === "object" && value != null;
    }
    applyOrderList(rawOrders, marketId, snapshot) {
        const orders = this.normalizeOrders(rawOrders);
        if (snapshot) {
            if (marketId != null) {
                this.clearOrdersForMarket(marketId);
            }
            else {
                this.orderMap.clear();
            }
        }
        for (const order of orders) {
            this.applyOrderUpdate(order);
        }
        this.orders = Array.from(this.orderMap.values());
        this.emitOrders();
    }
    applyOrderUpdate(order) {
        const key = String(order.order_index ?? order.order_id ?? order.client_order_index ?? "");
        if (!key)
            return;
        const status = (order.status ?? "").toLowerCase();
        if (TERMINAL_ORDER_STATUSES.has(status)) {
            this.orderMap.delete(key);
            return;
        }
        if (order.client_order_index != null || order.order_index != null) {
            for (const [existingKey, existingOrder] of Array.from(this.orderMap.entries())) {
                if (existingKey === key)
                    continue;
                const sameOrderIndex = order.order_index != null &&
                    existingOrder.order_index != null &&
                    Number(existingOrder.order_index) === Number(order.order_index);
                const sameClientIndex = order.client_order_index != null &&
                    existingOrder.client_order_index != null &&
                    Number(existingOrder.client_order_index) === Number(order.client_order_index);
                if (sameOrderIndex || sameClientIndex) {
                    this.orderMap.delete(existingKey);
                }
            }
        }
        this.orderMap.set(key, order);
    }
    clearOrdersForMarket(marketId) {
        const normalized = Number(marketId);
        if (!Number.isFinite(normalized))
            return;
        for (const [key, existing] of Array.from(this.orderMap.entries())) {
            if (Number(existing.market_index) === normalized) {
                this.orderMap.delete(key);
            }
        }
    }
    extractMarketIdFromChannel(channel) {
        if (typeof channel !== "string")
            return null;
        const match = channel.match(/account_market:(\d+)/);
        if (match && match[1]) {
            const value = Number(match[1]);
            return Number.isFinite(value) ? value : null;
        }
        return null;
    }
    isEmptyPositionsPayload(value) {
        if (value == null)
            return true;
        if (Array.isArray(value))
            return value.length === 0;
        if (isPlainObject(value))
            return Object.keys(value).length === 0;
        return false;
    }
    emitDepth() {
        if (!this.orderBook || this.marketId == null)
            return;
        const depth = toDepth(this.displaySymbol, this.orderBook);
        this.depthEvent.emit(depth);
        this.emitSyntheticTicker();
    }
    emitAccount() {
        if (!this.accountDetails)
            return;
        const snapshot = toAccountSnapshot(this.displaySymbol, this.accountDetails, this.positions, [], { marketSymbol: this.marketSymbol, marketId: this.marketId });
        this.accountEvent.emit(snapshot);
    }
    emitOrders() {
        const mapped = toOrders(this.displaySymbol, this.orders ?? []);
        this.ordersEvent.emit(mapped);
    }
    startPolling() {
        if (!this.pollers.ticker) {
            this.pollers.ticker = setInterval(() => {
                this.refreshTicker().catch((error) => this.logger("ticker", error));
            }, this.tickerPollMs);
            void this.refreshTicker();
        }
        if (!this.accountPoller) {
            const pollAccount = () => {
                if (this.accountPollInFlight)
                    return;
                this.accountPollInFlight = true;
                this.refreshAccountSnapshot()
                    .catch((error) => this.logger("accountPoll", error))
                    .finally(() => {
                    this.accountPollInFlight = false;
                });
            };
            this.accountPoller = setInterval(pollAccount, ACCOUNT_POLL_INTERVAL_MS);
            pollAccount();
        }
    }
    async refreshTicker() {
        try {
            const stats = await this.http.getExchangeStats();
            const marketId = this.marketId;
            if (marketId == null)
                return;
            const match = stats.find((entry) => Number(entry.market_id) === marketId || (entry.symbol ? entry.symbol.toUpperCase() : "") === this.marketSymbol);
            if (!match)
                return;
            const ticker = toTicker(this.displaySymbol, match);
            this.tickerEvent.emit(ticker);
            this.loggedCreateOrderPayload = false;
        }
        catch (error) {
            this.logger("refreshTicker", error);
        }
    }
    watchKlines(interval, handler) {
        this.klinesEvent.add(handler);
        const cached = this.klineCache.get(interval);
        if (cached) {
            handler(cloneKlines(cached));
        }
        const existing = this.pollers.klines.get(interval);
        if (!existing) {
            const poll = () => {
                void this.refreshKlines(interval).catch((error) => this.logger("klines", error));
            };
            const timer = setInterval(poll, this.klinePollMs);
            this.pollers.klines.set(interval, timer);
            poll();
        }
    }
    async refreshKlines(interval) {
        await this.ensureInitialized();
        const marketId = this.marketId;
        if (marketId == null)
            return;
        const resolutionMs = RESOLUTION_MS[interval];
        if (!resolutionMs)
            return;
        const end = Date.now();
        const count = Math.max(KLINE_DEFAULT_COUNT, 200);
        const start = end - resolutionMs * count;
        const startTs = Math.max(0, Math.floor(start));
        const endTs = Math.max(startTs + resolutionMs, Math.floor(end));
        const raw = await this.http.getCandlesticks({
            marketId,
            resolution: interval,
            countBack: count,
            endTimestamp: endTs,
            startTimestamp: startTs,
            setTimestampToEnd: true,
        });
        const sorted = raw.slice().sort((a, b) => a.start_timestamp - b.start_timestamp);
        const mapped = toKlines(this.displaySymbol, interval, sorted);
        this.klineCache.set(interval, mapped);
        this.klinesEvent.emit(cloneKlines(mapped));
        this.emitSyntheticTicker();
    }
    emitSyntheticTicker() {
        if (!this.orderBook)
            return;
        const bestBid = getBestPrice(this.orderBook.bids, "bid");
        const bestAsk = getBestPrice(this.orderBook.asks, "ask");
        if (bestBid == null && bestAsk == null)
            return;
        const last = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk ?? 0);
        const ticker = {
            symbol: this.displaySymbol,
            eventType: "lighterSyntheticTicker",
            eventTime: Date.now(),
            lastPrice: last.toString(),
            openPrice: (bestBid ?? last).toString(),
            highPrice: (bestAsk ?? last).toString(),
            lowPrice: (bestBid ?? last).toString(),
            volume: "0",
            quoteVolume: "0",
            priceChange: undefined,
            priceChangePercent: undefined,
            weightedAvgPrice: undefined,
            lastQty: undefined,
            openTime: Date.now(),
            closeTime: Date.now(),
            firstId: undefined,
            lastId: undefined,
            count: undefined,
        };
        this.tickerEvent.emit(ticker);
    }
    async getPrecision() {
        await this.loadMetadata();
        if (this.priceDecimals == null || this.sizeDecimals == null) {
            throw new Error("Lighter market metadata not initialized");
        }
        const priceTick = decimalsToStep(this.priceDecimals);
        const qtyStep = decimalsToStep(this.sizeDecimals);
        return {
            priceTick,
            qtyStep,
            priceDecimals: this.priceDecimals,
            sizeDecimals: this.sizeDecimals,
            marketId: this.marketId ?? null,
        };
    }
    mapCreateOrderParams(params) {
        if (this.marketId == null || this.priceDecimals == null || this.sizeDecimals == null) {
            throw new Error("Lighter market metadata not initialized");
        }
        if (params.quantity == null || !Number.isFinite(params.quantity)) {
            throw new Error("Lighter orders require quantity");
        }
        const side = params.side;
        const isAsk = side === "SELL" ? 1 : 0;
        const baseAmount = scaleQuantityWithMinimum(params.quantity, this.sizeDecimals);
        const baseAmountScaledString = scaledToDecimalString(baseAmount, this.sizeDecimals);
        const clientOrderIndex = BigInt(Date.now() % Number.MAX_SAFE_INTEGER);
        let priceScaled = params.price != null ? decimalToScaled(params.price, this.priceDecimals) : null;
        if ((params.type === "MARKET" || params.type === "STOP_MARKET") && priceScaled == null) {
            priceScaled = decimalToScaled(this.estimateMarketPrice(side), this.priceDecimals);
        }
        if (priceScaled == null) {
            throw new Error("Lighter order requires price");
        }
        const reduceOnly = params.reduceOnly === "true" || params.closePosition === "true" ? 1 : 0;
        const resultType = mapOrderType(params.type ?? "LIMIT");
        const resultTimeInForce = mapTimeInForce(params.timeInForce, params.type ?? "LIMIT");
        let triggerPriceScaled = 0n;
        if (params.stopPrice != null) {
            triggerPriceScaled = decimalToScaled(params.stopPrice, this.priceDecimals);
        }
        // Align with chain expectations:
        // - Pure MARKET orders use immediate expiry (0)
        // - STOP orders rest until trigger, so they require an absolute future expiry
        // - All other orders use absolute future timestamp (ms) for ~28 days
        const TWENTY_EIGHT_DAYS_MS = 28 * 24 * 60 * 60 * 1000;
        const isImmediate = resultType === LIGHTER_ORDER_TYPE.MARKET;
        const orderExpiry = isImmediate
            ? BigInt(IMMEDIATE_OR_CANCEL_EXPIRY_PLACEHOLDER)
            : BigInt(Date.now() + TWENTY_EIGHT_DAYS_MS);
        return {
            marketIndex: this.marketId,
            clientOrderIndex,
            baseAmount,
            baseAmountScaledString,
            price: Number(priceScaled),
            priceScaledString: scaledToDecimalString(priceScaled, this.priceDecimals),
            isAsk,
            orderType: resultType,
            timeInForce: resultTimeInForce,
            reduceOnly,
            triggerPrice: Number(triggerPriceScaled),
            triggerPriceScaledString: scaledToDecimalString(triggerPriceScaled, this.priceDecimals),
            orderExpiry,
            expiredAt: BigInt(Date.now() + 10 * 60 * 1000),
        };
    }
    estimateMarketPrice(side) {
        if (this.orderBook) {
            const levels = side === "SELL" ? this.orderBook.bids : this.orderBook.asks;
            if (levels && levels.length) {
                const sorted = [...levels].sort((a, b) => {
                    const aPrice = Number(a.price);
                    const bPrice = Number(b.price);
                    return side === "SELL" ? bPrice - aPrice : aPrice - bPrice;
                });
                const level = sorted[0];
                if (level)
                    return Number(level.price);
            }
        }
        if (this.ticker) {
            return Number(this.ticker.last_trade_price);
        }
        throw new Error("Unable to determine market price for order");
    }
}
function mergeLevels(existing, updates) {
    const map = new Map();
    for (const level of existing) {
        map.set(level.price, level.size);
    }
    for (const update of updates) {
        if (Number(update.size) <= 0) {
            map.delete(update.price);
        }
        else {
            map.set(update.price, update.size);
        }
    }
    return Array.from(map.entries()).map(([price, size]) => ({ price, size }));
}
function cloneKlines(klines) {
    return klines.map((kline) => ({ ...kline }));
}
function getBestPrice(levels, side) {
    if (!levels || !levels.length)
        return null;
    const sorted = levels
        .map((level) => {
        if (Array.isArray(level))
            return Number(level[0]);
        return Number(level.price);
    })
        .filter((price) => Number.isFinite(price));
    if (!sorted.length)
        return null;
    return side === "bid" ? Math.max(...sorted) : Math.min(...sorted);
}
function normalizeLevels(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((entry) => {
        if (Array.isArray(entry)) {
            const price = String(entry[0]);
            const size = String(entry[1]);
            return { price, size };
        }
        const obj = entry;
        return { price: String(obj.price), size: String(obj.size) };
    })
        .filter((lvl) => lvl.price != null && lvl.size != null);
}
// Ensure correct side ordering and limit depth size
function sortAndTrimLevels(levels, side, limit = 200) {
    const list = Array.isArray(levels) ? levels.slice() : [];
    list.sort((a, b) => {
        const pa = Number(a.price);
        const pb = Number(b.price);
        if (!Number.isFinite(pa) || !Number.isFinite(pb))
            return 0;
        return side === "bid" ? pb - pa : pa - pb;
    });
    return list.slice(0, Math.max(1, limit));
}
function mapOrderType(type) {
    switch (type) {
        case "MARKET":
            return LIGHTER_ORDER_TYPE.MARKET;
        case "STOP_MARKET":
            return LIGHTER_ORDER_TYPE.STOP_LOSS;
        default:
            return LIGHTER_ORDER_TYPE.LIMIT;
    }
}
function mapTimeInForce(timeInForce, type) {
    // Lighter expects STOP orders to be immediate-or-cancel at trigger time.
    // Force IOC for MARKET and STOP_MARKET to satisfy chain validation.
    if (type === "MARKET" || type === "STOP_MARKET") {
        return LIGHTER_TIME_IN_FORCE.IMMEDIATE_OR_CANCEL;
    }
    const value = (timeInForce ?? "GTC").toUpperCase();
    switch (value) {
        case "IOC":
            return LIGHTER_TIME_IN_FORCE.IMMEDIATE_OR_CANCEL;
        case "GTX":
            return LIGHTER_TIME_IN_FORCE.POST_ONLY;
        default:
            return LIGHTER_TIME_IN_FORCE.GOOD_TILL_TIME;
    }
}
function decimalsToStep(decimals) {
    if (!Number.isFinite(decimals) || decimals <= 0) {
        return 1;
    }
    const step = Number(`1e-${decimals}`);
    return Number.isFinite(step) ? step : Math.pow(10, -decimals);
}
function isPlainObject(value) {
    return typeof value === "object" && value != null && !Array.isArray(value);
}
