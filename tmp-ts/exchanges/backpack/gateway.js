import ccxt from "ccxt";
import NodeWebSocket from "ws";
import { sign, utils as edUtils, hashes as edHashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
const WebSocketCtor = typeof globalThis.WebSocket !== "undefined"
    ? globalThis.WebSocket
    : NodeWebSocket;
// Configure ed25519 to use our sha512 implementation
edUtils.sha512 = sha512;
edHashes.sha512 = sha512;
const ORDER_STATUS_MAP = {
    NEW: "NEW",
    OPEN: "OPEN",
    FILLED: "FILLED",
    CLOSED: "FILLED",
    CANCELLED: "CANCELLED",
    CANCELED: "CANCELLED",
    EXPIRED: "EXPIRED",
    PARTIALLY_FILLED: "PARTIALLY_FILLED",
    PARTIAL: "PARTIALLY_FILLED",
    TRIGGER_PENDING: "TRIGGER_PENDING",
    TRIGGERPENDING: "TRIGGER_PENDING",
    TRIGGER_FAILED: "TRIGGER_FAILED",
    TRIGGERFAILED: "TRIGGER_FAILED",
    REJECTED: "REJECTED",
};
const TRIGGER_TOPICS = {
    orders: (marketId) => `account.orderUpdate.${marketId}`,
    positions: (marketId) => `account.positionUpdate.${marketId}`,
};
const DEFAULT_WS_WINDOW = "5000";
const WS_PING_INTERVAL = 25_000;
const WS_RECONNECT_DELAY = 2_000;
export class BackpackGateway {
    exchange;
    symbol;
    marketSymbol;
    market = null;
    isContractMarket = false;
    logger;
    initialized = false;
    initPromise = null;
    accountListeners = new Set();
    orderListeners = new Set();
    depthListeners = new Set();
    tickerListeners = new Set();
    klineListeners = new Set();
    accountPollTimer = null;
    orderPollTimer = null;
    depthPollTimer = null;
    tickerPollTimer = null;
    klinePollTimers = new Map();
    localOrders = new Map();
    lastBalanceSnapshot = null;
    marketId = "";
    ws = null;
    wsReady = false;
    wsPingTimer = null;
    wsReconnectTimer = null;
    wsTopics = new Set();
    wsConnecting = false;
    wsWindow;
    wsCleanup = null;
    apiKey;
    apiSecret;
    constructor(options) {
        this.symbol = options.symbol.toUpperCase();
        this.marketSymbol = this.symbol;
        this.logger = options.logger ?? ((context, error) => console.error(`[BackpackGateway] ${context}:`, error));
        this.apiKey = options.apiKey ?? process.env.BACKPACK_API_KEY ?? "";
        this.apiSecret = options.apiSecret ?? process.env.BACKPACK_API_SECRET ?? "";
        this.wsWindow = process.env.BACKPACK_WS_WINDOW ?? DEFAULT_WS_WINDOW;
        this.exchange = new ccxt.backpack({
            apiKey: this.apiKey,
            secret: this.apiSecret,
            password: options.password ?? process.env.BACKPACK_PASSWORD,
            subaccount: options.subaccount ?? process.env.BACKPACK_SUBACCOUNT,
            sandbox: options.sandbox ?? (process.env.BACKPACK_SANDBOX === "true"),
            enableRateLimit: true,
            timeout: 30_000,
        });
    }
    async ensureInitialized(symbol) {
        if (this.initialized)
            return;
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = this.doInitialize(symbol);
        return this.initPromise;
    }
    async doInitialize(symbol) {
        try {
            await this.exchange.loadMarkets();
            const requested = (symbol ?? this.symbol).toUpperCase();
            const market = this.findMarket(requested);
            if (!market) {
                throw new Error(`Symbol ${requested} not found in Backpack markets`);
            }
            this.market = market;
            this.marketSymbol = market.symbol;
            this.marketId = market.id;
            this.isContractMarket = Boolean(market.contract);
            if (process.env.BACKPACK_DEBUG === "1") {
                console.debug("[BackpackGateway] marketInfo", {
                    userSymbol: this.symbol,
                    ccxtSymbol: this.marketSymbol,
                    marketId: this.marketId,
                });
            }
            this.initialized = true;
        }
        catch (error) {
            throw error;
        }
    }
    findMarket(requested) {
        const normalize = (value) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const normalized = normalize(requested);
        const markets = Object.values(this.exchange.markets);
        for (const market of markets) {
            if (normalize(market.id) === normalized)
                return market;
        }
        for (const market of markets) {
            if (normalize(market.symbol) === normalized)
                return market;
        }
        for (const market of markets) {
            const combo = `${market.base ?? ""}${market.quote ?? ""}${market.contract ? "PERP" : ""}`;
            if (normalize(combo) === normalized)
                return market;
        }
        return null;
    }
    // ---- Subscription APIs -------------------------------------------------
    onAccount(callback) {
        this.accountListeners.add(callback);
        if (this.lastBalanceSnapshot) {
            try {
                callback(this.lastBalanceSnapshot);
            }
            catch (error) {
                this.logger("accountReplay", error);
            }
        }
        void this.subscribeOnce("accountSubscribe", () => this.buildPositionTopic(true));
        this.startAccountPolling();
    }
    onOrders(callback) {
        this.orderListeners.add(callback);
        if (this.localOrders.size) {
            try {
                callback(Array.from(this.localOrders.values()).map((order) => ({ ...order })));
            }
            catch (error) {
                this.logger("ordersReplay", error);
            }
        }
        void this.subscribeOnce("ordersSubscribe", () => this.buildOrderTopic(true));
        this.startOrderPolling();
    }
    onDepth(_callback) {
        this.depthListeners.add(_callback);
        this.startDepthPolling();
    }
    onTicker(_callback) {
        this.tickerListeners.add(_callback);
        this.startTickerPolling();
    }
    watchKlines(interval, callback) {
        const normalizedInterval = this.normalizeTimeframe(interval);
        this.klineListeners.add({ interval: normalizedInterval, callback });
        this.startKlinePolling(normalizedInterval);
    }
    // ---- Polling -----------------------------------------------------------
    startAccountPolling() {
        if (this.accountPollTimer)
            return;
        const poll = async () => {
            try {
                const snapshot = await this.fetchAccountSnapshot();
                this.lastBalanceSnapshot = snapshot;
                this.emitAccount(snapshot);
            }
            catch (error) {
                this.logger("accountPoll", error);
            }
        };
        void poll();
        this.accountPollTimer = setInterval(poll, 5_000);
    }
    startOrderPolling() {
        if (this.orderPollTimer)
            return;
        const poll = async () => {
            try {
                const [openOrders, allOrders] = await Promise.all([
                    this.exchange.fetchOpenOrders(this.marketSymbol),
                    this.exchange.fetchOrders(this.marketSymbol, undefined, 200, {}),
                ]);
                const active = new Map();
                for (const entry of [...openOrders, ...allOrders]) {
                    const status = this.normalizeStatus(entry.status ?? entry.info?.status);
                    if (this.isTerminalStatus(status))
                        continue;
                    const mapped = this.mapRestOrder(entry);
                    active.set(String(mapped.orderId), mapped);
                }
                this.localOrders.clear();
                for (const [id, order] of active.entries()) {
                    this.localOrders.set(id, order);
                }
                this.emitOrders();
            }
            catch (error) {
                this.logger("orderPoll", error);
            }
        };
        void poll();
        this.orderPollTimer = setInterval(poll, 3_000);
    }
    startDepthPolling() {
        if (this.depthPollTimer)
            return;
        const poll = async () => {
            try {
                const orderbook = await this.exchange.fetchOrderBook(this.marketSymbol, 20);
                const depth = this.mapOrderBookToDepth(orderbook);
                for (const listener of this.depthListeners)
                    listener(depth);
            }
            catch (error) {
                this.logger("depthPoll", error);
            }
        };
        void poll();
        this.depthPollTimer = setInterval(poll, 1_000);
    }
    startTickerPolling() {
        if (this.tickerPollTimer)
            return;
        const poll = async () => {
            try {
                const ticker = await this.exchange.fetchTicker(this.marketSymbol);
                const mapped = this.mapTickerToAsterTicker(ticker);
                for (const listener of this.tickerListeners)
                    listener(mapped);
            }
            catch (error) {
                this.logger("tickerPoll", error);
            }
        };
        void poll();
        this.tickerPollTimer = setInterval(poll, 2_000);
    }
    startKlinePolling(interval) {
        if (this.klinePollTimers.has(interval))
            return;
        const poll = async () => {
            try {
                const ohlcv = await this.exchange.fetchOHLCV(this.marketSymbol, interval, undefined, 100);
                const klines = ohlcv
                    .filter((row) => Array.isArray(row) && row.length >= 6)
                    .map((row) => this.mapOHLCVToKline(row, interval));
                for (const { interval: key, callback } of this.klineListeners) {
                    if (key === interval)
                        callback(klines);
                }
            }
            catch (error) {
                this.logger(`klinePoll:${interval}`, error);
            }
        };
        void poll();
        this.klinePollTimers.set(interval, setInterval(poll, 5_000));
    }
    // ---- Order actions -----------------------------------------------------
    async createOrder(params) {
        await this.ensureInitialized();
        const symbol = this.marketSymbol;
        const normalizedType = this.normalizeOrderType(params.type);
        const side = params.side.toLowerCase();
        const amount = params.quantity;
        let price = params.price;
        const extraParams = {};
        if (params.timeInForce === "GTX") {
            extraParams.postOnly = true;
            extraParams.timeInForce = "GTC";
        }
        else if (params.timeInForce) {
            extraParams.timeInForce = params.timeInForce;
        }
        if (params.reduceOnly !== undefined) {
            extraParams.reduceOnly = params.reduceOnly === "true";
        }
        let ccxtType;
        if (normalizedType === "STOP_MARKET") {
            ccxtType = "market";
            price = undefined;
            if (params.stopPrice !== undefined) {
                extraParams.triggerPrice = params.stopPrice;
                if (extraParams.triggerBy === undefined) {
                    extraParams.triggerBy = "MarkPrice";
                }
            }
        }
        else if (normalizedType === "MARKET") {
            ccxtType = "market";
            price = undefined;
        }
        else {
            ccxtType = "limit";
        }
        if (params.stopPrice !== undefined && normalizedType !== "STOP_MARKET") {
            extraParams.stopPrice = params.stopPrice;
        }
        const order = await this.exchange.createOrder(symbol, ccxtType, side, amount, price, extraParams);
        const mapped = this.mapRestOrder(order);
        this.localOrders.set(String(mapped.orderId), mapped);
        this.emitOrders();
        return mapped;
    }
    async cancelOrder(params) {
        await this.exchange.cancelOrder(params.orderId.toString(), this.marketSymbol);
        this.localOrders.delete(String(params.orderId));
        this.emitOrders();
    }
    async cancelOrders(params) {
        await Promise.all(params.orderIdList.map((orderId) => this.exchange.cancelOrder(String(orderId), this.marketSymbol)));
        for (const orderId of params.orderIdList) {
            this.localOrders.delete(String(orderId));
        }
        this.emitOrders();
    }
    async cancelAllOrders() {
        try {
            if (typeof this.exchange.cancelAllOrders === "function") {
                await this.exchange.cancelAllOrders(this.marketSymbol);
                this.localOrders.clear();
                this.emitOrders();
                return;
            }
        }
        catch {
            // fall through to manual cancel
        }
        const open = await this.exchange.fetchOpenOrders(this.marketSymbol);
        for (const order of open) {
            await this.exchange.cancelOrder(order.id, this.marketSymbol);
            this.localOrders.delete(String(order.id));
        }
        this.emitOrders();
    }
    // ---- Mapping helpers ---------------------------------------------------
    mapBalanceToAccountSnapshot(balance) {
        return this.mapBalanceToAccountSnapshotWithPositions(balance, []);
    }
    async fetchAccountSnapshot() {
        await this.ensureInitialized();
        const [balance, positions] = await Promise.all([
            this.exchange.fetchBalance(),
            this.isContractMarket
                ? this.exchange.fetchPositions([this.marketSymbol]).catch((error) => {
                    this.logger("fetchPositions", error);
                    return [];
                })
                : Promise.resolve([]),
        ]);
        return this.mapBalanceToAccountSnapshotWithPositions(balance, positions ?? []);
    }
    mapBalanceToAccountSnapshotWithPositions(balance, rawPositions) {
        const now = Date.now();
        const assets = this.normalizeAssets(balance, now);
        const positions = this.normalizePositions(rawPositions, now);
        const totalWalletBalance = this.sumStrings(assets.map((asset) => asset.walletBalance));
        const totalUnrealized = this.sumStrings(positions.map((position) => position.unrealizedProfit ?? "0"));
        const availableBalance = this.sumStrings(assets.map((asset) => asset.availableBalance));
        const snapshot = {
            canTrade: true,
            canDeposit: true,
            canWithdraw: true,
            updateTime: now,
            totalWalletBalance,
            totalUnrealizedProfit: totalUnrealized,
            positions,
            assets,
            availableBalance,
            maxWithdrawAmount: availableBalance,
        };
        if (this.isContractMarket) {
            const totalMarginBalance = this.addStrings(totalWalletBalance, totalUnrealized);
            snapshot.totalMarginBalance = totalMarginBalance;
            snapshot.totalCrossWalletBalance = totalWalletBalance;
            snapshot.totalCrossUnPnl = totalUnrealized;
        }
        return snapshot;
    }
    normalizeAssets(balance, now) {
        const metaKeys = new Set(["free", "used", "total", "info", "timestamp", "datetime", "debt"]);
        const assets = [];
        for (const [currency, value] of Object.entries(balance)) {
            if (metaKeys.has(currency))
                continue;
            if (!value || typeof value !== "object")
                continue;
            const walletBalance = this.toStringAmount(value.total ?? value.free ?? "0");
            const availableBalance = this.toStringAmount(value.free ?? "0");
            assets.push({ asset: currency, walletBalance, availableBalance, updateTime: now });
        }
        return assets;
    }
    normalizePositions(rawPositions, now) {
        if (!Array.isArray(rawPositions))
            return [];
        const positions = [];
        for (const raw of rawPositions) {
            const info = raw?.info ?? raw ?? {};
            const quantity = this.toNumber(raw?.contracts ?? info.netExposureQuantity ?? info.netQuantity);
            if (!quantity)
                continue;
            const sideRaw = String(raw?.side ?? info.side ?? this.deriveSideFromExposure(info)).toLowerCase();
            const isShort = sideRaw.includes("short") || quantity < 0;
            const positionAmt = isShort ? -Math.abs(quantity) : Math.abs(quantity);
            const entryPrice = this.toStringAmount(raw?.entryPrice ?? info.entryPrice ?? "0");
            const unrealized = this.toStringAmount(raw?.unrealizedPnl ?? info.pnlUnrealized ?? "0");
            const markPrice = this.toOptionalString(raw?.markPrice ?? info.markPrice);
            const liquidationPrice = this.toOptionalString(raw?.liquidationPrice ?? info.estLiquidationPrice);
            const leverage = this.toOptionalString(raw?.leverage ?? info.leverage);
            positions.push({
                symbol: this.symbol,
                positionAmt: positionAmt.toString(),
                entryPrice,
                unrealizedProfit: unrealized,
                positionSide: "BOTH",
                updateTime: now,
                markPrice,
                liquidationPrice,
                leverage,
                marginType: "CROSSED",
            });
        }
        return positions;
    }
    mapOrderBookToDepth(orderbook) {
        return {
            lastUpdateId: orderbook.nonce || Date.now(),
            bids: (orderbook.bids ?? [])
                .filter((row) => row && row.length >= 2)
                .map(([price, amount]) => [String(price ?? 0), String(amount ?? 0)]),
            asks: (orderbook.asks ?? [])
                .filter((row) => row && row.length >= 2)
                .map(([price, amount]) => [String(price ?? 0), String(amount ?? 0)]),
            eventTime: orderbook.timestamp,
        };
    }
    mapTickerToAsterTicker(ticker) {
        return {
            symbol: ticker.symbol,
            lastPrice: ticker.last?.toString() ?? "0",
            openPrice: ticker.open?.toString() ?? "0",
            highPrice: ticker.high?.toString() ?? "0",
            lowPrice: ticker.low?.toString() ?? "0",
            volume: ticker.baseVolume?.toString() ?? "0",
            quoteVolume: ticker.quoteVolume?.toString() ?? "0",
            eventTime: ticker.timestamp,
        };
    }
    mapOHLCVToKline(candle, interval) {
        const [openTime, open, high, low, close, volume] = candle;
        return {
            openTime,
            closeTime: openTime + this.intervalToMs(interval),
            open: open.toString(),
            high: high.toString(),
            low: low.toString(),
            close: close.toString(),
            volume: volume.toString(),
            numberOfTrades: 0,
        };
    }
    mapRestOrder(order) {
        const info = (order.info ?? {});
        const side = (order.side ?? "buy").toUpperCase();
        let type = this.normalizeOrderType(order.type ?? info.o);
        if (order.triggerPrice != null ||
            info.triggerPrice != null ||
            info.stopLossTriggerPrice != null ||
            info.Y != null ||
            info.y != null) {
            type = "STOP_MARKET";
        }
        const status = this.normalizeStatus(order.status ?? info.status);
        const price = this.pickString([order.price, info.price, info.p]);
        const quantity = this.pickString([order.amount, info.quantity, info.triggerQuantity, info.q, info.Y]);
        const executed = this.pickString([order.filled, info.executedQuantity, info.executedBaseQuantity, info.z]);
        const stopPrice = this.pickString([order.stopPrice, info.triggerPrice, info.stopLossTriggerPrice, info.P]);
        const avgPrice = this.pickString([order.average, info.avgPrice, info.L]);
        const cumQuote = this.pickString([order.cost, info.executedQuoteQuantity, info.Z]);
        const timestamp = order.timestamp ?? Date.now();
        const reduceOnly = Boolean(order.reduceOnly ?? info.reduceOnly ?? info.r ?? false);
        return {
            orderId: String(order.id ?? ""),
            clientOrderId: order.clientOrderId || "",
            symbol: this.symbol,
            side,
            type,
            status,
            price,
            origQty: quantity,
            executedQty: executed,
            stopPrice,
            time: timestamp,
            updateTime: order.lastUpdateTimestamp ?? timestamp,
            reduceOnly,
            closePosition: false,
            avgPrice,
            cumQuote,
        };
    }
    mapWsOrder(data) {
        const sideRaw = String(data.S ?? "").toUpperCase();
        const side = sideRaw === "BID" ? "BUY" : "SELL";
        const triggerPresent = data.P != null || data.B != null;
        const type = (triggerPresent ? "STOP_MARKET" : String(data.o ?? "LIMIT").toUpperCase());
        const status = this.normalizeStatus(data.X);
        const price = this.pickString([data.p, data.P, "0"]);
        const quantity = this.pickString([data.q, data.Y]);
        const executed = this.pickString([data.z, data.l, data.Z]);
        const stopPrice = this.pickString([data.P]);
        const timestampMicro = Number(data.E ?? data.T ?? Date.now() * 1000);
        const timestamp = Number.isFinite(timestampMicro) ? Math.floor(timestampMicro / 1000) : Date.now();
        const reduceOnly = Boolean(data.r);
        const avgPrice = this.pickString([data.L]);
        const cumQuote = this.pickString([data.Z]);
        return {
            orderId: String(data.i ?? ""),
            clientOrderId: data.c ? String(data.c) : "",
            symbol: this.symbol,
            side,
            type,
            status,
            price,
            origQty: quantity,
            executedQty: executed,
            stopPrice,
            time: timestamp,
            updateTime: timestamp,
            reduceOnly,
            closePosition: false,
            avgPrice,
            cumQuote,
        };
    }
    emitOrders() {
        const snapshot = Array.from(this.localOrders.values()).map((order) => ({ ...order }));
        for (const listener of this.orderListeners) {
            try {
                listener(snapshot);
            }
            catch (error) {
                this.logger("emitOrders", error);
            }
        }
    }
    mapWsPosition(data) {
        const quantityRaw = data.q ?? data.Q;
        const qty = Number(this.toStringAmount(quantityRaw));
        if (!Number.isFinite(qty))
            return null;
        const entryPrice = this.toStringAmount(data.B ?? data.entryPrice ?? "0");
        const unrealized = this.toStringAmount(data.P ?? "0");
        const markPrice = this.toOptionalString(data.M ?? data.markPrice);
        const leverage = this.toOptionalString(data.f ?? data.leverage);
        const updateTime = Number(data.E ?? data.T ?? Date.now());
        const isShort = qty < 0;
        const positionAmt = isShort ? (-Math.abs(qty)).toString() : Math.abs(qty).toString();
        return {
            symbol: this.symbol,
            positionAmt,
            entryPrice,
            unrealizedProfit: unrealized,
            positionSide: "BOTH",
            updateTime: Number.isFinite(updateTime) ? Math.floor(updateTime / 1000) : Date.now(),
            markPrice,
            leverage,
            marginType: "CROSSED",
        };
    }
    mergeWsPosition(position) {
        const snapshot = this.lastBalanceSnapshot
            ? {
                ...this.lastBalanceSnapshot,
                positions: this.lastBalanceSnapshot.positions ? [...this.lastBalanceSnapshot.positions] : [],
            }
            : {
                canTrade: true,
                canDeposit: true,
                canWithdraw: true,
                updateTime: Date.now(),
                totalWalletBalance: "0",
                totalUnrealizedProfit: "0",
                positions: [],
                assets: [],
                availableBalance: "0",
                maxWithdrawAmount: "0",
            };
        const positions = snapshot.positions ?? [];
        const idx = positions.findIndex((p) => p.symbol === position.symbol);
        if (this.isNearlyZero(position.positionAmt)) {
            if (idx >= 0)
                positions.splice(idx, 1);
        }
        else if (idx >= 0) {
            positions[idx] = position;
        }
        else {
            positions.push(position);
        }
        snapshot.positions = positions;
        snapshot.totalUnrealizedProfit = this.sumStrings(positions.map((p) => p.unrealizedProfit ?? "0"));
        snapshot.updateTime = Date.now();
        this.lastBalanceSnapshot = snapshot;
        if (process.env.BACKPACK_DEBUG === "1") {
            console.debug("[BackpackGateway] positions", snapshot.positions);
        }
        this.emitAccount(snapshot);
    }
    emitAccount(snapshot) {
        for (const listener of this.accountListeners) {
            try {
                listener(snapshot);
            }
            catch (error) {
                this.logger("emitAccount", error);
            }
        }
    }
    // ---- WebSocket ---------------------------------------------------------
    ensurePrivateSocket() {
        if (!this.apiKey || !this.apiSecret)
            return;
        if (!this.marketId)
            return;
        if (this.ws && (this.ws.readyState === WebSocketCtor.OPEN || this.ws.readyState === WebSocketCtor.CONNECTING)) {
            return;
        }
        if (this.wsConnecting)
            return;
        this.connectPrivateSocket();
    }
    connectPrivateSocket() {
        this.wsConnecting = true;
        this.detachWebSocket();
        const socket = new WebSocketCtor("wss://ws.backpack.exchange");
        this.ws = socket;
        if ("addEventListener" in socket && typeof socket.addEventListener === "function") {
            socket.addEventListener("open", this.handleWsOpen);
            socket.addEventListener("close", this.handleWsClose);
            socket.addEventListener("error", this.handleWsError);
            socket.addEventListener("message", this.handleWsMessage);
            this.wsCleanup = () => {
                socket.removeEventListener("open", this.handleWsOpen);
                socket.removeEventListener("close", this.handleWsClose);
                socket.removeEventListener("error", this.handleWsError);
                socket.removeEventListener("message", this.handleWsMessage);
            };
        }
        else if ("on" in socket && typeof socket.on === "function") {
            const nodeSocket = socket;
            const off = typeof nodeSocket.off === "function"
                ? (event, handler) => nodeSocket.off(event, handler)
                : (event, handler) => nodeSocket.removeListener(event, handler);
            const wrappedMessage = (data) => this.handleWsMessage({ data });
            nodeSocket.on("open", this.handleWsOpen);
            nodeSocket.on("close", this.handleWsClose);
            nodeSocket.on("error", this.handleWsError);
            nodeSocket.on("message", wrappedMessage);
            this.wsCleanup = () => {
                off("open", this.handleWsOpen);
                off("close", this.handleWsClose);
                off("error", this.handleWsError);
                off("message", wrappedMessage);
            };
        }
        else {
            socket.onopen = this.handleWsOpen;
            socket.onclose = this.handleWsClose;
            socket.onerror = this.handleWsError;
            socket.onmessage = this.handleWsMessage;
            this.wsCleanup = () => {
                socket.onopen = null;
                socket.onclose = null;
                socket.onerror = null;
                socket.onmessage = null;
            };
        }
    }
    handleWsOpen = () => {
        this.wsConnecting = false;
        this.wsReady = true;
        this.startPing();
        void this.resubscribeAllTopics();
    };
    handleWsClose = (event) => {
        if (this.wsCleanup) {
            try {
                this.wsCleanup();
            }
            catch {
                /* ignore */
            }
            this.wsCleanup = null;
        }
        this.wsConnecting = false;
        this.wsReady = false;
        this.ws = null;
        this.stopPing();
        this.scheduleReconnect();
    };
    handleWsError = (_event) => {
        /* swallow non-fatal errors; reconnect handled by close */
    };
    handleWsMessage = (event) => {
        try {
            const payload = event?.data ?? event;
            const raw = typeof payload === "string"
                ? payload
                : Buffer.isBuffer(payload)
                    ? payload.toString("utf8")
                    : payload?.toString?.() ?? "";
            if (!raw)
                return;
            const message = JSON.parse(raw);
            const stream = String(message.stream ?? "");
            const data = message.data;
            if (process.env.BACKPACK_DEBUG === "1") {
                console.debug("[BackpackGateway] wsMessage", {
                    stream,
                    data,
                    result: message.result,
                    symbol: this.symbol,
                    marketId: this.marketId,
                });
            }
            if (!data)
                return;
            if (stream.startsWith("account.orderUpdate")) {
                this.handleWsOrder(data);
            }
            else if (stream.startsWith("account.positionUpdate")) {
                this.handleWsPosition(data);
            }
            else if (stream === "ping") {
                this.sendPong();
            }
        }
        catch (error) {
            this.logger("wsMessageParse", error);
        }
    };
    handleWsOrder(data) {
        const mapped = this.mapWsOrder(data);
        if (process.env.BACKPACK_DEBUG === "1") {
            console.debug("[BackpackGateway] wsOrder", mapped);
        }
        const status = mapped.status;
        const id = mapped.orderId;
        if (this.isTerminalStatus(status)) {
            if (this.localOrders.delete(String(id))) {
                this.emitOrders();
            }
            return;
        }
        this.localOrders.set(String(id), mapped);
        this.emitOrders();
    }
    handleWsPosition(data) {
        if (data) {
            const mapped = this.mapWsPosition(data);
            if (mapped) {
                this.mergeWsPosition(mapped);
                return;
            }
        }
        void this.refreshAccountSnapshot();
    }
    async refreshAccountSnapshot() {
        try {
            const snapshot = await this.fetchAccountSnapshot();
            this.lastBalanceSnapshot = snapshot;
            this.emitAccount(snapshot);
        }
        catch (error) {
            this.logger("refreshAccountSnapshot", error);
        }
    }
    async resubscribeAllTopics() {
        if (!this.ws || this.ws.readyState !== WebSocketCtor.OPEN)
            return;
        if (!this.wsTopics.size)
            return;
        for (const topic of this.wsTopics) {
            await this.sendWsSubscription([topic], "SUBSCRIBE");
        }
    }
    subscribePrivateTopic(topic) {
        if (!topic || !this.apiKey || !this.apiSecret)
            return;
        if (this.wsTopics.has(topic))
            return;
        this.wsTopics.add(topic);
        if (this.wsReady && this.ws && this.ws.readyState === WebSocketCtor.OPEN) {
            void this.sendWsSubscription([topic], "SUBSCRIBE");
        }
    }
    async sendWsSubscription(topics, method) {
        if (!this.ws || this.ws.readyState !== WebSocketCtor.OPEN)
            return;
        if (!topics.length)
            return;
        try {
            const timestamp = Date.now().toString();
            const payload = `instruction=${method.toLowerCase()}&timestamp=${timestamp}&window=${this.wsWindow}`;
            const signature = await this.createSignature(payload);
            const message = {
                method,
                params: topics,
                signature: [this.apiKey, signature, timestamp, this.wsWindow],
            };
            if (process.env.BACKPACK_DEBUG === "1") {
                this.logger("wsSubscribe", message);
            }
            this.ws.send(JSON.stringify(message));
        }
        catch (error) {
            this.logger("wsSubscribe", error);
        }
    }
    async subscribeOnce(context, topicFactory) {
        try {
            await this.ensureInitialized();
            if (!this.apiKey || !this.apiSecret)
                return;
            this.ensurePrivateSocket();
            const baseTopic = topicFactory();
            const idTopic = baseTopic === "account.orderUpdate" ? this.buildOrderTopic() : this.buildPositionTopic();
            this.subscribePrivateTopic(baseTopic);
            this.subscribePrivateTopic(idTopic);
        }
        catch (error) {
            this.logger(context, error);
        }
    }
    startPing() {
        this.stopPing();
        if (!this.ws || typeof this.ws.send !== "function")
            return;
        this.wsPingTimer = setInterval(() => {
            try {
                if (this.ws && this.ws.readyState === WebSocketCtor.OPEN) {
                    this.ws.send(JSON.stringify({ method: "PING" }));
                }
            }
            catch (error) {
                this.logger("wsPing", error);
            }
        }, WS_PING_INTERVAL);
    }
    stopPing() {
        if (this.wsPingTimer) {
            clearInterval(this.wsPingTimer);
            this.wsPingTimer = null;
        }
    }
    sendPong() {
        try {
            if (this.ws && this.ws.readyState === WebSocketCtor.OPEN) {
                this.ws.send(JSON.stringify({ method: "PONG" }));
            }
        }
        catch (error) {
            this.logger("wsPong", error);
        }
    }
    scheduleReconnect() {
        if (this.wsReconnectTimer)
            return;
        this.wsReconnectTimer = setTimeout(() => {
            this.wsReconnectTimer = null;
            this.ensurePrivateSocket();
        }, WS_RECONNECT_DELAY);
    }
    detachWebSocket() {
        if (this.wsCleanup) {
            try {
                this.wsCleanup();
            }
            catch {
                /* ignore */
            }
            this.wsCleanup = null;
        }
        if (this.ws) {
            try {
                this.ws.close();
            }
            catch {
                /* ignore */
            }
        }
    }
    buildOrderTopic(symbolOnly = false) {
        const id = this.marketId || this.symbol.replace(/[^A-Z0-9_]/g, "_");
        return symbolOnly ? "account.orderUpdate" : TRIGGER_TOPICS.orders(id);
    }
    buildPositionTopic(symbolOnly = false) {
        const id = this.marketId || this.symbol.replace(/[^A-Z0-9_]/g, "_");
        return symbolOnly ? "account.positionUpdate" : TRIGGER_TOPICS.positions(id);
    }
    async createSignature(payload) {
        if (!this.apiSecret) {
            throw new Error("Backpack API secret is required for websocket authentication");
        }
        let secretBytes;
        try {
            secretBytes = Buffer.from(this.apiSecret, "base64");
        }
        catch {
            secretBytes = Buffer.alloc(0);
        }
        if (!secretBytes.length) {
            throw new Error("Backpack API secret must be base64 encoded 32-byte key");
        }
        if (secretBytes.length < 32) {
            throw new Error("Backpack API secret must be base64 encoded 32-byte key");
        }
        const seed = secretBytes.length === 32 ? secretBytes : secretBytes.subarray(0, 32);
        const signature = await sign(new TextEncoder().encode(payload), seed);
        return Buffer.from(signature).toString("base64");
    }
    // ---- Utility methods ---------------------------------------------------
    normalizeTimeframe(interval) {
        const map = {
            "1m": "1m",
            "5m": "5m",
            "15m": "15m",
            "1h": "1h",
            "4h": "4h",
            "1d": "1d",
        };
        return map[interval] ?? "1m";
    }
    intervalToMs(interval) {
        const map = {
            "1m": 60_000,
            "5m": 300_000,
            "15m": 900_000,
            "1h": 3_600_000,
            "4h": 14_400_000,
            "1d": 86_400_000,
        };
        return map[interval] ?? 60_000;
    }
    deriveSideFromExposure(info) {
        const exposure = this.toNumber(info.netExposureNotional ?? info.netCost ?? info.netQuantity);
        if (!exposure)
            return "flat";
        return exposure < 0 ? "short" : "long";
    }
    toStringAmount(value) {
        if (value === undefined || value === null)
            return "0";
        if (typeof value === "string") {
            return value.trim() === "" ? "0" : value;
        }
        if (typeof value === "number") {
            return Number.isFinite(value) ? value.toString() : "0";
        }
        return "0";
    }
    toOptionalString(value) {
        const result = this.toStringAmount(value);
        return result === "0" ? undefined : result;
    }
    toNumber(value) {
        const parsed = Number(this.toStringAmount(value));
        return Number.isFinite(parsed) ? parsed : 0;
    }
    isNearlyZero(value, epsilon = 1e-9) {
        return Math.abs(Number(value)) < epsilon;
    }
    sumStrings(values) {
        let total = 0;
        for (const value of values) {
            const parsed = Number(value);
            if (Number.isFinite(parsed))
                total += parsed;
        }
        return total.toString();
    }
    addStrings(a, b) {
        const sum = Number(a) + Number(b);
        return Number.isFinite(sum) ? sum.toString() : "0";
    }
    normalizeStatus(status) {
        if (!status)
            return "UNKNOWN";
        const key = status.replace(/[^a-zA-Z]/g, "").toUpperCase();
        return (ORDER_STATUS_MAP[key] ??
            status
                .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
                .replace(/\s+/g, "_")
                .toUpperCase());
    }
    isTerminalStatus(status) {
        if (!status)
            return false;
        const normalized = status.toUpperCase();
        return normalized === "FILLED" || normalized === "CANCELLED" || normalized === "EXPIRED" || normalized === "REJECTED" || normalized === "TRIGGER_FAILED";
    }
    normalizeOrderType(type) {
        if (!type)
            return "LIMIT";
        const upper = type.toUpperCase();
        if (upper.includes("STOP"))
            return "STOP_MARKET";
        if (upper === "MARKET" || upper === "LIMIT")
            return upper;
        return upper;
    }
    pickString(values) {
        for (const value of values) {
            if (value === undefined || value === null)
                continue;
            const asString = this.toStringAmount(value);
            if (asString !== "0" || Number(value) === 0)
                return asString;
        }
        return "0";
    }
}
