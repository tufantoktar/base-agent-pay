import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  STOCK_AUDIT_SCHEMA_VERSION,
  StockAuditStoreError,
  publicStockAuditRecord,
} from "./stock-audit-store.js";
import { SqliteStockAuditStore } from "./stock-audit-store-sqlite.js";

const NOW = "2026-08-27T12:00:00.000Z";

test("SQLite stock audit store persists and looks up safe audit records", () => {
  const store = createStore();
  const created = store.createAuditRecord(auditRecord());
  const fetched = store.getAuditRecord(created.auditId);
  const publicRecord = publicStockAuditRecord(fetched);

  assert.equal(schemaVersion(store), String(STOCK_AUDIT_SCHEMA_VERSION));
  assert.equal(countAudits(store), 1);
  assert.equal(fetched.auditId, "11111111-1111-4111-8111-111111111111");
  assert.equal(fetched.requestId, "22222222-2222-4222-8222-222222222222");
  assert.equal(fetched.paymentStatus, "VERIFIED");
  assert.notEqual(fetched.paymentStatus, "SETTLED");
  assert.equal(fetched.chainId, 8453);
  assert.equal(fetched.caip2, "eip155:8453");
  assert.equal(publicRecord.id, undefined);
  assert.equal(publicRecord.payment.status, "VERIFIED");
  assert.equal(publicRecord.asset.contractAddress, fetched.contractAddress);
});

test("SQLite stock audit store never persists payment headers", () => {
  const store = createStore();
  const created = store.createAuditRecord({
    ...auditRecord(),
    paymentHeader: "mock.header.must.not.persist",
    xPayment: "mock.header.must.not.persist",
  });
  const serialized = JSON.stringify(store.getAuditRecord(created.auditId));

  assert.doesNotMatch(serialized, /mock\.header\.must\.not\.persist/u);
  assert.doesNotMatch(serialized, /X-PAYMENT/i);
});

test("SQLite stock audit store rejects SETTLED mock status", () => {
  const store = createStore();

  assert.throws(
    () =>
      store.createAuditRecord({
        ...auditRecord(),
        paymentStatus: "SETTLED",
      }),
    StockAuditStoreError,
  );
  assert.equal(countAudits(store), 0);
});

test("SQLite stock audit store enforces unique public IDs", () => {
  const store = createStore();
  store.createAuditRecord(auditRecord());

  assert.throws(
    () =>
      store.createAuditRecord({
        ...auditRecord(),
        resultHash: `sha256:${"b".repeat(64)}`,
      }),
    StockAuditStoreError,
  );
  assert.equal(countAudits(store), 1);
});

test("SQLite stock audit state survives restart", () => {
  const fixture = createStoreFixture();
  const first = new SqliteStockAuditStore({
    path: fixture.path,
    now: () => new Date(NOW),
  });
  first.createAuditRecord(auditRecord());
  first.close();

  const second = new SqliteStockAuditStore({
    path: fixture.path,
    now: () => new Date(NOW),
  });
  const fetched = second.getAuditRecord("11111111-1111-4111-8111-111111111111");

  assert.equal(fetched.requestId, "22222222-2222-4222-8222-222222222222");
  assert.equal(fetched.resultHash, `sha256:${"a".repeat(64)}`);

  second.close();
  fixture.cleanup();
});

function auditRecord(overrides = {}) {
  return {
    auditId: "11111111-1111-4111-8111-111111111111",
    requestId: "22222222-2222-4222-8222-222222222222",
    mandateId: "stock-mandate-store-test",
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
    resultHash: `sha256:${"a".repeat(64)}`,
    observedBlockNumber: "123456",
    observedAt: "2026-08-27T10:00:00.000Z",
    createdAt: NOW,
    requestHash: "0xrequest-hash",
    policyDecisionCode: "STOCK_MANDATE_ALLOWED",
    registrySource:
      "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base#contract-addresses",
    rpcSource: "Base Mainnet",
    ...overrides,
  };
}

function createStore() {
  const store = new SqliteStockAuditStore({
    path: ":memory:",
    now: () => new Date(NOW),
  });
  test.after(() => store.close());
  return store;
}

function createStoreFixture() {
  const directory = mkdtempSync(join(tmpdir(), "base-agent-pay-stock-audit-test-"));
  return {
    path: join(directory, "stock-audit.sqlite"),
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function schemaVersion(store) {
  return store.db
    .prepare("SELECT value FROM stock_audit_store_metadata WHERE key = 'schema_version'")
    .get().value;
}

function countAudits(store) {
  return store.db
    .prepare("SELECT COUNT(*) AS count FROM stock_analysis_audit")
    .get().count;
}
