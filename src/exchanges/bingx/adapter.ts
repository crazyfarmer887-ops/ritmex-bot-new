import { setTimeout, clearTimeout } from "timers";
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
  marginMode?: "cross" | "isolated";
  sandbox?: boolean;
  pollIntervals?: BingxGatewayOptions["pollIntervals"];
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

    const symbolSource =
      credentials.symbol ?? process.env.BINGX_SYMBOL ?? process.env.TRADE_SYMBOL ?? "BTC/USDT:USDT";
    const leverage = Number(
      credentials.leverage ?? process.env.BINGX_LEVERAGE ?? process.env.LEVERAGE ?? 50
    );
    const marginMode = (credentials.marginMode ?? process.env.BINGX_MARGIN_MODE ?? "cross")
      .toString()
      .toLowerCase() === "isolated"
      ? "isolated"
      : "cross";
    const sandbox =
      credentials.sandbox ??
      parseOptionalBoolean(process.env.BINGX_SANDBOX) ??
      parseOptionalBoolean(process.env.SANDBOX_MODE);

    this.gateway = new BingxGateway({
      apiKey,
      apiSecret,
      password: credentials.password ?? process.env.BINGX_PASSWORD,
      symbol: symbolSource,
      displaySymbol: symbolSource,
      leverage,
      marginMode,
      sandbox,
      pollIntervals: credentials.pollIntervals,
      logger: (context, error) => this.logError(context, error),
    });

    this.symbol = symbolSource;
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
    this.gateway.onDepth(this.safeInvoke("watchDepth", cb));
  }

  watchTicker(_symbol: string, cb: TickerListener): void {
    void this.ensureInitialized("watchTicker");
    this.gateway.onTicker(this.safeInvoke("watchTicker", cb));
  }

  watchKlines(_symbol: string, interval: string, cb: KlineListener): void {
    void this.ensureInitialized(`watchKlines:${interval}`);
    this.gateway.watchKlines(interval, this.safeInvoke("watchKlines", cb));
  }

  async createOrder(params: CreateOrderParams): Promise<AsterOrder> {
    await this.ensureInitialized("createOrder");
    return this.gateway.createOrder(params);
  }

  async cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void> {
    await this.ensureInitialized("cancelOrder");
    await this.gateway.cancelOrder(params);
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void> {
    await this.ensureInitialized("cancelOrders");
    await this.gateway.cancelOrders(params);
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
    if (now - this.lastInitErrorAt < 5000) return;
    this.lastInitErrorAt = now;
    console.error(`[BingxExchangeAdapter] ${context} failed`, error);
  }

  private logError(context: string, error: unknown): void {
    const detail = extractMessage(error);
    const message = `[BingxExchangeAdapter] ${context} failed: ${detail}`;
    const criticalContexts = ["initialize", "accountPoll", "orderPoll"];
    if (
      criticalContexts.some((prefix) => context.startsWith(prefix)) ||
      process.env.BINGX_DEBUG === "1" ||
      process.env.BINGX_DEBUG === "true"
    ) {
      console.error(message);
    }
  }
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  return undefined;
}
