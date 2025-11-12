import ccxt, {
  type Balances,
  type Order as CcxtOrder,
  type OrderBook as CcxtOrderBook,
  type Ticker as CcxtTicker,
} from "ccxt";
import type {
  AccountListener,
  DepthListener,
  KlineListener,
  OrderListener,
  TickerListener,
} from "../adapter";
import type {
  AsterAccountSnapshot,
  AsterDepth,
  AsterKline,
  AsterOrder,
  AsterTicker,
  CreateOrderParams,
  OrderType,
} from "../types";

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

export interface BingxGatewayOptions {
  apiKey: string;
  apiSecret: string;
  password?: string;
  symbol: string;
  leverage?: number;
  sandbox?: boolean;
  defaultType?: string;
  subType?: string;
  logger?: (context: string, error: unknown) => void;
}

export class BingxGateway {
  private readonly exchange: any;
  private readonly symbol: string;
  private marketSymbol: string;
  private marketId: string;
  private isContractMarket = false;
  private readonly leverage: number | null;
  private readonly logger: (context: string, error: unknown) => void;

  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private readonly accountListeners = new Set<AccountListener>();
  private readonly orderListeners = new Set<OrderListener>();
  private readonly depthListeners = new Set<DepthListener>();
  private readonly tickerListeners = new Set<TickerListener>();
  private readonly klineListeners = new Map<
    string,
    { callback: KlineListener; timer: ReturnType<typeof setInterval> | null }
  >();

  private accountPollTimer: ReturnType<typeof setInterval> | null = null;
  private orderPollTimer: ReturnType<typeof setInterval> | null = null;
  private depthPollTimer: ReturnType<typeof setInterval> | null = null;
  private tickerPollTimer: ReturnType<typeof setInterval> | null = null;

  private readonly localOrders = new Map<string, AsterOrder>();
  private lastBalanceSnapshot: AsterAccountSnapshot | null = null;

  constructor(options: BingxGatewayOptions) {
    this.symbol = options.symbol.toUpperCase();
    this.marketSymbol = this.symbol;
    this.marketId = this.symbol;
    this.logger = options.logger ?? ((context, error) => console.error(`[BingxGateway] ${context}:`, error));
    this.leverage = Number.isFinite(options.leverage ?? Number(process.env.BINGX_LEVERAGE))
      ? Number(options.leverage ?? Number(process.env.BINGX_LEVERAGE))
      : 50;

    const ExchangeCtor = (ccxt as any).bingx;
    if (!ExchangeCtor) {
      throw new Error("ccxt.bingx exchange is not available. Please ensure ccxt dependency includes BingX.");
    }

    this.exchange = new ExchangeCtor({
      apiKey: options.apiKey,
      secret: options.apiSecret,
      password: options.password ?? process.env.BINGX_PASSWORD,
      enableRateLimit: true,
      options: {
        defaultType: options.defaultType ?? process.env.BINGX_DEFAULT_TYPE ?? "swap",
        defaultSubType: options.subType ?? process.env.BINGX_SUB_TYPE,
      },
    });

    const sandboxRequested =
      options.sandbox ??
      this.parseOptionalBoolean(process.env.BINGX_SANDBOX) ??
      this.parseOptionalBoolean(process.env.BINGX_TESTNET);
    if (sandboxRequested && typeof this.exchange.setSandboxMode === "function") {
      this.exchange.setSandboxMode(true);
    }
  }

  async ensureInitialized(symbol?: string): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize(symbol)
      .then(() => {
        this.initialized = true;
      })
      .finally(() => {
        this.initPromise = null;
      });
    return this.initPromise;
  }

  onAccount(callback: AccountListener): void {
    this.accountListeners.add(callback);
    if (this.lastBalanceSnapshot) {
      try {
        callback(this.lastBalanceSnapshot);
      } catch (error) {
        this.logger("accountReplay", error);
      }
    }
    void this.ensureInitialized(this.symbol);
    this.startAccountPolling();
  }

  onOrders(callback: OrderListener): void {
    this.orderListeners.add(callback);
    if (this.localOrders.size > 0) {
      try {
        callback(Array.from(this.localOrders.values()).map((order) => ({ ...order })));
      } catch (error) {
        this.logger("ordersReplay", error);
      }
    }
    void this.ensureInitialized(this.symbol);
    this.startOrderPolling();
  }

  onDepth(_symbol: string, callback: DepthListener): void {
    this.depthListeners.add(callback);
    void this.ensureInitialized(this.symbol);
    this.startDepthPolling();
  }

  onTicker(_symbol: string, callback: TickerListener): void {
    this.tickerListeners.add(callback);
    void this.ensureInitialized(this.symbol);
    this.startTickerPolling();
  }

  watchKlines(_symbol: string, interval: string, callback: KlineListener): void {
    const normalizedInterval = this.normalizeTimeframe(interval);
    const existing = this.klineListeners.get(normalizedInterval);
    if (existing) {
      this.klineListeners.set(normalizedInterval, { callback, timer: existing.timer });
      return;
    }
    this.klineListeners.set(normalizedInterval, { callback, timer: null });
    void this.ensureInitialized(this.symbol);
    this.startKlinePolling(normalizedInterval);
  }

  async createOrder(params: CreateOrderParams): Promise<AsterOrder> {
    await this.ensureInitialized(this.symbol);
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
    if (params.closePosition === "true") {
      extraParams.closePosition = true;
    }

    let ccxtType: string;
    if (normalizedType === "STOP_MARKET") {
      ccxtType = "market";
      price = undefined;
      if (params.stopPrice !== undefined) {
        extraParams.stopPrice = params.stopPrice;
        extraParams.triggerPrice = params.stopPrice;
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

    const order = (await this.exchange.createOrder(symbol, ccxtType, side, amount, price, extraParams)) as CcxtOrder;
    const mapped = this.mapRestOrder(order);
    this.localOrders.set(String(mapped.orderId), mapped);
    this.emitOrders();
    return mapped;
  }

  async cancelOrder(params: { orderId: number | string }): Promise<void> {
    await this.ensureInitialized(this.symbol);
    await this.exchange.cancelOrder(params.orderId.toString(), this.marketSymbol);
    this.localOrders.delete(String(params.orderId));
    this.emitOrders();
  }

  async cancelOrders(params: { orderIdList: Array<number | string> }): Promise<void> {
    await this.ensureInitialized(this.symbol);
    await Promise.all(
      params.orderIdList.map((orderId) => this.exchange.cancelOrder(String(orderId), this.marketSymbol).catch((error: unknown) => {
        this.logger("cancelOrder", error);
      }))
    );
    for (const orderId of params.orderIdList) {
      this.localOrders.delete(String(orderId));
    }
    this.emitOrders();
  }

  async cancelAllOrders(): Promise<void> {
    await this.ensureInitialized(this.symbol);
    try {
      if (typeof this.exchange.cancelAllOrders === "function") {
        await this.exchange.cancelAllOrders(this.marketSymbol);
        this.localOrders.clear();
        this.emitOrders();
        return;
      }
    } catch (error) {
      this.logger("cancelAllOrders", error);
    }

    const openOrders: CcxtOrder[] = await this.exchange.fetchOpenOrders(this.marketSymbol).catch((error: unknown) => {
      this.logger("fetchOpenOrders", error);
      return [];
    });
    for (const order of openOrders) {
      try {
        await this.exchange.cancelOrder(order.id, this.marketSymbol);
      } catch (error) {
        this.logger("cancelOpenOrder", error);
      }
      this.localOrders.delete(String(order.id));
    }
    this.emitOrders();
  }

  // ---- Initialization helpers ---------------------------------------------

  private async doInitialize(symbol?: string): Promise<void> {
    await this.exchange.loadMarkets();
    const requested = (symbol ?? this.symbol).toUpperCase();
    const market = this.findMarket(requested);
    if (!market) {
      throw new Error(`Symbol ${requested} not found in BingX markets`);
    }
    this.marketSymbol = market.symbol;
    this.marketId = market.id;
    this.isContractMarket = Boolean(market.contract);
    await this.ensureTradingSettings();
  }

  private async ensureTradingSettings(): Promise<void> {
    if (!this.isContractMarket) return;
    try {
      if (typeof this.exchange.setMarginMode === "function") {
        await this.exchange.setMarginMode("cross", this.marketSymbol);
      }
    } catch (error) {
      this.logger("setMarginMode", error);
    }
    try {
      if (typeof this.exchange.setPositionMode === "function") {
        await this.exchange.setPositionMode(false, this.marketSymbol);
      }
    } catch (error) {
      this.logger("setPositionMode", error);
    }
    if (this.leverage && Number.isFinite(this.leverage)) {
      try {
        if (typeof this.exchange.setLeverage === "function") {
          await this.exchange.setLeverage(this.leverage, this.marketSymbol);
        }
      } catch (error) {
        this.logger("setLeverage", error);
      }
    }
  }

  private findMarket(requested: string): any | null {
    const normalize = (value: string | undefined | null): string =>
      (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const normalized = normalize(requested);
    const markets = Object.values(this.exchange.markets ?? {}) as Array<any>;
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
        const snapshot = await this.fetchAccountSnapshot();
        this.lastBalanceSnapshot = snapshot;
        this.emitAccount(snapshot);
      } catch (error) {
        this.logger("accountPoll", error);
      }
    };
    void poll();
    this.accountPollTimer = setInterval(poll, 5_000);
  }

  private startOrderPolling(): void {
    if (this.orderPollTimer) return;
    const poll = async () => {
      try {
        await this.refreshOrders();
      } catch (error) {
        this.logger("orderPoll", error);
      }
    };
    void poll();
    this.orderPollTimer = setInterval(poll, 3_000);
  }

  private startDepthPolling(): void {
    if (this.depthPollTimer) return;
    const poll = async () => {
      try {
        const orderBook = (await this.exchange.fetchOrderBook(this.marketSymbol, 50)) as CcxtOrderBook;
        const depth = this.mapOrderBookToDepth(orderBook);
        for (const listener of this.depthListeners) {
          listener(depth);
        }
      } catch (error) {
        this.logger("depthPoll", error);
      }
    };
    void poll();
    this.depthPollTimer = setInterval(poll, 1_000);
  }

  private startTickerPolling(): void {
    if (this.tickerPollTimer) return;
    const poll = async () => {
      try {
        const ticker = (await this.exchange.fetchTicker(this.marketSymbol)) as CcxtTicker;
        const mapped = this.mapTickerToAsterTicker(ticker);
        for (const listener of this.tickerListeners) {
          listener(mapped);
        }
      } catch (error) {
        this.logger("tickerPoll", error);
      }
    };
    void poll();
    this.tickerPollTimer = setInterval(poll, 2_000);
  }

  private startKlinePolling(interval: string): void {
    const existing = this.klineListeners.get(interval);
    if (!existing || existing.timer) return;
    const poll = async () => {
      try {
        const ohlcv = (await this.exchange.fetchOHLCV(this.marketSymbol, interval, undefined, 100)) as number[][];
        const klines = ohlcv
          .filter((row) => Array.isArray(row) && row.length >= 6)
          .map((row) => this.mapOHLCVToKline(row as [number, number, number, number, number, number], interval));
        const listener = this.klineListeners.get(interval)?.callback;
        if (listener) {
          listener(klines);
        }
      } catch (error) {
        this.logger(`klinePoll:${interval}`, error);
      }
    };
    void poll();
    const timer = setInterval(poll, 5_000);
    this.klineListeners.set(interval, { callback: existing.callback, timer });
  }

  // ---- Fetch helpers -------------------------------------------------------

  private async fetchAccountSnapshot(): Promise<AsterAccountSnapshot> {
    await this.ensureInitialized(this.symbol);
    const [balance, positions] = await Promise.all([
      this.exchange.fetchBalance().catch((error: unknown) => {
        this.logger("fetchBalance", error);
        return {} as Balances;
      }),
      this.isContractMarket
        ? this.exchange.fetchPositions([this.marketSymbol]).catch((error: unknown) => {
            this.logger("fetchPositions", error);
            return [];
          })
        : Promise.resolve([]),
    ]);
    return this.mapBalanceToAccountSnapshotWithPositions(balance, positions ?? []);
  }

  private async refreshOrders(): Promise<void> {
    await this.ensureInitialized(this.symbol);
    const [openOrders, recentOrders] = await Promise.all([
      this.exchange.fetchOpenOrders(this.marketSymbol).catch((error: unknown) => {
        this.logger("fetchOpenOrders", error);
        return [];
      }),
      this.exchange.fetchOrders(this.marketSymbol, undefined, 200, {}).catch((error: unknown) => {
        this.logger("fetchOrders", error);
        return [];
      }),
    ]);
    const nextActive = new Map<string, AsterOrder>();
    for (const entry of [...openOrders, ...recentOrders]) {
      const mapped = this.mapRestOrder(entry as CcxtOrder);
      if (this.isTerminalStatus(mapped.status)) continue;
      nextActive.set(String(mapped.orderId), mapped);
    }
    this.localOrders.clear();
    for (const [id, order] of nextActive.entries()) {
      this.localOrders.set(id, order);
    }
    this.emitOrders();
  }

  private emitAccount(snapshot: AsterAccountSnapshot): void {
    for (const listener of this.accountListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger("emitAccount", error);
      }
    }
  }

  private emitOrders(): void {
    const snapshot = Array.from(this.localOrders.values()).map((order) => ({ ...order }));
    for (const listener of this.orderListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger("emitOrders", error);
      }
    }
  }

  // ---- Mapping helpers -----------------------------------------------------

  private mapBalanceToAccountSnapshotWithPositions(balance: Balances, rawPositions: any[]): AsterAccountSnapshot {
    const now = Date.now();
    const assets = this.normalizeAssets(balance, now);
    const positions = this.normalizePositions(rawPositions, now);
    const totalWalletBalance = this.sumStrings(assets.map((asset) => asset.walletBalance));
    const totalUnrealized = this.sumStrings(positions.map((position) => position.unrealizedProfit ?? "0"));
    const availableBalance = this.sumStrings(assets.map((asset) => asset.availableBalance));

    const snapshot: AsterAccountSnapshot = {
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

  private normalizeAssets(balance: Balances, now: number): AsterAccountSnapshot["assets"] {
    const metaKeys = new Set(["free", "used", "total", "info", "timestamp", "datetime", "debt"]);
    const assets: AsterAccountSnapshot["assets"] = [];
    for (const [currency, value] of Object.entries(balance ?? {})) {
      if (metaKeys.has(currency)) continue;
      if (!value || typeof value !== "object") continue;
      const walletBalance = this.toStringAmount((value as any).total ?? (value as any).free ?? "0");
      const availableBalance = this.toStringAmount((value as any).free ?? "0");
      assets.push({ asset: currency, walletBalance, availableBalance, updateTime: now });
    }
    return assets;
  }

  private normalizePositions(rawPositions: any[], now: number): AsterAccountSnapshot["positions"] {
    if (!Array.isArray(rawPositions)) return [];
    const positions: AsterAccountSnapshot["positions"] = [];
    for (const raw of rawPositions) {
      const info = raw?.info ?? raw ?? {};
      const quantity = this.toNumber(raw?.contracts ?? raw?.positionAmt ?? info.netExposureQuantity ?? info.positionAmt);
      if (!quantity) continue;
      const sideRaw = String(raw?.side ?? info.side ?? this.deriveSideFromExposure(info)).toLowerCase();
      const isShort = sideRaw.includes("short") || quantity < 0;
      const positionAmt = isShort ? -Math.abs(quantity) : Math.abs(quantity);
      const entryPrice = this.toStringAmount(raw?.entryPrice ?? info.entryPrice ?? "0");
      const unrealized = this.toStringAmount(raw?.unrealizedPnl ?? info.unRealizedProfit ?? info.pnlUnrealized ?? "0");
      const markPrice = this.toOptionalString(raw?.markPrice ?? info.markPrice);
      const liquidationPrice = this.toOptionalString(raw?.liquidationPrice ?? info.liquidationPrice);
      const leverage = this.toOptionalString(raw?.leverage ?? info.leverage ?? this.leverage);
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

  private mapRestOrder(order: CcxtOrder): AsterOrder {
    const info = (order.info ?? {}) as Record<string, unknown>;
    const side = (order.side ?? "buy").toUpperCase() as "BUY" | "SELL";
    let type = this.normalizeOrderType(order.type ?? (info.type as string));
    if (
      order.triggerPrice != null ||
      info.triggerPrice != null ||
      info.stopLossTriggerPrice != null ||
      info.stopPrice != null
    ) {
      type = "STOP_MARKET";
    }
    const status = this.normalizeStatus(order.status ?? (info.status as string));
    const price = this.pickString([order.price, info.price, info.p]);
    const quantity = this.pickString([order.amount, info.quantity, info.origQty, info.q]);
    const executed = this.pickString([order.filled, info.executedQuantity, info.executedBaseQuantity, info.z]);
    const stopPrice = this.pickString([order.stopPrice, info.stopPrice, info.triggerPrice, info.P]);
    const avgPrice = this.pickString([order.average, info.avgPrice, info.averagePrice]);
    const cumQuote = this.pickString([order.cost, info.executedQuoteQuantity, info.cumQuote]);
    const timestamp = order.timestamp ?? Date.now();
    const reduceOnly = Boolean(order.reduceOnly ?? info.reduceOnly ?? info.reduce_only ?? false);

    return {
      orderId: String(order.id ?? ""),
      clientOrderId: (order.clientOrderId as any as string) || "",
      symbol: this.symbol,
      side,
      type: type as OrderType,
      status,
      price,
      origQty: quantity,
      executedQty: executed,
      stopPrice,
      time: timestamp,
      updateTime: order.lastUpdateTimestamp ?? timestamp,
      reduceOnly,
      closePosition: Boolean(info.closePosition ?? false),
      avgPrice,
      cumQuote,
    };
  }

  // ---- Utility methods -----------------------------------------------------

  private normalizeTimeframe(interval: string): string {
    const map: Record<string, string> = {
      "1m": "1m",
      "3m": "3m",
      "5m": "5m",
      "15m": "15m",
      "30m": "30m",
      "1h": "1h",
      "2h": "2h",
      "4h": "4h",
      "6h": "6h",
      "12h": "12h",
      "1d": "1d",
    };
    return map[interval] ?? "1m";
  }

  private intervalToMs(interval: string): number {
    const map: Record<string, number> = {
      "1m": 60_000,
      "3m": 180_000,
      "5m": 300_000,
      "15m": 900_000,
      "30m": 1_800_000,
      "1h": 3_600_000,
      "2h": 7_200_000,
      "4h": 14_400_000,
      "6h": 21_600_000,
      "12h": 43_200_000,
      "1d": 86_400_000,
    };
    return map[interval] ?? 60_000;
  }

  private deriveSideFromExposure(info: Record<string, unknown>): "long" | "short" | "flat" {
    const exposure = this.toNumber(info.netExposureNotional ?? info.netCost ?? info.netQuantity);
    if (!exposure) return "flat";
    return exposure < 0 ? "short" : "long";
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

  private isTerminalStatus(status?: string): boolean {
    if (!status) return false;
    const normalized = status.toUpperCase();
    return (
      normalized === "FILLED" ||
      normalized === "CANCELLED" ||
      normalized === "EXPIRED" ||
      normalized === "REJECTED" ||
      normalized === "TRIGGER_FAILED"
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

  private parseOptionalBoolean(value: string | undefined): boolean | undefined {
    if (value == null) return undefined;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    return true;
  }
}

