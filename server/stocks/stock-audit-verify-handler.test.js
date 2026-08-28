import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handleStockAnalysisAuditVerifyRequest } from "./stock-audit-verify-handler.js";
import {
  createStockAnalysisAuditRecord,
  serializeStockProofPayload,
} from "./stock-audit-proof.js";
import {
  STOCK_AUDIT_VERIFICATION_STATUSES,
} from "./stock-audit-verification.js";
import { STOCK_AUDIT_ERROR_CODES } from "./stock-audit-store.js";
import { SqliteStockAuditStore } from "./stock-audit-store-sqlite.js";
import { STOCK_MANDATE_CODES } from "./stock-mandate.js";

const SNAPSHOT_AUDIT_ID = "11111111-1111-4111-8111-111111111111";
const RISK_AUDIT_ID = "33333333-3333-4333-8333-333333333333";

test("snapshot audit verification returns VALID", async () => {
  const auditStore = createStore();
  const record = auditStore.createAuditRecord(
    auditRecord({
      createAuditId: () => SNAPSHOT_AUDIT_ID,
      createRequestId: () => "22222222-2222-4222-8222-222222222222",
      result: snapshotResult(),
    }),
  );
  const response = await callAuditVerify({
    url: `/api/stock-analysis/audit/verify?id=${record.auditId}`,
    auditStore,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(
    response.body.verification.status,
    STOCK_AUDIT_VERIFICATION_STATUSES.VALID,
  );
  assert.equal(response.body.verification.matches, true);
  assert.equal(
    response.body.verification.computedResultHash,
    response.body.verification.storedResultHash,
  );
  assert.equal(response.body.verification.auditId, SNAPSHOT_AUDIT_ID);
  assert.equal(response.body.verification.requestId, record.requestId);
  assert.equal(response.body.verification.verifiedAt, "2026-08-27T13:00:00.000Z");
});

test("risk-check audit verification returns VALID", async () => {
  const auditStore = createStore();
  const record = auditStore.createAuditRecord(
    auditRecord({
      createAuditId: () => RISK_AUDIT_ID,
      createRequestId: () => "44444444-4444-4444-8444-444444444444",
      request: {
        symbol: "AAPLc",
        analysisType: "risk-check",
        scope: "stock-analysis",
        mandate: { mandateId: "stock-mandate-verify-test" },
      },
      result: riskResult(),
    }),
  );
  const response = await callAuditVerify({
    url: `/api/stock-analysis/audit/verify?id=${record.auditId}`,
    auditStore,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.verification.status,
    STOCK_AUDIT_VERIFICATION_STATUSES.VALID,
  );
  assert.equal(response.body.verification.matches, true);
});

test("tampered row symbol returns INVALID", async () => {
  const auditStore = createStore();
  const record = auditStore.createAuditRecord(auditRecord());

  auditStore.db
    .prepare("UPDATE stock_analysis_audit SET symbol = ? WHERE audit_id = ?")
    .run("NVDAc", record.auditId);

  const response = await callAuditVerify({
    url: `/api/stock-analysis/audit/verify?id=${record.auditId}`,
    auditStore,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.verification.status,
    STOCK_AUDIT_VERIFICATION_STATUSES.INVALID,
  );
  assert.equal(response.body.verification.matches, false);
});

test("tampered analysis payload returns INVALID", async () => {
  const auditStore = createStore();
  const record = auditStore.createAuditRecord(auditRecord());
  const payload = JSON.parse(record.proofPayloadJson);
  payload.analysis.snapshot.totalSupplyAtomic = "461502990001";

  auditStore.db
    .prepare("UPDATE stock_analysis_audit SET proof_payload_json = ? WHERE audit_id = ?")
    .run(serializeStockProofPayload(payload), record.auditId);

  const response = await callAuditVerify({
    url: `/api/stock-analysis/audit/verify?id=${record.auditId}`,
    auditStore,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.verification.status,
    STOCK_AUDIT_VERIFICATION_STATUSES.INVALID,
  );
  assert.notEqual(
    response.body.verification.computedResultHash,
    response.body.verification.storedResultHash,
  );
});

test("tampered payment reference returns INVALID", async () => {
  const auditStore = createStore();
  const record = auditStore.createAuditRecord(auditRecord());
  const payload = JSON.parse(record.proofPayloadJson);
  payload.payment.reference = "0xother-payment-reference";

  auditStore.db
    .prepare("UPDATE stock_analysis_audit SET proof_payload_json = ? WHERE audit_id = ?")
    .run(serializeStockProofPayload(payload), record.auditId);

  const response = await callAuditVerify({
    url: `/api/stock-analysis/audit/verify?id=${record.auditId}`,
    auditStore,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.verification.status,
    STOCK_AUDIT_VERIFICATION_STATUSES.INVALID,
  );
});

test("tampered observed block returns INVALID", async () => {
  const auditStore = createStore();
  const record = auditStore.createAuditRecord(auditRecord());
  const payload = JSON.parse(record.proofPayloadJson);
  payload.observed.blockNumber = "123457";

  auditStore.db
    .prepare("UPDATE stock_analysis_audit SET proof_payload_json = ? WHERE audit_id = ?")
    .run(serializeStockProofPayload(payload), record.auditId);

  const response = await callAuditVerify({
    url: `/api/stock-analysis/audit/verify?id=${record.auditId}`,
    auditStore,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.verification.status,
    STOCK_AUDIT_VERIFICATION_STATUSES.INVALID,
  );
});

test("legacy audit row without proof payload returns UNVERIFIABLE", async () => {
  const auditStore = createStore();
  const record = auditStore.createAuditRecord(auditRecord());

  auditStore.db
    .prepare("UPDATE stock_analysis_audit SET proof_payload_json = NULL WHERE audit_id = ?")
    .run(record.auditId);

  const response = await callAuditVerify({
    url: `/api/stock-analysis/audit/verify?id=${record.auditId}`,
    auditStore,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.body.verification.status,
    STOCK_AUDIT_VERIFICATION_STATUSES.UNVERIFIABLE,
  );
  assert.equal(response.body.verification.matches, false);
  assert.equal(response.body.verification.computedResultHash, null);
});

test("unknown auditId returns safe 404", async () => {
  const response = await callAuditVerify({
    url: "/api/stock-analysis/audit/verify?id=55555555-5555-4555-8555-555555555555",
    auditStore: createStore(),
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.code, STOCK_AUDIT_ERROR_CODES.NOT_FOUND);
});

test("malformed auditId returns safe 400 before store access", async () => {
  let calls = 0;
  const response = await callAuditVerify({
    url: "/api/stock-analysis/audit/verify?id=not-a-valid-id",
    auditStore: {
      async getAuditRecord() {
        calls += 1;
        return null;
      },
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, STOCK_AUDIT_ERROR_CODES.INVALID_LOOKUP);
  assert.equal(calls, 0);
});

test("audit verification exposes no mutation endpoint", async () => {
  const response = await callAuditVerify({
    method: "POST",
    url: `/api/stock-analysis/audit/verify?id=${SNAPSHOT_AUDIT_ID}`,
    auditStore: createStore(),
  });

  assert.equal(response.statusCode, 405);
  assert.equal(response.body.code, "METHOD_NOT_ALLOWED");
});

test("verification response omits proof payload and secret-like fields", async () => {
  const auditStore = createStore();
  const record = auditStore.createAuditRecord(auditRecord());
  const response = await callAuditVerify({
    url: `/api/stock-analysis/audit/verify?id=${record.auditId}`,
    auditStore,
  });
  const serialized = JSON.stringify(response.body);

  assert.doesNotMatch(serialized, /proofPayload/u);
  assert.doesNotMatch(serialized, /X-PAYMENT/i);
  assert.doesNotMatch(serialized, /PAYMENT_DATABASE_URL/u);
  assert.doesNotMatch(serialized, /privateKey/u);
  assert.doesNotMatch(serialized, /CDP_API_KEY_SECRET/u);
});

async function callAuditVerify({ method = "GET", url, auditStore }) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = {};

  const chunks = [];
  const headers = new Map();
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk) {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
    },
  };

  await handleStockAnalysisAuditVerifyRequest(req, res, {
    auditStore,
    now: "2026-08-27T13:00:00.000Z",
    env: { X402_MODE: "mock", PAYMENT_STORE_PATH: ":memory:" },
  });

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: res.statusCode,
    headers,
    body: rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
  };
}

function auditRecord(overrides = {}) {
  return createStockAnalysisAuditRecord({
    request: snapshotRequest(),
    result: snapshotResult(),
    mandateDecision: {
      allowed: true,
      code: STOCK_MANDATE_CODES.ALLOWED,
      mandateId: "stock-mandate-verify-test",
    },
    payment: payment(),
    requestHash: "0xrequest-hash",
    now: "2026-08-27T12:00:00.000Z",
    createAuditId: () => SNAPSHOT_AUDIT_ID,
    createRequestId: () => "22222222-2222-4222-8222-222222222222",
    ...overrides,
  });
}

function snapshotRequest() {
  return {
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: "stock-analysis",
    mandate: { mandateId: "stock-mandate-verify-test" },
  };
}

function payment() {
  return {
    mode: "mock",
    status: "VERIFIED",
    scheme: "mock-x402",
    amount: "0.01",
    currency: "USDC",
    reference: "0xpayment-reference",
  };
}

function snapshotResult() {
  return {
    ok: true,
    analysisType: "snapshot",
    asset: {
      symbol: "AAPLc",
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
  };
}

function riskResult() {
  return {
    ok: true,
    analysisType: "risk-check",
    symbol: "AAPLc",
    risk: {
      status: "PASS",
      flags: [],
      checks: {
        registryMatched: true,
        symbolMatched: true,
      },
      evaluatedAt: "2026-08-27T12:00:00.000Z",
    },
    snapshot: {
      asset: {
        symbol: "AAPLc",
        contractAddress: "0xb200000000000000000000C2e324d24d7eEcd1fb",
      },
      network: {
        chainId: 8453,
        caip2: "eip155:8453",
      },
      onchain: {
        tokenName: "Apple Inc.",
        tokenSymbol: "AAPLc",
        decimals: "8",
        totalSupplyAtomic: "461502990000",
        blockNumber: "123456",
      },
    },
    provenance: {
      registrySource:
        "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base#contract-addresses",
      rpcSource: "Base Mainnet",
      observedAt: "2026-08-27T10:00:00.000Z",
    },
  };
}

function createStore() {
  const store = new SqliteStockAuditStore({
    path: ":memory:",
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });
  test.after(() => store.close());
  return store;
}
