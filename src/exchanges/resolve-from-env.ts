import type { ExchangeAdapter } from "./adapter";
import { createExchangeAdapter, resolveExchangeId, type SupportedExchangeId } from "./create-adapter";
import type { AsterCredentials } from "./aster-adapter";
import type { LighterCredentials } from "./lighter/adapter";
import type { BackpackCredentials } from "./backpack/adapter";
import type { ParadexCredentials } from "./paradex/adapter";
import type { BingxCredentials } from "./bingx/adapter";
import type { GrvtCredentials } from "./grvt/adapter";

interface BuildAdapterOptions {
  symbol: string;
  exchangeId?: string | SupportedExchangeId;
}

export function buildAdapterFromEnv(options: BuildAdapterOptions): ExchangeAdapter {
  const id = resolveExchangeId(options.exchangeId);
  const symbol = options.symbol;

  if (id === "aster") {
    const credentials = resolveAsterCredentials();
    return createExchangeAdapter({ exchange: id, symbol, aster: credentials });
  }

  if (id === "lighter") {
    const credentials = resolveLighterCredentials(symbol);
    return createExchangeAdapter({ exchange: id, symbol, lighter: credentials });
  }

  if (id === "backpack") {
    const credentials = resolveBackpackCredentials(symbol);
    return createExchangeAdapter({ exchange: id, symbol, backpack: credentials });
  }

  if (id === "paradex") {
    const credentials = resolveParadexCredentials();
    return createExchangeAdapter({ exchange: id, symbol, paradex: credentials });
  }

  if (id === "bingx") {
    const credentials = resolveBingxCredentials(symbol);
    return createExchangeAdapter({ exchange: id, symbol, bingx: credentials });
  }

  if (id === "grvt") {
    const credentials = resolveGrvtCredentials(symbol);
    return createExchangeAdapter({ exchange: id, symbol, grvt: credentials });
  }

  return createExchangeAdapter({ exchange: id, symbol, grvt: { symbol } });
}

function resolveAsterCredentials(): AsterCredentials {
  const apiKey = process.env.ASTER_API_KEY;
  const apiSecret = process.env.ASTER_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("缺少 ASTER_API_KEY 或 ASTER_API_SECRET 环境变量");
  }
  return { apiKey, apiSecret };
}

function resolveLighterCredentials(symbol: string): LighterCredentials {
  const accountIndexRaw = process.env.LIGHTER_ACCOUNT_INDEX;
  const apiPrivateKey = process.env.LIGHTER_API_PRIVATE_KEY;
  if (!accountIndexRaw || !apiPrivateKey) {
    throw new Error("缺少 LIGHTER_ACCOUNT_INDEX 或 LIGHTER_API_PRIVATE_KEY 环境变量");
  }
  const accountIndex = Number(accountIndexRaw);
  if (!Number.isInteger(accountIndex)) {
    throw new Error("LIGHTER_ACCOUNT_INDEX 必须是整数");
  }
  const credentials: LighterCredentials = {
    displaySymbol: symbol,
    accountIndex,
    apiPrivateKey,
    apiKeyIndex: process.env.LIGHTER_API_KEY_INDEX ? Number(process.env.LIGHTER_API_KEY_INDEX) : 0,
    environment: process.env.LIGHTER_ENV,
    baseUrl: process.env.LIGHTER_BASE_URL,
    l1Address: process.env.LIGHTER_L1_ADDRESS,
    marketSymbol: process.env.LIGHTER_SYMBOL,
    marketId: process.env.LIGHTER_MARKET_ID ? Number(process.env.LIGHTER_MARKET_ID) : undefined,
    priceDecimals: process.env.LIGHTER_PRICE_DECIMALS ? Number(process.env.LIGHTER_PRICE_DECIMALS) : undefined,
    sizeDecimals: process.env.LIGHTER_SIZE_DECIMALS ? Number(process.env.LIGHTER_SIZE_DECIMALS) : undefined,
  };
  return credentials;
}

function resolveBackpackCredentials(symbol: string): BackpackCredentials {
  const apiKey = process.env.BACKPACK_API_KEY;
  const apiSecret = process.env.BACKPACK_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("缺少 BACKPACK_API_KEY 或 BACKPACK_API_SECRET 环境变量");
  }
  const credentials: BackpackCredentials = {
    apiKey,
    apiSecret,
    password: process.env.BACKPACK_PASSWORD,
    subaccount: process.env.BACKPACK_SUBACCOUNT,
    symbol: process.env.BACKPACK_SYMBOL ?? symbol,
    sandbox: parseOptionalBoolean(process.env.BACKPACK_SANDBOX),
  };
  return credentials;
}

function resolveParadexCredentials(): ParadexCredentials {
  const privateKey = process.env.PARADEX_PRIVATE_KEY;
  const walletAddress = process.env.PARADEX_WALLET_ADDRESS;

  if (!privateKey || !walletAddress) {
    throw new Error("Paradex 需要配置 PARADEX_PRIVATE_KEY 与 PARADEX_WALLET_ADDRESS");
  }
  if (!isHex32(privateKey)) {
    throw new Error("PARADEX_PRIVATE_KEY 必须是 0x 开头的 32 字节十六进制字符串");
  }
  if (!isHexAddress(walletAddress)) {
    throw new Error("PARADEX_WALLET_ADDRESS 必须是有效的 0x 开头 40 字节十六进制地址");
  }

  const credentials: ParadexCredentials = {
    privateKey,
    walletAddress,
    sandbox: parseOptionalBoolean(process.env.PARADEX_SANDBOX),
    usePro: parseOptionalBoolean(process.env.PARADEX_USE_PRO),
    watchReconnectDelayMs: parseOptionalNumber(process.env.PARADEX_RECONNECT_DELAY_MS),
  };

  return credentials;
}

function resolveBingxCredentials(symbol: string): BingxCredentials {
  const apiKey = process.env.BINGX_API_KEY;
  const apiSecret = process.env.BINGX_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("BingX 需要配置 BINGX_API_KEY 与 BINGX_API_SECRET 环境变量");
  }
  const leverage = parseOptionalNumber(process.env.BINGX_LEVERAGE) ?? 50;
  const credentials: BingxCredentials = {
    apiKey,
    apiSecret,
    symbol: process.env.BINGX_SYMBOL ?? symbol,
    leverage,
    marginMode: process.env.BINGX_MARGIN_MODE,
    positionMode: parseBingxPositionMode(process.env.BINGX_POSITION_MODE),
    testnet: parseOptionalBoolean(process.env.BINGX_TESTNET),
  };
  return credentials;
}

function resolveGrvtCredentials(symbol: string): GrvtCredentials {
  const apiKey = process.env.GRVT_API_KEY;
  const apiSecret = process.env.GRVT_API_SECRET;
  const cookie = process.env.GRVT_COOKIE;
  const accountId = process.env.GRVT_ACCOUNT_ID;
  const subAccountId = process.env.GRVT_SUB_ACCOUNT_ID;
  const instrument = process.env.GRVT_INSTRUMENT;
  const signerPath = process.env.GRVT_SIGNER_PATH;

  // Validate authentication method
  if (!cookie || !accountId) {
    if (!apiKey) {
      throw new Error(
        "GRVT 需要配置以下环境变量之一:\n" +
          "  方式1: GRVT_COOKIE 与 GRVT_ACCOUNT_ID\n" +
          "  方式2: GRVT_API_KEY (以及 GRVT_API_SECRET 或 GRVT_SIGNER_PATH)"
      );
    }
  }

  // Required fields
  if (!subAccountId) {
    throw new Error("GRVT 需要配置 GRVT_SUB_ACCOUNT_ID 环境变量");
  }
  if (!instrument) {
    throw new Error("GRVT 需要配置 GRVT_INSTRUMENT 环境变量");
  }

  // Validate API secret or signer if using API key
  if (apiKey && !apiSecret && !signerPath) {
    throw new Error(
      "使用 GRVT_API_KEY 时，需要配置 GRVT_API_SECRET 或 GRVT_SIGNER_PATH 环境变量"
    );
  }

  const credentials: GrvtCredentials = {
    apiKey,
    apiSecret,
    cookie,
    accountId,
    subAccountId,
    instrument,
    symbol: process.env.GRVT_SYMBOL ?? symbol,
    env: process.env.GRVT_ENV as GrvtCredentials["env"],
  };

  return credentials;
}

function isHex32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return true;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBingxPositionMode(value: string | undefined): "ONE_WAY" | "HEDGE" | undefined {
  if (value == null) return undefined;
  const normalized = value.toString().trim().toUpperCase().replace(/[-\s]/g, "_");
  if (!normalized) return undefined;
  if (normalized === "ONE_WAY" || normalized === "ONEWAY") return "ONE_WAY";
  if (normalized === "HEDGE" || normalized === "HEDGE_MODE" || normalized === "DUAL") return "HEDGE";
  return undefined;
}
