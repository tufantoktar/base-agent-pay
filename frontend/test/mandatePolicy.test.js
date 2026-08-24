import assert from "node:assert/strict";
import test from "node:test";

import {
  DEMO_COUNTERPARTY,
  DEMO_CURRENCY,
  DEMO_REQUEST_AMOUNT,
  MANDATE_CODES,
  createDefaultMandate,
  evaluateMandatePreflight,
} from "../src/mandatePolicy.js";

const NOW = "2026-08-24T12:00:00.000Z";

test("creates default safe mandate values", () => {
  const mandate = createDefaultMandate({
    taskType: "summarize",
    now: NOW,
  });

  assert.equal(mandate.maxSpendPerTask, "0.10");
  assert.equal(mandate.currency, DEMO_CURRENCY);
  assert.deepEqual(mandate.allowedCounterparties, [DEMO_COUNTERPARTY]);
  assert.deepEqual(mandate.allowedScopes, ["summarize"]);
  assert.equal(mandate.expiresAt, "2026-08-24T12:30:00.000Z");
});

test("returns expired mandate warning", () => {
  const decision = evaluateMandatePreflight(
    validEvaluation({
      mandate: { expiresAt: NOW },
    }),
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, MANDATE_CODES.EXPIRED);
});

test("returns spend exceeded warning", () => {
  const decision = evaluateMandatePreflight(
    validEvaluation({
      request: { amount: "0.11" },
    }),
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, MANDATE_CODES.SPEND_EXCEEDED);
});

test("returns scope rejection warning", () => {
  const decision = evaluateMandatePreflight(
    validEvaluation({
      request: { scope: "rewrite" },
    }),
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, MANDATE_CODES.SCOPE_NOT_ALLOWED);
});

test("allows safe default mandate path", () => {
  const decision = evaluateMandatePreflight(validEvaluation());

  assert.equal(decision.allowed, true);
  assert.equal(decision.code, MANDATE_CODES.ALLOWED);
});

function validEvaluation(overrides = {}) {
  const mandate = {
    ...createDefaultMandate({
      taskType: "summarize",
      now: NOW,
    }),
    ...overrides.mandate,
  };
  const request = {
    taskType: "summarize",
    input: "Verify policy.",
    scope: "summarize",
    counterparty: DEMO_COUNTERPARTY,
    amount: DEMO_REQUEST_AMOUNT,
    currency: DEMO_CURRENCY,
    mandate,
    ...overrides.request,
  };

  return {
    request,
    mandate,
    now: overrides.now ?? NOW,
  };
}
