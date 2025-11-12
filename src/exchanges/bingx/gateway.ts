import ccxt, {
  type Balances,
  type Order as CcxtOrder,
  type OrderBook as CcxtOrderBook,
  type Ticker as CcxtTicker,
} from "ccxt";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterKline,
  AsterOrder,
  AsterTicker,
  CreateOrderParams,
  OrderType,
  PositionSide,
} from "../types";
import type {
  AccountListener,
  DepthListener,
  KlineListener,
  OrderListener,
  TickerListener,
} from "../adapter";

const ORDER_STATUS_MAP: Record<string, string> = {
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

const ACCOUNT_POLL_INTERVAL_MS = 3_000;
const ORDER_POLL_INTERVAL_MS = 1_500;
const DEPTH_POLL_INTERVAL_MS = 1_000;
const TICKER_POLL_INTERVAL_MS = 2_000;
const KLINE_POLL_INTERVAL_MS = 5_000;

export interface BingxGatewayOptions {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  leverage: number;
  marginMode?: string;
  testnet?: boolean;
  logger?: (context: string, error: unknown) => void;
}

export class BingxGateway {
  private readonly exchange: any;
  private readonly symbol: string;
  private readonly leverage: number;
  private readonly marginMode: string;
  private readonly logger: (context: string, error: unknown) => void;
  private marketSymbol: string;
  private market: any | null = null;

  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private readonly accountListeners = new Set<AccountListener>();
  private readonly orderListeners = new Set<OrderListener>();
  private readonly depthListeners = new Set<DepthListener>();
  private readonly tickerListeners = new Set<TickerListener>();
  private readonly klineListeners = new Map<string, Set<KlineListener>>();

  private accountPollTimer: ReturnType<typeof setInterval> | null = null;
  private orderPollTimer: ReturnType<typeof setInterval> | null = null;
  private depthPollTimer: ReturnType<typeof setInterval> | null = null;
  private tickerPollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly klinePollTimers = new Map<string, ReturnType<typeof setInterval>>();

  private lastAccountSnapshot: AsterAccountSnapshot | null = null;
  private readonly localOrders = new Map<string, AsterOrder>();

  constructor(options: BingxGatewayOptions) {
    const normalizedSymbol = options.symbol.toUpperCase();
    if (!normalizedSymbol.includes("BTC")) {
      throw new Error(`BingX gateway currently supports only BTC markets, received ${options.symbol}`);
    }
    this.symbol = normalizedSymbol;
    this.leverage = Number.isFinite(options.leverage) && options.leverage > 0 ? options.leverage : 50;
    this.marginMode = (options.marginMode ?? "ISOLATED").toUpperCase();
    this.logger = options.logger ?? ((context, error) => console.error(`[BingxGateway] ${context}:`, error));
    this.marketSymbol = this.symbol;

    this.exchange = new (ccxt as any).bingx({
      apiKey: options.apiKey,
      secret: options.apiSecret,
      enableRateLimit: true,
      timeout: 30_000,
      options: {
        defaultType: "swap",
      },
    });

    if (options.testnet) {
      try {
        if (typeof this.exchange.setSandboxMode === "function") {
          this.exchange.setSandboxMode(true);
        }
      } catch (error) {
        this.logger("setSandboxMode", error);
      }
    }
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize().catch((error) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  onAccount(callback: AccountListener): void {
    this.accountListeners.add(callback);
    if (this.lastAccountSnapshot) {
      try {
        callback(this.lastAccountSnapshot);
      } catch (error) {
        this.logger("accountReplay", error);
      }
    }
    this.startAccountPolling();
  }

  onOrders(callback: OrderListener): void {
    this.orderListeners.add(callback);
    if (this.localOrders.size) {
      try {
        callback(Array.from(this.localOrders.values()));
      } catch (error) {
        this.logger("ordersReplay", error);
      }
    }
    this.startOrderPolling();
  }

  onDepth(callback: DepthListener): void {
    this.depthListeners.add(callback);
    this.startDepthPolling();
  }

  onTicker(callback: TickerListener): void {
    this.tickerListeners.add(callback);
    this.startTickerPolling();
  }

  watchKlines(interval: string, callback: KlineListener): void {
    if (!this.klineListeners.has(interval)) {
      this.klineListeners.set(interval, new Set());
    }
    this.klineListeners.get(interval)!.add(callback);
    this.startKlinePolling(interval);
  }

  async createOrder(params: CreateOrderParams): Promise<AsterOrder> {
    await this.ensureInitialized();
    const symbol = this.marketSymbol;
    const normalizedType = this.normalizeOrderType(params.type);
    const side = params.side.toLowerCase();
    const amount = params.quantity;
    let price = params.price;

    const extraParams: Record<string, unknown> = {};
    if (params.timeInForce === "GTX") {
      extraParams.postOnly = true;
      extraParams.timeInForce = "GTC";
    } else if (params.timeInForce) {
      extraParams.timeInForce = params.timeInForce;
    }
    if (params.reduceOnly !== undefined) {
      extraParams.reduceOnly = params.reduceOnly === "true";
    }
    if (params.closePosition !== undefined) {
      extraParams.closePosition = params.closePosition === "true";
    }
    extraParams.positionSide = "BOTH";
    extraParams.marginMode = this.marginMode.toLowerCase();

    let ccxtType: string;
    if (normalizedType === "STOP_MARKET") {
      ccxtType = "market";
      price = undefined;
      if (params.stopPrice !== undefined) {
        extraParams.triggerPrice = params.stopPrice;
        extraParams.stopPrice = params.stopPrice;
        extraParams.triggerBy = extraParams.triggerBy ?? "MarkPrice";
      }
    } else if (normalizedType === "MARKET") {
      ccxtType = "market";
      price = undefined;
    } else {
      ccxtType = "limit";
    }

    if (params.stopPrice !== undefined && normalizedType !== "STOP_MARKET") {
      extraParams.stopPrice = params.stopPrice;
    }

    const order = await this.exchange.createOrder(symbol, ccxtType, side, amount, price, extraParams);
    const mapped = this.mapOrder(order as CcxtOrder);
    this.localOrders.set(String(mapped.orderId), mapped);
    this.emitOrders();
    return mapped;
  }

  async cancelOrder(params: { orderId: number | string }): Promise<void> {
    await this.ensureInitialized();
    await this.exchange.cancelOrder(params.orderId.toString(), this.marketSymbol);
    this.localOrders.delete(String(params.orderId));
    this.emitOrders();
  }

  async cancelOrders(params: { orderIdList: Array<number | string> }): Promise<void> {
    await this.ensureInitialized();
    await Promise.all(
      params.orderIdList.map((orderId) => this.exchange.cancelOrder(orderId.toString(), this.marketSymbol))
    );
    for (const id of params.orderIdList) {
      this.localOrders.delete(String(id));
    }
    this.emitOrders();
  }

  async cancelAllOrders(): Promise<void> {
    await this.ensureInitialized();
    try {
      if (typeof this.exchange.cancelAllOrders === "function") {
        await this.exchange.cancelAllOrders(this.marketSymbol);
        this.localOrders.clear();
        this.emitOrders();
        return;
      }
    } catch (error) {
      this.logger("cancelAllOrdersFallback", error);
    }
    const openOrders = await this.exchange.fetchOpenOrders(this.marketSymbol);
    for (const order of openOrders) {
      await this.exchange.cancelOrder(order.id as string, this.marketSymbol);
      this.localOrders.delete(String(order.id));
    }
    this.emitOrders();
  }

  // ---- Initialization ------------------------------------------------------

  private async doInitialize(): Promise<void> {
    await this.exchange.loadMarkets();
    const market = this.findMarket(this.symbol);
    if (!market) {
      throw new Error(`Symbol ${this.symbol} not found in BingX markets`);
    }
    this.market = market;
    this.marketSymbol = market.symbol;

    await this.configureLeverage();
    this.initialized = true;
  }

  private async configureLeverage(): Promise<void> {
    try {
      if (typeof this.exchange.setMarginMode === "function") {
        await this.exchange.setMarginMode(this.marginMode.toLowerCase(), this.marketSymbol);
      }
    } catch (error) {
      this.logger("setMarginMode", error);
    }
    try {
      if (typeof this.exchange.setLeverage === "function") {
        await this.exchange.setLeverage(this.leverage, this.marketSymbol, {
          marginMode: this.marginMode.toLowerCase(),
        });
      }
    } catch (error) {
      this.logger("setLeverage", error);
    }
  }

  private findMarket(requested: string): any | null {
    const normalize = (value: string | undefined | null): string =>
      (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const normalized = normalize(requested);
    const markets = Object.values(this.exchange.markets) as Array<any>;
    for (const market of markets) {
      if (normalize(market.id) === normalized) return market;
    }
    for (const market of markets) {
      if (normalize(market.symbol) === normalized) return market;
    }
    for (const market of markets) {
      const combo = `${market.base ?? ""}${market.quote ?? ""}${market.contract ? "PERP" : ""}`;
      if (normalize(combo) === normalized) return market;
    }
    return null;
  }

  // ---- Polling -------------------------------------------------------------

  private startAccountPolling(): void {
    if (this.accountPollTimer) return;
    const poll = async () => {
      try {
        await this.ensureInitialized();
        const snapshot = await this.fetchAccountSnapshot();
        this.lastAccountSnapshot = snapshot;
        this.emitAccount(snapshot);
      } catch (error) {
        this.logger("accountPoll", error);
      }
    };
    void poll();
    this.accountPollTimer = setInterval(poll, ACCOUNT_POLL_INTERVAL_MS);
  }

  private startOrderPolling(): void {
    if (this.orderPollTimer) return;
    const poll = async () => {
      try {
        await this.ensureInitialized();
        const orders = await this.exchange.fetchOpenOrders(this.marketSymbol);
        this.localOrders.clear();
        for (const order of orders) {
          const mapped = this.mapOrder(order as CcxtOrder);
          this.localOrders.set(String(mapped.orderId), mapped);
        }
        this.emitOrders();
      } catch (error) {
        this.logger("orderPoll", error);
      }
    };
    void poll();
    this.orderPollTimer = setInterval(poll, ORDER_POLL_INTERVAL_MS);
  }

  private startDepthPolling(): void {
    if (this.depthPollTimer) return;
    const poll = async () => {
      try {
        await this.ensureInitialized();
        const orderbook = await this.exchange.fetchOrderBook(this.marketSymbol, 50);
        const mapped = this.mapOrderBookToDepth(orderbook as CcxtOrderBook);
        this.emitDepth(mapped);
      } catch (error) {
        this.logger("depthPoll", error);
      }
    };
    void poll();
    this.depthPollTimer = setInterval(poll, DEPTH_POLL_INTERVAL_MS);
  }

  private startTickerPolling(): void {
    if (this.tickerPollTimer) return;
    const poll = async () => {
      try {
        await this.ensureInitialized();
        const ticker = await this.exchange.fetchTicker(this.marketSymbol);
        const mapped = this.mapTickerToAsterTicker(ticker as CcxtTicker);
        this.emitTicker(mapped);
      } catch (error) {
        this.logger("tickerPoll", error);
      }
    };
    void poll();
    this.tickerPollTimer = setInterval(poll, TICKER_POLL_INTERVAL_MS);
  }

  private startKlinePolling(interval: string): void {
    if (this.klinePollTimers.has(interval)) return;
    const poll = async () => {
      try {
        await this.ensureInitialized();
        const ohlcv = await this.exchange.fetchOHLCV(this.marketSymbol, interval, undefined, 100);
        const klines = (ohlcv as number[][])
          .filter((row) => Array.isArray(row) && row.length >= 6)
          .map((row) => this.mapOHLCVToKline(row as [number, number, number, number, number, number], interval));
        this.emitKlines(interval, klines);
      } catch (error) {
        this.logger(`klinePoll:${interval}`, error);
      }
    };
    void poll();
    this.klinePollTimers.set(interval, setInterval(poll, KLINE_POLL_INTERVAL_MS));
  }

  // ---- Fetch helpers -------------------------------------------------------

  private async fetchAccountSnapshot(): Promise<AsterAccountSnapshot> {
    const now = Date.now();
    const [balance, positions] = await Promise.all([
      this.exchange.fetchBalance({ type: "swap" }),
      this.exchange.fetchPositions([this.marketSymbol]).catch((error: unknown) => {
        this.logger("fetchPositions", error);
        return [];
      }),
    ]);
    const assets = this.normalizeAssets(balance as Balances, now);
    const normalizedPositions = this.normalizePositions(positions ?? [], now);
    const totalWalletBalance = this.sumStrings(assets.map((asset) => asset.walletBalance));
    const totalUnrealized = this.sumStrings(normalizedPositions.map((position) => position.unrealizedProfit ?? "0"));
    const availableBalance = this.sumStrings(assets.map((asset) => asset.availableBalance));

    const snapshot: AsterAccountSnapshot = {
      canTrade: true,
      canDeposit: true,
      canWithdraw: true,
      updateTime: now,
      totalWalletBalance,
      totalUnrealizedProfit: totalUnrealized,
      positions: normalizedPositions,
      assets,
      availableBalance,
      maxWithdrawAmount: availableBalance,
    };

    snapshot.totalMarginBalance = this.addStrings(totalWalletBalance, totalUnrealized);
    snapshot.totalCrossWalletBalance = totalWalletBalance;
    snapshot.totalCrossUnPnl = totalUnrealized;

    return snapshot;
  }

  private normalizeAssets(balance: Balances, now: number): AsterAccountSnapshot["assets"] {
    const metaKeys = new Set(["free", "used", "total", "info", "timestamp", "datetime", "debt"]);
    const assets: AsterAccountSnapshot["assets"] = [];

    const quote = this.market?.quote ?? "USDT";
    const free = this.extractBalance(balance, quote, "free");
    const total = this.extractBalance(balance, quote, "total");

    assets.push({
      asset: quote,
      walletBalance: total,
      availableBalance: free,
      updateTime: now,
    });

    for (const [currency, value] of Object.entries(balance)) {
      if (metaKeys.has(currency)) continue;
      if (currency === quote) continue;
      if (!value || typeof value !== "object") continue;
      const walletBalance = this.toStringAmount((value as any).total ?? "0");
      const availableBalance = this.toStringAmount((value as any).free ?? walletBalance);
      assets.push({ asset: currency, walletBalance, availableBalance, updateTime: now });
    }

    return assets;
  }

  private normalizePositions(rawPositions: any[], now: number): AsterAccountSnapshot["positions"] {
    if (!Array.isArray(rawPositions)) return [];
    const positions: AsterAccountSnapshot["positions"] = [];
    for (const raw of rawPositions) {
      const mapped = this.mapPosition(raw, now);
      if (mapped) positions.push(mapped);
    }
    return positions;
  }

  private mapPosition(raw: any, now: number) {
    const info = raw?.info ?? raw ?? {};
    const size = this.toNumber(raw?.contracts ?? raw?.positionAmt ?? info.positionAmt ?? info.position ?? 0);
    const sideRaw = String(raw?.side ?? info.side ?? "").toUpperCase();
    if (!Number.isFinite(size) || size === 0) return null;
    const isShort = sideRaw.includes("SHORT") || info.positionSide === "SHORT";
    const isLong = sideRaw.includes("LONG") || info.positionSide === "LONG";
    const signedAmount = isShort ? -Math.abs(size) : Math.abs(size);
    const entryPrice = this.toStringAmount(raw?.entryPrice ?? info.entryPrice ?? "0");
    const unrealized = this.toStringAmount(
      raw?.unrealizedPnl ?? info.unrealizedPnl ?? info.pnlUnrealized ?? info.unrealizedProfit ?? "0"
    );
    const markPrice = this.toOptionalString(raw?.markPrice ?? info.markPrice);
    const liquidationPrice = this.toOptionalString(raw?.liquidationPrice ?? info.liquidationPrice);
    const leverage = this.toOptionalString(raw?.leverage ?? info.leverage) ?? String(this.leverage);

    let positionSide: PositionSide = "BOTH";
    if (isShort) positionSide = "SHORT";
    else if (isLong) positionSide = "LONG";

    return {
      symbol: this.symbol,
      positionAmt: signedAmount.toString(),
      entryPrice,
      unrealizedProfit: unrealized,
      positionSide,
      updateTime: now,
      markPrice,
      liquidationPrice,
      leverage,
      marginType: this.marginMode,
    };
  }

  private mapOrderBookToDepth(orderbook: CcxtOrderBook): AsterDepth {
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

  private mapTickerToAsterTicker(ticker: CcxtTicker): AsterTicker {
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

  private mapOHLCVToKline(candle: [number, number, number, number, number, number], interval: string): AsterKline {
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

  private mapOrder(order: CcxtOrder): AsterOrder {
    const info = (order.info ?? {}) as Record<string, unknown>;
    const side = (order.side ?? "buy").toUpperCase() === "SELL" ? "SELL" : "BUY";
    let type = this.normalizeOrderType(order.type ?? (info.o as string)) as OrderType;
    if (order.triggerPrice != null || info.triggerPrice != null || info.stopLossTriggerPrice != null) {
      type = "STOP_MARKET";
    }
    const status = this.normalizeStatus(order.status ?? (info.status as string));
    const price = this.pickString([order.price, info.price]);
    const quantity = this.pickString([order.amount, info.quantity, info.triggerQuantity]);
    const executed = this.pickString([order.filled, info.executedQuantity, info.executedBaseQuantity]);
    const stopPrice = this.pickString([order.stopPrice, info.triggerPrice, info.stopLossTriggerPrice]);
    const avgPrice = this.pickString([order.average, info.avgPrice]);
    const cumQuote = this.pickString([order.cost, info.executedQuoteQuantity]);
    const timestamp = order.timestamp ?? Date.now();
    const reduceOnly = Boolean(order.reduceOnly ?? info.reduceOnly ?? false);

    return {
      orderId: String(order.id ?? ""),
      clientOrderId: (order.clientOrderId as any as string) || "",
      symbol: this.symbol,
      side,
      type,
      status,
      price,
      origQty: quantity,
      executedQty: executed,
      stopPrice,
      time: timestamp,
      updateTime: order.lastTradeTimestamp ?? timestamp,
      reduceOnly,
      closePosition: Boolean(info.closePosition ?? false),
      avgPrice,
      cumQuote,
      positionSide: "BOTH",
    };
  }

  // ---- Emitters ------------------------------------------------------------

  private emitAccount(snapshot: AsterAccountSnapshot): void {
    for (const listener of this.accountListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger("accountEmit", error);
      }
    }
  }

  private emitOrders(): void {
    if (!this.orderListeners.size) return;
    const orders = Array.from(this.localOrders.values());
    for (const listener of this.orderListeners) {
      try {
        listener(orders);
      } catch (error) {
        this.logger("ordersEmit", error);
      }
    }
  }

  private emitDepth(depth: AsterDepth): void {
    for (const listener of this.depthListeners) {
      try {
        listener(depth);
      } catch (error) {
        this.logger("depthEmit", error);
      }
    }
  }

  private emitTicker(ticker: AsterTicker): void {
    for (const listener of this.tickerListeners) {
      try {
        listener(ticker);
      } catch (error) {
        this.logger("tickerEmit", error);
      }
    }
  }

  private emitKlines(interval: string, klines: AsterKline[]): void {
    const listeners = this.klineListeners.get(interval);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(klines);
      } catch (error) {
        this.logger(`klinesEmit:${interval}`, error);
      }
    }
  }

  getMarketInfo(): any | null {
    return this.market;
  }

  // ---- Utilities -----------------------------------------------------------

  private extractBalance(balance: Balances, currency: string, field: "free" | "total"): string {
    const numeric = Number((balance?.[currency] as any)?.[field]);
    if (Number.isFinite(numeric)) {
      return numeric.toString();
    }
    const fallback = Number(balance?.[field]?.[currency as any]);
    if (Number.isFinite(fallback)) {
      return fallback.toString();
    }
    return "0";
  }

  private toStringAmount(value: unknown): string {
    if (value === undefined || value === null) return "0";
    if (typeof value === "string") {
      return value.trim() === "" ? "0" : value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value.toString() : "0";
    }
    return "0";
  }

  private toOptionalString(value: unknown): string | undefined {
    const result = this.toStringAmount(value);
    return result === "0" ? undefined : result;
  }

  private toNumber(value: unknown): number {
    const parsed = Number(this.toStringAmount(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private sumStrings(values: string[]): string {
    let total = 0;
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) total += parsed;
    }
    return total.toString();
  }

  private addStrings(a: string, b: string): string {
    const sum = Number(a) + Number(b);
    return Number.isFinite(sum) ? sum.toString() : "0";
  }

  private normalizeStatus(status?: string): string {
    if (!status) return "UNKNOWN";
    const key = status.replace(/[^a-zA-Z]/g, "").toUpperCase();
    return (
      ORDER_STATUS_MAP[key] ??
      status
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/\s+/g, "_")
        .toUpperCase()
    );
  }

  private normalizeOrderType(type?: string): string {
    if (!type) return "LIMIT";
    const upper = type.toUpperCase();
    if (upper.includes("STOP")) return "STOP_MARKET";
    if (upper === "MARKET" || upper === "LIMIT") return upper;
    return upper;
  }

  private pickString(values: Array<unknown>): string {
    for (const value of values) {
      if (value === undefined || value === null) continue;
      const asString = this.toStringAmount(value);
      if (asString !== "0" || Number(value) === 0) return asString;
    }
    return "0";
  }

  private intervalToMs(interval: string): number {
    const match = /^(\d+)([smhdw])$/i.exec(interval);
    if (!match) return 60_000;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case "s":
        return value * 1_000;
      case "m":
        return value * 60_000;
      case "h":
        return value * 3_600_000;
      case "d":
        return value * 86_400_000;
      case "w":
        return value * 604_800_000;
      default:
        return 60_000;
    }
  }
}
