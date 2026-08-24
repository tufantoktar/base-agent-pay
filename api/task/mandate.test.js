import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMandate,
  MANDATE_CODES,
  parseUsdcAmountToAtomicUnits,
} from "./mandate.js";

const NOW = "2026-08-24T12:00:00.000Z";

test("valid mandate => ALLOW", () => {
  const decision = evaluateMandate(validEvaluation());

  assert.equal(decision.allowed, true);
  assert.equal(decision.code, MANDATE_CODES.ALLOWED);
});

test("missing mandate => DENY", () => {
  const decision = evaluateMandate({
    request: validRequest(),
    now: NOW,
  });

  assertDenied(decision, MANDATE_CODES.MISSING);
});

test("malformed mandate => DENY", () => {
  const decision = evaluateMandate({
    mandate: "not-a-mandate",
    request: validRequest(),
    now: NOW,
  });

  assertDenied(decision, MANDATE_CODES.INVALID);
});

test("expired mandate => DENY", () => {
  const decision = evaluateMandate(
    validEvaluation({
      mandate: { expiresAt: NOW },
    }),
  );

  assertDenied(decision, MANDATE_CODES.EXPIRED);
});

test("amount below max => ALLOW", () => {
  const decision = evaluateMandate(
    validEvaluation({
      mandate: { maxSpendPerTask: "0.50" },
      request: { amount: "0.49" },
    }),
  );

  assert.equal(decision.code, MANDATE_CODES.ALLOWED);
});

test("amount equal max => ALLOW", () => {
  const decision = evaluateMandate(
    validEvaluation({
      mandate: { maxSpendPerTask: "0.50" },
      request: { amount: "0.50" },
    }),
  );

  assert.equal(decision.code, MANDATE_CODES.ALLOWED);
});

test("amount above max => DENY", () => {
  const decision = evaluateMandate(
    validEvaluation({
      mandate: { maxSpendPerTask: "0.50" },
      request: { amount: "0.500001" },
    }),
  );

  assertDenied(decision, MANDATE_CODES.SPEND_EXCEEDED);
});

test("counterparty allowed => ALLOW", () => {
  const decision = evaluateMandate(
    validEvaluation({
      mandate: { allowedCounterparties: ["base-agent-pay"] },
      request: { counterparty: "base-agent-pay" },
    }),
  );

  assert.equal(decision.code, MANDATE_CODES.ALLOWED);
});

test("counterparty denied => DENY", () => {
  const decision = evaluateMandate(
    validEvaluation({
      mandate: { allowedCounterparties: ["base-agent-pay"] },
      request: { counterparty: "other-service" },
    }),
  );

  assertDenied(decision, MANDATE_CODES.COUNTERPARTY_NOT_ALLOWED);
});

test("scope allowed => ALLOW", () => {
  const decision = evaluateMandate(
    validEvaluation({
      mandate: { allowedScopes: ["summarize"] },
      request: { scope: "summarize" },
    }),
  );

  assert.equal(decision.code, MANDATE_CODES.ALLOWED);
});

test("scope denied => DENY", () => {
  const decision = evaluateMandate(
    validEvaluation({
      mandate: { allowedScopes: ["summarize"] },
      request: { scope: "research" },
    }),
  );

  assertDenied(decision, MANDATE_CODES.SCOPE_NOT_ALLOWED);
});

test("unsupported currency => DENY", () => {
  const decision = evaluateMandate(
    validEvaluation({
      request: { currency: "EUR" },
    }),
  );

  assertDenied(decision, MANDATE_CODES.CURRENCY_NOT_ALLOWED);
});

test("missing amount => DENY", () => {
  const decision = evaluateMandate(
    validEvaluation({
      request: { amount: undefined },
    }),
  );

  assertDenied(decision, MANDATE_CODES.AMOUNT_INVALID);
});

test("missing scope => DENY", () => {
  const decision = evaluateMandate(
    validEvaluation({
      request: { scope: undefined },
    }),
  );

  assertDenied(decision, MANDATE_CODES.SCOPE_NOT_ALLOWED);
});

test("missing counterparty => DENY", () => {
  const decision = evaluateMandate(
    validEvaluation({
      request: { counterparty: undefined },
    }),
  );

  assertDenied(decision, MANDATE_CODES.COUNTERPARTY_NOT_ALLOWED);
});

test("internal evaluation failure => DENY", () => {
  const failingMandate = new Proxy(
    {},
    {
      get() {
        throw new Error("policy state failed");
      },
    },
  );

  const decision = evaluateMandate({
    mandate: failingMandate,
    request: validRequest(),
    now: NOW,
  });

  assertDenied(decision, MANDATE_CODES.INTERNAL_ERROR);
});

test("USDC decimal strings convert to 6-decimal atomic units", () => {
  assert.equal(parseUsdcAmountToAtomicUnits("0.50"), 500000n);
  assert.equal(parseUsdcAmountToAtomicUnits("1.000001"), 1000001n);
});

function validEvaluation(overrides = {}) {
  return {
    mandate: {
      ...validMandate(),
      ...overrides.mandate,
    },
    request: {
      ...validRequest(),
      ...overrides.request,
    },
    now: overrides.now ?? NOW,
  };
}

function validMandate() {
  return {
    mandateId: "mandate-demo-1",
    maxSpendPerTask: "0.50",
    currency: "USDC",
    allowedCounterparties: ["base-agent-pay"],
    expiresAt: "2026-08-25T12:00:00.000Z",
    allowedScopes: ["summarize"],
  };
}

function validRequest() {
  return {
    amount: "0.25",
    currency: "USDC",
    counterparty: "base-agent-pay",
    scope: "summarize",
  };
}

function assertDenied(decision, code) {
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, code);
}
