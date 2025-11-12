import ccxt, {
  type Balances,
  type Order as CcxtOrder,
  type OrderBook as CcxtOrderBook,
  type OHLCV as CcxtOhlcv,
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
  AsterAccountAsset,
  AsterAccountSnapshot,
  AsterDepth,
  AsterKline,
  AsterOrder,
  AsterTicker,
  CreateOrderParams,
  OrderType,
} from "../types";
import { extractMessage } from "../../utils/errors";

export interface BingxGatewayOptions {
  symbol: string;
  displaySymbol: string;
  apiKey?: string;
  apiSecret?: string;
  password?: string;
  leverage?: number;
  marginMode?: "cross" | "isolated";
  sandbox?: boolean;
  pollIntervals?: Partial<BingxPollingConfig>;
  logger?: (context: string, error: unknown) => void;
}

interface BingxPollingConfig {
  account: number;
  orders: number;
  depth: number;
  ticker: number;
  klines: number;
}

export class BingxGateway {
  private readonly exchange: any;
  private readonly symbol: string;
  private marketSymbol: string;
  private marketId: string;
  private market: any | null = null;
  private readonly displaySymbol: string;
  private readonly leverage: number;
  private readonly marginMode: "cross" | "isolated";
  private readonly logger: (context: string, error: unknown) => void;
  private readonly pollIntervals: BingxPollingConfig;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private readonly accountListeners = new Set<AccountListener>();
  private readonly orderListeners = new Set<OrderListener>();
  private readonly depthListeners = new Set<DepthListener>();
  private readonly tickerListeners = new Set<TickerListener>();
  private readonly klineListeners = new Map<string, Set<KlineListener>>();

  private accountPollTimer: NodeJS.Timeout | null = null;
  private orderPollTimer: NodeJS.Timeout | null = null;
  private depthPollTimer: NodeJS.Timeout | null = null;
  private tickerPollTimer: NodeJS.Timeout | null = null;
  private readonly klinePollTimers = new Map<string, NodeJS.Timeout>();

  private readonly localOrders = new Map<string, AsterOrder>();
  private lastBalanceSnapshot: AsterAccountSnapshot | null = null;

  constructor(options: BingxGatewayOptions) {
    this.symbol = this.normalizeUserSymbol(options.symbol);
    this.marketSymbol = this.symbol;
    this.marketId = this.symbol;
    this.displaySymbol = options.displaySymbol;
    this.leverage = options.leverage ?? 50;
    this.marginMode = options.marginMode ?? "cross";
    this.logger = options.logger ?? ((context, error) => console.error(`[BingxGateway] ${context}:`, error));
    this.pollIntervals = {
      account: options.pollIntervals?.account ?? 5000,
      orders: options.pollIntervals?.orders ?? 2000,
      depth: options.pollIntervals?.depth ?? 1000,
      ticker: options.pollIntervals?.ticker ?? 2000,
      klines: options.pollIntervals?.klines ?? 5000,
    };

    const exchangeOptions: Record<string, unknown> = {
      apiKey: options.apiKey ?? process.env.BINGX_API_KEY,
      secret: options.apiSecret ?? process.env.BINGX_API_SECRET,
      password: options.password ?? process.env.BINGX_PASSWORD,
      enableRateLimit: true,
      timeout: 30_000,
      options: {
        defaultType: "swap",
        defaultSubType: "linear",
        hedgeMode: false,
      },
    };

    this.exchange = new (ccxt as any).bingx(exchangeOptions);
    if (options.sandbox ?? process.env.BINGX_SANDBOX === "true") {
      try {
        if (typeof this.exchange.setSandboxMode === "function") {
          this.exchange.setSandboxMode(true);
        } else {
          this.exchange.options = this.exchange.options ?? {};
          this.exchange.options.sandboxMode = true;
        }
      } catch (error) {
        this.logger("sandbox", error);
      }
    }
  }

  async ensureInitialized(requestedSymbol?: string): Promise<void> {
    if (this.initialized && (!requestedSymbol || this.matchesCurrentSymbol(requestedSymbol))) {
      return;
    }
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize(requestedSymbol)
      .then((value) => {
        this.initialized = true;
        return value;
      })
      .catch((error) => {
        this.initPromise = null;
        throw error;
      });
    return this.initPromise;
  }

  private async doInitialize(requestedSymbol?: string): Promise<void> {
    const targetSymbol = requestedSymbol ?? this.symbol;
    try {
      await this.exchange.loadMarkets();
      const market = this.findMarket(targetSymbol);
      if (!market) {
        throw new Error(`Symbol ${targetSymbol} not found in BingX markets`);
      }
      this.market = market;
      this.marketSymbol = market.symbol ?? targetSymbol;
      this.marketId = market.id ?? this.marketSymbol;

      await this.configureMarginAndLeverage();

      this.logger(
        "initialize",
        `BingX gateway initialized for ${this.marketSymbol} (leverage=${this.leverage}, marginMode=${this.marginMode})`
      );
    } catch (error) {
      this.logger("initialize", error);
      throw error;
    }
  }

  private async configureMarginAndLeverage(): Promise<void> {
    const targetSymbol = this.marketSymbol;
    if (!targetSymbol) return;
    try {
      if (typeof this.exchange.setPositionMode === "function") {
        await this.exchange.setPositionMode(false);
      }
    } catch (error) {
      this.logger("setPositionMode", error);
    }
    try {
      if (typeof this.exchange.setMarginMode === "function") {
        await this.exchange.setMarginMode(this.marginMode, targetSymbol);
      }
    } catch (error) {
      this.logger("setMarginMode", error);
    }
    try {
      if (typeof this.exchange.setLeverage === "function") {
        await this.exchange.setLeverage(this.leverage, targetSymbol, { marginMode: this.marginMode });
      }
    } catch (error) {
      this.logger("setLeverage", error);
    }
  }

  destroy(): void {
    this.initialized = false;
    this.initPromise = null;
    this.clearPolling();
    if (typeof this.exchange.close === "function") {
      try {
        void this.exchange.close();
      } catch (error) {
        this.logger("destroy", error);
      }
    }
  }

  private clearPolling(): void {
    if (this.accountPollTimer) {
      clearInterval(this.accountPollTimer);
      this.accountPollTimer = null;
    }
    if (this.orderPollTimer) {
      clearInterval(this.orderPollTimer);
      this.orderPollTimer = null;
    }
    if (this.depthPollTimer) {
      clearInterval(this.depthPollTimer);
      this.depthPollTimer = null;
    }
    if (this.tickerPollTimer) {
      clearInterval(this.tickerPollTimer);
      this.tickerPollTimer = null;
    }
    for (const timer of this.klinePollTimers.values()) {
      clearInterval(timer);
    }
    this.klinePollTimers.clear();
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
    this.startAccountPolling();
  }

  onOrders(callback: OrderListener): void {
    this.orderListeners.add(callback);
    this.emitCurrentOrders();
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
    const normalizedInterval = this.normalizeInterval(interval);
    if (!this.klineListeners.has(normalizedInterval)) {
      this.klineListeners.set(normalizedInterval, new Set());
    }
    this.klineListeners.get(normalizedInterval)!.add(callback);
    this.startKlinePolling(normalizedInterval);
  }

  private startAccountPolling(): void {
    if (this.accountPollTimer) return;
    const poll = async () => {
      try {
        await this.ensureInitialized();
        await this.fetchAndEmitAccount();
      } catch (error) {
        this.logger("accountPoll", error);
      }
    };
    void poll();
    this.accountPollTimer = setInterval(() => void poll(), this.pollIntervals.account);
  }

  private startOrderPolling(): void {
    if (this.orderPollTimer) return;
    const poll = async () => {
      try {
        await this.ensureInitialized();
        let openOrders: CcxtOrder[] = [];
        let closedOrders: CcxtOrder[] = [];

        try {
          openOrders = (await this.exchange.fetchOpenOrders(this.marketSymbol)) as CcxtOrder[];
        } catch (error) {
          this.logger("orderPollOpen", error);
        }

        try {
          closedOrders = (await this.exchange.fetchClosedOrders(
            this.marketSymbol,
            undefined,
            50
          )) as CcxtOrder[];
        } catch (error) {
          this.logger("orderPollClosed", error);
        }

        this.updateOrdersFromRemote(openOrders, closedOrders);
      } catch (error) {
        this.logger("orderPoll", error);
        this.emitCurrentOrders();
      }
    };
    void poll();
    this.orderPollTimer = setInterval(() => void poll(), this.pollIntervals.orders);
  }

  private startDepthPolling(): void {
    if (this.depthPollTimer) return;
    const poll = async () => {
      try {
        await this.ensureInitialized();
        const orderbook = (await this.exchange.fetchOrderBook(this.marketSymbol, 50)) as CcxtOrderBook;
        const depth = this.mapOrderBookToDepth(orderbook);
        for (const listener of this.depthListeners) {
          listener(depth);
        }
      } catch (error) {
        this.logger("depthPoll", error);
      }
    };
    void poll();
    this.depthPollTimer = setInterval(() => void poll(), this.pollIntervals.depth);
  }

  private startTickerPolling(): void {
    if (this.tickerPollTimer) return;
    const poll = async () => {
      try {
        await this.ensureInitialized();
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
    this.tickerPollTimer = setInterval(() => void poll(), this.pollIntervals.ticker);
  }

  private startKlinePolling(interval: string): void {
    if (this.klinePollTimers.has(interval)) return;
    const poll = async () => {
      try {
        await this.ensureInitialized();
        const ohlcv = (await this.exchange.fetchOHLCV(this.marketSymbol, interval, undefined, 100)) as CcxtOhlcv[];
        const klines = ohlcv
          .filter((candle) => Array.isArray(candle) && candle.length >= 6)
          .map((candle) => this.mapOHLCVToKline(candle as CcxtOhlcv, interval));
        for (const listener of this.klineListeners.get(interval) ?? []) {
          listener(klines);
        }
      } catch (error) {
        this.logger(`klinePoll:${interval}`, error);
      }
    };
    void poll();
    this.klinePollTimers.set(interval, setInterval(() => void poll(), this.pollIntervals.klines));
  }

  async createOrder(params: CreateOrderParams): Promise<AsterOrder> {
    await this.ensureInitialized(params.symbol);
    const symbol = this.marketSymbol;
    const type = this.mapOrderTypeToCcxt(params.type);
    const side = params.side.toLowerCase();
    let amount = params.quantity;
    const price = params.price;

    const extraParams: Record<string, unknown> = {};
    if (params.stopPrice !== undefined) extraParams.stopPrice = params.stopPrice;
    if (params.timeInForce) extraParams.timeInForce = params.timeInForce;
    if (params.reduceOnly !== undefined) {
      extraParams.reduceOnly = params.reduceOnly === "true";
    }
    if (params.closePosition !== undefined) {
      extraParams.closePosition = params.closePosition === "true";
    }
    if (params.activationPrice !== undefined) {
      extraParams.activationPrice = params.activationPrice;
    }
    if (params.callbackRate !== undefined) {
      extraParams.callbackRate = params.callbackRate;
    }

    try {
      const market = this.market ?? this.exchange.market(symbol);
      if (market) {
        const precisionDigits = Number((market.precision?.amount ?? market.amountPrecision));
        const minAmount = Number(market.limits?.amount?.min);
        if (!Number.isFinite(amount) || Number(amount) <= 0) {
          amount = minAmount && Number.isFinite(minAmount) && minAmount > 0 ? minAmount : 0.001;
        }
        if (Number.isFinite(precisionDigits) && typeof this.exchange.amountToPrecision === "function") {
          amount = Number(this.exchange.amountToPrecision(symbol, amount));
        }
      }
    } catch (error) {
      this.logger("normalizeAmount", error);
    }

    try {
      const isClosePosition = extraParams.closePosition === true;
      const shouldOmitAmount = isClosePosition && type === "market";
      const amountArg = shouldOmitAmount ? undefined : amount;
      const order = (await this.exchange.createOrder(
        symbol,
        type,
        side,
        amountArg,
        price,
        extraParams
      )) as CcxtOrder;
      const mapped = this.mapOrderToAsterOrder(order);
      this.upsertLocalOrder(mapped);
      return mapped;
    } catch (error) {
      throw new Error(`BingX createOrder failed: ${extractMessage(error)}`);
    }
  }

  async cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void> {
    await this.ensureInitialized(params.symbol);
    try {
      await this.exchange.cancelOrder(params.orderId, this.marketSymbol);
      this.removeLocalOrder(String(params.orderId));
    } catch (error) {
      throw new Error(`BingX cancelOrder failed: ${extractMessage(error)}`);
    }
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void> {
    await this.ensureInitialized(params.symbol);
    const errors: Array<{ id: number | string; error: unknown }> = [];
    await Promise.all(
      params.orderIdList.map(async (orderId) => {
        try {
          await this.exchange.cancelOrder(orderId, this.marketSymbol);
          this.removeLocalOrder(String(orderId));
        } catch (error) {
          errors.push({ id: orderId, error });
        }
      })
    );
    if (errors.length) {
      const messages = errors.map((entry) => `${entry.id}: ${extractMessage(entry.error)}`).join("; ");
      throw new Error(`BingX cancelOrders failed for ${messages}`);
    }
  }

  async cancelAllOrders(): Promise<void> {
    await this.ensureInitialized();
    try {
      if (typeof this.exchange.cancelAllOrders === "function") {
        await this.exchange.cancelAllOrders(this.marketSymbol);
      } else {
        const openOrders = (await this.exchange.fetchOpenOrders(this.marketSymbol)) as CcxtOrder[];
        await Promise.all(openOrders.map((order: CcxtOrder) => this.exchange.cancelOrder(order.id, this.marketSymbol)));
      }
      this.localOrders.clear();
      this.emitCurrentOrders();
    } catch (error) {
      throw new Error(`BingX cancelAllOrders failed: ${extractMessage(error)}`);
    }
  }

  private async fetchAndEmitAccount(): Promise<void> {
    const balance = (await this.exchange.fetchBalance()) as Balances;
    await this.attachPositions(balance);
    const snapshot = this.mapBalanceToAccountSnapshot(balance);
    this.lastBalanceSnapshot = snapshot;
    for (const listener of this.accountListeners) {
      listener(snapshot);
    }
  }

  private async attachPositions(balance: Balances): Promise<void> {
    const fetchPositions = (this.exchange as any).fetchPositions;
    if (typeof fetchPositions !== "function") return;
    try {
      const positions = await fetchPositions.call(this.exchange, [this.marketSymbol]);
      if (Array.isArray(positions)) {
        ((balance as unknown as { info?: Record<string, unknown> }).info ??= {}).positions = positions;
      }
    } catch (error) {
      this.logger("fetchPositions", error);
    }
  }

  private mapBalanceToAccountSnapshot(balance: Balances): AsterAccountSnapshot {
    const now = Date.now();

    const rawPositions = (() => {
      const info = (balance as unknown as { info?: { positions?: unknown } })?.info;
      const positionsValue = info?.positions;
      if (!positionsValue) return [] as Array<any>;
      if (Array.isArray(positionsValue)) return positionsValue as Array<any>;
      return Object.values(positionsValue as Record<string, unknown>);
    })();

    const positions = this.normalizePositions(rawPositions, now);

    const free = (balance.free ?? {}) as Record<string, number | undefined>;
    const used = (balance.used ?? {}) as Record<string, number | undefined>;
    const total = (balance.total ?? {}) as Record<string, number | undefined>;

    const assetKeys = new Set<string>([
      ...Object.keys(free),
      ...Object.keys(used),
      ...Object.keys(total),
    ]);

    const assets: AsterAccountAsset[] = Array.from(assetKeys).map((asset) => ({
      asset,
      walletBalance: String(total[asset] ?? 0),
      availableBalance: String(free[asset] ?? 0),
      updateTime: now,
    }));

    const totalWalletBalance = Array.from(assetKeys).reduce((acc, asset) => {
      const value = total[asset];
      return acc + (typeof value === "number" ? value : Number(value ?? 0));
    }, 0);

    return {
      canTrade: true,
      canDeposit: true,
      canWithdraw: true,
      updateTime: now,
      totalWalletBalance: totalWalletBalance.toString(),
      totalUnrealizedProfit: positions
        .reduce((acc, pos) => acc + Number(pos.unrealizedProfit ?? 0), 0)
        .toString(),
      positions,
      assets,
    };
  }

  private normalizePositions(rawPositions: any[], now: number): AsterAccountSnapshot["positions"] {
    return rawPositions
      .filter((pos) => pos)
      .map((pos: any) => {
        const rawSymbol =
          pos?.symbol ?? pos?.instrument ?? pos?.market ?? pos?.info?.market ?? this.marketSymbol;
        const normalizedSymbol =
          rawSymbol === this.marketSymbol || rawSymbol === this.displaySymbol
            ? this.displaySymbol
            : String(rawSymbol ?? this.displaySymbol);

        const quantityRaw =
          pos?.positionAmt ?? pos?.contracts ?? pos?.size ?? pos?.amount ?? pos?.info?.size ?? 0;
        let quantityNum = Number(quantityRaw);
        if (!Number.isFinite(quantityNum)) {
          quantityNum = Number(pos?.size ?? pos?.positionAmt ?? 0);
        }
        const rawSide = String(
          pos?.side ?? pos?.info?.side ?? pos?.positionSide ?? pos?.position_side ?? ""
        ).toLowerCase();
        const isShort = rawSide.includes("short") || rawSide.includes("sell");
        const positionAmt = isShort ? -Math.abs(quantityNum) : Math.abs(quantityNum);

        const entryPrice =
          pos?.entryPrice ??
          pos?.averageEntryPrice ??
          pos?.avgEntryPrice ??
          pos?.info?.average_entry_price ??
          pos?.entry_price ??
          "0";
        const unrealized =
          pos?.unrealizedPnl ??
          pos?.unrealizedProfit ??
          pos?.info?.unrealized_pnl ??
          pos?.unrealized_profit ??
          "0";
        const leverage =
          pos?.leverage ?? pos?.info?.leverage ?? pos?.initialLeverage ?? this.leverage;

        return {
          symbol: normalizedSymbol,
          positionAmt: positionAmt.toString(),
          entryPrice: String(entryPrice ?? "0"),
          unrealizedProfit: String(unrealized ?? "0"),
          positionSide: "BOTH" as const,
          updateTime: now,
          leverage: leverage != null ? String(leverage) : undefined,
        };
      });
  }

  private mapOrderToAsterOrder(order: CcxtOrder): AsterOrder {
    const side = (order.side ?? "buy").toUpperCase() as "BUY" | "SELL";
    const mappedType = this.mapCcxtOrderTypeToAster(order.type);
    return {
      orderId: String(order.id ?? ""),
      clientOrderId: (order.clientOrderId as any as string) || "",
      symbol: this.displaySymbol,
      side,
      type: mappedType,
      status: (order.status as any as string) || "",
      price: order.price?.toString() || "0",
      origQty: order.amount?.toString() || "0",
      executedQty: order.filled?.toString() || "0",
      stopPrice: order.stopPrice?.toString() || "0",
      time: order.timestamp || Date.now(),
      updateTime: order.lastUpdateTimestamp || Date.now(),
      reduceOnly: Boolean((order.info?.reduceOnly as boolean | undefined) ?? false),
      closePosition: Boolean((order.info?.closePosition as boolean | undefined) ?? false),
      avgPrice: order.average?.toString(),
      cumQuote: order.cost?.toString(),
    };
  }

  private mapOrderBookToDepth(orderbook: CcxtOrderBook): AsterDepth {
    return {
      lastUpdateId: orderbook.nonce || Date.now(),
      bids: (orderbook.bids || [])
        .filter((t) => t && t.length >= 2)
        .map(([price, amount]) => [String(price ?? 0), String(amount ?? 0)]),
      asks: (orderbook.asks || [])
        .filter((t) => t && t.length >= 2)
        .map(([price, amount]) => [String(price ?? 0), String(amount ?? 0)]),
      eventTime: orderbook.timestamp,
    };
  }

  private mapTickerToAsterTicker(ticker: CcxtTicker): AsterTicker {
    return {
      symbol: ticker.symbol,
      lastPrice: ticker.last?.toString() || "0",
      openPrice: ticker.open?.toString() || "0",
      highPrice: ticker.high?.toString() || "0",
      lowPrice: ticker.low?.toString() || "0",
      volume: ticker.baseVolume?.toString() || "0",
      quoteVolume: ticker.quoteVolume?.toString() || "0",
      eventTime: ticker.timestamp,
    };
  }

  private mapOHLCVToKline(candle: CcxtOhlcv, interval: string): AsterKline {
    const [timestampRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = candle;
    const timestamp =
      typeof timestampRaw === "number" && Number.isFinite(timestampRaw) ? timestampRaw : Date.now();
    const open = Number(openRaw ?? 0);
    const high = Number(highRaw ?? 0);
    const low = Number(lowRaw ?? 0);
    const close = Number(closeRaw ?? 0);
    const volume = Number(volumeRaw ?? 0);
    return {
      openTime: timestamp,
      closeTime: timestamp + this.getIntervalMs(interval),
      open: open.toString(),
      high: high.toString(),
      low: low.toString(),
      close: close.toString(),
      volume: volume.toString(),
      numberOfTrades: 0,
    };
  }

  private mapOrderTypeToCcxt(type: string): string {
    const typeMap: Record<string, string> = {
      LIMIT: "limit",
      MARKET: "market",
      STOP: "stop",
      STOP_MARKET: "stop",
      TAKE_PROFIT: "take_profit",
      TAKE_PROFIT_MARKET: "take_profit",
      TRAILING_STOP_MARKET: "trailing_stop_market",
    };
    return typeMap[type] || "limit";
  }

  private mapCcxtOrderTypeToAster(type: string | undefined): OrderType {
    const typeMap: Record<string, OrderType> = {
      limit: "LIMIT",
      market: "MARKET",
      stop: "STOP_MARKET",
      stop_market: "STOP_MARKET",
      take_profit: "TAKE_PROFIT",
      trailing_stop_market: "TRAILING_STOP_MARKET",
    };
    return type ? typeMap[type] ?? "LIMIT" : "LIMIT";
  }

  private normalizeInterval(interval: string): string {
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

  private getIntervalMs(interval: string): number {
    const base: Record<string, number> = {
      "1m": 60 * 1000,
      "3m": 3 * 60 * 1000,
      "5m": 5 * 60 * 1000,
      "15m": 15 * 60 * 1000,
      "30m": 30 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "2h": 2 * 60 * 60 * 1000,
      "4h": 4 * 60 * 60 * 1000,
      "6h": 6 * 60 * 60 * 1000,
      "12h": 12 * 60 * 60 * 1000,
      "1d": 24 * 60 * 60 * 1000,
    };
    return base[interval] ?? 60 * 1000;
  }

  private upsertLocalOrder(order: AsterOrder): void {
    const key = String(order.orderId);
    if (this.isOrderClosed(order)) {
      this.localOrders.delete(key);
      this.emitCurrentOrders();
      return;
    }
    this.localOrders.set(key, order);
    this.emitCurrentOrders();
  }

  private removeLocalOrder(orderId: string): void {
    if (this.localOrders.delete(orderId)) {
      this.emitCurrentOrders();
    }
  }

  private updateOrdersFromRemote(open: CcxtOrder[], closed: CcxtOrder[]): void {
    const nextOpen = new Map<string, AsterOrder>();

    for (const order of open) {
      const mapped = this.mapOrderToAsterOrder(order);
      if (!this.isOrderClosed(mapped)) {
        nextOpen.set(String(mapped.orderId), mapped);
      }
    }

    for (const order of closed) {
      const mapped = this.mapOrderToAsterOrder(order);
      if (!this.isOrderClosed(mapped)) {
        nextOpen.set(String(mapped.orderId), mapped);
      }
    }

    this.localOrders.clear();
    for (const [id, order] of nextOpen.entries()) {
      this.localOrders.set(id, order);
    }

    this.emitCurrentOrders();
  }

  private emitCurrentOrders(): void {
    if (!this.orderListeners.size) return;
    const open = Array.from(this.localOrders.values()).filter((order) => !this.isOrderClosed(order));
    for (const listener of this.orderListeners) {
      try {
        listener(open);
      } catch (error) {
        this.logger("emitOrders", error);
      }
    }
  }

  private isOrderClosed(order: AsterOrder): boolean {
    const status = (order.status ?? "").toUpperCase();
    if (
      status.includes("CLOSE") ||
      status.includes("FILLED") ||
      status.includes("CANCEL") ||
      status.includes("REJECT")
    ) {
      return true;
    }
    const orig = Number(order.origQty ?? 0);
    const filled = Number(order.executedQty ?? 0);
    if (Number.isFinite(orig) && Number.isFinite(filled) && Math.abs(orig - filled) < 1e-12) {
      return true;
    }
    return false;
  }

  private normalizeUserSymbol(value: string): string {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return "BTC/USDT:USDT";
    if (trimmed.includes("/")) return trimmed.toUpperCase();
    if (trimmed.endsWith(":USDT")) return trimmed.toUpperCase();
    if (/^[A-Z0-9]+:[A-Z0-9]+$/i.test(trimmed)) return trimmed.toUpperCase();
    if (trimmed.endsWith("USDT")) return `${trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
    return trimmed.toUpperCase();
  }

  private matchesCurrentSymbol(value: string): boolean {
    const normalized = this.normalizeUserSymbol(value);
    return this.normalizeRawSymbol(normalized) === this.normalizeRawSymbol(this.marketSymbol);
  }

  private findMarket(requested: string): any | null {
    const normalized = this.normalizeRawSymbol(requested);
    const markets = Object.values(this.exchange.markets ?? {}) as Array<any>;

    for (const market of markets) {
      const candidates = [
        market.id,
        market.symbol,
        `${market.base ?? ""}${market.quote ?? ""}${market.contract ? "PERP" : ""}`,
        `${market.base ?? ""}/${market.quote ?? ""}:${market.settle ?? ""}`,
        `${market.base ?? ""}${market.quote ?? ""}`,
      ]
        .filter(Boolean)
        .map((entry) => this.normalizeRawSymbol(String(entry)));
      if (candidates.includes(normalized)) {
        return market;
      }
    }
    return null;
  }

  private normalizeRawSymbol(value: string): string {
    return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
}
