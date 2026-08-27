import { getStockBySymbol } from "./stock-registry.js";
import { STOCK_ANALYSIS_TYPES } from "./stock-analysis-engine.js";

export const STOCK_MANDATE_CODES = Object.freeze({
  MISSING: "STOCK_MANDATE_MISSING",
  INVALID: "STOCK_MANDATE_INVALID",
  EXPIRED: "STOCK_MANDATE_EXPIRED",
  SCOPE_NOT_ALLOWED: "STOCK_MANDATE_SCOPE_NOT_ALLOWED",
  ASSET_NOT_ALLOWED: "STOCK_MANDATE_ASSET_NOT_ALLOWED",
  ANALYSIS_TYPE_NOT_ALLOWED: "STOCK_MANDATE_ANALYSIS_TYPE_NOT_ALLOWED",
  UNSUPPORTED_ASSET: "STOCK_MANDATE_UNSUPPORTED_ASSET",
  INVALID_SPEND_POLICY: "STOCK_MANDATE_INVALID_SPEND_POLICY",
  ALLOWED: "STOCK_MANDATE_ALLOWED",
});

export const STOCK_ANALYSIS_SCOPE = "stock-analysis";
export const STOCK_MANDATE_SUPPORTED_CURRENCY = "USDC";
export const STOCK_MANDATE_USDC_DECIMALS = 6;
export const STOCK_MANDATE_USDC_ATOMIC_UNITS = 1_000_000n;

const MANDATE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/u;
const DECIMAL_STRING_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u;
const ALLOWED_MANDATE_KEYS = Object.freeze([
  "mandateId",
  "allowedAssets",
  "allowedAnalysisTypes",
  "allowedScopes",
  "expiresAt",
  "maxSpendPerTask",
  "currency",
  "allowedCounterparties",
]);

export function evaluateStockMandate({
  mandate,
  request,
  now = new Date(),
  registry = { getBySymbol: getStockBySymbol },
} = {}) {
  try {
    return evaluateStockMandateInner({ mandate, request, now, registry });
  } catch {
    return deny(
      STOCK_MANDATE_CODES.INVALID,
      "Stock mandate evaluation failed closed.",
    );
  }
}

export function parseUsdcSpendToAtomicUnits(value) {
  if (typeof value !== "string") {
    throw new Error("USDC spend policy must be a decimal string.");
  }

  const normalized = value.trim();
  const match = DECIMAL_STRING_PATTERN.exec(normalized);
  if (!match) {
    throw new Error("USDC spend policy must use up to 6 decimal places.");
  }

  const [, whole, fractional = ""] = match;
  return (
    BigInt(whole) * STOCK_MANDATE_USDC_ATOMIC_UNITS +
    BigInt(fractional.padEnd(STOCK_MANDATE_USDC_DECIMALS, "0"))
  );
}

function evaluateStockMandateInner({ mandate, request, now, registry }) {
  if (mandate === undefined || mandate === null) {
    return deny(STOCK_MANDATE_CODES.MISSING, "Stock mandate is required.");
  }

  if (!isPlainObject(mandate) || !isPlainObject(request)) {
    return deny(STOCK_MANDATE_CODES.INVALID, "Stock mandate request is invalid.");
  }

  if (Object.keys(mandate).some((key) => !ALLOWED_MANDATE_KEYS.includes(key))) {
    return deny(STOCK_MANDATE_CODES.INVALID, "Stock mandate structure is invalid.");
  }

  const mandateId = normalizeText(mandate.mandateId);
  if (!MANDATE_ID_PATTERN.test(mandateId)) {
    return deny(STOCK_MANDATE_CODES.INVALID, "Stock mandate ID is invalid.");
  }

  const allowedAssets = parseAllowedAssets(mandate.allowedAssets, registry);
  const allowedAnalysisTypes = parseUniqueTextList(mandate.allowedAnalysisTypes);
  const allowedScopes = parseUniqueTextList(mandate.allowedScopes);
  const expiresAtMs = parseExpiresAt(mandate.expiresAt);
  const nowMs = parseNow(now);

  if (
    !allowedAssets.ok ||
    !allowedAnalysisTypes.ok ||
    !allowedScopes.ok ||
    expiresAtMs === null ||
    nowMs === null
  ) {
    return deny(STOCK_MANDATE_CODES.INVALID, "Stock mandate structure is invalid.");
  }

  if (nowMs >= expiresAtMs) {
    return deny(STOCK_MANDATE_CODES.EXPIRED, "Stock mandate has expired.");
  }

  const requestedScope = normalizeText(request.scope);
  if (
    requestedScope !== STOCK_ANALYSIS_SCOPE ||
    allowedScopes.values.length !== 1 ||
    allowedScopes.values[0] !== STOCK_ANALYSIS_SCOPE
  ) {
    return deny(
      STOCK_MANDATE_CODES.SCOPE_NOT_ALLOWED,
      "Requested scope is not allowed by mandate.",
    );
  }

  if (!allowedAssets.supported) {
    return deny(
      STOCK_MANDATE_CODES.UNSUPPORTED_ASSET,
      "Mandate includes an unsupported stock asset.",
    );
  }

  const requestedSymbol = canonicalizeRequestedSymbol(request.symbol, registry);
  if (!allowedAssets.values.includes(requestedSymbol)) {
    return deny(
      STOCK_MANDATE_CODES.ASSET_NOT_ALLOWED,
      "Requested asset is not allowed by mandate.",
    );
  }

  const requestedAnalysisType = normalizeText(request.analysisType);
  if (
    !Object.values(STOCK_ANALYSIS_TYPES).includes(requestedAnalysisType) ||
    !allowedAnalysisTypes.values.every((type) =>
      Object.values(STOCK_ANALYSIS_TYPES).includes(type),
    ) ||
    !allowedAnalysisTypes.values.includes(requestedAnalysisType)
  ) {
    return deny(
      STOCK_MANDATE_CODES.ANALYSIS_TYPE_NOT_ALLOWED,
      "Requested analysis type is not allowed by mandate.",
    );
  }

  const paymentPolicy = validateOptionalPaymentPolicy(mandate);
  if (!paymentPolicy.ok) {
    return deny(
      STOCK_MANDATE_CODES.INVALID_SPEND_POLICY,
      "Stock mandate spend policy is invalid.",
    );
  }

  return Object.freeze({
    allowed: true,
    code: STOCK_MANDATE_CODES.ALLOWED,
    reason: "Stock mandate allowed.",
    mandateId,
  });
}

function parseAllowedAssets(value, registry) {
  const parsed = parseUniqueTextList(value);
  if (!parsed.ok) {
    return { ok: false, supported: true, values: [] };
  }

  const canonicalValues = [];
  const canonicalSeen = new Set();
  try {
    for (const asset of parsed.values) {
      const stock = registry.getBySymbol(asset);
      if (canonicalSeen.has(stock.symbol)) {
        return { ok: false, supported: true, values: [] };
      }
      canonicalSeen.add(stock.symbol);
      canonicalValues.push(stock.symbol);
    }
    return { ok: true, supported: true, values: canonicalValues };
  } catch {
    return { ok: true, supported: false, values: [] };
  }
}

function canonicalizeRequestedSymbol(symbol, registry) {
  const normalized = normalizeText(symbol);
  try {
    return registry.getBySymbol(normalized).symbol;
  } catch {
    return normalized;
  }
}

function validateOptionalPaymentPolicy(mandate) {
  const hasPaymentPolicy =
    "maxSpendPerTask" in mandate ||
    "currency" in mandate ||
    "allowedCounterparties" in mandate;

  if (!hasPaymentPolicy) {
    return { ok: true };
  }

  if (normalizeText(mandate.currency) !== STOCK_MANDATE_SUPPORTED_CURRENCY) {
    return { ok: false };
  }

  try {
    const maxSpend = parseUsdcSpendToAtomicUnits(mandate.maxSpendPerTask);
    if (maxSpend <= 0n) {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }

  const allowedCounterparties = parseUniqueTextList(mandate.allowedCounterparties);
  if (!allowedCounterparties.ok) {
    return { ok: false };
  }

  return { ok: true };
}

function parseUniqueTextList(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, values: [] };
  }

  const values = value.map((entry) => normalizeText(entry));
  if (values.some((entry) => entry.length === 0 || entry === "*")) {
    return { ok: false, values: [] };
  }

  const seen = new Set();
  for (const entry of values) {
    if (seen.has(entry)) {
      return { ok: false, values: [] };
    }
    seen.add(entry);
  }

  return { ok: true, values };
}

function parseExpiresAt(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseNow(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function deny(code, reason) {
  return Object.freeze({
    allowed: false,
    code,
    reason,
  });
}
