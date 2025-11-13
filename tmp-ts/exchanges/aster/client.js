import crypto from "crypto";
import { setInterval, clearInterval, setTimeout, clearTimeout } from "timers";
import { decimalsOf } from "../../utils/math";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const FUTURES_REST_BASE = "https://fapi.asterdex.com";
const SPOT_REST_BASE = "https://sapi.asterdex.com";
const WS_PUBLIC_URL = "wss://fstream.asterdex.com/ws";
const WS_LISTEN_KEY_URL = "wss://fstream.asterdex.com/ws/";
const FINAL_ORDER_STATUSES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);
const DEFAULT_DEPTH_LEVEL = 20;
const DEFAULT_DEPTH_SPEED = "100ms";
const DEFAULT_KLINE_LIMIT = 120;
const KLINE_REFRESH_INTERVAL_MS = 60_000;
const LISTEN_KEY_KEEPALIVE_MS = 30 * 60 * 1000;
const RECONNECT_DELAY_MS = 2000;
const POSITION_SYNC_INTERVAL_MS = 5000;
const EXCHANGE_INFO_CACHE_TTL_MS = 60 * 60 * 1000;
function requireEnv(value, key) {
    if (!value) {
        throw new Error(`Missing required environment variable ${key}`);
    }
    return value;
}
function serialize(params) {
    return Object.keys(params)
        .filter((key) => params[key] !== undefined && params[key] !== null)
        .sort()
        .map((key) => `${key}=${encodeURIComponent(String(params[key]))}`)
        .join("&");
}
export class AsterSpotRestClient {
    apiKey;
    apiSecret;
    constructor(options = {}) {
        this.apiKey = options.apiKey ?? process.env.ASTER_API_KEY;
        this.apiSecret = options.apiSecret ?? process.env.ASTER_API_SECRET;
    }
    async ping() {
        await this.request({ path: "/api/v1/ping", method: "GET" });
    }
    async getServerTime() {
        return this.request({ path: "/api/v1/time", method: "GET" });
    }
    async getExchangeInfo() {
        return this.request({ path: "/api/v1/exchangeInfo", method: "GET" });
    }
    async getDepth(symbol, limit) {
        const payload = await this.request({
            path: "/api/v1/depth",
            method: "GET",
            params: { symbol: symbol.toUpperCase(), limit },
        });
        return {
            lastUpdateId: Number(payload.lastUpdateId),
            E: payload.E,
            T: payload.T,
            bids: (payload.bids ?? []).map(([price, qty]) => [String(price), String(qty)]),
            asks: (payload.asks ?? []).map(([price, qty]) => [String(price), String(qty)]),
        };
    }
    async getTrades(symbol, limit) {
        const payload = await this.request({
            path: "/api/v1/trades",
            method: "GET",
            params: { symbol: symbol.toUpperCase(), limit },
        });
        return payload.map((item) => ({
            id: Number(item.id),
            price: String(item.price),
            qty: String(item.qty),
            baseQty: item.baseQty !== undefined ? String(item.baseQty) : undefined,
            quoteQty: item.quoteQty !== undefined ? String(item.quoteQty) : undefined,
            time: Number(item.time ?? Date.now()),
            isBuyerMaker: Boolean(item.isBuyerMaker),
        }));
    }
    async getHistoricalTrades(params) {
        const payload = await this.request({
            path: "/api/v1/historicalTrades",
            method: "GET",
            params: {
                symbol: params.symbol.toUpperCase(),
                limit: params.limit,
                fromId: params.fromId,
            },
            requiresApiKey: true,
        });
        return payload.map((item) => ({
            id: Number(item.id),
            price: String(item.price),
            qty: String(item.qty),
            baseQty: item.baseQty !== undefined ? String(item.baseQty) : undefined,
            quoteQty: item.quoteQty !== undefined ? String(item.quoteQty) : undefined,
            time: Number(item.time ?? Date.now()),
            isBuyerMaker: Boolean(item.isBuyerMaker),
            isBestMatch: item.isBestMatch !== undefined ? Boolean(item.isBestMatch) : undefined,
        }));
    }
    async getAggTrades(params) {
        const payload = await this.request({
            path: "/api/v1/aggTrades",
            method: "GET",
            params: {
                symbol: params.symbol.toUpperCase(),
                fromId: params.fromId,
                startTime: params.startTime,
                endTime: params.endTime,
                limit: params.limit,
            },
        });
        return payload.map((item) => ({
            a: Number(item.a),
            p: String(item.p),
            q: String(item.q),
            f: Number(item.f),
            l: Number(item.l),
            T: Number(item.T),
            m: Boolean(item.m),
            M: item.M !== undefined ? Boolean(item.M) : undefined,
        }));
    }
    async getKlines(params) {
        const payload = await this.request({
            path: "/api/v1/klines",
            method: "GET",
            params: {
                symbol: params.symbol.toUpperCase(),
                interval: params.interval,
                startTime: params.startTime,
                endTime: params.endTime,
                limit: params.limit,
            },
        });
        return payload.map((entry) => ({
            openTime: Number(entry[0]),
            open: String(entry[1]),
            high: String(entry[2]),
            low: String(entry[3]),
            close: String(entry[4]),
            volume: String(entry[5]),
            closeTime: Number(entry[6]),
            quoteAssetVolume: String(entry[7]),
            numberOfTrades: Number(entry[8] ?? 0),
            takerBuyBaseAssetVolume: String(entry[9] ?? "0"),
            takerBuyQuoteAssetVolume: String(entry[10] ?? "0"),
        }));
    }
    async getTicker24h(symbol) {
        const payload = await this.request({
            path: "/api/v1/ticker/24hr",
            method: "GET",
            params: symbol ? { symbol: symbol.toUpperCase() } : undefined,
        });
        return this.normalizeTicker24h(payload);
    }
    async getTickerPrice(symbol) {
        const payload = await this.request({
            path: "/api/v1/ticker/price",
            method: "GET",
            params: symbol ? { symbol: symbol.toUpperCase() } : undefined,
        });
        return Array.isArray(payload) ? payload.map((item) => this.normalizePriceTicker(item)) : this.normalizePriceTicker(payload);
    }
    async getBookTicker(symbol) {
        const payload = await this.request({
            path: "/api/v1/ticker/bookTicker",
            method: "GET",
            params: symbol ? { symbol: symbol.toUpperCase() } : undefined,
        });
        return Array.isArray(payload) ? payload.map((item) => this.normalizeBookTicker(item)) : this.normalizeBookTicker(payload);
    }
    async getCommissionRate(symbol, params = {}) {
        const payload = await this.request({
            path: "/api/v1/commissionRate",
            method: "GET",
            params: { symbol: symbol.toUpperCase(), recvWindow: params.recvWindow },
            signed: true,
        });
        return {
            symbol: payload.symbol,
            makerCommissionRate: String(payload.makerCommissionRate),
            takerCommissionRate: String(payload.takerCommissionRate),
        };
    }
    async createOrder(params) {
        const response = await this.request({
            path: "/api/v1/order",
            method: "POST",
            params: this.normalizeSpotOrderParams(params),
            signed: true,
            sendInBody: true,
        });
        return toOrderFromRest(response);
    }
    async cancelOrder(params) {
        const response = await this.request({
            path: "/api/v1/order",
            method: "DELETE",
            params: {
                symbol: params.symbol.toUpperCase(),
                orderId: params.orderId,
                origClientOrderId: params.origClientOrderId,
                recvWindow: params.recvWindow,
            },
            signed: true,
        });
        return toOrderFromRest(response);
    }
    async getOrder(params) {
        const response = await this.request({
            path: "/api/v1/order",
            method: "GET",
            params: {
                symbol: params.symbol.toUpperCase(),
                orderId: params.orderId,
                origClientOrderId: params.origClientOrderId,
                recvWindow: params.recvWindow,
            },
            signed: true,
        });
        return toOrderFromRest(response);
    }
    async getOpenOrders(params = {}) {
        const response = await this.request({
            path: "/api/v1/openOrders",
            method: "GET",
            params: {
                symbol: params.symbol ? params.symbol.toUpperCase() : undefined,
                recvWindow: params.recvWindow,
            },
            signed: true,
        });
        return response.map(toOrderFromRest);
    }
    async cancelAllOpenOrders(params) {
        const payload = {
            symbol: params.symbol.toUpperCase(),
            recvWindow: params.recvWindow,
        };
        if (params.orderIdList && params.orderIdList.length) {
            payload.orderIdList = `[${params.orderIdList
                .map((id) => (typeof id === "string" ? id.trim() : String(id)))
                .join(",")}]`;
        }
        if (params.origClientOrderIdList && params.origClientOrderIdList.length) {
            payload.origClientOrderIdList = JSON.stringify(params.origClientOrderIdList);
        }
        return this.request({
            path: "/api/v1/allOpenOrders",
            method: "DELETE",
            params: payload,
            signed: true,
        });
    }
    async getAllOrders(params) {
        const response = await this.request({
            path: "/api/v1/allOrders",
            method: "GET",
            params: {
                symbol: params.symbol.toUpperCase(),
                orderId: params.orderId,
                startTime: params.startTime,
                endTime: params.endTime,
                limit: params.limit,
                recvWindow: params.recvWindow,
            },
            signed: true,
        });
        return response.map(toOrderFromRest);
    }
    async getAccount(params = {}) {
        const payload = await this.request({
            path: "/api/v1/account",
            method: "GET",
            params: { recvWindow: params.recvWindow },
            signed: true,
        });
        return {
            ...payload,
            balances: (payload.balances ?? []).map((balance) => ({
                asset: balance.asset,
                free: String(balance.free ?? "0"),
                locked: String(balance.locked ?? "0"),
            })),
        };
    }
    async getUserTrades(params = {}) {
        const response = await this.request({
            path: "/api/v1/userTrades",
            method: "GET",
            params: {
                symbol: params.symbol ? params.symbol.toUpperCase() : undefined,
                orderId: params.orderId,
                startTime: params.startTime,
                endTime: params.endTime,
                fromId: params.fromId,
                limit: params.limit,
                recvWindow: params.recvWindow,
            },
            signed: true,
        });
        return response.map((item) => ({
            symbol: item.symbol,
            id: Number(item.id),
            orderId: Number(item.orderId),
            side: item.side,
            price: String(item.price),
            qty: String(item.qty),
            quoteQty: item.quoteQty !== undefined ? String(item.quoteQty) : undefined,
            commission: String(item.commission ?? "0"),
            commissionAsset: String(item.commissionAsset ?? ""),
            time: Number(item.time ?? Date.now()),
            counterpartyId: item.counterpartyId !== undefined ? Number(item.counterpartyId) : undefined,
            maker: Boolean(item.maker),
            buyer: Boolean(item.buyer),
        }));
    }
    normalizeTicker24h(payload) {
        const mapOne = (entry) => ({
            symbol: entry.symbol,
            priceChange: String(entry.priceChange),
            priceChangePercent: String(entry.priceChangePercent),
            weightedAvgPrice: String(entry.weightedAvgPrice),
            prevClosePrice: String(entry.prevClosePrice),
            lastPrice: String(entry.lastPrice),
            lastQty: String(entry.lastQty),
            bidPrice: String(entry.bidPrice),
            bidQty: String(entry.bidQty),
            askPrice: String(entry.askPrice),
            askQty: String(entry.askQty),
            openPrice: String(entry.openPrice),
            highPrice: String(entry.highPrice),
            lowPrice: String(entry.lowPrice),
            volume: String(entry.volume),
            quoteVolume: String(entry.quoteVolume),
            openTime: Number(entry.openTime ?? 0),
            closeTime: Number(entry.closeTime ?? 0),
            firstId: Number(entry.firstId ?? 0),
            lastId: Number(entry.lastId ?? 0),
            count: Number(entry.count ?? 0),
            baseAsset: entry.baseAsset,
            quoteAsset: entry.quoteAsset,
        });
        return Array.isArray(payload) ? payload.map((entry) => mapOne(entry)) : mapOne(payload);
    }
    normalizePriceTicker(entry) {
        return {
            symbol: entry.symbol,
            price: String(entry.price),
            time: entry.time !== undefined ? Number(entry.time) : undefined,
        };
    }
    normalizeBookTicker(entry) {
        return {
            symbol: entry.symbol,
            bidPrice: String(entry.bidPrice),
            bidQty: String(entry.bidQty),
            askPrice: String(entry.askPrice),
            askQty: String(entry.askQty),
            time: entry.time !== undefined ? Number(entry.time) : undefined,
        };
    }
    normalizeSpotOrderParams(params) {
        const payload = {
            symbol: params.symbol.toUpperCase(),
            side: params.side,
            type: params.type,
            timeInForce: params.timeInForce,
            quantity: params.quantity !== undefined ? params.quantity : undefined,
            quoteOrderQty: params.quoteOrderQty !== undefined ? params.quoteOrderQty : undefined,
            price: params.price !== undefined ? params.price : undefined,
            newClientOrderId: params.newClientOrderId,
            stopPrice: params.stopPrice !== undefined ? params.stopPrice : undefined,
            recvWindow: params.recvWindow,
        };
        return payload;
    }
    ensureApiKey() {
        if (!this.apiKey) {
            throw new Error("[AsterSpotRestClient] Missing API key");
        }
        return this.apiKey;
    }
    ensureCredentials() {
        const apiKey = this.ensureApiKey();
        const apiSecret = this.apiSecret;
        if (!apiSecret) {
            throw new Error("[AsterSpotRestClient] Missing API secret");
        }
        return { apiKey, apiSecret };
    }
    cleanParams(params) {
        const source = params ?? {};
        const cleaned = {};
        for (const key of Object.keys(source)) {
            const value = source[key];
            if (value === undefined || value === null)
                continue;
            cleaned[key] = value;
        }
        return cleaned;
    }
    async request({ path, method, params, signed = false, sendInBody, requiresApiKey = false, }) {
        const cleaned = this.cleanParams(params);
        const headers = {};
        let url = `${SPOT_REST_BASE}${path}`;
        const useBody = sendInBody ?? (method !== "GET" && method !== "DELETE");
        let body;
        if (requiresApiKey || signed) {
            headers["X-MBX-APIKEY"] = this.ensureApiKey();
        }
        if (signed) {
            if (cleaned.timestamp === undefined)
                cleaned.timestamp = Date.now();
            if (cleaned.recvWindow === undefined)
                cleaned.recvWindow = 5000;
            const { apiSecret } = this.ensureCredentials();
            const serialized = serialize(cleaned);
            const signature = crypto.createHmac("sha256", apiSecret).update(serialized).digest("hex");
            if (useBody) {
                body = serialized ? `${serialized}&signature=${signature}` : `signature=${signature}`;
            }
            else {
                const query = serialized ? `${serialized}&signature=${signature}` : `signature=${signature}`;
                url += url.includes("?") ? `&${query}` : `?${query}`;
            }
        }
        else {
            const query = serialize(cleaned);
            if (query) {
                if (useBody) {
                    body = query;
                }
                else {
                    url += url.includes("?") ? `&${query}` : `?${query}`;
                }
            }
        }
        const init = { method, headers };
        if (useBody) {
            init.body = body ?? "";
            headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
        let response;
        try {
            response = await fetch(url, init);
        }
        catch (error) {
            throw new Error(`[AsterSpotRestClient] 请求失败 ${String(error)}`);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${text}`);
        }
        if (!text) {
            return undefined;
        }
        try {
            return JSON.parse(text);
        }
        catch (error) {
            throw new Error(`[AsterSpotRestClient] 无法解析响应: ${text.slice(0, 200)}`);
        }
    }
}
function toDepth(streamSymbol, data) {
    return {
        eventType: data.e,
        eventTime: data.E,
        tradeTime: data.T,
        symbol: streamSymbol,
        lastUpdateId: data.u,
        bids: (data.b ?? []).map(([price, qty]) => [price, qty]),
        asks: (data.a ?? []).map(([price, qty]) => [price, qty]),
    };
}
function toTicker(data) {
    return {
        eventType: data.e,
        eventTime: data.E,
        symbol: data.s,
        lastPrice: data.c,
        openPrice: data.o,
        highPrice: data.h,
        lowPrice: data.l,
        volume: data.q ?? data.v ?? "0",
        quoteVolume: data.Q ?? data.V ?? "0",
        priceChange: data.p,
        priceChangePercent: data.P,
        weightedAvgPrice: data.w,
        lastQty: data.l ?? data.L,
        openTime: data.O,
        closeTime: data.C,
        firstId: data.F,
        lastId: data.L,
        count: data.n,
    };
}
function toKline(data) {
    return {
        eventType: data.e,
        eventTime: data.E,
        symbol: data.s,
        interval: data.k.i,
        openTime: data.k.t,
        closeTime: data.k.T,
        firstTradeId: data.k.f,
        lastTradeId: data.k.L,
        open: data.k.o,
        high: data.k.h,
        low: data.k.l,
        close: data.k.c,
        volume: data.k.v,
        numberOfTrades: data.k.n,
        quoteAssetVolume: data.k.q,
        takerBuyBaseAssetVolume: data.k.V,
        takerBuyQuoteAssetVolume: data.k.Q,
        isClosed: Boolean(data.k.x),
    };
}
function fromRestKline(entry, interval, symbol) {
    return {
        eventType: undefined,
        eventTime: undefined,
        symbol,
        interval,
        openTime: entry[0],
        open: String(entry[1]),
        high: String(entry[2]),
        low: String(entry[3]),
        close: String(entry[4]),
        volume: String(entry[5]),
        closeTime: entry[6],
        quoteAssetVolume: String(entry[7]),
        numberOfTrades: Number(entry[8] ?? 0),
        takerBuyBaseAssetVolume: String(entry[9] ?? "0"),
        takerBuyQuoteAssetVolume: String(entry[10] ?? "0"),
        isClosed: Boolean(entry[11]),
    };
}
function toOrderFromRest(raw) {
    return {
        avgPrice: raw.avgPrice ?? "0",
        clientOrderId: raw.clientOrderId ?? "",
        cumQuote: raw.cumQuote ?? "0",
        executedQty: raw.executedQty ?? "0",
        orderId: raw.orderId,
        origQty: raw.origQty ?? raw.quantity ?? "0",
        origType: raw.origType ?? raw.type ?? "",
        price: raw.price ?? "0",
        reduceOnly: Boolean(raw.reduceOnly),
        side: raw.side ?? "",
        positionSide: raw.positionSide ?? "BOTH",
        status: raw.status ?? "NEW",
        stopPrice: raw.stopPrice ?? raw.triggerPrice ?? "0",
        closePosition: Boolean(raw.closePosition),
        symbol: raw.symbol ?? "",
        time: raw.time ?? raw.updateTime ?? Date.now(),
        timeInForce: raw.timeInForce ?? "GTC",
        type: raw.type ?? "LIMIT",
        activatePrice: raw.activatePrice,
        priceRate: raw.priceRate,
        updateTime: raw.updateTime ?? Date.now(),
        workingType: raw.workingType ?? "CONTRACT_PRICE",
        priceProtect: Boolean(raw.priceProtect),
    };
}
function toOrderFromEvent(event) {
    return {
        avgPrice: event.ap ?? "0",
        clientOrderId: event.c ?? "",
        cumQuote: event.z ?? "0",
        executedQty: event.z ?? "0",
        orderId: event.i,
        origQty: event.q ?? "0",
        origType: event.ot ?? event.o ?? "",
        price: event.p ?? "0",
        reduceOnly: Boolean(event.R),
        side: event.S,
        positionSide: event.ps ?? "BOTH",
        status: event.X,
        stopPrice: event.sp ?? "0",
        closePosition: Boolean(event.cp),
        symbol: event.s,
        time: event.T ?? Date.now(),
        timeInForce: event.f ?? "GTC",
        type: event.o ?? "LIMIT",
        activatePrice: event.AP,
        priceRate: event.cr,
        updateTime: event.T ?? Date.now(),
        workingType: event.wt ?? "CONTRACT_PRICE",
        priceProtect: Boolean(event.PP),
    };
}
function toPositionFromRisk(raw) {
    const positionSide = String(raw.positionSide ?? raw.ps ?? "BOTH").toUpperCase();
    return {
        symbol: raw.symbol ?? raw.s ?? "",
        positionAmt: raw.positionAmt ?? raw.pa ?? "0",
        entryPrice: raw.entryPrice ?? raw.ep ?? "0",
        unrealizedProfit: raw.unRealizedProfit ?? raw.unrealizedProfit ?? raw.up ?? "0",
        positionSide,
        updateTime: raw.updateTime ?? Date.now(),
        initialMargin: raw.initialMargin ?? raw.positionInitialMargin,
        maintMargin: raw.maintMargin,
        positionInitialMargin: raw.positionInitialMargin,
        openOrderInitialMargin: raw.openOrderInitialMargin,
        leverage: raw.leverage,
        isolated: typeof raw.isolated === "boolean" ? raw.isolated : undefined,
        maxNotional: raw.maxNotionalValue ?? raw.maxNotional,
        marginType: raw.marginType,
        isolatedMargin: raw.isolatedMargin,
        isAutoAddMargin: raw.isAutoAddMargin,
        liquidationPrice: raw.liquidationPrice,
        markPrice: raw.markPrice,
    };
}
function deepCloneAccount(snapshot) {
    return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
}
function sumUnrealizedProfit(positions) {
    const total = positions.reduce((acc, position) => acc + Number(position.unrealizedProfit ?? 0), 0);
    return total.toFixed(8);
}
function clonePositions(positions) {
    return positions.map((position) => ({
        ...position,
        updateTime: position.updateTime ?? Date.now(),
    }));
}
class SimpleEvent {
    listeners = new Set();
    add(listener) {
        this.listeners.add(listener);
    }
    remove(listener) {
        this.listeners.delete(listener);
    }
    emit(payload) {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener(payload);
            }
            catch (error) {
                console.error("[SimpleEvent] listener failure", error);
            }
        }
    }
    listenerCount() {
        return this.listeners.size;
    }
}
export class AsterRestClient {
    apiKey;
    apiSecret;
    constructor(options = {}) {
        this.apiKey = requireEnv(options.apiKey ?? process.env.ASTER_API_KEY, "ASTER_API_KEY");
        this.apiSecret = requireEnv(options.apiSecret ?? process.env.ASTER_API_SECRET, "ASTER_API_SECRET");
    }
    async getAccount() {
        return this.signedRequest({ path: "/fapi/v2/account", method: "GET", params: {} });
    }
    async getOpenOrders(symbol) {
        const params = {};
        if (symbol)
            params.symbol = symbol;
        const raw = await this.signedRequest({ path: "/fapi/v1/openOrders", method: "GET", params });
        return raw.map(toOrderFromRest);
    }
    async getPositions(symbol) {
        const params = {};
        if (symbol)
            params.symbol = symbol.toUpperCase();
        const raw = await this.signedRequest({ path: "/fapi/v2/positionRisk", method: "GET", params });
        return raw.map(toPositionFromRisk);
    }
    async getExchangeInfo() {
        const url = `${FUTURES_REST_BASE}/fapi/v1/exchangeInfo`;
        let response;
        try {
            response = await fetch(url);
        }
        catch (error) {
            throw new Error(`[AsterRestClient] 获取交易规则失败 ${String(error)}`);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${text}`);
        }
        try {
            return JSON.parse(text);
        }
        catch (error) {
            throw new Error(`[AsterRestClient] 无法解析交易规则响应: ${text.slice(0, 200)}`);
        }
    }
    async createOrder(params) {
        // Sanitize and normalize params for Aster futures API. Paradex-specific flags
        // like reduceOnly/closePosition on STOP/TRAILING should not leak here.
        const payload = {};
        payload.symbol = String(params.symbol).toUpperCase();
        payload.side = params.side;
        payload.type = params.type;
        if (params.timeInForce !== undefined)
            payload.timeInForce = params.timeInForce;
        if (params.price !== undefined)
            payload.price = params.price;
        if (params.stopPrice !== undefined)
            payload.stopPrice = params.stopPrice;
        if (params.activationPrice !== undefined)
            payload.activationPrice = params.activationPrice;
        if (params.callbackRate !== undefined)
            payload.callbackRate = params.callbackRate;
        if (params.quantity !== undefined)
            payload.quantity = Math.abs(params.quantity);
        // Aster rejects reduceOnly/closePosition for certain order types (e.g. STOP/TRAILING).
        // Keep the behavior exchange-specific by stripping them here for Aster.
        const type = String(params.type).toUpperCase();
        const isStopOrTrailing = type === "STOP_MARKET" || type === "TRAILING_STOP_MARKET";
        const supportsClosePosition = type === "STOP_MARKET" || type === "TAKE_PROFIT_MARKET";
        if (!isStopOrTrailing) {
            if (params.reduceOnly !== undefined)
                payload.reduceOnly = params.reduceOnly;
        }
        if (supportsClosePosition) {
            if (params.closePosition !== undefined)
                payload.closePosition = params.closePosition;
        }
        const response = await this.signedRequest({ path: "/fapi/v1/order", method: "POST", params: payload });
        return toOrderFromRest(response);
    }
    async cancelOrder(params) {
        const response = await this.signedRequest({ path: "/fapi/v1/order", method: "DELETE", params });
        return toOrderFromRest(response);
    }
    async cancelOrders(params) {
        const payload = { symbol: params.symbol };
        if (params.orderIdList?.length) {
            payload.orderIdList = `[${params.orderIdList
                .map((id) => (typeof id === "string" ? id.trim() : String(id)))
                .join(",")}]`;
        }
        if (params.origClientOrderIdList?.length) {
            payload.origClientOrderIdList = JSON.stringify(params.origClientOrderIdList);
        }
        const response = await this.signedRequest({ path: "/fapi/v1/batchOrders", method: "DELETE", params: payload });
        return response.map(toOrderFromRest);
    }
    async cancelAllOrders(params) {
        await this.signedRequest({ path: "/fapi/v1/allOpenOrders", method: "DELETE", params });
    }
    async getKlines(symbol, interval, limit = DEFAULT_KLINE_LIMIT) {
        const upper = symbol.toUpperCase();
        const url = `${FUTURES_REST_BASE}/fapi/v1/continuousKlines?pair=${upper}&contractType=PERPETUAL&interval=${encodeURIComponent(interval)}&limit=${limit}`;
        let response;
        try {
            response = await fetch(url);
        }
        catch (error) {
            throw new Error(`[AsterRestClient] 获取K线失败 ${String(error)}`);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${text}`);
        }
        try {
            const payload = JSON.parse(text);
            return payload.map((entry) => fromRestKline(entry, interval, upper));
        }
        catch (error) {
            throw new Error(`[AsterRestClient] 无法解析K线响应: ${text.slice(0, 200)}`);
        }
    }
    async getPremiumIndex(symbol) {
        const upper = symbol.toUpperCase();
        const url = `${FUTURES_REST_BASE}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(upper)}`;
        let response;
        try {
            response = await fetch(url);
        }
        catch (error) {
            throw new Error(`[AsterRestClient] 获取资金费率失败 ${String(error)}`);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${text}`);
        }
        try {
            const payload = JSON.parse(text);
            // The response shape mirrors Binance: { symbol, markPrice, indexPrice, lastFundingRate, nextFundingTime, time }
            return payload;
        }
        catch (error) {
            throw new Error(`[AsterRestClient] 无法解析资金费率响应: ${text.slice(0, 200)}`);
        }
    }
    async getListenKey() {
        const response = await this.signedRequest({ path: "/fapi/v1/listenKey", method: "POST", params: {} });
        return response.listenKey;
    }
    async keepAliveListenKey(listenKey) {
        await this.signedRequest({ path: "/fapi/v1/listenKey", method: "PUT", params: { listenKey } });
    }
    async closeListenKey(listenKey) {
        await this.signedRequest({ path: "/fapi/v1/listenKey", method: "DELETE", params: { listenKey } });
    }
    async signedRequest({ path, method, params }) {
        const timestamp = Date.now();
        const payload = { ...params, timestamp, recvWindow: 5000 };
        const query = serialize(payload);
        const signature = crypto.createHmac("sha256", this.apiSecret).update(query).digest("hex");
        const url = `${FUTURES_REST_BASE}${path}?${query}&signature=${signature}`;
        const init = {
            method,
            headers: {
                "X-MBX-APIKEY": this.apiKey,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        };
        let response;
        try {
            response = await fetch(url, init);
        }
        catch (error) {
            throw new Error(`[AsterRestClient] 请求失败 ${String(error)}`);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${text}`);
        }
        try {
            return JSON.parse(text);
        }
        catch (error) {
            throw new Error(`[AsterRestClient] 无法解析响应: ${text.slice(0, 200)}`);
        }
    }
}
export class AsterPublicStreams {
    ws = null;
    reconnectTimeout = null;
    streams = new Map();
    depthHandlers = new Map();
    tickerHandlers = new Map();
    klineHandlers = new Map();
    nextRequestId = 1;
    subscribeDepth(symbol, handler) {
        const upper = symbol.toUpperCase();
        const stream = `${upper.toLowerCase()}@depth${DEFAULT_DEPTH_LEVEL}@${DEFAULT_DEPTH_SPEED}`;
        this.addHandler(this.depthHandlers, upper, handler);
        this.registerStream(stream, { stream, kind: "depth", symbol: upper });
    }
    subscribeTicker(symbol, handler) {
        const upper = symbol.toUpperCase();
        const stream = `${upper.toLowerCase()}@miniTicker`;
        this.addHandler(this.tickerHandlers, upper, handler);
        this.registerStream(stream, { stream, kind: "ticker", symbol: upper });
    }
    subscribeKline(symbol, interval, handler) {
        const upper = symbol.toUpperCase();
        const stream = `${upper.toLowerCase()}@kline_${interval}`;
        this.addHandler(this.klineHandlers, `${upper}:${interval}`, handler);
        this.registerStream(stream, { stream, kind: "kline", symbol: upper, interval });
    }
    addHandler(map, key, handler) {
        let set = map.get(key);
        if (!set) {
            set = new Set();
            map.set(key, set);
        }
        set.add(handler);
        this.ensureConnection();
    }
    registerStream(stream, state) {
        if (!this.streams.has(stream)) {
            this.streams.set(stream, state);
            this.send({ method: "SUBSCRIBE", params: [stream], id: this.nextRequestId++ });
        }
    }
    ensureConnection() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        this.connect();
    }
    connect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.ws = new WebSocket(WS_PUBLIC_URL);
        this.ws.onopen = () => {
            const streams = Array.from(this.streams.keys());
            if (streams.length) {
                this.send({ method: "SUBSCRIBE", params: streams, id: this.nextRequestId++ });
            }
        };
        this.ws.onmessage = (event) => {
            let payload;
            if (typeof event.data === "string") {
                try {
                    payload = JSON.parse(event.data);
                }
                catch (error) {
                    console.error("[AsterPublicStreams] 无法解析消息", error, event.data);
                    return;
                }
            }
            else {
                payload = event.data;
            }
            if (!payload)
                return;
            if (payload.result !== undefined)
                return; // subscription ack
            const data = payload.data ?? payload;
            if (!data.e)
                return;
            switch (data.e) {
                case "depthUpdate":
                    this.dispatchDepth(data);
                    break;
                case "24hrMiniTicker":
                    this.dispatchTicker(data);
                    break;
                case "kline":
                    this.dispatchKline(data);
                    break;
                default:
                    break;
            }
        };
        this.ws.onclose = () => {
            this.scheduleReconnect();
        };
        this.ws.onerror = () => {
            this.ws?.close();
        };
    }
    scheduleReconnect() {
        if (this.reconnectTimeout)
            return;
        this.reconnectTimeout = setTimeout(() => {
            this.connect();
        }, RECONNECT_DELAY_MS);
    }
    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }
    dispatchDepth(data) {
        const symbol = String(data.s ?? "").toUpperCase();
        const handlers = this.depthHandlers.get(symbol);
        if (!handlers || !handlers.size)
            return;
        const depth = toDepth(symbol, data);
        handlers.forEach((handler) => handler(depth));
    }
    dispatchTicker(data) {
        const symbol = String(data.s ?? "").toUpperCase();
        const handlers = this.tickerHandlers.get(symbol);
        if (!handlers || !handlers.size)
            return;
        const ticker = toTicker(data);
        handlers.forEach((handler) => handler(ticker));
    }
    dispatchKline(data) {
        const symbol = String(data.s ?? "").toUpperCase();
        const interval = data.k?.i ?? "";
        const key = `${symbol}:${interval}`;
        const handlers = this.klineHandlers.get(key);
        if (!handlers || !handlers.size)
            return;
        const kline = toKline(data);
        handlers.forEach((handler) => handler(kline));
    }
}
export class AsterUserStream {
    rest;
    listenKey = null;
    ws = null;
    keepAliveTimer = null;
    reconnectTimeout = null;
    accountEvent = new SimpleEvent();
    orderEvent = new SimpleEvent();
    connectEvent = new SimpleEvent();
    isRunning = false;
    constructor(rest) {
        this.rest = rest;
    }
    onAccount(listener) {
        this.accountEvent.add(listener);
    }
    onOrder(listener) {
        this.orderEvent.add(listener);
    }
    onConnect(listener) {
        this.connectEvent.add(listener);
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        await this.ensureListenKey();
        this.openSocket();
        this.scheduleKeepAlive();
    }
    stop() {
        this.isRunning = false;
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.listenKey) {
            void this.rest.closeListenKey(this.listenKey).catch(() => undefined);
            this.listenKey = null;
        }
    }
    async ensureListenKey() {
        if (this.listenKey)
            return;
        this.listenKey = await this.rest.getListenKey();
    }
    scheduleKeepAlive() {
        if (this.keepAliveTimer)
            return;
        this.keepAliveTimer = setInterval(() => {
            if (!this.listenKey)
                return;
            void this.rest.keepAliveListenKey(this.listenKey).catch((error) => {
                console.error("[AsterUserStream] keepAlive error", error);
            });
        }, LISTEN_KEY_KEEPALIVE_MS / 2);
    }
    openSocket() {
        if (!this.listenKey)
            return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        const url = `${WS_LISTEN_KEY_URL}${this.listenKey}`;
        this.ws = new WebSocket(url);
        this.ws.onopen = () => {
            this.connectEvent.emit();
        };
        this.ws.onmessage = (event) => {
            let payload;
            if (typeof event.data === "string") {
                try {
                    payload = JSON.parse(event.data);
                }
                catch (error) {
                    console.error("[AsterUserStream] 无法解析消息", error, event.data);
                    return;
                }
            }
            else {
                payload = event.data;
            }
            if (!payload)
                return;
            if (payload === "ping") {
                this.ws?.send("pong");
                return;
            }
            switch (payload.e) {
                case "ACCOUNT_UPDATE":
                    this.accountEvent.emit({ eventTime: payload.E, payload: payload.a });
                    break;
                case "ORDER_TRADE_UPDATE":
                    this.orderEvent.emit({ eventTime: payload.E, payload: payload.o });
                    break;
                case "listenKeyExpired":
                    this.handleListenKeyExpired();
                    break;
                default:
                    break;
            }
        };
        this.ws.onclose = () => {
            this.scheduleReconnect();
        };
        this.ws.onerror = () => {
            this.ws?.close();
        };
    }
    async handleListenKeyExpired() {
        this.listenKey = null;
        await this.ensureListenKey();
        this.openSocket();
    }
    scheduleReconnect() {
        if (!this.isRunning)
            return;
        if (this.reconnectTimeout)
            return;
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.openSocket();
        }, RECONNECT_DELAY_MS);
    }
}
function updateAccountSnapshot(snapshot, event) {
    if (!snapshot)
        return snapshot;
    const next = deepCloneAccount(snapshot);
    if (!next)
        return snapshot;
    next.updateTime = event.eventTime;
    const balances = event.payload.B ?? [];
    for (const balance of balances) {
        const asset = balance.a;
        let assetEntry = next.assets.find((item) => item.asset === asset);
        if (!assetEntry) {
            assetEntry = {
                asset,
                walletBalance: "0",
                availableBalance: "0",
                updateTime: event.eventTime,
            };
            next.assets.push(assetEntry);
        }
        if (balance.wb !== undefined)
            assetEntry.walletBalance = balance.wb;
        if (balance.cw !== undefined)
            assetEntry.crossWalletBalance = balance.cw;
        if (balance.bc !== undefined)
            assetEntry.availableBalance = balance.bc;
        assetEntry.updateTime = event.eventTime;
    }
    const positions = event.payload.P ?? [];
    const unrealizedTotals = positions.reduce((acc, item) => acc + parseFloat(item.up ?? "0"), 0);
    next.totalUnrealizedProfit = unrealizedTotals.toFixed(8);
    for (const position of positions) {
        const symbol = position.s;
        let positionEntry = next.positions.find((item) => item.symbol === symbol && item.positionSide === position.ps);
        if (!positionEntry) {
            positionEntry = {
                symbol,
                positionAmt: "0",
                entryPrice: "0",
                unrealizedProfit: "0",
                positionSide: position.ps,
                updateTime: event.eventTime,
            };
            next.positions.push(positionEntry);
        }
        positionEntry.positionAmt = position.pa ?? positionEntry.positionAmt;
        positionEntry.entryPrice = position.ep ?? positionEntry.entryPrice;
        positionEntry.unrealizedProfit = position.up ?? positionEntry.unrealizedProfit;
        positionEntry.updateTime = event.eventTime;
    }
    return next;
}
function mergeOrderSnapshot(map, order) {
    const rawId = order.orderId;
    if (rawId === undefined || rawId === null)
        return;
    const key = String(rawId);
    if (!key)
        return;
    if (FINAL_ORDER_STATUSES.has(order.status)) {
        map.delete(key);
    }
    else {
        map.set(key, { ...order, orderId: key });
    }
}
export class AsterGateway {
    rest;
    publicStreams;
    userStream;
    accountSnapshot = null;
    openOrders = new Map();
    positionSyncTimer = null;
    positionSyncInFlight = false;
    accountEvent = new SimpleEvent();
    ordersEvent = new SimpleEvent();
    depthEvents = new Map();
    tickerEvents = new Map();
    klineEvents = new Map();
    klineStores = new Map();
    klineRefreshTimers = new Map();
    klineInitialFetches = new Map();
    initialized = false;
    initializing = null;
    precisionCache = new Map();
    exchangeInfo = null;
    exchangeInfoFetchedAt = 0;
    exchangeInfoPromise = null;
    constructor(options = {}) {
        this.rest = new AsterRestClient(options);
        this.publicStreams = new AsterPublicStreams();
        this.userStream = new AsterUserStream(this.rest);
        this.userStream.onAccount((event) => {
            const updated = updateAccountSnapshot(this.accountSnapshot, event);
            if (updated) {
                this.accountSnapshot = updated;
                this.accountEvent.emit(updated);
            }
        });
        this.userStream.onOrder((event) => {
            const order = toOrderFromEvent(event.payload);
            mergeOrderSnapshot(this.openOrders, order);
            this.ordersEvent.emit(Array.from(this.openOrders.values()));
            const execType = typeof event.payload?.x === "string" ? event.payload.x.toUpperCase() : "";
            const status = typeof event.payload?.X === "string" ? event.payload.X.toUpperCase() : "";
            if (execType === "TRADE" || status === "FILLED" || status === "PARTIALLY_FILLED") {
                void this.refreshPositions();
            }
        });
        this.userStream.onConnect(() => {
            void this.refreshSnapshots();
        });
    }
    async ensureInitialized(symbol) {
        if (this.initialized)
            return;
        if (this.initializing)
            return this.initializing;
        this.initializing = (async () => {
            await this.refreshSnapshots();
            this.initialized = true;
            await this.userStream.start();
            this.startPositionSync();
        })().catch((error) => {
            this.initializing = null;
            throw error;
        });
        return this.initializing;
    }
    onAccount(listener) {
        this.accountEvent.add(listener);
        if (this.accountSnapshot)
            listener(this.accountSnapshot);
    }
    onOrders(listener) {
        this.ordersEvent.add(listener);
        listener(Array.from(this.openOrders.values()));
    }
    onDepth(symbol, listener) {
        const upper = symbol.toUpperCase();
        let event = this.depthEvents.get(upper);
        if (!event) {
            event = new SimpleEvent();
            this.depthEvents.set(upper, event);
            this.publicStreams.subscribeDepth(upper, (depth) => {
                event?.emit(depth);
            });
        }
        event.add(listener);
    }
    onTicker(symbol, listener) {
        const upper = symbol.toUpperCase();
        let event = this.tickerEvents.get(upper);
        if (!event) {
            event = new SimpleEvent();
            this.tickerEvents.set(upper, event);
            this.publicStreams.subscribeTicker(upper, (ticker) => {
                event?.emit(ticker);
            });
        }
        event.add(listener);
    }
    onKlines(symbol, interval, listener) {
        const upper = symbol.toUpperCase();
        const key = `${upper}:${interval}`;
        let event = this.klineEvents.get(key);
        if (!event) {
            event = new SimpleEvent();
            this.klineEvents.set(key, event);
            this.publicStreams.subscribeKline(symbol, interval, (kline) => {
                const storeKey = `${upper}:${interval}`;
                let store = this.klineStores.get(storeKey);
                if (!store) {
                    store = [];
                    this.klineStores.set(storeKey, store);
                }
                const index = store.findIndex((item) => item.openTime === kline.openTime);
                if (index >= 0) {
                    store[index] = kline;
                }
                else {
                    store.push(kline);
                    store.sort((a, b) => a.openTime - b.openTime);
                    if (store.length > DEFAULT_KLINE_LIMIT) {
                        store.shift();
                    }
                }
                event?.emit([...store]);
            });
            void this.ensureKlineSeed(upper, interval);
        }
        event.add(listener);
        const existing = this.klineStores.get(key);
        if (existing && existing.length) {
            listener([...existing]);
        }
        else {
            void this.ensureKlineSeed(upper, interval);
        }
    }
    ensureKlineSeed(symbol, interval) {
        const key = `${symbol}:${interval}`;
        const existing = this.klineInitialFetches.get(key);
        if (existing)
            return existing;
        const task = (async () => {
            try {
                const klines = await this.rest.getKlines(symbol, interval, DEFAULT_KLINE_LIMIT);
                klines.sort((a, b) => a.openTime - b.openTime);
                this.klineStores.set(key, klines);
                const event = this.klineEvents.get(key);
                if (event) {
                    event.emit([...klines]);
                }
            }
            catch (error) {
                console.error("[AsterGateway] seed klines failed", error);
            }
            finally {
                this.startKlineRefresh(symbol, interval);
            }
        })();
        this.klineInitialFetches.set(key, task);
        return task;
    }
    startKlineRefresh(symbol, interval) {
        const key = `${symbol}:${interval}`;
        if (this.klineRefreshTimers.has(key))
            return;
        const timer = setInterval(async () => {
            try {
                const klines = await this.rest.getKlines(symbol, interval, DEFAULT_KLINE_LIMIT);
                klines.sort((a, b) => a.openTime - b.openTime);
                this.klineStores.set(key, klines);
                const event = this.klineEvents.get(key);
                if (event) {
                    event.emit([...klines]);
                }
            }
            catch (error) {
                console.error("[AsterGateway] refresh klines failed", error);
            }
        }, KLINE_REFRESH_INTERVAL_MS);
        this.klineRefreshTimers.set(key, timer);
    }
    async refreshSnapshots() {
        try {
            const account = await this.rest.getAccount();
            let positions = account.positions ?? [];
            try {
                const latestPositions = await this.rest.getPositions();
                if (Array.isArray(latestPositions) && latestPositions.length) {
                    positions = latestPositions;
                }
            }
            catch (positionError) {
                console.error("[AsterGateway] 刷新持仓失败", positionError);
            }
            const normalizedPositions = clonePositions(positions);
            const snapshot = {
                ...account,
                positions: normalizedPositions,
                totalUnrealizedProfit: sumUnrealizedProfit(normalizedPositions),
                updateTime: Date.now(),
            };
            this.accountSnapshot = snapshot;
            this.accountEvent.emit(snapshot);
        }
        catch (error) {
            console.error("[AsterGateway] 刷新账户信息失败", error);
        }
        try {
            const orders = await this.rest.getOpenOrders();
            this.openOrders.clear();
            orders.forEach((order) => mergeOrderSnapshot(this.openOrders, order));
            this.ordersEvent.emit(Array.from(this.openOrders.values()));
        }
        catch (error) {
            console.error("[AsterGateway] 刷新挂单失败", error);
        }
    }
    startPositionSync() {
        if (this.positionSyncTimer)
            return;
        const tick = () => {
            void this.refreshPositions();
        };
        void this.refreshPositions();
        this.positionSyncTimer = setInterval(tick, POSITION_SYNC_INTERVAL_MS);
    }
    async refreshPositions() {
        if (this.positionSyncInFlight)
            return;
        this.positionSyncInFlight = true;
        try {
            const positions = await this.rest.getPositions();
            if (!Array.isArray(positions))
                return;
            const normalizedPositions = clonePositions(positions);
            if (!this.accountSnapshot) {
                const snapshot = {
                    canTrade: true,
                    canDeposit: true,
                    canWithdraw: true,
                    updateTime: Date.now(),
                    totalWalletBalance: "0",
                    totalUnrealizedProfit: sumUnrealizedProfit(normalizedPositions),
                    positions: normalizedPositions,
                    assets: [],
                };
                this.accountSnapshot = snapshot;
                this.accountEvent.emit(snapshot);
                return;
            }
            const nextSnapshot = {
                ...this.accountSnapshot,
                positions: normalizedPositions,
                totalUnrealizedProfit: sumUnrealizedProfit(normalizedPositions),
                updateTime: Date.now(),
            };
            this.accountSnapshot = nextSnapshot;
            this.accountEvent.emit(nextSnapshot);
        }
        catch (error) {
            console.error("[AsterGateway] 同步持仓失败", error);
        }
        finally {
            this.positionSyncInFlight = false;
        }
    }
    getAccountSnapshot() {
        return this.accountSnapshot;
    }
    getOpenOrdersSnapshot() {
        return Array.from(this.openOrders.values());
    }
    async createOrder(params) {
        const normalized = await this.normalizeOrderParams(params);
        const order = await this.rest.createOrder(normalized);
        mergeOrderSnapshot(this.openOrders, order);
        this.ordersEvent.emit(Array.from(this.openOrders.values()));
        return order;
    }
    async getPrecision(symbol) {
        const upper = String(symbol).toUpperCase();
        const cached = this.precisionCache.get(upper);
        if (cached)
            return cached;
        let exchangeInfo;
        try {
            exchangeInfo = await this.loadExchangeInfo();
        }
        catch (error) {
            console.error("[AsterGateway] 获取交易规则失败", error);
            return null;
        }
        const symbols = exchangeInfo?.symbols ?? [];
        const match = symbols.find((item) => {
            if (!item)
                return false;
            const symbolName = typeof item.symbol === "string" ? item.symbol.toUpperCase() : "";
            const pairName = typeof item.pair === "string" ? item.pair.toUpperCase() : "";
            return symbolName === upper || pairName === upper;
        });
        if (!match)
            return null;
        const precision = this.extractSymbolPrecision(match);
        this.precisionCache.set(upper, precision);
        return precision;
    }
    async cancelOrder(params) {
        const result = await this.rest.cancelOrder(params);
        mergeOrderSnapshot(this.openOrders, result);
        this.ordersEvent.emit(Array.from(this.openOrders.values()));
    }
    async cancelOrders(params) {
        const results = await this.rest.cancelOrders(params);
        results.forEach((order) => mergeOrderSnapshot(this.openOrders, order));
        this.ordersEvent.emit(Array.from(this.openOrders.values()));
    }
    async cancelAllOrders(params) {
        await this.rest.cancelAllOrders(params);
        for (const [key, order] of Array.from(this.openOrders.entries())) {
            if (order.symbol === params.symbol) {
                this.openOrders.delete(key);
            }
        }
        this.ordersEvent.emit(Array.from(this.openOrders.values()));
    }
    async normalizeOrderParams(params) {
        const symbol = String(params.symbol).toUpperCase();
        const precision = await this.getPrecision(symbol);
        if (!precision) {
            return { ...params, symbol };
        }
        const { priceTick, qtyStep, priceDecimals, sizeDecimals } = precision;
        const normalized = { ...params, symbol };
        if (normalized.price !== undefined) {
            normalized.price = this.quantizePrice(normalized.price, priceTick, priceDecimals);
        }
        if (normalized.stopPrice !== undefined) {
            normalized.stopPrice = this.quantizePrice(normalized.stopPrice, priceTick, priceDecimals);
        }
        if (normalized.activationPrice !== undefined) {
            normalized.activationPrice = this.quantizePrice(normalized.activationPrice, priceTick, priceDecimals);
        }
        if (normalized.quantity !== undefined) {
            normalized.quantity = this.quantizeQuantity(Math.abs(normalized.quantity), qtyStep, sizeDecimals);
        }
        return normalized;
    }
    async loadExchangeInfo() {
        const now = Date.now();
        if (this.exchangeInfo && now - this.exchangeInfoFetchedAt <= EXCHANGE_INFO_CACHE_TTL_MS) {
            return this.exchangeInfo;
        }
        if (this.exchangeInfoPromise) {
            return this.exchangeInfoPromise;
        }
        this.exchangeInfoPromise = this.rest
            .getExchangeInfo()
            .then((info) => {
            this.exchangeInfo = info;
            this.exchangeInfoFetchedAt = Date.now();
            this.exchangeInfoPromise = null;
            return info;
        })
            .catch((error) => {
            this.exchangeInfoPromise = null;
            throw error;
        });
        return this.exchangeInfoPromise;
    }
    extractSymbolPrecision(symbolInfo) {
        const filters = symbolInfo.filters ?? [];
        const normalizeFilterType = (type) => filters.find((item) => typeof item.filterType === "string" && item.filterType.toUpperCase() === type);
        const parseNumber = (value) => {
            if (typeof value === "number" && Number.isFinite(value))
                return value;
            if (typeof value === "string") {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : undefined;
            }
            return undefined;
        };
        const priceFilter = normalizeFilterType("PRICE_FILTER");
        const lotFilter = normalizeFilterType("LOT_SIZE");
        const marketLotFilter = normalizeFilterType("MARKET_LOT_SIZE");
        const tickSize = parseNumber(priceFilter?.tickSize);
        const stepSize = parseNumber(lotFilter?.stepSize ?? marketLotFilter?.stepSize);
        const priceDecimals = typeof symbolInfo.pricePrecision === "number" && Number.isFinite(symbolInfo.pricePrecision)
            ? symbolInfo.pricePrecision
            : typeof symbolInfo.quotePrecision === "number" && Number.isFinite(symbolInfo.quotePrecision)
                ? symbolInfo.quotePrecision
                : undefined;
        const sizeDecimals = typeof symbolInfo.quantityPrecision === "number" && Number.isFinite(symbolInfo.quantityPrecision)
            ? symbolInfo.quantityPrecision
            : typeof symbolInfo.baseAssetPrecision === "number" && Number.isFinite(symbolInfo.baseAssetPrecision)
                ? symbolInfo.baseAssetPrecision
                : undefined;
        return {
            priceTick: this.ensurePositivePrecision(tickSize, priceDecimals),
            qtyStep: this.ensurePositivePrecision(stepSize, sizeDecimals),
            priceDecimals,
            sizeDecimals,
        };
    }
    ensurePositivePrecision(value, decimals) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            const digits = Math.max(0, decimals ?? decimalsOf(value));
            return Number(value.toFixed(digits));
        }
        if (typeof decimals === "number" && decimals >= 0) {
            const fallback = Math.pow(10, -decimals);
            const digits = Math.max(0, decimals);
            return Number(fallback.toFixed(digits));
        }
        return 0;
    }
    quantizePrice(value, tick, decimals) {
        if (!Number.isFinite(value))
            return value;
        let result = value;
        if (Number.isFinite(tick) && tick > 0) {
            const ratio = value / tick;
            const rounded = Math.round(ratio);
            const quantized = rounded * tick;
            const digits = Math.max(0, decimals ?? decimalsOf(tick));
            result = Number(quantized.toFixed(digits));
        }
        else if (typeof decimals === "number" && decimals >= 0) {
            result = Number(value.toFixed(decimals));
        }
        if (typeof decimals === "number" && decimals >= 0) {
            result = Number(result.toFixed(decimals));
        }
        return result;
    }
    quantizeQuantity(value, step, decimals) {
        if (!Number.isFinite(value))
            return value;
        const absValue = Math.abs(value);
        let result = absValue;
        if (Number.isFinite(step) && step > 0) {
            const ratio = absValue / step;
            const floored = Math.floor(ratio + 1e-12) * step;
            const digits = Math.max(0, decimals ?? decimalsOf(step));
            result = Number(floored.toFixed(digits));
            if (result <= 0 && absValue > 0) {
                const fallback = Number(step.toFixed(digits));
                if (fallback > 0) {
                    result = fallback;
                }
            }
        }
        else if (typeof decimals === "number" && decimals >= 0) {
            result = Number(absValue.toFixed(decimals));
        }
        if (typeof decimals === "number" && decimals >= 0) {
            result = Number(result.toFixed(decimals));
        }
        return result;
    }
}
