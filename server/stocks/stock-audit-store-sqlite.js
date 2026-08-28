import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_PAYMENT_STORE_PATH } from "../task/payment-store-sqlite.js";
import {
  STOCK_AUDIT_ERROR_CODES,
  STOCK_AUDIT_SCHEMA_VERSION,
  StockAuditStore,
  StockAuditStoreError,
  assertValidStockAuditRecord,
} from "./stock-audit-store.js";

export const DEFAULT_STOCK_AUDIT_STORE_PATH = DEFAULT_PAYMENT_STORE_PATH;

export class SqliteStockAuditStore extends StockAuditStore {
  constructor({ path = DEFAULT_STOCK_AUDIT_STORE_PATH, now = () => new Date() } = {}) {
    super();
    this.driver = "sqlite";
    this.path = path;
    this.now = now;
    this.db = openDatabase(path);
    this.initialize();
  }

  createAuditRecord(record) {
    try {
      assertValidStockAuditRecord(record);
      const createdAt = record.createdAt || toUtcTimestamp(this.now());

      this.db
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
            proof_payload_json,
            observed_block_number,
            observed_at,
            created_at,
            request_hash,
            policy_decision_code,
            registry_source,
            rpc_source
          ) VALUES (
            @auditId,
            @requestId,
            @mandateId,
            @symbol,
            @analysisType,
            @scope,
            @paymentMode,
            @paymentStatus,
            @paymentScheme,
            @paymentAmount,
            @paymentCurrency,
            @paymentReference,
            @chainId,
            @caip2,
            @contractAddress,
            @resultStatus,
            @resultHash,
            @proofPayloadJson,
            @observedBlockNumber,
            @observedAt,
            @createdAt,
            @requestHash,
            @policyDecisionCode,
            @registrySource,
            @rpcSource
          )`,
        )
        .run(toInsertParams({ ...record, createdAt }));

      const stored = this.getAuditRecord(record.auditId);
      if (!stored) {
        throw new StockAuditStoreError("Stock audit insert did not create a row.");
      }

      return stored;
    } catch (error) {
      if (error instanceof StockAuditStoreError) {
        throw error;
      }
      throw storeError("Stock audit insert failed.", error);
    }
  }

  getAuditRecord(auditId) {
    try {
      const row = this.db
        .prepare("SELECT * FROM stock_analysis_audit WHERE audit_id = ?")
        .get(auditId);
      return row ? mapAuditRow(row) : null;
    } catch (error) {
      throw storeError("Stock audit read failed.", error);
    }
  }

  close() {
    this.db.close();
  }

  initialize() {
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS stock_audit_store_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS stock_analysis_audit (
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
          proof_payload_json TEXT,
          observed_block_number TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          request_hash TEXT,
          policy_decision_code TEXT,
          registry_source TEXT,
          rpc_source TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_stock_analysis_audit_symbol
          ON stock_analysis_audit(symbol);
        CREATE INDEX IF NOT EXISTS idx_stock_analysis_audit_created_at
          ON stock_analysis_audit(created_at);
      `);
      this.migrateSchema();
    } catch (error) {
      if (error instanceof StockAuditStoreError) {
        throw error;
      }
      throw storeError("Stock audit schema initialization failed.", error);
    }
  }

  migrateSchema() {
    const version = this.db
      .prepare("SELECT value FROM stock_audit_store_metadata WHERE key = 'schema_version'")
      .get()?.value;

    if (version && !["1", String(STOCK_AUDIT_SCHEMA_VERSION)].includes(version)) {
      throw new StockAuditStoreError(
        `Unsupported stock audit store schema version: ${version}.`,
      );
    }

    if (!hasColumn(this.db, "stock_analysis_audit", "proof_payload_json")) {
      this.db.exec("ALTER TABLE stock_analysis_audit ADD COLUMN proof_payload_json TEXT");
    }

    if (version) {
      this.db
        .prepare("UPDATE stock_audit_store_metadata SET value = ? WHERE key = 'schema_version'")
        .run(String(STOCK_AUDIT_SCHEMA_VERSION));
    } else {
      this.db
        .prepare(
          `INSERT INTO stock_audit_store_metadata (key, value)
           VALUES ('schema_version', ?)
           ON CONFLICT(key) DO NOTHING`,
        )
        .run(String(STOCK_AUDIT_SCHEMA_VERSION));
    }

    const currentVersion = this.db
      .prepare("SELECT value FROM stock_audit_store_metadata WHERE key = 'schema_version'")
      .get()?.value;
    if (currentVersion !== String(STOCK_AUDIT_SCHEMA_VERSION)) {
      throw new StockAuditStoreError(
        `Unsupported stock audit store schema version: ${currentVersion}.`,
      );
    }
  }
}

function openDatabase(path) {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  return new DatabaseSync(path);
}

function hasColumn(db, tableName, columnName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);
}

function toInsertParams(record) {
  return {
    auditId: record.auditId,
    requestId: record.requestId,
    mandateId: record.mandateId,
    symbol: record.symbol,
    analysisType: record.analysisType,
    scope: record.scope,
    paymentMode: record.paymentMode,
    paymentStatus: record.paymentStatus,
    paymentScheme: record.paymentScheme,
    paymentAmount: record.paymentAmount,
    paymentCurrency: record.paymentCurrency,
    paymentReference: record.paymentReference,
    chainId: record.chainId,
    caip2: record.caip2,
    contractAddress: record.contractAddress,
    resultStatus: record.resultStatus,
    resultHash: record.resultHash,
    proofPayloadJson: record.proofPayloadJson,
    observedBlockNumber: record.observedBlockNumber ?? null,
    observedAt: record.observedAt ?? null,
    createdAt: record.createdAt,
    requestHash: record.requestHash ?? null,
    policyDecisionCode: record.policyDecisionCode ?? null,
    registrySource: record.registrySource ?? null,
    rpcSource: record.rpcSource ?? null,
  };
}

function mapAuditRow(row) {
  return {
    id: row.id,
    auditId: row.audit_id,
    requestId: row.request_id,
    mandateId: row.mandate_id,
    symbol: row.symbol,
    analysisType: row.analysis_type,
    scope: row.scope,
    paymentMode: row.payment_mode,
    paymentStatus: row.payment_status,
    paymentScheme: row.payment_scheme,
    paymentAmount: row.payment_amount,
    paymentCurrency: row.payment_currency,
    paymentReference: row.payment_reference,
    chainId: row.chain_id,
    caip2: row.caip2,
    contractAddress: row.contract_address,
    resultStatus: row.result_status,
    resultHash: row.result_hash,
    proofPayloadJson: row.proof_payload_json ?? "",
    observedBlockNumber: row.observed_block_number ?? "",
    observedAt: row.observed_at ?? "",
    createdAt: row.created_at,
    requestHash: row.request_hash ?? "",
    policyDecisionCode: row.policy_decision_code ?? "",
    registrySource: row.registry_source ?? "",
    rpcSource: row.rpc_source ?? "",
  };
}

function toUtcTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function storeError(message, cause) {
  return new StockAuditStoreError(message, {
    code: STOCK_AUDIT_ERROR_CODES.STORE_ERROR,
    cause,
  });
}
