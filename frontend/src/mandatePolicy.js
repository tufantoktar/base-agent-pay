export const DEMO_COUNTERPARTY = "base-agent-pay";
export const DEMO_REQUEST_AMOUNT = "0.01";
export const DEMO_CURRENCY = "USDC";

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

const USDC_ATOMIC_UNITS = 1_000_000n;
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u;

export function createDefaultMandate({
  taskType,
  counterparty = DEMO_COUNTERPARTY,
  now = new Date(),
}) {
  return {
    mandateId: `mandate-demo-${taskType}`,
    maxSpendPerTask: "0.10",
    currency: DEMO_CURRENCY,
    allowedCounterparties: [counterparty],
    expiresAt: new Date(getTime(now) + 30 * 60 * 1000).toISOString(),
    allowedScopes: [taskType],
  };
}

export function evaluateMandatePreflight({ mandate, request, now = new Date() }) {
  try {
    if (!mandate || typeof mandate !== "object") {
      return deny(MANDATE_CODES.MISSING, "Mandate is required.");
    }

    const expiresAt = Date.parse(mandate.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return deny(MANDATE_CODES.INVALID, "Mandate expiry is invalid.");
    }

    if (getTime(now) >= expiresAt) {
      return deny(MANDATE_CODES.EXPIRED, "Mandate has expired.");
    }

    if (mandate.currency !== DEMO_CURRENCY || request.currency !== DEMO_CURRENCY) {
      return deny(MANDATE_CODES.CURRENCY_NOT_ALLOWED, "Only USDC is supported.");
    }

    const requestedAmount = parseUsdcAmount(request.amount);
    const maxSpend = parseUsdcAmount(mandate.maxSpendPerTask);
    if (requestedAmount <= 0n) {
      return deny(MANDATE_CODES.AMOUNT_INVALID, "Requested spend is invalid.");
    }

    if (maxSpend <= 0n) {
      return deny(MANDATE_CODES.INVALID, "Mandate max spend is invalid.");
    }

    if (requestedAmount > maxSpend) {
      return deny(
        MANDATE_CODES.SPEND_EXCEEDED,
        "Requested spend exceeds mandate limit.",
      );
    }

    if (!mandate.allowedCounterparties?.includes(request.counterparty)) {
      return deny(
        MANDATE_CODES.COUNTERPARTY_NOT_ALLOWED,
        "Counterparty is not allowed.",
      );
    }

    if (!mandate.allowedScopes?.includes(request.scope)) {
      return deny(MANDATE_CODES.SCOPE_NOT_ALLOWED, "Scope is not allowed.");
    }

    return {
      allowed: true,
      code: MANDATE_CODES.ALLOWED,
      reason: "Mandate allows this task.",
    };
  } catch {
    return deny(MANDATE_CODES.INTERNAL_ERROR, "Mandate preflight failed closed.");
  }
}

export function mandateDecisionMessage(decision) {
  return decision?.reason ?? "Mandate blocked this task.";
}

export function parseUsdcAmount(amount) {
  if (typeof amount !== "string") {
    throw new Error("Amount must be a decimal string.");
  }

  const match = AMOUNT_PATTERN.exec(amount.trim());
  if (!match) {
    throw new Error("Amount is invalid.");
  }

  const [, whole, fractional = ""] = match;
  return BigInt(whole) * USDC_ATOMIC_UNITS + BigInt(fractional.padEnd(6, "0"));
}

function getTime(value) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new Error("Invalid time.");
  }
  return time;
}

function deny(code, reason) {
  return {
    allowed: false,
    code,
    reason,
  };
}
