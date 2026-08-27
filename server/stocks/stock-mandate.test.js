import assert from "node:assert/strict";
import test from "node:test";

import {
  STOCK_ANALYSIS_SCOPE,
  STOCK_MANDATE_CODES,
  evaluateStockMandate,
  parseUsdcSpendToAtomicUnits,
} from "./stock-mandate.js";

const NOW = "2026-08-27T12:00:00.000Z";

test("valid stock mandate allows snapshot analysis", () => {
  const decision = evaluateStockMandate(validEvaluation());

  assert.equal(decision.allowed, true);
  assert.equal(decision.code, STOCK_MANDATE_CODES.ALLOWED);
  assert.equal(decision.mandateId, "stock-mandate-test");
});

test("missing stock mandate denies", () => {
  const decision = evaluateStockMandate({
    request: validRequest(),
    now: NOW,
  });

  assertDenied(decision, STOCK_MANDATE_CODES.MISSING);
});

test("expired stock mandate denies", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: { expiresAt: NOW },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.EXPIRED);
});

test("scope mismatch denies", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      request: { scope: "stock-risk" },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.SCOPE_NOT_ALLOWED);
});

test("extra allowed scope in mandate denies", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: { allowedScopes: [STOCK_ANALYSIS_SCOPE, "stock-risk"] },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.SCOPE_NOT_ALLOWED);
});

test("asset not allowed denies", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      request: { symbol: "NVDAc" },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.ASSET_NOT_ALLOWED);
});

test("analysis type not allowed denies", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: { allowedAnalysisTypes: ["snapshot"] },
      request: { analysisType: "risk-check" },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.ANALYSIS_TYPE_NOT_ALLOWED);
});

test("unsupported asset in mandate is rejected", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: { allowedAssets: ["AAPLc", "TSLAc"] },
      request: { symbol: "AAPLc" },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.UNSUPPORTED_ASSET);
});

test("wildcard asset is rejected", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: { allowedAssets: ["*"] },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.INVALID);
});

test("empty allowlists are rejected", () => {
  for (const override of [
    { allowedAssets: [] },
    { allowedAnalysisTypes: [] },
    { allowedScopes: [] },
  ]) {
    const decision = evaluateStockMandate(
      validEvaluation({
        mandate: override,
      }),
    );

    assertDenied(decision, STOCK_MANDATE_CODES.INVALID);
  }
});

test("malformed expiry is rejected", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: { expiresAt: "soon" },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.INVALID);
});

test("exact expiry boundary denies when now equals expiresAt", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: { expiresAt: "2026-08-27T12:00:00.000Z" },
      now: "2026-08-27T12:00:00.000Z",
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.EXPIRED);
});

test("duplicate assets are rejected deterministically", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: { allowedAssets: ["AAPLc", "aaplc"] },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.INVALID);
});

test("unsupported analysis type in mandate is rejected", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: { allowedAnalysisTypes: ["snapshot", "forecast"] },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.ANALYSIS_TYPE_NOT_ALLOWED);
});

test("optional USDC spend policy validates without payment execution", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: {
        maxSpendPerTask: "0.050000",
        currency: "USDC",
        allowedCounterparties: ["base-agent-pay"],
      },
    }),
  );

  assert.equal(decision.code, STOCK_MANDATE_CODES.ALLOWED);
  assert.equal(parseUsdcSpendToAtomicUnits("0.050000"), 50000n);
});

test("invalid optional spend policy fails closed", () => {
  for (const mandate of [
    { maxSpendPerTask: "0.0500001", currency: "USDC", allowedCounterparties: ["base-agent-pay"] },
    { maxSpendPerTask: "0.05", currency: "ETH", allowedCounterparties: ["base-agent-pay"] },
    { maxSpendPerTask: "0.05", currency: "USDC", allowedCounterparties: [] },
    { maxSpendPerTask: "0", currency: "USDC", allowedCounterparties: ["base-agent-pay"] },
  ]) {
    const decision = evaluateStockMandate(validEvaluation({ mandate }));

    assertDenied(decision, STOCK_MANDATE_CODES.INVALID_SPEND_POLICY);
  }
});

test("extra mandate fields are rejected", () => {
  const decision = evaluateStockMandate(
    validEvaluation({
      mandate: { contractAddress: "0x1111111111111111111111111111111111111111" },
    }),
  );

  assertDenied(decision, STOCK_MANDATE_CODES.INVALID);
});

test("mandate evaluation fails closed on internal errors", () => {
  const decision = evaluateStockMandate({
    mandate: validMandate(),
    request: validRequest(),
    now: NOW,
    registry: {
      getBySymbol() {
        throw new Error("registry unavailable");
      },
    },
  });

  assertDenied(decision, STOCK_MANDATE_CODES.UNSUPPORTED_ASSET);
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
    mandateId: "stock-mandate-test",
    allowedAssets: ["AAPLc"],
    allowedAnalysisTypes: ["snapshot", "risk-check"],
    allowedScopes: [STOCK_ANALYSIS_SCOPE],
    expiresAt: "2026-12-31T23:59:59.000Z",
  };
}

function validRequest() {
  return {
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: STOCK_ANALYSIS_SCOPE,
  };
}

function assertDenied(decision, code) {
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, code);
}
