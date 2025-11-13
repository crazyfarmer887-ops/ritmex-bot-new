import type { ExchangeAdapter } from "./adapter";
import { createExchangeAdapter, resolveExchangeId, type SupportedExchangeId } from "./create-adapter";
import type { AsterCredentials } from "./aster-adapter";
import type { LighterCredentials } from "./lighter/adapter";
import type { BackpackCredentials } from "./backpack/adapter";
import type { ParadexCredentials } from "./paradex/adapter";
import type { BingxCredentials } from "./bingx/adapter";
import type { GrvtCredentials } from "./grvt/adapter";
import { sanitizeEnvValue, getSanitizedEnv } from "../utils/env";

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
  const apiKey = getSanitizedEnv("ASTER_API_KEY");
  const apiSecret = getSanitizedEnv("ASTER_API_SECRET");
  if (!apiKey || !apiSecret) {
    throw new Error("缺少 ASTER_API_KEY 或 ASTER_API_SECRET 环境变量");
  }
  return { apiKey, apiSecret };
}

function resolveLighterCredentials(symbol: string): LighterCredentials {
  const accountIndexRaw = getSanitizedEnv("LIGHTER_ACCOUNT_INDEX");
  const apiPrivateKey = getSanitizedEnv("LIGHTER_API_PRIVATE_KEY");
  if (!accountIndexRaw || !apiPrivateKey) {
    throw new Error("缺少 LIGHTER_ACCOUNT_INDEX 或 LIGHTER_API_PRIVATE_KEY 环境变量");
  }
  const accountIndex = Number(accountIndexRaw);
  if (!Number.isInteger(accountIndex)) {
    throw new Error("LIGHTER_ACCOUNT_INDEX 必须是整数");
  }
  const apiKeyIndexRaw = getSanitizedEnv("LIGHTER_API_KEY_INDEX");
  const marketIdRaw = getSanitizedEnv("LIGHTER_MARKET_ID");
  const priceDecimalsRaw = getSanitizedEnv("LIGHTER_PRICE_DECIMALS");
  const sizeDecimalsRaw = getSanitizedEnv("LIGHTER_SIZE_DECIMALS");
  const credentials: LighterCredentials = {
    displaySymbol: symbol,
    accountIndex,
    apiPrivateKey,
    apiKeyIndex: apiKeyIndexRaw ? Number(apiKeyIndexRaw) : 0,
    environment: getSanitizedEnv("LIGHTER_ENV"),
    baseUrl: getSanitizedEnv("LIGHTER_BASE_URL"),
    l1Address: getSanitizedEnv("LIGHTER_L1_ADDRESS"),
    marketSymbol: getSanitizedEnv("LIGHTER_SYMBOL"),
    marketId: marketIdRaw ? Number(marketIdRaw) : undefined,
    priceDecimals: priceDecimalsRaw ? Number(priceDecimalsRaw) : undefined,
    sizeDecimals: sizeDecimalsRaw ? Number(sizeDecimalsRaw) : undefined,
  };
  return credentials;
}

function resolveBackpackCredentials(symbol: string): BackpackCredentials {
  const apiKey = getSanitizedEnv("BACKPACK_API_KEY");
  const apiSecret = getSanitizedEnv("BACKPACK_API_SECRET");
  if (!apiKey || !apiSecret) {
    throw new Error("缺少 BACKPACK_API_KEY 或 BACKPACK_API_SECRET 环境变量");
  }
  const credentials: BackpackCredentials = {
    apiKey,
    apiSecret,
    password: getSanitizedEnv("BACKPACK_PASSWORD"),
    subaccount: getSanitizedEnv("BACKPACK_SUBACCOUNT"),
    symbol: getSanitizedEnv("BACKPACK_SYMBOL") ?? symbol,
    sandbox: parseOptionalBoolean(getSanitizedEnv("BACKPACK_SANDBOX")),
  };
  return credentials;
}

function resolveParadexCredentials(): ParadexCredentials {
  const privateKey = getSanitizedEnv("PARADEX_PRIVATE_KEY");
  const walletAddress = getSanitizedEnv("PARADEX_WALLET_ADDRESS");

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
    sandbox: parseOptionalBoolean(getSanitizedEnv("PARADEX_SANDBOX")),
    usePro: parseOptionalBoolean(getSanitizedEnv("PARADEX_USE_PRO")),
    watchReconnectDelayMs: parseOptionalNumber(getSanitizedEnv("PARADEX_RECONNECT_DELAY_MS")),
  };

  return credentials;
}

function resolveBingxCredentials(symbol: string): BingxCredentials {
  const apiKey = getSanitizedEnv("BINGX_API_KEY");
  const apiSecret = getSanitizedEnv("BINGX_API_SECRET");
  if (!apiKey || !apiSecret) {
    throw new Error("BingX 需要配置 BINGX_API_KEY 与 BINGX_API_SECRET 环境变量");
  }
  const leverage = parseOptionalNumber(getSanitizedEnv("BINGX_LEVERAGE")) ?? 50;
  const credentials: BingxCredentials = {
    apiKey,
    apiSecret,
    symbol: getSanitizedEnv("BINGX_SYMBOL") ?? symbol,
    leverage,
    marginMode: getSanitizedEnv("BINGX_MARGIN_MODE"),
    testnet: parseOptionalBoolean(getSanitizedEnv("BINGX_TESTNET")),
  };
  return credentials;
}

function resolveGrvtCredentials(symbol: string): GrvtCredentials {
  const apiKey = getSanitizedEnv("GRVT_API_KEY");
  const apiSecret = getSanitizedEnv("GRVT_API_SECRET");
  const cookie = getSanitizedEnv("GRVT_COOKIE");
  const accountId = getSanitizedEnv("GRVT_ACCOUNT_ID");
  const subAccountId = getSanitizedEnv("GRVT_SUB_ACCOUNT_ID");
  const instrument = getSanitizedEnv("GRVT_INSTRUMENT");
  const signerPath = getSanitizedEnv("GRVT_SIGNER_PATH");

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
    symbol: getSanitizedEnv("GRVT_SYMBOL") ?? sanitizeEnvValue(symbol) ?? symbol,
    env: getSanitizedEnv("GRVT_ENV") as GrvtCredentials["env"],
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
  const cleaned = sanitizeEnvValue(value);
  if (!cleaned) return undefined;
  const normalized = cleaned.toLowerCase();
  if (!normalized) return undefined;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return true;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  const cleaned = sanitizeEnvValue(value);
  if (!cleaned) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}
