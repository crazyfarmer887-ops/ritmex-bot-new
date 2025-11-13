import { DEFAULT_LIGHTER_ENVIRONMENT, LIGHTER_HOSTS } from "./constants";
export class LighterHttpClient {
    baseUrl;
    priceProtection;
    fetcher;
    constructor(options = {}) {
        const env = options.environment ?? DEFAULT_LIGHTER_ENVIRONMENT;
        const host = options.baseUrl ?? LIGHTER_HOSTS[env]?.rest;
        if (!host) {
            throw new Error(`Unknown Lighter environment: ${env}`);
        }
        this.baseUrl = host.replace(/\/$/, "");
        this.priceProtection = options.priceProtection;
        this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
        if (!this.fetcher) {
            throw new Error("Global fetch is not available; provide a custom fetch implementation");
        }
    }
    async getOrderBooks() {
        const response = await this.get("/api/v1/orderBooks");
        return response.order_books ?? [];
    }
    async getExchangeStats() {
        const response = await this.get("/api/v1/exchangeStats");
        const stats = response.order_book_stats ?? [];
        return stats.map((entry) => ({
            market_id: entry.market_id,
            symbol: entry.symbol,
            index_price: entry.index_price ?? entry.mark_price ?? entry.last_trade_price,
            mark_price: entry.mark_price ?? entry.last_trade_price,
            last_trade_price: entry.last_trade_price,
            open_interest: entry.open_interest ?? "0",
            daily_base_token_volume: entry.daily_base_token_volume,
            daily_quote_token_volume: entry.daily_quote_token_volume,
            daily_price_low: entry.daily_price_low,
            daily_price_high: entry.daily_price_high,
            daily_price_change: entry.daily_price_change,
            current_funding_rate: entry.current_funding_rate,
            funding_rate: entry.funding_rate,
            funding_timestamp: entry.funding_timestamp,
        }));
    }
    async getAccountDetails(accountIndex, authToken, options = {}) {
        const query = {};
        if (authToken) {
            query.auth = authToken;
        }
        const by = options.by ?? "index";
        query.by = by;
        if (options.value !== undefined) {
            query.value = options.value;
        }
        else if (by === "index") {
            query.value = accountIndex;
        }
        const response = await this.get("/api/v1/account", {
            query,
            headers: authToken ? { Authorization: authToken } : undefined,
            tolerateNotFound: true,
        });
        return response.account ?? null;
    }
    async getCandlesticks(params) {
        const response = await this.get("/api/v1/candlesticks", {
            query: {
                market_id: params.marketId,
                resolution: params.resolution,
                count_back: params.countBack,
                start_timestamp: params.startTimestamp,
                end_timestamp: params.endTimestamp,
                set_timestamp_to_end: params.setTimestampToEnd ?? true,
            },
        });
        return (response.candlesticks ?? []).map((entry) => ({
            start_timestamp: entry.start_timestamp ?? entry.timestamp ?? 0,
            end_timestamp: entry.end_timestamp ??
                (entry.start_timestamp ?? entry.timestamp ?? 0) + 1,
            open: String(entry.open ?? 0),
            high: String(entry.high ?? 0),
            low: String(entry.low ?? 0),
            close: String(entry.close ?? 0),
            base_token_volume: String(entry.base_token_volume ?? 0),
            quote_token_volume: String(entry.quote_token_volume ?? 0),
            trades: entry.trades,
        }));
    }
    async getNextNonce(accountIndex, apiKeyIndex) {
        const response = await this.get("/api/v1/nextNonce", {
            query: {
                account_index: accountIndex,
                api_key_index: apiKeyIndex,
            },
        });
        if (typeof response.nonce !== "number") {
            throw new Error("Lighter nextNonce response missing nonce");
        }
        return BigInt(response.nonce);
    }
    async sendTransaction(txType, txInfo, options = {}) {
        const form = new FormData();
        form.set("tx_type", String(txType));
        form.set("tx_info", txInfo);
        const priceProtection = options.priceProtection ?? this.priceProtection;
        form.set("price_protection", String(priceProtection ?? false));
        return this.postForm("/api/v1/sendTx", form, options.authToken);
    }
    async get(path, options = {}) {
        const url = new URL(path, `${this.baseUrl}`);
        if (options.query) {
            for (const [key, value] of Object.entries(options.query)) {
                if (value === undefined || value === null)
                    continue;
                url.searchParams.set(key, String(value));
            }
        }
        const requestUrl = url.toString();
        const response = await this.fetcher(requestUrl, {
            method: "GET",
            headers: {
                "Accept": "application/json",
                ...this.cleanHeaders(options.headers),
            },
        });
        if (options.tolerateNotFound && response.status === 404) {
            return { code: 404 };
        }
        return this.parseResponse(response, requestUrl);
    }
    async post(path, body, authToken) {
        const requestUrl = new URL(path, `${this.baseUrl}`).toString();
        const response = await this.fetcher(requestUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...(authToken ? { Authorization: authToken } : {}),
            },
            body: JSON.stringify(body),
        });
        return this.parseResponse(response, requestUrl);
    }
    async postForm(path, form, authToken) {
        const requestUrl = new URL(path, `${this.baseUrl}`).toString();
        const response = await this.fetcher(requestUrl, {
            method: "POST",
            headers: {
                Accept: "application/json",
                ...(authToken ? { Authorization: authToken } : {}),
            },
            body: form,
        });
        return this.parseResponse(response, requestUrl);
    }
    cleanHeaders(headers) {
        if (!headers)
            return undefined;
        const result = {};
        for (const [key, value] of Object.entries(headers)) {
            if (value)
                result[key] = value;
        }
        return Object.keys(result).length ? result : undefined;
    }
    async parseResponse(response, requestUrl) {
        const text = await response.text();
        if (!response.ok) {
            const snippet = text ? truncateBody(text) : response.statusText;
            throw new Error(`Lighter HTTP ${response.status} ${response.statusText} (${requestUrl}): ${snippet}`);
        }
        if (!text) {
            throw new Error(`Empty Lighter response body (${requestUrl})`);
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (error) {
            throw new Error(`Failed to parse Lighter response (${requestUrl}): ${String(error)}. Body: ${truncateBody(text)}`);
        }
        if (typeof parsed.code === "number" && parsed.code !== 200) {
            throw new Error(parsed.message ?? `Lighter API returned code ${parsed.code} (${requestUrl})`);
        }
        return parsed;
    }
}
function truncateBody(body, limit = 200) {
    return body.length > limit ? `${body.slice(0, limit)}…` : body;
}
