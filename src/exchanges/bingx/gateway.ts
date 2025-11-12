import ccxt, {
  type Balances,
  type Order as CcxtOrder,
  type OrderBook as CcxtOrderBook,
  type OHLCV as CcxtOhlcv,
  type Ticker as CcxtTicker,
} from "ccxt";
import type {
  AsterAccountAsset,
  AsterAccountPosition,
  AsterAccountSnapshot,
  AsterDepth,
  AsterKline,
  AsterOrder,
  AsterTicker,
  CreateOrderParams,
  OrderType,
} from "../types";
import type {
  AccountListener,
  DepthListener,
  KlineListener,
  OrderListener,
  TickerListener,
} from "../adapter";
import { extractMessage } from "../../utils/errors";

type BingxPollingConfig = {
  account: number;
  orders: number;
  depth: number;
  ticker: number;
  klines: number;
};

const DEFAULT_POLL_INTERVALS: BingxPollingConfig = {
  account: 5000,
  orders: 2000,
  depth: 1000,
  ticker: 1000,
  klines: 5000,
};

export interface BingxGatewayOptions {
  apiKey: string;
  apiSecret: string;
  password?: string;
  symbol: string;
  displaySymbol?: string;
  sandbox?: boolean;
  leverage?: number;
  pollIntervals?: Partial<BingxPollingConfig>;
  logger?: (context: string, error: unknown) => void;
}

export class BingxGateway {
  private readonly exchange: any;
  private readonly requestedSymbol: string;
  private readonly displaySymbol: string;
  private readonly normalizedDisplaySymbol: string;
  private readonly leverage: number;
  private readonly logger: (context: string, error: unknown) => void;
  private readonly debug: boolean;
  private readonly pollIntervals: BingxPollingConfig;

  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private marketSymbol = "";
  private market: any | null = null;
  private leverageConfigured = false;

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

  private lastBalanceSnapshot: AsterAccountSnapshot | null = null;
  private lastOrders: AsterOrder[] = [];

  constructor(options: BingxGatewayOptions) {
    this.requestedSymbol = options.symbol.toUpperCase();
    this.displaySymbol = (options.displaySymbol ?? options.symbol).toUpperCase();
    this.normalizedDisplaySymbol = this.normalizeKey(this.displaySymbol);
    this.leverage = Number.isFinite(options.leverage) && options.leverage ? Number(options.leverage) : 50;
    this.debug = process.env.BINGX_DEBUG === "1" || process.env.BINGX_DEBUG === "true";

    this.logger =
      options.logger ??
      ((context, error) => {
        if (this.debug) {
          console.error(`[BingxGateway] ${context}: ${extractMessage(error)}`);
        }
      });

    this.pollIntervals = {
      account: options.pollIntervals?.account ?? DEFAULT_POLL_INTERVALS.account,
      orders: options.pollIntervals?.orders ?? DEFAULT_POLL_INTERVALS.orders,
      depth: options.pollIntervals?.depth ?? DEFAULT_POLL_INTERVALS.depth,
      ticker: options.pollIntervals?.ticker ?? DEFAULT_POLL_INTERVALS.ticker,
      klines: options.pollIntervals?.klines ?? DEFAULT_POLL_INTERVALS.klines,
    };

    this.exchange = new (ccxt as any).bingx({
      apiKey: options.apiKey,
      secret: options.apiSecret,
      password: options.password ?? process.env.BINGX_PASSWORD,
      enableRateLimit: true,
      timeout: 30_000,
      options: {
        defaultType: "swap",
      },
    });

    const sandbox = options.sandbox ?? (process.env.BINGX_SANDBOX === "true");
    if (typeof this.exchange.setSandboxMode === "function") {
      try {
        void this.exchange.setSandboxMode(Boolean(sandbox));
      } catch (error) {
        this.logger("setSandboxMode", error);
      }
    }
  }

  async ensureInitialized(symbol?: string): Promise<void> {
    if (this.initialized) {
      if (symbol && this.normalizeKey(symbol) !== this.normalizedDisplaySymbol) {
        // Only one symbol is supported at a time; ignore mismatched requests.
      }
      return;
    }
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize(symbol)
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

  private async doInitialize(symbol?: string): Promise<void> {
    try {
      await this.exchange.loadMarkets();
      const requested = (symbol ?? this.requestedSymbol).toUpperCase();
      const market = this.findMarket(requested);
      if (!market) {
        throw new Error(`Symbol ${requested} not found in BingX markets`);
      }
      this.market = market;
      this.marketSymbol = market.symbol ?? requested;
      await this.configureLeverage();
    } catch (error) {
      this.logger("initialize", error);
      throw error;
    }
  }

  private findMarket(requested: string): any | null {
    const normalized = this.normalizeKey(requested);
    const markets = Object.values(this.exchange.markets ?? {}) as Array<any>;

    const prioritized = markets.filter((m) => m && (m.contract || m.type === "swap" || m.linear));
    const buckets = [prioritized, markets];

    for (const bucket of buckets) {
      for (const market of bucket) {
        if (!market) continue;
        const candidates = this.buildMarketKeys(market);
        if (candidates.includes(normalized)) {
          return market;
        }
      }
    }
    return null;
  }

  private buildMarketKeys(market: any): string[] {
    const keys = new Set<string>();
    const push = (value: unknown) => {
      if (typeof value !== "string") return;
      const normalized = this.normalizeKey(value);
      if (normalized) keys.add(normalized);
    };

    push(market.symbol);
    push(market.id);
    push(`${market.base ?? ""}/${market.quote ?? ""}`);
    push(`${market.base ?? ""}${market.quote ?? ""}`);
    push(`${market.base ?? ""}${market.quote ?? ""}${market.settle ?? ""}`);
    push(`${market.base ?? ""}${market.settle ?? ""}`);
    if (market.contract) {
      push(`${market.base ?? ""}${market.quote ?? ""}PERP`);
      push(`${market.base ?? ""}${market.quote ?? ""}:${market.settle ?? ""}`);
    }
    if (market.info) {
      push(market.info.symbol);
      push(market.info.symbolName);
      push(market.info.contractId);
      push(market.info.contractSymbol);
      push(market.info.pair);
    }
    return Array.from(keys);
  }

  private normalizeKey(value: string): string {
    return value.replace(/[^0-9A-Z]/gi, "").toUpperCase();
  }

  private async configureLeverage(): Promise<void> {
    if (this.leverageConfigured) return;
    if (typeof this.exchange.setLeverage !== "function") {
      this.leverageConfigured = true;
      return;
    }
    try {
      await this.exchange.setLeverage(this.leverage, this.marketSymbol, { marginMode: "cross" });
      this.leverageConfigured = true;
      if (this.debug) {
        console.info(`[BingxGateway] leverage set to ${this.leverage}x for ${this.marketSymbol}`);
      }
    } catch (error) {
      this.logger("setLeverage", error);
      this.leverageConfigured = true;
    }
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
    void this.ensureInitialized();
    this.startAccountPolling();
  }

  onOrders(callback: OrderListener): void {
    this.orderListeners.add(callback);
    if (this.lastOrders.length) {
      try {
        callback(this.lastOrders);
      } catch (error) {
        this.logger("orderReplay", error);
      }
    }
    void this.ensureInitialized();
    this.startOrderPolling();
  }

  onDepth(callback: DepthListener): void {
    this.depthListeners.add(callback);
    void this.ensureInitialized();
    this.startDepthPolling();
  }

  onTicker(callback: TickerListener): void {
    this.tickerListeners.add(callback);
    void this.ensureInitialized();
    this.startTickerPolling();
  }

  watchKlines(interval: string, callback: KlineListener): void {
    const normalized = this.normalizeInterval(interval);
    if (!this.klineListeners.has(normalized)) {
      this.klineListeners.set(normalized, new Set());
    }
    this.klineListeners.get(normalized)!.add(callback);
    void this.ensureInitialized();
    this.startKlinePolling(normalized);
  }

  private startAccountPolling(): void {
    if (this.accountPollTimer) return;
    const poll = async () => {
      if (!this.accountListeners.size) return;
      try {
        await this.ensureInitialized();
        await this.fetchAndEmitAccount();
      } catch (error) {
        this.logger("accountPoll", error);
      }
    };
    void poll();
    this.accountPollTimer = setInterval(() => {
      void poll();
    }, this.pollIntervals.account);
  }

  private startOrderPolling(): void {
    if (this.orderPollTimer) return;
    const poll = async () => {
      if (!this.orderListeners.size) return;
      try {
        await this.ensureInitialized();
        await this.fetchAndEmitOrders();
      } catch (error) {
        this.logger("orderPoll", error);
      }
    };
    void poll();
    this.orderPollTimer = setInterval(() => {
      void poll();
    }, this.pollIntervals.orders);
  }

  private startDepthPolling(): void {
    if (this.depthPollTimer) return;
    const poll = async () => {
      if (!this.depthListeners.size) return;
      try {
        await this.ensureInitialized();
        const orderbook = (await this.exchange.fetchOrderBook(this.marketSymbol, 50)) as CcxtOrderBook;
        const depth = this.mapOrderBookToDepth(orderbook);
        for (const listener of this.depthListeners) {
          try {
            listener(depth);
          } catch (error) {
            this.logger("depthListener", error);
          }
        }
      } catch (error) {
        this.logger("depthPoll", error);
      }
    };
    void poll();
    this.depthPollTimer = setInterval(() => {
      void poll();
    }, this.pollIntervals.depth);
  }

  private startTickerPolling(): void {
    if (this.tickerPollTimer) return;
    const poll = async () => {
      if (!this.tickerListeners.size) return;
      try {
        await this.ensureInitialized();
        const ticker = (await this.exchange.fetchTicker(this.marketSymbol)) as CcxtTicker;
        const mapped = this.mapTickerToAsterTicker(ticker);
        for (const listener of this.tickerListeners) {
          try {
            listener(mapped);
          } catch (error) {
            this.logger("tickerListener", error);
          }
        }
      } catch (error) {
        this.logger("tickerPoll", error);
      }
    };
    void poll();
    this.tickerPollTimer = setInterval(() => {
      void poll();
    }, this.pollIntervals.ticker);
  }

  private startKlinePolling(interval: string): void {
    if (this.klinePollTimers.has(interval)) return;
    const poll = async () => {
      const listeners = this.klineListeners.get(interval);
      if (!listeners || !listeners.size) return;
      try {
        await this.ensureInitialized();
        const ohlcv = (await this.exchange.fetchOHLCV(this.marketSymbol, interval, undefined, 150)) as CcxtOhlcv[];
        const klines = ohlcv
          .filter((candle) => Array.isArray(candle) && candle.length >= 6)
          .map((candle) => this.mapOHLCVToKline(candle as CcxtOhlcv, interval));
        for (const listener of listeners) {
          try {
            listener(klines);
          } catch (error) {
            this.logger(`klineListener:${interval}`, error);
          }
        }
      } catch (error) {
        this.logger(`klinePoll:${interval}`, error);
      }
    };
    void poll();
    this.klinePollTimers.set(
      interval,
      setInterval(() => {
        void poll();
      }, this.pollIntervals.klines)
    );
  }

  async createOrder(params: CreateOrderParams): Promise<AsterOrder> {
    await this.ensureInitialized(params.symbol);
    const type = this.mapOrderTypeToCcxt(params.type);
    const side = params.side.toLowerCase();
    const amount = Number(params.quantity ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Bingx createOrder requires a positive quantity");
    }

    const price = params.price ?? undefined;
    const extra: Record<string, unknown> = {};
    if (params.stopPrice !== undefined) {
      extra.stopPrice = params.stopPrice;
      extra.triggerPrice = params.stopPrice;
    }
    if (params.activationPrice !== undefined) {
      extra.activationPrice = params.activationPrice;
    }
    if (params.callbackRate !== undefined) {
      extra.callbackRate = params.callbackRate;
    }
    if (params.timeInForce) {
      extra.timeInForce = params.timeInForce;
    }
    if (params.reduceOnly !== undefined) {
      extra.reduceOnly = params.reduceOnly === "true";
    }
    if (params.closePosition !== undefined) {
      extra.closePosition = params.closePosition === "true";
    }
    if (params.triggerType) {
      extra.triggerType = params.triggerType;
    }

    try {
      const order = (await this.exchange.createOrder(
        this.marketSymbol,
        type,
        side,
        amount,
        price,
        extra
      )) as CcxtOrder;
      const mapped = this.mapOrderToAsterOrder(order);
      await this.fetchAndEmitOrders();
      return mapped;
    } catch (error) {
      throw new Error(`Bingx createOrder failed: ${extractMessage(error)}`);
    }
  }

  async cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void> {
    await this.ensureInitialized(params.symbol);
    try {
      await this.exchange.cancelOrder(params.orderId, this.marketSymbol);
    } catch (error) {
      throw new Error(`Bingx cancelOrder failed: ${extractMessage(error)}`);
    } finally {
      await this.fetchAndEmitOrders();
    }
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void> {
    await this.ensureInitialized(params.symbol);
    const errors: Array<{ id: number | string; error: unknown }> = [];
    await Promise.all(
      params.orderIdList.map(async (orderId) => {
        try {
          await this.exchange.cancelOrder(orderId, this.marketSymbol);
        } catch (error) {
          errors.push({ id: orderId, error });
        }
      })
    );
    await this.fetchAndEmitOrders();
    if (errors.length) {
      const detail = errors.map((entry) => `${entry.id}: ${extractMessage(entry.error)}`).join("; ");
      throw new Error(`Bingx cancelOrders failed: ${detail}`);
    }
  }

  async cancelAllOrders(): Promise<void> {
    await this.ensureInitialized();
    try {
      if (typeof this.exchange.cancelAllOrders === "function") {
        await this.exchange.cancelAllOrders(this.marketSymbol);
      } else {
        const openOrders = (await this.exchange.fetchOpenOrders(this.marketSymbol)) as CcxtOrder[];
        await Promise.all(openOrders.map((order) => this.exchange.cancelOrder(order.id, this.marketSymbol)));
      }
    } catch (error) {
      throw new Error(`Bingx cancelAllOrders failed: ${extractMessage(error)}`);
    } finally {
      await this.fetchAndEmitOrders();
    }
  }

  async getPrecision(): Promise<{
    priceTick: number;
    qtyStep: number;
    priceDecimals?: number;
    sizeDecimals?: number;
    marketId?: number;
  } | null> {
    await this.ensureInitialized();
    const market =
      this.market ??
      (typeof this.exchange.market === "function" ? this.exchange.market(this.marketSymbol) : null);
    if (!market) return null;
    return {
      priceTick: this.resolvePriceTick(market),
      qtyStep: this.resolveQtyStep(market),
      priceDecimals: this.resolveDecimals(market?.precision?.price),
      sizeDecimals: this.resolveDecimals(market?.precision?.amount),
    };
  }

  private async fetchAndEmitAccount(): Promise<void> {
    const balance = (await this.exchange.fetchBalance()) as Balances;
    const positionsFromBalance = this.extractPositionsFromBalance(balance);
    const extraPositions: any[] = [];
    const fetchPositions = (this.exchange as any).fetchPositions;
    if (typeof fetchPositions === "function") {
      try {
        const raw = await fetchPositions.call(this.exchange, [this.marketSymbol]);
        if (Array.isArray(raw)) {
          extraPositions.push(...raw);
        }
      } catch (error) {
        this.logger("fetchPositions", error);
      }
    }
    const snapshot = this.mapBalanceToAccountSnapshot(balance, [...positionsFromBalance, ...extraPositions]);
    this.lastBalanceSnapshot = snapshot;
    for (const listener of this.accountListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger("accountListener", error);
      }
    }
  }

  private async fetchAndEmitOrders(): Promise<void> {
    if (!this.orderListeners.size) return;
    const openOrders = (await this.exchange.fetchOpenOrders(this.marketSymbol)) as CcxtOrder[];
    const mapped = openOrders.map((order) => this.mapOrderToAsterOrder(order));
    this.lastOrders = mapped;
    for (const listener of this.orderListeners) {
      try {
        listener(mapped);
      } catch (error) {
        this.logger("orderListener", error);
      }
    }
  }

  private extractPositionsFromBalance(balance: Balances): any[] {
    const info = (balance as unknown as { info?: any })?.info;
    if (!info) return [];
    const candidates =
      info.positions ??
      info.position ??
      info.positionInfo ??
      info.positionData ??
      info.data ??
      info.positionList ??
      [];
    if (Array.isArray(candidates)) return candidates;
    if (typeof candidates === "object" && candidates) {
      return Object.values(candidates);
    }
    return [];
  }

  private mapBalanceToAccountSnapshot(balance: Balances, positionsRaw: any[]): AsterAccountSnapshot {
    const now = Date.now();
    const positions = this.normalizePositions(positionsRaw, now);

    const free = (balance.free ?? {}) as Record<string, number | undefined>;
    const total = (balance.total ?? {}) as Record<string, number | undefined>;

    const assetKeys = new Set<string>([...Object.keys(free), ...Object.keys(total)]);
    const assets: AsterAccountAsset[] = Array.from(assetKeys).map((asset) => ({
      asset,
      walletBalance: this.toStringNumber(total[asset]),
      availableBalance: this.toStringNumber(free[asset]),
      updateTime: now,
    }));

    const totalWalletBalance = Array.from(assetKeys).reduce((acc, asset) => {
      const value = total[asset];
      const num = Number(value ?? 0);
      return acc + (Number.isFinite(num) ? num : 0);
    }, 0);

    const totalUnrealized = positions.reduce((acc, pos) => acc + Number(pos.unrealizedProfit ?? 0), 0);

    return {
      canTrade: true,
      canDeposit: true,
      canWithdraw: true,
      updateTime: now,
      totalWalletBalance: totalWalletBalance.toString(),
      totalUnrealizedProfit: totalUnrealized.toString(),
      positions,
      assets,
    };
  }

  private normalizePositions(rawPositions: any[], now: number): AsterAccountPosition[] {
    const map = new Map<string, AsterAccountPosition>();
    for (const pos of rawPositions) {
      const normalized = this.normalizeSinglePosition(pos, now);
      if (!normalized) continue;
      map.set(normalized.symbol, normalized);
    }
    return Array.from(map.values());
  }

  private normalizeSinglePosition(pos: any, now: number): AsterAccountPosition | null {
    if (!pos) return null;
    const rawSymbol =
      pos.symbol ?? pos.instrument ?? pos.market ?? pos.pair ?? pos.contractId ?? pos.info?.symbol;
    if (rawSymbol) {
      const normalizedSymbol = this.normalizeKey(String(rawSymbol));
      if (normalizedSymbol !== this.normalizedDisplaySymbol) {
        // Only keep positions that match the configured symbol.
        return null;
      }
    }

    const rawSize =
      pos.positionAmt ??
      pos.contracts ??
      pos.positionSize ??
      pos.size ??
      pos.amount ??
      pos.volume ??
      pos.info?.positionAmt ??
      pos.info?.size ??
      0;
    let size = Number(rawSize ?? 0);
    if (!Number.isFinite(size)) {
      size = Number(pos?.info?.positionAmt ?? 0);
    }
    const sideText = String(
      pos.side ?? pos.direction ?? pos.positionSide ?? pos.info?.side ?? pos.info?.positionSide ?? ""
    ).toLowerCase();
    if (sideText.includes("short") || sideText.includes("sell")) {
      size = -Math.abs(size);
    } else {
      size = Math.abs(size);
    }

    const entryPrice =
      pos.entryPrice ??
      pos.avgPrice ??
      pos.average ??
      pos.avgCost ??
      pos.info?.entryPrice ??
      pos.info?.avgEntryPrice ??
      pos.info?.averagePrice ??
      0;
    const unrealized =
      pos.unrealizedPnl ??
      pos.info?.unrealizedPnl ??
      pos.info?.unRealizedProfit ??
      pos.pnl ??
      pos.upl ??
      0;

    const leverage = pos.leverage ?? pos.info?.leverage ?? pos.info?.initialLeverage;
    const markPrice = pos.markPrice ?? pos.info?.markPrice;
    const liquidationPrice = pos.liquidationPrice ?? pos.info?.liquidationPrice;

    return {
      symbol: this.displaySymbol,
      positionAmt: this.toStringNumber(size),
      entryPrice: this.toStringNumber(entryPrice),
      unrealizedProfit: this.toStringNumber(unrealized),
      positionSide: "BOTH",
      updateTime: now,
      markPrice: this.optionalString(markPrice),
      liquidationPrice: this.optionalString(liquidationPrice),
      leverage: this.optionalString(leverage),
    };
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
      price: this.toStringNumber(order.price),
      origQty: this.toStringNumber(order.amount),
      executedQty: this.toStringNumber(order.filled),
      stopPrice: this.toStringNumber(order.stopPrice),
      time: order.timestamp || Date.now(),
      updateTime: order.lastUpdateTimestamp || Date.now(),
      reduceOnly: Boolean((order.info?.reduceOnly as boolean | undefined) ?? false),
      closePosition: Boolean((order.info?.closePosition as boolean | undefined) ?? false),
      avgPrice: this.optionalString(order.average),
      cumQuote: this.optionalString(order.cost),
    };
  }

  private mapOrderBookToDepth(orderbook: CcxtOrderBook): AsterDepth {
    return {
      lastUpdateId: orderbook.nonce ?? Date.now(),
      bids: (orderbook.bids ?? [])
        .filter((entry) => entry && entry.length >= 2)
        .map(([price, amount]) => [this.toStringNumber(price), this.toStringNumber(amount)]),
      asks: (orderbook.asks ?? [])
        .filter((entry) => entry && entry.length >= 2)
        .map(([price, amount]) => [this.toStringNumber(price), this.toStringNumber(amount)]),
      eventTime: orderbook.timestamp,
    };
  }

  private mapTickerToAsterTicker(ticker: CcxtTicker): AsterTicker {
    return {
      symbol: this.displaySymbol,
      lastPrice: this.toStringNumber(ticker.last),
      openPrice: this.toStringNumber(ticker.open),
      highPrice: this.toStringNumber(ticker.high),
      lowPrice: this.toStringNumber(ticker.low),
      volume: this.toStringNumber(ticker.baseVolume),
      quoteVolume: this.toStringNumber(ticker.quoteVolume),
      eventTime: ticker.timestamp ?? Date.now(),
    };
  }

  private mapOHLCVToKline(candle: CcxtOhlcv, interval: string): AsterKline {
    const [timestampRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = candle;
    const timestamp = typeof timestampRaw === "number" && Number.isFinite(timestampRaw) ? timestampRaw : Date.now();
    const intervalMs = this.getIntervalMs(interval);
    return {
      openTime: timestamp,
      closeTime: timestamp + intervalMs,
      open: this.toStringNumber(openRaw),
      high: this.toStringNumber(highRaw),
      low: this.toStringNumber(lowRaw),
      close: this.toStringNumber(closeRaw),
      volume: this.toStringNumber(volumeRaw),
      numberOfTrades: 0,
    };
  }

  private mapOrderTypeToCcxt(type: string): string {
    const typeMap: Record<string, string> = {
      LIMIT: "limit",
      MARKET: "market",
      STOP: "stop",
      STOP_MARKET: "stop",
      TAKE_PROFIT: "take-profit",
      TAKE_PROFIT_MARKET: "take-profit",
      TRAILING_STOP_MARKET: "trailing-stop",
    };
    return typeMap[type] ?? "limit";
  }

  private mapCcxtOrderTypeToAster(type: string | undefined): OrderType {
    const typeMap: Record<string, OrderType> = {
      limit: "LIMIT",
      market: "MARKET",
      stop: "STOP_MARKET",
      "stop-market": "STOP_MARKET",
      "take-profit": "TAKE_PROFIT",
      "take-profit-market": "TAKE_PROFIT_MARKET",
      "trailing-stop": "TRAILING_STOP_MARKET",
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
      "4h": "4h",
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
      "4h": 4 * 60 * 60 * 1000,
      "1d": 24 * 60 * 60 * 1000,
    };
    return base[interval] ?? 60 * 1000;
  }

  private resolvePriceTick(market: any): number {
    const infoTick =
      Number(market?.info?.tickSize) ??
      Number(market?.info?.priceTickSize) ??
      Number(market?.info?.pricePrecision);
    if (Number.isFinite(infoTick) && infoTick > 0) {
      return Number(infoTick);
    }
    if (Number.isFinite(market?.tickSize) && market.tickSize > 0) {
      return Number(market.tickSize);
    }
    const precisionDigits = Number(market?.precision?.price);
    if (Number.isFinite(precisionDigits) && precisionDigits >= 0) {
      return Number((1 / Math.pow(10, precisionDigits)).toFixed(precisionDigits + 2));
    }
    const limitMin = Number(market?.limits?.price?.min);
    if (Number.isFinite(limitMin) && limitMin > 0) {
      return Number(limitMin);
    }
    return 0.1;
  }

  private resolveQtyStep(market: any): number {
    const infoStep =
      Number(market?.info?.stepSize) ??
      Number(market?.info?.quantityPrecision) ??
      Number(market?.info?.sizeTickSize);
    if (Number.isFinite(infoStep) && infoStep > 0) {
      return Number(infoStep);
    }
    const precisionDigits = Number(market?.precision?.amount);
    if (Number.isFinite(precisionDigits) && precisionDigits >= 0) {
      return Number((1 / Math.pow(10, precisionDigits)).toFixed(precisionDigits + 2));
    }
    const limitMin = Number(market?.limits?.amount?.min);
    if (Number.isFinite(limitMin) && limitMin > 0) {
      return Number(limitMin);
    }
    return 0.001;
  }

  private resolveDecimals(value: unknown): number | undefined {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
    return undefined;
  }

  private toStringNumber(value: unknown): string {
    if (value == null) return "0";
    const num = Number(value);
    if (!Number.isFinite(num)) {
      const str = String(value);
      return str.trim() ? str : "0";
    }
    return num.toString();
  }

  private optionalString(value: unknown): string | undefined {
    if (value == null || value === "") return undefined;
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num.toString();
    }
    return String(value);
  }
}

