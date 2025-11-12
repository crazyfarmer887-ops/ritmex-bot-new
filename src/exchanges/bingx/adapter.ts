import type {
  AccountListener,
  DepthListener,
  ExchangeAdapter,
  KlineListener,
  OrderListener,
  TickerListener,
} from "../adapter";
import type { AsterOrder, CreateOrderParams, ExchangePrecision } from "../types";
import { extractMessage } from "../../utils/errors";
import { BingxGateway, type BingxGatewayOptions } from "./gateway";

export interface BingxCredentials {
  apiKey?: string;
  apiSecret?: string;
  symbol?: string;
  leverage?: number;
  marginMode?: string;
  testnet?: boolean;
}

export class BingxExchangeAdapter implements ExchangeAdapter {
  readonly id = "bingx";
  private readonly gateway: BingxGateway;
  private readonly symbol: string;

  constructor(credentials: BingxCredentials = {}) {
    const apiKey = credentials.apiKey ?? process.env.BINGX_API_KEY;
    const apiSecret = credentials.apiSecret ?? process.env.BINGX_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new Error("BINGX_API_KEY and BINGX_API_SECRET environment variables are required");
    }

    const leverage =
      credentials.leverage ??
      parseOptionalNumber(process.env.BINGX_LEVERAGE) ??
      50;
    const marginMode = credentials.marginMode ?? process.env.BINGX_MARGIN_MODE ?? "ISOLATED";
    const symbol =
      credentials.symbol ?? process.env.BINGX_SYMBOL ?? process.env.TRADE_SYMBOL ?? "BTCUSDT";
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!normalizedSymbol.includes("BTC")) {
      throw new Error(`BingX adapter currently supports only BTC instruments, received ${symbol}`);
    }

    this.symbol = normalizedSymbol;

    const gatewayOptions: BingxGatewayOptions = {
      apiKey,
      apiSecret,
      symbol: normalizedSymbol,
      leverage: leverage > 0 ? leverage : 50,
      marginMode,
      testnet: credentials.testnet ?? parseOptionalBoolean(process.env.BINGX_TESTNET),
      logger: (context, error) => this.logError(context, error),
    };

    this.gateway = new BingxGateway(gatewayOptions);
  }

  supportsTrailingStops(): boolean {
    return false;
  }

  watchAccount(cb: AccountListener): void {
    this.gateway.onAccount(this.safeInvoke("watchAccount", cb));
  }

  watchOrders(cb: OrderListener): void {
    this.gateway.onOrders(this.safeInvoke("watchOrders", cb));
  }

  watchDepth(symbol: string, cb: DepthListener): void {
    this.assertSymbol(symbol);
    this.gateway.onDepth(this.safeInvoke("watchDepth", cb));
  }

  watchTicker(symbol: string, cb: TickerListener): void {
    this.assertSymbol(symbol);
    this.gateway.onTicker(this.safeInvoke("watchTicker", cb));
  }

  watchKlines(symbol: string, interval: string, cb: KlineListener): void {
    this.assertSymbol(symbol);
    this.gateway.watchKlines(interval, this.safeInvoke("watchKlines", cb));
  }

  async createOrder(params: CreateOrderParams): Promise<AsterOrder> {
    this.assertSymbol(params.symbol);
    return this.gateway.createOrder({ ...params, symbol: this.symbol });
  }

  async cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void> {
    this.assertSymbol(params.symbol);
    await this.gateway.cancelOrder({ orderId: params.orderId });
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void> {
    this.assertSymbol(params.symbol);
    await this.gateway.cancelOrders({ orderIdList: params.orderIdList });
  }

  async cancelAllOrders(params: { symbol: string }): Promise<void> {
    this.assertSymbol(params.symbol);
    await this.gateway.cancelAllOrders();
  }

  async getPrecision(): Promise<ExchangePrecision | null> {
    await this.gateway.ensureInitialized();
    const market = this.gateway.getMarketInfo();
    if (!market) return null;
    const priceTick = this.resolveStepSize(
      market?.limits?.price?.min,
      market?.precision?.price,
      0.5
    );
    const qtyStep = this.resolveStepSize(
      market?.limits?.amount?.min,
      market?.precision?.amount,
      0.001
    );
    const priceDecimals = this.extractDecimals(market?.precision?.price);
    const sizeDecimals = this.extractDecimals(market?.precision?.amount);
    return {
      priceTick,
      qtyStep,
      priceDecimals: Number.isFinite(priceDecimals) ? priceDecimals : undefined,
      sizeDecimals: Number.isFinite(sizeDecimals) ? sizeDecimals : undefined,
    };
  }

  private assertSymbol(symbol: string): void {
    if (!symbol) return;
    const normalized = symbol.trim().toUpperCase();
    if (normalized !== this.symbol) {
      throw new Error(`BingX adapter initialized for ${this.symbol} but received ${symbol}`);
    }
  }

  private safeInvoke<T extends (...args: any[]) => void>(context: string, cb: T): T {
    const wrapped = ((...args: Parameters<T>) => {
      try {
        cb(...args);
      } catch (error) {
        this.logError(context, error);
      }
    }) as T;
    return wrapped;
  }

  private logError(context: string, error: unknown): void {
    if (process.env.BINGX_DEBUG === "1" || process.env.BINGX_DEBUG === "true") {
      console.error(`[BingxExchangeAdapter] ${context} failed: ${extractMessage(error)}`);
    }
  }

  private toNumber(value: unknown): number {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private resolveStepSize(limitValue: unknown, precisionValue: unknown, fallback: number): number {
    const limit = this.toNumber(limitValue);
    if (limit > 0) return limit;
    const decimals = this.extractDecimals(precisionValue);
    if (Number.isFinite(decimals) && decimals >= 0 && decimals <= 12) {
      const step = Math.pow(10, -decimals);
      if (Number.isFinite(step) && step > 0) return step;
    }
    return fallback;
  }

  private extractDecimals(value: unknown): number {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    return NaN;
  }
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  return undefined;
}
