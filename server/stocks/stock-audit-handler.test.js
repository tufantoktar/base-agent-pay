import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handleStockAnalysisAuditRequest } from "./stock-audit-handler.js";
import { STOCK_AUDIT_ERROR_CODES } from "./stock-audit-store.js";
import {
  createCanonicalStockResultPayload,
  createStockResultHashFromProofPayload,
  serializeStockProofPayload,
} from "./stock-audit-proof.js";
import { SqliteStockAuditStore } from "./stock-audit-store-sqlite.js";

const AUDIT_ID = "11111111-1111-4111-8111-111111111111";

test("lookup by valid auditId returns safe stock audit metadata", async () => {
  const auditStore = createStore();
  auditStore.createAuditRecord(auditRecord());
  const response = await callAuditLookup({
    url: `/api/stock-analysis/audit?id=${AUDIT_ID}`,
    auditStore,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.audit.auditId, AUDIT_ID);
  assert.equal(response.body.audit.requestId, "22222222-2222-4222-8222-222222222222");
  assert.equal(response.body.audit.payment.mode, "mock");
  assert.equal(response.body.audit.payment.status, "VERIFIED");
  assert.notEqual(response.body.audit.payment.status, "SETTLED");
  assert.equal(response.body.audit.network.chainId, 8453);
  assert.equal(response.body.audit.network.caip2, "eip155:8453");
  assert.equal(
    response.body.audit.asset.contractAddress,
    "0xb200000000000000000000C2e324d24d7eEcd1fb",
  );
  assert.equal(response.body.audit.id, undefined);
  assert.equal(response.body.audit.proofPayloadJson, undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /X-PAYMENT/i);
});

test("unknown auditId returns safe 404", async () => {
  const response = await callAuditLookup({
    url: "/api/stock-analysis/audit?id=33333333-3333-4333-8333-333333333333",
    auditStore: createStore(),
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.code, STOCK_AUDIT_ERROR_CODES.NOT_FOUND);
});

test("lookup rejects arbitrary non-UUID ids before store access", async () => {
  let calls = 0;
  const response = await callAuditLookup({
    url: "/api/stock-analysis/audit?id=11111111%27%20OR%201%3D1",
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

test("audit lookup exposes no mutation endpoint", async () => {
  const response = await callAuditLookup({
    method: "POST",
    url: `/api/stock-analysis/audit?id=${AUDIT_ID}`,
    auditStore: createStore(),
  });

  assert.equal(response.statusCode, 405);
  assert.equal(response.body.code, "METHOD_NOT_ALLOWED");
});

async function callAuditLookup({ method = "GET", url, auditStore }) {
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

  await handleStockAnalysisAuditRequest(req, res, {
    auditStore,
    env: { X402_MODE: "mock", PAYMENT_STORE_PATH: ":memory:" },
  });

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: res.statusCode,
    headers,
    body: rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
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

function auditRecord() {
  const proof = proofFields();

  return {
    auditId: AUDIT_ID,
    requestId: "22222222-2222-4222-8222-222222222222",
    mandateId: "stock-mandate-lookup-test",
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: "stock-analysis",
    paymentMode: "mock",
    paymentStatus: "VERIFIED",
    paymentScheme: "mock-x402",
    paymentAmount: "0.01",
    paymentCurrency: "USDC",
    paymentReference: "0xpayment-reference",
    chainId: 8453,
    caip2: "eip155:8453",
    contractAddress: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    resultStatus: "OK",
    resultHash: proof.resultHash,
    proofPayloadJson: proof.proofPayloadJson,
    observedBlockNumber: "123456",
    observedAt: "2026-08-27T10:00:00.000Z",
    createdAt: "2026-08-27T12:00:00.000Z",
    requestHash: "0xrequest-hash",
    policyDecisionCode: "STOCK_MANDATE_ALLOWED",
    registrySource:
      "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base#contract-addresses",
    rpcSource: "Base Mainnet",
  };
}

function proofFields() {
  const proofPayload = createCanonicalStockResultPayload({
    request: {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
    },
    result: {
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
    },
    mandateId: "stock-mandate-lookup-test",
    payment: {
      mode: "mock",
      status: "VERIFIED",
      scheme: "mock-x402",
      amount: "0.01",
      currency: "USDC",
      reference: "0xpayment-reference",
    },
  });

  return {
    resultHash: createStockResultHashFromProofPayload(proofPayload),
    proofPayloadJson: serializeStockProofPayload(proofPayload),
  };
}
