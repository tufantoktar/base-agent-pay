import assert from "node:assert/strict";
import test from "node:test";

import {
  STOCK_AUDIT_ERROR_CODES,
  STOCK_AUDIT_SCHEMA_VERSION,
  StockAuditStoreError,
} from "./stock-audit-store.js";
import { PostgresStockAuditStore } from "./stock-audit-store-postgres.js";

test("Postgres stock audit connection failure is wrapped safely", async () => {
  const store = new PostgresStockAuditStore({
    pool: {
      async connect() {
        throw new Error("internal postgres stock audit connection details");
      },
    },
  });

  await assert.rejects(
    () => store.createAuditRecord(auditRecord()),
    (error) => {
      assert.ok(error instanceof StockAuditStoreError);
      assert.equal(error.code, STOCK_AUDIT_ERROR_CODES.STORE_ERROR);
      assert.equal(error.message, "Stock audit schema initialization failed.");
      assert.doesNotMatch(error.message, /internal postgres/u);
      return true;
    },
  );
});

test("Postgres stock audit migration adds proof payload column idempotently", async () => {
  const queries = [];
  let schemaVersion = "1";
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("SELECT value FROM")) {
        return { rows: schemaVersion ? [{ value: schemaVersion }] : [] };
      }
      if (sql.includes("UPDATE") && sql.includes("stock_audit_store_metadata")) {
        schemaVersion = params[0];
      }
      if (sql.includes("INSERT INTO") && sql.includes("stock_audit_store_metadata")) {
        schemaVersion = params[0];
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  };

  await new PostgresStockAuditStore({ pool }).ensureInitialized();
  await new PostgresStockAuditStore({ pool }).ensureInitialized();

  assert.equal(schemaVersion, String(STOCK_AUDIT_SCHEMA_VERSION));
  assert.equal(
    queries.filter(
      ({ sql }) =>
        sql.includes("ADD COLUMN IF NOT EXISTS") &&
        sql.includes("proof_payload_json"),
    ).length,
    2,
  );
  assert.equal(queries.filter(({ sql }) => sql === "BEGIN").length, 2);
  assert.equal(queries.filter(({ sql }) => sql === "COMMIT").length, 2);
});

function auditRecord() {
  return {
    auditId: "11111111-1111-4111-8111-111111111111",
    requestId: "22222222-2222-4222-8222-222222222222",
    mandateId: "stock-mandate-postgres-test",
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
    createdAt: "2026-08-27T12:00:00.000Z",
    requestHash: "0xrequest-hash",
    policyDecisionCode: "STOCK_MANDATE_ALLOWED",
    registrySource:
      "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base#contract-addresses",
    rpcSource: "Base Mainnet",
  };
}
