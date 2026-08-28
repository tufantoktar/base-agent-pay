import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  STOCK_AUDIT_SCHEMA_VERSION,
  StockAuditStoreError,
  publicStockAuditRecord,
} from "./stock-audit-store.js";
import {
  createCanonicalStockResultPayload,
  createStockResultHashFromProofPayload,
  serializeStockProofPayload,
} from "./stock-audit-proof.js";
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
  assert.equal(publicRecord.proofPayloadJson, undefined);
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
  assert.equal(fetched.resultHash, auditRecord().resultHash);

  second.close();
  fixture.cleanup();
});

test("SQLite stock audit migration preserves legacy rows without proof payload", () => {
  const fixture = createLegacyStoreFixture();
  const store = new SqliteStockAuditStore({
    path: fixture.path,
    now: () => new Date(NOW),
  });
  const fetched = store.getAuditRecord("11111111-1111-4111-8111-111111111111");

  assert.equal(schemaVersion(store), String(STOCK_AUDIT_SCHEMA_VERSION));
  assert.equal(hasColumn(store.db, "stock_analysis_audit", "proof_payload_json"), true);
  assert.equal(fetched.proofPayloadJson, "");
  assert.equal(fetched.resultHash, auditRecord().resultHash);
  store.close();

  const reopened = new SqliteStockAuditStore({
    path: fixture.path,
    now: () => new Date(NOW),
  });
  assert.equal(schemaVersion(reopened), String(STOCK_AUDIT_SCHEMA_VERSION));
  assert.equal(hasColumn(reopened.db, "stock_analysis_audit", "proof_payload_json"), true);
  reopened.close();
  fixture.cleanup();
});

function auditRecord(overrides = {}) {
  const proof = proofFields();

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
    resultHash: proof.resultHash,
    proofPayloadJson: proof.proofPayloadJson,
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

function proofFields() {
  const proofPayload = createCanonicalStockResultPayload({
    request: {
      symbol: "AAPLc",
      analysisType: "snapshot",
      scope: "stock-analysis",
    },
    result: snapshotResult(),
    mandateId: "stock-mandate-store-test",
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

function createLegacyStoreFixture() {
  const fixture = createStoreFixture();
  const db = new DatabaseSync(fixture.path);
  const record = auditRecord();

  db.exec(`
    CREATE TABLE stock_audit_store_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO stock_audit_store_metadata (key, value)
    VALUES ('schema_version', '1');

    CREATE TABLE stock_analysis_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL UNIQUE,
      mandate_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      analysis_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      payment_mode TEXT NOT NULL CHECK (payment_mode = 'mock'),
      payment_status TEXT NOT NULL CHECK (payment_status = 'VERIFIED'),
      payment_scheme TEXT NOT NULL,
      payment_amount TEXT NOT NULL,
      payment_currency TEXT NOT NULL,
      payment_reference TEXT NOT NULL,
      chain_id INTEGER NOT NULL CHECK (chain_id = 8453),
      caip2 TEXT NOT NULL CHECK (caip2 = 'eip155:8453'),
      contract_address TEXT NOT NULL,
      result_status TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      observed_block_number TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      request_hash TEXT,
      policy_decision_code TEXT,
      registry_source TEXT,
      rpc_source TEXT
    );
  `);
  db
    .prepare(
      `INSERT INTO stock_analysis_audit (
        audit_id,
        request_id,
        mandate_id,
        symbol,
        analysis_type,
        scope,
        payment_mode,
        payment_status,
        payment_scheme,
        payment_amount,
        payment_currency,
        payment_reference,
        chain_id,
        caip2,
        contract_address,
        result_status,
        result_hash,
        observed_block_number,
        observed_at,
        created_at,
        request_hash,
        policy_decision_code,
        registry_source,
        rpc_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.auditId,
      record.requestId,
      record.mandateId,
      record.symbol,
      record.analysisType,
      record.scope,
      record.paymentMode,
      record.paymentStatus,
      record.paymentScheme,
      record.paymentAmount,
      record.paymentCurrency,
      record.paymentReference,
      record.chainId,
      record.caip2,
      record.contractAddress,
      record.resultStatus,
      record.resultHash,
      record.observedBlockNumber,
      record.observedAt,
      record.createdAt,
      record.requestHash,
      record.policyDecisionCode,
      record.registrySource,
      record.rpcSource,
    );
  db.close();
  return fixture;
}

function schemaVersion(store) {
  return store.db
    .prepare("SELECT value FROM stock_audit_store_metadata WHERE key = 'schema_version'")
    .get().value;
}

function hasColumn(db, tableName, columnName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);
}

function countAudits(store) {
  return store.db
    .prepare("SELECT COUNT(*) AS count FROM stock_analysis_audit")
    .get().count;
}
