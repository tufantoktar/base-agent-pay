import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { STOCK_ANALYSIS_TYPES } from "./stock-analysis-engine.js";
import {
  STOCK_ANALYSIS_SCOPE,
  STOCK_MANDATE_SUPPORTED_CURRENCY,
} from "./stock-mandate.js";
import { listSupportedStocks } from "./stock-registry.js";

export const STOCK_RESOURCE_PATH = "/api/stock-analysis";
export const STOCK_RESOURCE_METHOD = "POST";
export const STOCK_RESOURCE_DESCRIPTION =
  "Policy-controlled read-only tokenized stock analysis on Base.";
export const STOCK_PAYMENT_AMOUNT = "0.01";

const SUPPORTED_STOCK_SYMBOLS = Object.freeze(
  listSupportedStocks().map((stock) => stock.symbol),
);

const SUPPORTED_ANALYSIS_TYPES = Object.freeze([
  STOCK_ANALYSIS_TYPES.SNAPSHOT,
  STOCK_ANALYSIS_TYPES.RISK_CHECK,
]);

const STOCK_INPUT_EXAMPLE = Object.freeze({
  symbol: "AAPLc",
  analysisType: STOCK_ANALYSIS_TYPES.SNAPSHOT,
  scope: STOCK_ANALYSIS_SCOPE,
  mandate: Object.freeze({
    mandateId: "stock-mandate-example",
    allowedAssets: Object.freeze(["AAPLc"]),
    allowedAnalysisTypes: SUPPORTED_ANALYSIS_TYPES,
    allowedScopes: Object.freeze([STOCK_ANALYSIS_SCOPE]),
    expiresAt: "2026-12-31T23:59:59.000Z",
  }),
});

const STOCK_MANDATE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    mandateId: {
      type: "string",
      pattern: "^[a-zA-Z0-9._:-]{1,128}$",
    },
    allowedAssets: {
      type: "array",
      items: { type: "string", enum: SUPPORTED_STOCK_SYMBOLS },
      minItems: 1,
      maxItems: SUPPORTED_STOCK_SYMBOLS.length,
      uniqueItems: true,
    },
    allowedAnalysisTypes: {
      type: "array",
      items: { type: "string", enum: SUPPORTED_ANALYSIS_TYPES },
      minItems: 1,
      maxItems: SUPPORTED_ANALYSIS_TYPES.length,
      uniqueItems: true,
    },
    allowedScopes: {
      type: "array",
      items: { type: "string", const: STOCK_ANALYSIS_SCOPE },
      minItems: 1,
      maxItems: 1,
      uniqueItems: true,
    },
    expiresAt: {
      type: "string",
      description: "UTC ISO-8601 mandate expiry timestamp.",
    },
    maxSpendPerTask: {
      type: "string",
      pattern: "^(0|[1-9]\\d*)(?:\\.\\d{1,6})?$",
      description: "Optional USDC policy cap for this analysis request.",
    },
    currency: {
      type: "string",
      const: STOCK_MANDATE_SUPPORTED_CURRENCY,
    },
    allowedCounterparties: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      uniqueItems: true,
    },
  },
  required: [
    "mandateId",
    "allowedAssets",
    "allowedAnalysisTypes",
    "allowedScopes",
    "expiresAt",
  ],
});

const STOCK_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    symbol: {
      type: "string",
      enum: SUPPORTED_STOCK_SYMBOLS,
      description: "Supported Coinbase B20 tokenized stock symbol.",
    },
    analysisType: {
      type: "string",
      enum: SUPPORTED_ANALYSIS_TYPES,
      description: "Read-only stock analysis type.",
    },
    scope: {
      type: "string",
      const: STOCK_ANALYSIS_SCOPE,
    },
    mandate: STOCK_MANDATE_SCHEMA,
  },
  required: ["symbol", "analysisType", "scope", "mandate"],
  additionalProperties: false,
});

const STOCK_SNAPSHOT_OUTPUT_EXAMPLE = Object.freeze({
  ok: true,
  analysisType: STOCK_ANALYSIS_TYPES.SNAPSHOT,
  asset: Object.freeze({
    symbol: "AAPLc",
    standard: "B20",
    issuer: "Coinbase",
  }),
  network: Object.freeze({
    chainId: 8453,
    caip2: "eip155:8453",
  }),
  snapshot: Object.freeze({
    tokenName: "Apple Inc.",
    tokenSymbol: "AAPLc",
    decimals: "8",
    totalSupplyAtomic: "461502990000",
  }),
  provenance: Object.freeze({
    observedAt: "2026-08-27T10:00:00.000Z",
  }),
  payment: Object.freeze({
    mode: "mock",
    status: "VERIFIED",
  }),
});

const STOCK_OUTPUT_SCHEMA = Object.freeze({
  anyOf: Object.freeze([
    Object.freeze({
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean", const: true },
        analysisType: { type: "string", const: STOCK_ANALYSIS_TYPES.SNAPSHOT },
        asset: {
          type: "object",
          additionalProperties: true,
          properties: {
            symbol: { type: "string", enum: SUPPORTED_STOCK_SYMBOLS },
            standard: { type: "string", const: "B20" },
            issuer: { type: "string", const: "Coinbase" },
          },
          required: ["symbol", "standard", "issuer"],
        },
        network: {
          type: "object",
          properties: {
            chainId: { type: "number", const: 8453 },
            caip2: { type: "string", const: "eip155:8453" },
          },
          required: ["chainId", "caip2"],
        },
        snapshot: {
          type: "object",
          additionalProperties: true,
          properties: {
            tokenName: { type: ["string", "null"] },
            tokenSymbol: { type: ["string", "null"] },
            decimals: { type: ["string", "null"] },
            totalSupplyAtomic: { type: ["string", "null"] },
          },
        },
        provenance: {
          type: "object",
          additionalProperties: true,
          properties: {
            observedAt: { type: "string" },
          },
        },
        payment: {
          type: "object",
          properties: {
            mode: { type: "string", const: "mock" },
            status: { type: "string", const: "VERIFIED" },
          },
        },
      },
      required: ["ok", "analysisType", "asset", "network", "snapshot"],
    }),
    Object.freeze({
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean", const: true },
        analysisType: { type: "string", const: STOCK_ANALYSIS_TYPES.RISK_CHECK },
        symbol: { type: "string", enum: SUPPORTED_STOCK_SYMBOLS },
        risk: {
          type: "object",
          additionalProperties: true,
          properties: {
            status: { type: "string", enum: ["PASS", "WARN", "FAIL"] },
            flags: {
              type: "array",
              items: { type: "string" },
            },
            evaluatedAt: { type: "string" },
          },
          required: ["status", "flags"],
        },
        payment: {
          type: "object",
          properties: {
            mode: { type: "string", const: "mock" },
            status: { type: "string", const: "VERIFIED" },
          },
        },
      },
      required: ["ok", "analysisType", "symbol", "risk"],
    }),
  ]),
});

export function createStockBazaarDiscoveryExtensions() {
  return declareDiscoveryExtension({
    method: STOCK_RESOURCE_METHOD,
    bodyType: "json",
    input: STOCK_INPUT_EXAMPLE,
    inputSchema: STOCK_INPUT_SCHEMA,
    output: {
      example: STOCK_SNAPSHOT_OUTPUT_EXAMPLE,
      schema: STOCK_OUTPUT_SCHEMA,
    },
  });
}

export function listStockBazaarSymbols() {
  return SUPPORTED_STOCK_SYMBOLS;
}

export function listStockBazaarAnalysisTypes() {
  return SUPPORTED_ANALYSIS_TYPES;
}
