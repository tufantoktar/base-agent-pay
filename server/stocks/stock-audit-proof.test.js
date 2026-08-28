import assert from "node:assert/strict";
import test from "node:test";

import {
  STOCK_AUDIT_PAYMENT_STATUS,
  createCanonicalStockResultPayload,
  createStockAnalysisAuditRecord,
  createStockResultHash,
} from "./stock-audit-proof.js";
import { STOCK_MANDATE_CODES } from "./stock-mandate.js";

const REQUEST = Object.freeze({
  symbol: "AAPLc",
  analysisType: "snapshot",
  scope: "stock-analysis",
  mandate: Object.freeze({
    mandateId: "stock-mandate-proof-test",
  }),
});

const PAYMENT = Object.freeze({
  mode: "mock",
  status: "VERIFIED",
  scheme: "mock-x402",
  amount: "0.01",
  currency: "USDC",
  reference: "0xpayment-reference",
});

test("stock result hash is deterministic for the same safe payload", () => {
  const first = createStockResultHash({
    request: REQUEST,
    result: snapshotResult(),
    mandateId: REQUEST.mandate.mandateId,
    paymentReference: PAYMENT.reference,
  });
  const second = createStockResultHash({
    paymentReference: PAYMENT.reference,
    mandateId: REQUEST.mandate.mandateId,
    result: snapshotResult({
      provenance: {
        rpcSource: "Base Mainnet",
        observedAt: "2026-08-27T10:00:00.000Z",
        registrySource:
          "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base#contract-addresses",
      },
    }),
    request: { scope: "stock-analysis", analysisType: "snapshot", symbol: "AAPLc" },
  });

  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/u);
});

test("stock result hash changes when the analysis payload changes", () => {
  const first = createStockResultHash({
    request: REQUEST,
    result: snapshotResult(),
    mandateId: REQUEST.mandate.mandateId,
    paymentReference: PAYMENT.reference,
  });
  const second = createStockResultHash({
    request: REQUEST,
    result: snapshotResult({
      snapshot: {
        tokenName: "Apple Inc.",
        tokenSymbol: "AAPLc",
        decimals: "8",
        totalSupplyAtomic: "461502990001",
        blockNumber: "123456",
      },
    }),
    mandateId: REQUEST.mandate.mandateId,
    paymentReference: PAYMENT.reference,
  });

  assert.notEqual(first, second);
});

test("canonical stock proof payload excludes payment headers", () => {
  const payload = createCanonicalStockResultPayload({
    request: {
      ...REQUEST,
      xPayment: "mock.do-not-include",
    },
    result: snapshotResult(),
    mandateId: REQUEST.mandate.mandateId,
    paymentReference: PAYMENT.reference,
  });
  const serialized = JSON.stringify(payload);

  assert.doesNotMatch(serialized, /X-PAYMENT/i);
  assert.doesNotMatch(serialized, /mock\.do-not-include/u);
  assert.equal(payload.payment.reference, PAYMENT.reference);
});

test("stock analysis audit record uses mock VERIFIED status and public ids", () => {
  const record = createStockAnalysisAuditRecord({
    request: REQUEST,
    result: snapshotResult(),
    mandateDecision: {
      allowed: true,
      code: STOCK_MANDATE_CODES.ALLOWED,
      mandateId: REQUEST.mandate.mandateId,
    },
    payment: PAYMENT,
    requestHash: "0xrequest-hash",
    now: "2026-08-27T12:00:00.000Z",
    createAuditId: () => "11111111-1111-4111-8111-111111111111",
    createRequestId: () => "22222222-2222-4222-8222-222222222222",
  });

  assert.equal(record.auditId, "11111111-1111-4111-8111-111111111111");
  assert.equal(record.requestId, "22222222-2222-4222-8222-222222222222");
  assert.equal(record.paymentMode, "mock");
  assert.equal(record.paymentStatus, STOCK_AUDIT_PAYMENT_STATUS);
  assert.notEqual(record.paymentStatus, "SETTLED");
  assert.equal(record.chainId, 8453);
  assert.equal(record.caip2, "eip155:8453");
  assert.equal(record.request, undefined);
});

function snapshotResult(overrides = {}) {
  return {
    ok: true,
    analysisType: "snapshot",
    asset: {
      symbol: "AAPLc",
      name: "Apple",
      standard: "B20",
      issuer: "Coinbase",
      contractAddress: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    },
    network: {
      chainId: 8453,
      caip2: "eip155:8453",
    },
    snapshot: {
      tokenName: "Apple Inc.",
      tokenSymbol: "AAPLc",
      decimals: "8",
      totalSupplyAtomic: "461502990000",
      blockNumber: "123456",
    },
    provenance: {
      registrySource:
        "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base#contract-addresses",
      rpcSource: "Base Mainnet",
      observedAt: "2026-08-27T10:00:00.000Z",
    },
    ...overrides,
  };
}
