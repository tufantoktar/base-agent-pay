import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { sha256Hex } from "../task/hash.js";
import { STOCK_RPC_CODES, StockRpcError } from "./b20-data-adapter.js";
import {
  handleStockAnalysisRequest,
  normalizeStockAnalysisRequest,
} from "./stock-analysis-handler.js";
import { STOCK_AUDIT_ERROR_CODES } from "./stock-audit-store.js";
import { SqliteStockAuditStore } from "./stock-audit-store-sqlite.js";
import {
  STOCK_AUDIT_VERIFICATION_STATUSES,
  verifyStockAuditRecord,
} from "./stock-audit-verification.js";
import { STOCK_MANDATE_CODES } from "./stock-mandate.js";
import { createStockPaymentAdapter } from "./stock-payment.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const SNAPSHOT = Object.freeze({
  asset: Object.freeze({
    symbol: "AAPLc",
    name: "Apple",
    standard: "B20",
    issuer: "Coinbase",
    contractAddress: "0xb200000000000000000000C2e324d24d7eEcd1fb",
  }),
  network: Object.freeze({
    chainId: 8453,
    caip2: "eip155:8453",
  }),
  onchain: Object.freeze({
    tokenName: "Apple Inc.",
    tokenSymbol: "AAPLc",
    decimals: "8",
    totalSupplyAtomic: "461502990000",
    blockNumber: "123456",
  }),
  provenance: Object.freeze({
    registrySource: "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base#contract-addresses",
    rpcSource: "Base Mainnet",
    observedAt: "2026-08-27T10:00:00.000Z",
  }),
});

test("POST /api/stock-analysis snapshot returns safe normalized data", async () => {
  const response = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: "stock-analysis",
    mandate: validMandate(),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.analysisType, "snapshot");
  assert.equal(response.body.asset.symbol, "AAPLc");
  assert.equal(response.body.network.chainId, 8453);
  assert.equal(response.body.snapshot.totalSupplyAtomic, "461502990000");
  assert.equal(typeof response.body.snapshot.totalSupplyAtomic, "string");
  assert.equal(response.body.provenance.rpcSource, "Base Mainnet");
  assert.equal(response.body.payment.mode, "mock");
  assert.equal(response.body.payment.status, "VERIFIED");
  assert.equal(response.body.payment.amount, "0.01");
  assert.equal(response.body.payment.currency, "USDC");
  assert.match(response.body.audit.auditId, UUID_V4_PATTERN);
  assert.match(response.body.audit.requestId, UUID_V4_PATTERN);
  assert.match(response.body.audit.resultHash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(countAudits(response.auditStore), 1);
  assert.equal(
    response.auditStore.getAuditRecord(response.body.audit.auditId).paymentStatus,
    "VERIFIED",
  );
  assert.deepEqual(response.body.mandateDecision, {
    allowed: true,
    code: STOCK_MANDATE_CODES.ALLOWED,
  });
});

test("POST /api/stock-analysis risk-check returns PASS for healthy snapshot", async () => {
  const response = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "risk-check",
    scope: "stock-analysis",
    mandate: validMandate(),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.risk.status, "PASS");
  assert.deepEqual(response.body.risk.flags, []);
  assert.equal(countAudits(response.auditStore), 1);
  assert.equal(
    response.auditStore.getAuditRecord(response.body.audit.auditId).analysisType,
    "risk-check",
  );
});

test("missing symbol is rejected", async () => {
  const response = await callStockAnalysis({
    analysisType: "snapshot",
    scope: "stock-analysis",
    mandate: validMandate(),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "STOCK_ANALYSIS_INVALID_REQUEST");
  assert.equal(countAudits(response.auditStore), 0);
});

test("missing analysisType is rejected", async () => {
  const response = await callStockAnalysis({
    symbol: "AAPLc",
    scope: "stock-analysis",
    mandate: validMandate(),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "STOCK_ANALYSIS_INVALID_REQUEST");
  assert.equal(countAudits(response.auditStore), 0);
});

test("missing scope is rejected", async () => {
  const response = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "snapshot",
    mandate: validMandate(),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "STOCK_ANALYSIS_INVALID_REQUEST");
  assert.equal(countAudits(response.auditStore), 0);
});

test("missing mandate is rejected before adapter use", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
    },
    {
      autoPay: false,
      dataAdapter: {
        async getStockSnapshot() {
          calls += 1;
          return SNAPSHOT;
        },
      },
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, STOCK_MANDATE_CODES.MISSING);
  assert.deepEqual(response.body.mandateDecision, {
    allowed: false,
    code: STOCK_MANDATE_CODES.MISSING,
  });
  assert.equal(calls, 0);
  assert.equal(countAudits(response.auditStore), 0);
});

test("denied mandate never calls payment adapter or Base RPC", async () => {
  const calls = {
    paymentVerify: 0,
    paymentChallenge: 0,
    stockSnapshot: 0,
  };
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-risk",
      mandate: validMandate(),
    },
    {
      autoPay: false,
      paymentAdapter: {
        verifyPayment() {
          calls.paymentVerify += 1;
          return { ok: false };
        },
        createPaymentRequired() {
          calls.paymentChallenge += 1;
          return {};
        },
      },
      dataAdapter: {
        async getStockSnapshot() {
          calls.stockSnapshot += 1;
          return SNAPSHOT;
        },
      },
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, STOCK_MANDATE_CODES.SCOPE_NOT_ALLOWED);
  assert.equal(response.body.mockPaymentHeader, undefined);
  assert.deepEqual(calls, {
    paymentVerify: 0,
    paymentChallenge: 0,
    stockSnapshot: 0,
  });
  assert.equal(countAudits(response.auditStore), 0);
});

test("allowed mandate without payment returns stock x402 challenge", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    { autoPay: false },
  );

  assert.equal(response.statusCode, 402);
  assert.equal(response.body.code, "PAYMENT_REQUIRED");
  assert.equal(response.body.mode, "mock");
  assert.equal(response.body.resource.url, "/api/stock-analysis");
  assert.equal(
    response.body.resource.description,
    "Policy-controlled read-only tokenized stock analysis on Base.",
  );
  assert.equal(response.body.accepts[0].resource, "/api/stock-analysis");
  assert.equal(response.body.accepts[0].amount, "0.01");
  assert.equal(response.body.accepts[0].currency, "USDC");
  assert.equal(response.body.accepts[0].asset.symbol, "USDC");
  assert.equal(response.body.extensions.bazaar.info.input.method, "POST");
  assert.ok(response.body.mockPaymentHeader.startsWith("mock."));
  assert.equal(response.headers.has("x-payment-response"), true);
  assert.equal(countAudits(response.auditStore), 0);
});

test("Base RPC is not called before payment is accepted", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      autoPay: false,
      dataAdapter: {
        async getStockSnapshot() {
          calls += 1;
          return SNAPSHOT;
        },
      },
    },
  );

  assert.equal(response.statusCode, 402);
  assert.equal(calls, 0);
  assert.equal(countAudits(response.auditStore), 0);
});

test("analysis engine is not called before payment is accepted", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      autoPay: false,
      analysisEngine: {
        async analyze() {
          calls += 1;
          return { ok: true };
        },
      },
    },
  );

  assert.equal(response.statusCode, 402);
  assert.equal(calls, 0);
  assert.equal(countAudits(response.auditStore), 0);
});

test("invalid mock stock payment fails safely before analysis", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      autoPay: false,
      headers: {
        "x-payment": "mock.invalid.header",
      },
      analysisEngine: {
        async analyze() {
          calls += 1;
          return { ok: true };
        },
      },
    },
  );

  assert.equal(response.statusCode, 402);
  assert.equal(response.body.code, "PAYMENT_REQUIRED");
  assert.match(response.body.reason, /invalid/i);
  assert.equal(calls, 0);
  assert.equal(countAudits(response.auditStore), 0);
});

test("unsupported symbol fails safely before adapter use", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "TSLAc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: {
        ...validMandate(),
        allowedAssets: ["TSLAc"],
      },
    },
    {
      autoPay: false,
      dataAdapter: {
        async getStockSnapshot() {
          calls += 1;
          return SNAPSHOT;
        },
      },
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, STOCK_MANDATE_CODES.UNSUPPORTED_ASSET);
  assert.equal(calls, 0);
  assert.equal(countAudits(response.auditStore), 0);
});

test("unsupported analysis type is rejected by mandate before adapter use", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "forecast",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      autoPay: false,
      dataAdapter: {
        async getStockSnapshot() {
          calls += 1;
          return SNAPSHOT;
        },
      },
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, STOCK_MANDATE_CODES.ANALYSIS_TYPE_NOT_ALLOWED);
  assert.equal(calls, 0);
  assert.equal(countAudits(response.auditStore), 0);
});

test("arbitrary contract address field is rejected", async () => {
  const response = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: "stock-analysis",
    mandate: validMandate(),
    contractAddress: "0x1111111111111111111111111111111111111111",
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "STOCK_ANALYSIS_INVALID_REQUEST");
  assert.equal(countAudits(response.auditStore), 0);
});

test("timeout maps safely without raw upstream details", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      dataAdapter: throwingAdapter(STOCK_RPC_CODES.TIMEOUT, "sensitive upstream timeout"),
    },
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, STOCK_RPC_CODES.TIMEOUT);
  assert.doesNotMatch(JSON.stringify(response.body), /sensitive upstream/u);
  assert.equal(countAudits(response.auditStore), 0);
});

test("malformed response maps safely", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      dataAdapter: throwingAdapter(STOCK_RPC_CODES.INVALID_RESPONSE),
    },
  );

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, STOCK_RPC_CODES.INVALID_RESPONSE);
  assert.equal(countAudits(response.auditStore), 0);
});

test("chain mismatch maps safely", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      dataAdapter: throwingAdapter(STOCK_RPC_CODES.CHAIN_MISMATCH),
    },
  );

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, STOCK_RPC_CODES.CHAIN_MISMATCH);
  assert.equal(countAudits(response.auditStore), 0);
});

test("metadata mismatch maps safely", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "risk-check",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      dataAdapter: throwingAdapter(STOCK_RPC_CODES.METADATA_MISMATCH),
    },
  );

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, STOCK_RPC_CODES.METADATA_MISMATCH);
  assert.equal(countAudits(response.auditStore), 0);
});

test("analysis failure returns safely without audit persistence", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      analysisEngine: {
        async analyze() {
          throw new Error("sensitive analysis internals");
        },
      },
    },
  );

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.code, "STOCK_ANALYSIS_FAILED");
  assert.doesNotMatch(JSON.stringify(response.body), /sensitive analysis/u);
  assert.equal(countAudits(response.auditStore), 0);
});

test("audit persistence failure fails closed after analysis", async () => {
  let analysisCalls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      analysisEngine: {
        async analyze() {
          analysisCalls += 1;
          return snapshotResult();
        },
      },
      auditStore: {
        async createAuditRecord() {
          throw new Error("sensitive database internals");
        },
      },
    },
  );

  assert.equal(analysisCalls, 1);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.code, STOCK_AUDIT_ERROR_CODES.PERSISTENCE_FAILED);
  assert.equal(response.body.audit.persisted, false);
  assert.equal(response.body.payment.status, "VERIFIED");
  assert.doesNotMatch(JSON.stringify(response.body), /sensitive database/u);
});

test("denied mandate never calls analysis engine", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
    },
    {
      autoPay: false,
      analysisEngine: {
        async analyze() {
          calls += 1;
          return { ok: true };
        },
      },
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, STOCK_MANDATE_CODES.MISSING);
  assert.equal(calls, 0);
  assert.equal(countAudits(response.auditStore), 0);
});

test("scope mismatch is denied before adapter use", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-risk",
      mandate: validMandate(),
    },
    {
      autoPay: false,
      dataAdapter: {
        async getStockSnapshot() {
          calls += 1;
          return SNAPSHOT;
        },
      },
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, STOCK_MANDATE_CODES.SCOPE_NOT_ALLOWED);
  assert.equal(calls, 0);
  assert.equal(countAudits(response.auditStore), 0);
});

test("asset not allowed is denied before adapter use", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "NVDAc",
      analysisType: "snapshot",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      autoPay: false,
      dataAdapter: {
        async getStockSnapshot() {
          calls += 1;
          return SNAPSHOT;
        },
      },
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, STOCK_MANDATE_CODES.ASSET_NOT_ALLOWED);
  assert.equal(calls, 0);
  assert.equal(countAudits(response.auditStore), 0);
});

test("risk-check reaches analysis when mandate allows it", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "risk-check",
      scope: "stock-analysis",
      mandate: validMandate(),
    },
    {
      analysisEngine: {
        async analyze(request) {
          calls += 1;
          assert.equal(request.scope, "stock-analysis");
          return {
            ...riskResult(),
            risk: { status: "PASS", flags: [] },
          };
        },
      },
    },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(response.body.risk.status, "PASS");
  assert.equal(countAudits(response.auditStore), 1);
});

test("requestId and auditId are unique across accepted executions", async () => {
  const first = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: "stock-analysis",
    mandate: validMandate(),
  });
  const second = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: "stock-analysis",
    mandate: validMandate(),
  });

  assert.notEqual(first.body.audit.auditId, second.body.audit.auditId);
  assert.notEqual(first.body.audit.requestId, second.body.audit.requestId);
});

test("duplicate logical stock executions create independent verifiable audit rows", async () => {
  const auditStore = new SqliteStockAuditStore({
    path: ":memory:",
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });
  test.after(() => auditStore.close());

  const body = {
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: "stock-analysis",
    mandate: validMandate(),
  };
  const first = await callStockAnalysis(body, { auditStore });
  const second = await callStockAnalysis(body, { auditStore });
  const firstAudit = auditStore.getAuditRecord(first.body.audit.auditId);
  const secondAudit = auditStore.getAuditRecord(second.body.audit.auditId);

  assert.equal(countAudits(auditStore), 2);
  assert.notEqual(firstAudit.auditId, secondAudit.auditId);
  assert.notEqual(firstAudit.requestId, secondAudit.requestId);
  assert.equal(firstAudit.requestHash, secondAudit.requestHash);
  assert.equal(firstAudit.paymentReference, secondAudit.paymentReference);
  assert.equal(
    verifyStockAuditRecord(firstAudit).status,
    STOCK_AUDIT_VERIFICATION_STATUSES.VALID,
  );
  assert.equal(
    verifyStockAuditRecord(secondAudit).status,
    STOCK_AUDIT_VERIFICATION_STATUSES.VALID,
  );
});

test("audit record pins Base Mainnet chain id", async () => {
  const response = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: "stock-analysis",
    mandate: validMandate(),
  });
  const audit = response.auditStore.getAuditRecord(response.body.audit.auditId);

  assert.equal(audit.chainId, 8453);
  assert.equal(audit.caip2, "eip155:8453");
});

test("extra request fields are rejected", async () => {
  const response = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: "stock-analysis",
    mandate: validMandate(),
    trade: true,
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "STOCK_ANALYSIS_INVALID_REQUEST");
  assert.equal(countAudits(response.auditStore), 0);
});

test("security regression: stock-analysis implementation exposes no write surface", async () => {
  const fs = await import("node:fs/promises");
  const files = [
    new URL("../../api/stock-analysis.js", import.meta.url),
    new URL("../../api/stock-analysis/audit.js", import.meta.url),
    new URL("../../api/stock-analysis/audit/verify.js", import.meta.url),
    new URL("./stock-analysis-engine.js", import.meta.url),
    new URL("./stock-analysis-handler.js", import.meta.url),
    new URL("./stock-audit-handler.js", import.meta.url),
    new URL("./stock-audit-proof.js", import.meta.url),
    new URL("./stock-audit-store-factory.js", import.meta.url),
    new URL("./stock-audit-store-postgres.js", import.meta.url),
    new URL("./stock-audit-store-sqlite.js", import.meta.url),
    new URL("./stock-audit-store.js", import.meta.url),
    new URL("./stock-audit-verification.js", import.meta.url),
    new URL("./stock-audit-verify-handler.js", import.meta.url),
    new URL("./stock-bazaar-discovery.js", import.meta.url),
    new URL("./stock-mandate.js", import.meta.url),
    new URL("./stock-payment.js", import.meta.url),
  ];
  const source = (await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).join("\n");

  for (const banned of [
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "approve",
    "transferFrom",
    "signer",
    "wallet",
    "private key",
    "/verify",
    "/settle",
  ]) {
    assert.equal(source.includes(banned), false, `${banned} must not appear`);
  }
});

async function callStockAnalysis(body, options = {}) {
  const auditStore =
    options.auditStore ??
    new SqliteStockAuditStore({
      path: ":memory:",
      now: () => new Date("2026-08-27T12:00:00.000Z"),
    });

  if (!options.auditStore) {
    test.after(() => auditStore.close());
  }

  const headers = {
    "content-type": "application/json",
    ...(options.headers ?? {}),
  };

  if (options.autoPay !== false && !headers["x-payment"]) {
    const paymentHeader = createMockStockPaymentHeader(body);
    if (paymentHeader) {
      headers["x-payment"] = paymentHeader;
    }
  }

  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  req.headers = headers;

  const chunks = [];
  const responseHeaders = new Map();
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      responseHeaders.set(name.toLowerCase(), value);
    },
    end(chunk) {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
    },
  };

  await handleStockAnalysisRequest(req, res, {
    analysisEngine: options.analysisEngine,
    dataAdapter:
      options.dataAdapter ??
      {
        async getStockSnapshot() {
          return SNAPSHOT;
        },
      },
    clock: () => new Date("2026-08-27T12:00:00.000Z"),
    env: options.env ?? { X402_MODE: "mock" },
    paymentAdapter: options.paymentAdapter,
    auditStore,
  });

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: res.statusCode,
    headers: responseHeaders,
    body: rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
    auditStore,
  };
}

function createMockStockPaymentHeader(body) {
  const request = normalizeStockAnalysisRequest(body);
  if (!request.ok) {
    return undefined;
  }

  const adapter = createStockPaymentAdapter({
    env: { X402_MODE: "mock" },
  });
  return adapter.createPaymentRequired({
    requestHash: sha256Hex(request.value),
  }).mockPaymentHeader;
}

function validMandate(overrides = {}) {
  return {
    mandateId: "stock-mandate-handler-test",
    allowedAssets: ["AAPLc"],
    allowedAnalysisTypes: ["snapshot", "risk-check"],
    allowedScopes: ["stock-analysis"],
    expiresAt: "2026-12-31T23:59:59.000Z",
    ...overrides,
  };
}

function snapshotResult() {
  return {
    ok: true,
    analysisType: "snapshot",
    asset: SNAPSHOT.asset,
    network: SNAPSHOT.network,
    snapshot: SNAPSHOT.onchain,
    provenance: SNAPSHOT.provenance,
  };
}

function riskResult() {
  return {
    ok: true,
    analysisType: "risk-check",
    symbol: SNAPSHOT.asset.symbol,
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
      asset: SNAPSHOT.asset,
      network: SNAPSHOT.network,
      onchain: SNAPSHOT.onchain,
    },
    provenance: SNAPSHOT.provenance,
  };
}

function throwingAdapter(code, message = "upstream internals") {
  return {
    async getStockSnapshot() {
      throw new StockRpcError(message, { code });
    },
  };
}

function countAudits(store) {
  if (!store?.db) {
    return 0;
  }

  return store.db
    .prepare("SELECT COUNT(*) AS count FROM stock_analysis_audit")
    .get().count;
}
