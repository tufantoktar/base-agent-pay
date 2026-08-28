import pg from "pg";

import {
  STOCK_AUDIT_ERROR_CODES,
  STOCK_AUDIT_SCHEMA_VERSION,
  StockAuditStore,
  StockAuditStoreError,
  assertValidStockAuditRecord,
} from "./stock-audit-store.js";

const { Pool } = pg;

export const DEFAULT_STOCK_AUDIT_POSTGRES_SCHEMA = "public";
const DEFAULT_POSTGRES_POOL_SIZE = 5;

export class PostgresStockAuditStore extends StockAuditStore {
  constructor({
    connectionString = process.env.PAYMENT_DATABASE_URL,
    pool,
    now = () => new Date(),
    logger,
    schema = DEFAULT_STOCK_AUDIT_POSTGRES_SCHEMA,
    max = DEFAULT_POSTGRES_POOL_SIZE,
  } = {}) {
    super();
    this.driver = "postgres";
    this.now = now;
    this.logger = logger;
    this.schema = normalizeIdentifier(schema);
    this.pool =
      pool ??
      createPool({
        connectionString,
        max,
      });
    this.ownsPool = !pool;
    this.initialization = null;
    this.closed = false;
  }

  async createAuditRecord(record) {
    return this.guard("Stock audit insert failed.", async () => {
      await this.ensureInitialized();
      assertValidStockAuditRecord(record);

      const result = await this.pool.query(
        `INSERT INTO ${this.table("stock_analysis_audit")} (
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
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, $24, $25
        )
        RETURNING *`,
        toInsertParams(record),
      );
      const created = mapAuditRow(result.rows[0]);
      this.log("postgres_stock_audit_created", safeAuditLogFields(created));
      return created;
    });
  }

  async getAuditRecord(auditId) {
    return this.guard("Stock audit read failed.", async () => {
      await this.ensureInitialized();
      const result = await this.pool.query(
        `SELECT * FROM ${this.table("stock_analysis_audit")}
         WHERE audit_id = $1`,
        [auditId],
      );
      return result.rows[0] ? mapAuditRow(result.rows[0]) : null;
    });
  }

  async close() {
    if (!this.ownsPool || this.closed) {
      return;
    }

    await this.pool.end();
    this.closed = true;
  }

  async ensureInitialized() {
    this.initialization ??= this.initialize();
    return this.initialization;
  }

  async initialize() {
    return this.guard("Stock audit schema initialization failed.", async () => {
      await this.withTransaction(async (client) => {
        if (this.schema !== DEFAULT_STOCK_AUDIT_POSTGRES_SCHEMA) {
          await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schema)}`);
        }
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${this.table("stock_audit_store_metadata")} (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS ${this.table("stock_analysis_audit")} (
            id BIGSERIAL PRIMARY KEY,
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

          CREATE INDEX IF NOT EXISTS ${quoteIdentifier("stock_analysis_audit_symbol_idx")}
            ON ${this.table("stock_analysis_audit")} (symbol);
          CREATE INDEX IF NOT EXISTS ${quoteIdentifier("stock_analysis_audit_created_at_idx")}
            ON ${this.table("stock_analysis_audit")} (created_at);
        `);
        const versionResult = await client.query(
          `SELECT value FROM ${this.table("stock_audit_store_metadata")}
           WHERE key = 'schema_version'`,
        );
        const version = versionResult.rows[0]?.value;
        if (version && !["1", String(STOCK_AUDIT_SCHEMA_VERSION)].includes(version)) {
          throw new StockAuditStoreError(
            `Unsupported stock audit store schema version: ${version}.`,
          );
        }
        await client.query(
          `ALTER TABLE ${this.table("stock_analysis_audit")}
           ADD COLUMN IF NOT EXISTS proof_payload_json TEXT`,
        );

        if (version) {
          await client.query(
            `UPDATE ${this.table("stock_audit_store_metadata")}
             SET value = $1
             WHERE key = 'schema_version'`,
            [String(STOCK_AUDIT_SCHEMA_VERSION)],
          );
        } else {
          await client.query(
            `INSERT INTO ${this.table("stock_audit_store_metadata")} (key, value)
             VALUES ('schema_version', $1)
             ON CONFLICT (key) DO NOTHING`,
            [String(STOCK_AUDIT_SCHEMA_VERSION)],
          );
        }

        const currentVersionResult = await client.query(
          `SELECT value FROM ${this.table("stock_audit_store_metadata")}
           WHERE key = 'schema_version'`,
        );
        const currentVersion = currentVersionResult.rows[0]?.value;
        if (currentVersion !== String(STOCK_AUDIT_SCHEMA_VERSION)) {
          throw new StockAuditStoreError(
            `Unsupported stock audit store schema version: ${currentVersion}.`,
          );
        }
      });
    });
  }

  async withTransaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original persistence failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  table(name) {
    return `${quoteIdentifier(this.schema)}.${quoteIdentifier(name)}`;
  }

  async guard(message, work) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StockAuditStoreError) {
        throw error;
      }

      this.log("postgres_stock_audit_error", { operation: message });
      throw new StockAuditStoreError(message, {
        code: STOCK_AUDIT_ERROR_CODES.STORE_ERROR,
        cause: error,
      });
    }
  }

  log(event, fields = {}) {
    if (typeof this.logger !== "function") {
      return;
    }

    try {
      this.logger({ event, store: this.driver, ...fields });
    } catch {
      // Store logging is best-effort and must not affect audit persistence.
    }
  }
}

function createPool({ connectionString, max }) {
  if (!connectionString) {
    throw new StockAuditStoreError("PAYMENT_DATABASE_URL is required for Postgres.");
  }

  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
}

function toInsertParams(record) {
  return [
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
    record.proofPayloadJson,
    record.observedBlockNumber ?? null,
    record.observedAt ?? null,
    record.createdAt,
    record.requestHash ?? null,
    record.policyDecisionCode ?? null,
    record.registrySource ?? null,
    record.rpcSource ?? null,
  ];
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
    createdAt: toStoredTimestamp(row.created_at),
    requestHash: row.request_hash ?? "",
    policyDecisionCode: row.policy_decision_code ?? "",
    registrySource: row.registry_source ?? "",
    rpcSource: row.rpc_source ?? "",
  };
}

function safeAuditLogFields(record) {
  if (!record) {
    return {};
  }

  return {
    auditId: record.auditId,
    requestId: record.requestId,
    symbol: record.symbol,
    analysisType: record.analysisType,
    paymentStatus: record.paymentStatus,
    resultHash: record.resultHash,
  };
}

function toStoredTimestamp(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeIdentifier(identifier) {
  const normalized = typeof identifier === "string" ? identifier.trim() : "";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(normalized)) {
    throw new StockAuditStoreError("Invalid Postgres schema identifier.");
  }
  return normalized;
}

function quoteIdentifier(identifier) {
  return `"${normalizeIdentifier(identifier)}"`;
}
