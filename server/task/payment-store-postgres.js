import pg from "pg";

import {
  PAYMENT_SCHEMA_VERSION,
  PAYMENT_STATES,
  PAYMENT_STORE_ERROR_CODES,
  PaymentStore,
  PaymentStoreError,
  assertKnownPaymentState,
  assertValidStateTransition,
} from "./payment-store.js";

const { Pool } = pg;

export const DEFAULT_POSTGRES_SCHEMA = "public";
const DEFAULT_POSTGRES_POOL_SIZE = 5;

const WRITABLE_COLUMNS = Object.freeze([
  "task_id",
  "request_fingerprint",
  "payment_fingerprint",
  "payment_id",
  "mode",
  "network",
  "asset",
  "amount_atomic",
  "counterparty",
  "state",
  "transaction_hash",
  "facilitator_reference",
  "settled_at",
  "last_error_code",
  "last_error_message",
  "can_retry",
  "settlement_attempts",
  "payment_requirements_json",
  "payment_required_json",
  "settlement_response_json",
  "payment_json",
  "response_payload_json",
  "response_headers_json",
]);

const FIELD_TO_COLUMN = Object.freeze({
  taskId: "task_id",
  requestFingerprint: "request_fingerprint",
  paymentFingerprint: "payment_fingerprint",
  paymentId: "payment_id",
  mode: "mode",
  network: "network",
  asset: "asset",
  amountAtomic: "amount_atomic",
  counterparty: "counterparty",
  state: "state",
  transactionHash: "transaction_hash",
  facilitatorReference: "facilitator_reference",
  settledAt: "settled_at",
  lastErrorCode: "last_error_code",
  lastErrorMessage: "last_error_message",
  canRetry: "can_retry",
  settlementAttempts: "settlement_attempts",
  paymentRequirements: "payment_requirements_json",
  paymentRequired: "payment_required_json",
  settlementResponse: "settlement_response_json",
  payment: "payment_json",
  taskResponse: "response_payload_json",
  responseHeaders: "response_headers_json",
});

export class PostgresPaymentStore extends PaymentStore {
  constructor({
    connectionString = process.env.PAYMENT_DATABASE_URL,
    pool,
    now = () => new Date(),
    logger,
    schema = DEFAULT_POSTGRES_SCHEMA,
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

  async getPayment(idempotencyKey) {
    return this.guard("Payment store read failed.", async () => {
      await this.ensureInitialized();
      const result = await this.pool.query(
        `SELECT * FROM ${this.table("live_payments")}
         WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      return result.rows[0] ? mapPaymentRow(result.rows[0]) : null;
    });
  }

  async createPayment(record) {
    return this.guard("Payment store insert failed.", async () => {
      await this.ensureInitialized();
      assertKnownPaymentState(record.state);

      const now = toUtcTimestamp(this.now());
      const result = await this.pool.query(
        `INSERT INTO ${this.table("live_payments")} (
          idempotency_key,
          task_id,
          request_fingerprint,
          payment_fingerprint,
          payment_id,
          mode,
          network,
          asset,
          amount_atomic,
          counterparty,
          state,
          transaction_hash,
          facilitator_reference,
          created_at,
          updated_at,
          settled_at,
          last_error_code,
          last_error_message,
          can_retry,
          settlement_attempts,
          payment_requirements_json,
          payment_required_json,
          settlement_response_json,
          payment_json,
          response_payload_json,
          response_headers_json
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *`,
        toInsertParams(record, now),
      );

      if (result.rows[0]) {
        const created = mapPaymentRow(result.rows[0]);
        this.log("postgres_payment_created", safePaymentLogFields(created));
        return created;
      }

      const existing = await this.getPayment(record.idempotencyKey);
      if (!existing) {
        throw new PaymentStoreError("Payment store insert did not create a row.");
      }

      this.log("postgres_duplicate_detected", safePaymentLogFields(existing));
      return existing;
    });
  }

  async transitionPayment({ idempotencyKey, fromStates, toState, updates = {} }) {
    return this.guard("Payment state transition failed.", async () => {
      await this.ensureInitialized();
      assertKnownPaymentState(toState);
      const fromStateList = normalizeFromStates(fromStates);
      for (const fromState of fromStateList) {
        assertKnownPaymentState(fromState);
      }

      return this.withTransaction(async (client) => {
        const current = await this.selectPaymentForUpdate(client, idempotencyKey);
        if (!current || !fromStateList.includes(current.state)) {
          return null;
        }
        assertValidStateTransition(current.state, toState);

        const updateColumns = toUpdateColumns({
          ...updates,
          state: toState,
          updatedAt: toUtcTimestamp(this.now()),
        });
        const assignments = updateColumns.map(
          ([column], index) => `${column} = $${index + 1}`,
        );
        const params = updateColumns.map(([, value]) => value);
        params.push(current.id);

        const result = await client.query(
          `UPDATE ${this.table("live_payments")}
           SET ${assignments.join(", ")}
           WHERE id = $${params.length}
           RETURNING *`,
          params,
        );
        const transitioned = result.rows[0]
          ? mapPaymentRow(result.rows[0])
          : null;
        this.log("postgres_state_transition", safePaymentLogFields(transitioned));
        return transitioned;
      });
    });
  }

  async claimSettlement({
    idempotencyKey,
    fromStates = [PAYMENT_STATES.RESOURCE_SUCCEEDED],
  }) {
    return this.guard("Payment settlement claim failed.", async () => {
      await this.ensureInitialized();
      const fromStateList = normalizeFromStates(fromStates);
      for (const fromState of fromStateList) {
        assertKnownPaymentState(fromState);
      }

      return this.withTransaction(async (client) => {
        const current = await this.selectPaymentForUpdate(client, idempotencyKey);
        if (!current || !fromStateList.includes(current.state)) {
          return null;
        }
        assertValidStateTransition(current.state, PAYMENT_STATES.SETTLING);

        const result = await client.query(
          `UPDATE ${this.table("live_payments")}
           SET state = $1,
               updated_at = $2,
               settlement_attempts = settlement_attempts + 1,
               can_retry = FALSE
           WHERE id = $3
           RETURNING *`,
          [PAYMENT_STATES.SETTLING, toUtcTimestamp(this.now()), current.id],
        );
        const claimed = result.rows[0] ? mapPaymentRow(result.rows[0]) : null;
        this.log("postgres_payment_claimed", safePaymentLogFields(claimed));
        return claimed;
      });
    });
  }

  async storeTaskResponse({
    idempotencyKey,
    taskId,
    responsePayload,
    responseHeaders,
  }) {
    return this.guard("Payment task response persistence failed.", async () => {
      await this.ensureInitialized();
      const result = await this.pool.query(
        `UPDATE ${this.table("live_payments")}
         SET task_id = $1,
             response_payload_json = $2,
             response_headers_json = $3,
             updated_at = $4
         WHERE idempotency_key = $5
           AND state = $6
         RETURNING *`,
        [
          taskId,
          stringifyJson(responsePayload),
          stringifyJson(responseHeaders),
          toUtcTimestamp(this.now()),
          idempotencyKey,
          PAYMENT_STATES.SETTLED,
        ],
      );
      return result.rows[0] ? mapPaymentRow(result.rows[0]) : null;
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
    return this.guard("Payment store schema initialization failed.", async () => {
      await this.withTransaction(async (client) => {
        if (this.schema !== DEFAULT_POSTGRES_SCHEMA) {
          await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schema)}`);
        }
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${this.table("payment_store_metadata")} (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS ${this.table("live_payments")} (
            id BIGSERIAL PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            task_id TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            payment_fingerprint TEXT NOT NULL UNIQUE,
            payment_id TEXT,
            mode TEXT NOT NULL,
            network TEXT NOT NULL,
            asset TEXT NOT NULL,
            amount_atomic TEXT NOT NULL,
            counterparty TEXT NOT NULL,
            state TEXT NOT NULL CHECK (
              state IN (
                'CREATED',
                'CHALLENGED',
                'AUTHORIZED',
                'RESOURCE_RUNNING',
                'RESOURCE_SUCCEEDED',
                'SETTLING',
                'SETTLED',
                'FAILED',
                'UNKNOWN',
                'BLOCKED'
              )
            ),
            transaction_hash TEXT,
            facilitator_reference TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            settled_at TEXT,
            last_error_code TEXT,
            last_error_message TEXT,
            can_retry BOOLEAN NOT NULL DEFAULT FALSE,
            settlement_attempts INTEGER NOT NULL DEFAULT 0
              CHECK (settlement_attempts >= 0),
            payment_requirements_json JSONB,
            payment_required_json JSONB,
            settlement_response_json JSONB,
            payment_json JSONB,
            response_payload_json JSONB,
            response_headers_json JSONB
          );

          CREATE INDEX IF NOT EXISTS ${quoteIdentifier("live_payments_state_idx")}
            ON ${this.table("live_payments")} (state);
          CREATE INDEX IF NOT EXISTS ${quoteIdentifier("live_payments_payment_id_idx")}
            ON ${this.table("live_payments")} (payment_id);
        `);
        await client.query(
          `INSERT INTO ${this.table("payment_store_metadata")} (key, value)
           VALUES ('schema_version', $1)
           ON CONFLICT (key) DO NOTHING`,
          [String(PAYMENT_SCHEMA_VERSION)],
        );
        const versionResult = await client.query(
          `SELECT value FROM ${this.table("payment_store_metadata")}
           WHERE key = 'schema_version'`,
        );
        const version = versionResult.rows[0]?.value;
        if (version !== String(PAYMENT_SCHEMA_VERSION)) {
          throw new PaymentStoreError(
            `Unsupported payment store schema version: ${version}.`,
          );
        }
      });
    });
  }

  async selectPaymentForUpdate(client, idempotencyKey) {
    const result = await client.query(
      `SELECT * FROM ${this.table("live_payments")}
       WHERE idempotency_key = $1
       FOR UPDATE`,
      [idempotencyKey],
    );
    return result.rows[0] ? mapPaymentRow(result.rows[0]) : null;
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
        // The original transaction error is the safety-relevant failure.
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
      if (error instanceof PaymentStoreError) {
        throw error;
      }

      this.log("postgres_store_error", { operation: message });
      throw new PaymentStoreError(message, {
        code: PAYMENT_STORE_ERROR_CODES.STORE_ERROR,
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
      // Store logging is best-effort and must not affect safety decisions.
    }
  }
}

function createPool({ connectionString, max }) {
  if (!connectionString) {
    throw new PaymentStoreError("PAYMENT_DATABASE_URL is required for Postgres.");
  }

  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
}

function normalizeFromStates(fromStates) {
  return Array.isArray(fromStates) ? fromStates : [fromStates];
}

function toInsertParams(record, now) {
  return [
    record.idempotencyKey,
    record.taskId,
    record.requestFingerprint,
    record.paymentFingerprint,
    record.paymentId ?? null,
    record.mode,
    record.network,
    record.asset,
    record.amountAtomic,
    record.counterparty,
    record.state,
    record.transactionHash ?? null,
    record.facilitatorReference ?? null,
    now,
    now,
    record.settledAt ?? null,
    record.lastErrorCode ?? null,
    record.lastErrorMessage ?? null,
    record.canRetry === true,
    record.settlementAttempts ?? 0,
    stringifyJson(record.paymentRequirements),
    stringifyJson(record.paymentRequired),
    stringifyJson(record.settlementResponse),
    stringifyJson(record.payment),
    stringifyJson(record.taskResponse?.payload),
    stringifyJson(record.taskResponse?.headers),
  ];
}

function toUpdateColumns(updates) {
  const columns = [];

  for (const [field, value] of Object.entries(updates)) {
    const column = FIELD_TO_COLUMN[field] ?? field;
    if (column === "updatedAt") {
      columns.push(["updated_at", value]);
      continue;
    }

    if (!WRITABLE_COLUMNS.includes(column)) {
      continue;
    }

    if (column.endsWith("_json")) {
      columns.push([column, stringifyJson(value)]);
    } else if (column === "can_retry") {
      columns.push([column, value === true]);
    } else {
      columns.push([column, value ?? null]);
    }
  }

  return columns;
}

function mapPaymentRow(row) {
  const taskResponse = parseTaskResponse(row);

  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    requestFingerprint: row.request_fingerprint,
    paymentFingerprint: row.payment_fingerprint,
    paymentId: row.payment_id ?? "",
    mode: row.mode,
    network: row.network,
    asset: row.asset,
    amountAtomic: row.amount_atomic,
    counterparty: row.counterparty,
    state: row.state,
    transactionHash: row.transaction_hash ?? "",
    facilitatorReference: row.facilitator_reference ?? "",
    createdAt: toStoredTimestamp(row.created_at),
    updatedAt: toStoredTimestamp(row.updated_at),
    settledAt: row.settled_at ? toStoredTimestamp(row.settled_at) : "",
    lastErrorCode: row.last_error_code ?? "",
    lastErrorMessage: row.last_error_message ?? "",
    canRetry: row.can_retry === true,
    settlementAttempts: row.settlement_attempts,
    paymentRequirements: parseJson(row.payment_requirements_json),
    paymentRequired: parseJson(row.payment_required_json),
    settlementResponse: parseJson(row.settlement_response_json),
    payment: parseJson(row.payment_json),
    taskResponse,
    fingerprint: row.payment_fingerprint,
  };
}

function parseTaskResponse(row) {
  const payload = parseJson(row.response_payload_json);
  if (!payload) {
    return null;
  }

  return {
    statusCode: 200,
    payload,
    headers: parseJson(row.response_headers_json) ?? {},
  };
}

function stringifyJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  return typeof value === "string" ? JSON.parse(value) : value;
}

function toUtcTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function toStoredTimestamp(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function safePaymentLogFields(payment) {
  if (!payment) {
    return {};
  }

  return {
    taskId: payment.taskId,
    paymentId: payment.paymentId,
    network: payment.network,
    asset: payment.asset,
    amountAtomic: payment.amountAtomic,
    counterparty: payment.counterparty,
    status: payment.state,
  };
}

function normalizeIdentifier(identifier) {
  const normalized = typeof identifier === "string" ? identifier.trim() : "";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(normalized)) {
    throw new PaymentStoreError("Invalid Postgres schema identifier.");
  }
  return normalized;
}

function quoteIdentifier(identifier) {
  return `"${normalizeIdentifier(identifier)}"`;
}
