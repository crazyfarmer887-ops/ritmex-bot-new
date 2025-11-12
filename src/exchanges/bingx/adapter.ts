import type {
  AccountListener,
  DepthListener,
  ExchangeAdapter,
  KlineListener,
  OrderListener,
  TickerListener,
} from "../adapter";
import type { AsterOrder, CreateOrderParams } from "../types";
import { extractMessage } from "../../utils/errors";
import { BingxGateway, type BingxGatewayOptions } from "./gateway";

export interface BingxCredentials {
  apiKey?: string;
  apiSecret?: string;
  password?: string;
  symbol?: string;
  leverage?: number;
  sandbox?: boolean;
  defaultType?: string;
  subType?: string;
}

export class BingxExchangeAdapter implements ExchangeAdapter {
  readonly id = "bingx";
  private readonly gateway: BingxGateway;
  private readonly symbol: string;
  private initPromise: Promise<void> | null = null;
  private readonly initContexts = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 3000;
  private lastInitErrorAt = 0;

  constructor(credentials: BingxCredentials = {}) {
    const apiKey = credentials.apiKey ?? process.env.BINGX_API_KEY;
    const apiSecret = credentials.apiSecret ?? process.env.BINGX_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new Error("BINGX_API_KEY and BINGX_API_SECRET environment variables are required");
    }
    const leverage = this.parseOptionalNumber(
      credentials.leverage,
      process.env.BINGX_LEVERAGE,
      50
    );
    const sandbox =
      credentials.sandbox ??
      this.parseOptionalBoolean(process.env.BINGX_SANDBOX) ??
      this.parseOptionalBoolean(process.env.BINGX_TESTNET);

    const symbol = (credentials.symbol ?? process.env.BINGX_SYMBOL ?? process.env.TRADE_SYMBOL ?? "BTCUSDT").toUpperCase();

    const gatewayOptions: BingxGatewayOptions = {
      apiKey,
      apiSecret,
      password: credentials.password ?? process.env.BINGX_PASSWORD,
      symbol,
      leverage,
      sandbox: sandbox ?? false,
      defaultType: credentials.defaultType ?? process.env.BINGX_DEFAULT_TYPE ?? "swap",
      subType: credentials.subType ?? process.env.BINGX_SUB_TYPE,
      logger: (context, error) => this.logError(context, error),
    };

    this.gateway = new BingxGateway(gatewayOptions);
    this.symbol = symbol;
  }

  supportsTrailingStops(): boolean {
    return false;
  }

  watchAccount(cb: AccountListener): void {
    void this.ensureInitialized("watchAccount");
    this.gateway.onAccount(this.safeInvoke("watchAccount", cb));
  }

  watchOrders(cb: OrderListener): void {
    void this.ensureInitialized("watchOrders");
    this.gateway.onOrders(this.safeInvoke("watchOrders", cb));
  }

  watchDepth(_symbol: string, cb: DepthListener): void {
    void this.ensureInitialized("watchDepth");
    this.gateway.onDepth(this.symbol, this.safeInvoke("watchDepth", cb));
  }

  watchTicker(_symbol: string, cb: TickerListener): void {
    void this.ensureInitialized("watchTicker");
    this.gateway.onTicker(this.symbol, this.safeInvoke("watchTicker", cb));
  }

  watchKlines(_symbol: string, interval: string, cb: KlineListener): void {
    void this.ensureInitialized(`watchKlines:${interval}`);
    this.gateway.watchKlines(this.symbol, interval, this.safeInvoke("watchKlines", cb));
  }

  async createOrder(params: CreateOrderParams): Promise<AsterOrder> {
    await this.ensureInitialized("createOrder");
    return this.gateway.createOrder(params);
  }

  async cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void> {
    await this.ensureInitialized("cancelOrder");
    await this.gateway.cancelOrder({ orderId: params.orderId });
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void> {
    await this.ensureInitialized("cancelOrders");
    await this.gateway.cancelOrders({ orderIdList: params.orderIdList });
  }

  async cancelAllOrders(_params: { symbol: string }): Promise<void> {
    await this.ensureInitialized("cancelAllOrders");
    await this.gateway.cancelAllOrders();
  }

  private safeInvoke<T extends (...args: any[]) => void>(context: string, cb: T): T {
    const wrapped = ((...args: any[]) => {
      try {
        cb(...args);
      } catch (error) {
        console.error(`[BingxExchangeAdapter] ${context} handler failed: ${extractMessage(error)}`);
      }
    }) as T;
    return wrapped;
  }

  private ensureInitialized(context?: string): Promise<void> {
    if (!this.initPromise) {
      this.initContexts.clear();
      this.initPromise = this.gateway
        .ensureInitialized(this.symbol)
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

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.initPromise) return;
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 60_000);
      void this.ensureInitialized("retry");
    }, this.retryDelayMs);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDelayMs = 3000;
  }

  private handleInitError(context: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastInitErrorAt < 5_000) return;
    this.lastInitErrorAt = now;
    console.error(`[BingxExchangeAdapter] ${context} failed`, error);
  }

  private logError(context: string, error: unknown): void {
    if (this.parseOptionalBoolean(process.env.BINGX_DEBUG) === true) {
      console.error(`[BingxExchangeAdapter] ${context} failed: ${extractMessage(error)}`);
    }
  }

  private parseOptionalNumber(candidate?: number, raw?: string, fallback?: number): number | undefined {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (raw !== undefined) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  private parseOptionalBoolean(value: string | boolean | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    return true;
  }
}

