export const MANDATE_CODES = Object.freeze({
  MISSING: "MANDATE_MISSING",
  INVALID: "MANDATE_INVALID",
  EXPIRED: "MANDATE_EXPIRED",
  SPEND_EXCEEDED: "MANDATE_SPEND_EXCEEDED",
  COUNTERPARTY_NOT_ALLOWED: "MANDATE_COUNTERPARTY_NOT_ALLOWED",
  SCOPE_NOT_ALLOWED: "MANDATE_SCOPE_NOT_ALLOWED",
  CURRENCY_NOT_ALLOWED: "MANDATE_CURRENCY_NOT_ALLOWED",
  AMOUNT_INVALID: "MANDATE_AMOUNT_INVALID",
  INTERNAL_ERROR: "MANDATE_INTERNAL_ERROR",
  ALLOWED: "MANDATE_ALLOWED",
});

export const SUPPORTED_MANDATE_CURRENCY = "USDC";
export const USDC_DECIMALS = 6;
export const USDC_ATOMIC_UNITS = 1_000_000n;

const MANDATE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/u;
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u;

export function evaluateMandate({ mandate, request, now = new Date() } = {}) {
  try {
    return evaluateMandateInner({ mandate, request, now });
  } catch {
    return deny(
      MANDATE_CODES.INTERNAL_ERROR,
      "Mandate evaluation failed closed.",
    );
  }
}

export function parseUsdcAmountToAtomicUnits(amount) {
  if (typeof amount !== "string") {
    throw new Error("USDC amount must be a decimal string.");
  }

  const normalized = amount.trim();
  const match = AMOUNT_PATTERN.exec(normalized);
  if (!match) {
    throw new Error("USDC amount must be a non-negative decimal with up to 6 decimals.");
  }

  const [, whole, fractional = ""] = match;
  const paddedFractional = fractional.padEnd(USDC_DECIMALS, "0");
  return BigInt(whole) * USDC_ATOMIC_UNITS + BigInt(paddedFractional);
}

function evaluateMandateInner({ mandate, request, now }) {
  if (mandate === undefined || mandate === null) {
    return deny(MANDATE_CODES.MISSING, "Mandate is required.");
  }

  if (!isPlainObject(mandate)) {
    return deny(MANDATE_CODES.INVALID, "Mandate must be an object.");
  }

  const mandateId = normalizeText(mandate.mandateId);
  if (!MANDATE_ID_PATTERN.test(mandateId)) {
    return deny(MANDATE_CODES.INVALID, "Mandate ID is invalid.");
  }

  const maxSpend = parseMandateMaxSpend(mandate.maxSpendPerTask);
  if (!maxSpend.ok) {
    return maxSpend.decision;
  }

  const expiresAtMs = parseExpiresAt(mandate.expiresAt);
  if (expiresAtMs === null) {
    return deny(MANDATE_CODES.INVALID, "Mandate expiresAt must be a valid UTC timestamp.");
  }

  const allowedCounterparties = parseAllowedList(mandate.allowedCounterparties);
  if (!allowedCounterparties.ok) {
    return deny(
      MANDATE_CODES.INVALID,
      "Mandate allowedCounterparties must contain at least one value.",
    );
  }

  const allowedScopes = parseAllowedList(mandate.allowedScopes);
  if (!allowedScopes.ok) {
    return deny(
      MANDATE_CODES.INVALID,
      "Mandate allowedScopes must contain at least one value.",
    );
  }

  const nowMs = parseNow(now);
  if (nowMs === null) {
    return deny(MANDATE_CODES.INTERNAL_ERROR, "Mandate evaluation clock is invalid.");
  }

  if (nowMs >= expiresAtMs) {
    return deny(MANDATE_CODES.EXPIRED, "Mandate has expired.");
  }

  if (normalizeText(mandate.currency) !== SUPPORTED_MANDATE_CURRENCY) {
    return deny(MANDATE_CODES.CURRENCY_NOT_ALLOWED, "Mandate currency is not supported.");
  }

  if (normalizeText(request?.currency) !== SUPPORTED_MANDATE_CURRENCY) {
    return deny(MANDATE_CODES.CURRENCY_NOT_ALLOWED, "Requested currency is not supported.");
  }

  const requestedAmount = parseRequestedAmount(request?.amount);
  if (!requestedAmount.ok) {
    return requestedAmount.decision;
  }

  if (requestedAmount.atomicUnits > maxSpend.atomicUnits) {
    return deny(
      MANDATE_CODES.SPEND_EXCEEDED,
      "Requested amount exceeds maxSpendPerTask.",
    );
  }

  const counterparty = normalizeText(request?.counterparty);
  if (!counterparty || !allowedCounterparties.values.includes(counterparty)) {
    return deny(
      MANDATE_CODES.COUNTERPARTY_NOT_ALLOWED,
      "Counterparty is not allowed by mandate.",
    );
  }

  const scope = normalizeText(request?.scope);
  if (!scope || !allowedScopes.values.includes(scope)) {
    return deny(MANDATE_CODES.SCOPE_NOT_ALLOWED, "Scope is not allowed by mandate.");
  }

  return {
    allowed: true,
    code: MANDATE_CODES.ALLOWED,
    reason: "Mandate allowed.",
    mandateId,
  };
}

function parseMandateMaxSpend(value) {
  try {
    const atomicUnits = parseUsdcAmountToAtomicUnits(value);
    if (atomicUnits <= 0n) {
      return {
        ok: false,
        decision: deny(
          MANDATE_CODES.INVALID,
          "Mandate maxSpendPerTask must be greater than zero.",
        ),
      };
    }
    return { ok: true, atomicUnits };
  } catch {
    return {
      ok: false,
      decision: deny(MANDATE_CODES.INVALID, "Mandate maxSpendPerTask is invalid."),
    };
  }
}

function parseRequestedAmount(value) {
  try {
    const atomicUnits = parseUsdcAmountToAtomicUnits(value);
    if (atomicUnits <= 0n) {
      return {
        ok: false,
        decision: deny(
          MANDATE_CODES.AMOUNT_INVALID,
          "Requested amount must be greater than zero.",
        ),
      };
    }
    return { ok: true, atomicUnits };
  } catch {
    return {
      ok: false,
      decision: deny(MANDATE_CODES.AMOUNT_INVALID, "Requested amount is invalid."),
    };
  }
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

function parseAllowedList(value) {
  if (!Array.isArray(value)) {
    return { ok: false, values: [] };
  }

  const values = value.map((entry) => normalizeText(entry));
  if (values.length === 0 || values.some((entry) => entry.length === 0)) {
    return { ok: false, values: [] };
  }

  return { ok: true, values };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function deny(code, reason) {
  return {
    allowed: false,
    code,
    reason,
  };
}
