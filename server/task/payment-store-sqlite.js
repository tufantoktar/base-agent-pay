import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  PAYMENT_SCHEMA_VERSION,
  PAYMENT_STATES,
  PAYMENT_STORE_ERROR_CODES,
  PaymentStore,
  PaymentStoreError,
  assertKnownPaymentState,
  assertValidStateTransition,
} from "./payment-store.js";

export const DEFAULT_PAYMENT_STORE_PATH = "./runtime/base-agent-pay.sqlite";

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

export class SqlitePaymentStore extends PaymentStore {
  constructor({ path = DEFAULT_PAYMENT_STORE_PATH, now = () => new Date() } = {}) {
    super();
    this.driver = "sqlite";
    this.path = path;
    this.now = now;
    this.db = openDatabase(path);
    this.initialize();
  }

  getPayment(idempotencyKey) {
    try {
      const row = this.db
        .prepare("SELECT * FROM live_payments WHERE idempotency_key = ?")
        .get(idempotencyKey);
      return row ? mapPaymentRow(row) : null;
    } catch (error) {
      throw storeError("Payment store read failed.", error);
    }
  }

  getPaymentByLookup(lookupId) {
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM live_payments
           WHERE idempotency_key = ?
              OR task_id = ?
              OR payment_id = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(lookupId, lookupId, lookupId);
      return row ? mapPaymentRow(row) : null;
    } catch (error) {
      throw storeError("Payment store read failed.", error);
    }
  }

  createPayment(record) {
    try {
      const now = toUtcTimestamp(this.now());
      assertKnownPaymentState(record.state);

      this.db
        .prepare(
          `INSERT INTO live_payments (
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
            @idempotencyKey,
            @taskId,
            @requestFingerprint,
            @paymentFingerprint,
            @paymentId,
            @mode,
            @network,
            @asset,
            @amountAtomic,
            @counterparty,
            @state,
            @transactionHash,
            @facilitatorReference,
            @createdAt,
            @updatedAt,
            @settledAt,
            @lastErrorCode,
            @lastErrorMessage,
            @canRetry,
            @settlementAttempts,
            @paymentRequirementsJson,
            @paymentRequiredJson,
            @settlementResponseJson,
            @paymentJson,
            @responsePayloadJson,
            @responseHeadersJson
          )
          ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(toInsertParams(record, now));

      const stored = this.getPayment(record.idempotencyKey);
      if (!stored) {
        throw new PaymentStoreError("Payment store insert did not create a row.");
      }

      return stored;
    } catch (error) {
      if (error instanceof PaymentStoreError) {
        throw error;
      }
      throw storeError("Payment store insert failed.", error);
    }
  }

  transitionPayment({ idempotencyKey, fromStates, toState, updates = {} }) {
    try {
      assertKnownPaymentState(toState);
      const fromStateList = normalizeFromStates(fromStates);
      for (const fromState of fromStateList) {
        assertKnownPaymentState(fromState);
      }

      const current = this.getPayment(idempotencyKey);
      if (!current || !fromStateList.includes(current.state)) {
        return null;
      }
      assertValidStateTransition(current.state, toState);

      const now = toUtcTimestamp(this.now());
      const updateColumns = toUpdateColumns({
        ...updates,
        state: toState,
        updatedAt: now,
      });
      const assignments = updateColumns.map(([column]) => `${column} = @${column}`);
      const params = Object.fromEntries(updateColumns);
      params.idempotency_key = idempotencyKey;
      params.current_state = current.state;

      const result = this.db
        .prepare(
          `UPDATE live_payments
           SET ${assignments.join(", ")}
           WHERE idempotency_key = @idempotency_key
             AND state = @current_state`,
        )
        .run(params);

      if (result.changes !== 1) {
        return null;
      }

      return this.getPayment(idempotencyKey);
    } catch (error) {
      if (error instanceof PaymentStoreError) {
        throw error;
      }
      throw storeError("Payment state transition failed.", error);
    }
  }

  claimSettlement({
    idempotencyKey,
    fromStates = [PAYMENT_STATES.RESOURCE_SUCCEEDED],
  }) {
    const current = this.getPayment(idempotencyKey);
    const settlementAttempts = Number(current?.settlementAttempts ?? 0) + 1;

    return this.transitionPayment({
      idempotencyKey,
      fromStates,
      toState: PAYMENT_STATES.SETTLING,
      updates: {
        settlementAttempts,
        canRetry: false,
      },
    });
  }

  storeTaskResponse({ idempotencyKey, taskId, responsePayload, responseHeaders }) {
    try {
      const now = toUtcTimestamp(this.now());
      const result = this.db
        .prepare(
          `UPDATE live_payments
           SET task_id = @taskId,
               response_payload_json = @responsePayloadJson,
               response_headers_json = @responseHeadersJson,
               updated_at = @updatedAt
           WHERE idempotency_key = @idempotencyKey
             AND state = @state`,
        )
        .run({
          idempotencyKey,
          taskId,
          responsePayloadJson: stringifyJson(responsePayload),
          responseHeadersJson: stringifyJson(responseHeaders),
          updatedAt: now,
          state: PAYMENT_STATES.SETTLED,
        });

      if (result.changes !== 1) {
        return null;
      }

      return this.getPayment(idempotencyKey);
    } catch (error) {
      throw storeError("Payment task response persistence failed.", error);
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
        CREATE TABLE IF NOT EXISTS payment_store_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS live_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
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
          can_retry INTEGER NOT NULL DEFAULT 0 CHECK (can_retry IN (0, 1)),
          settlement_attempts INTEGER NOT NULL DEFAULT 0,
          payment_requirements_json TEXT,
          payment_required_json TEXT,
          settlement_response_json TEXT,
          payment_json TEXT,
          response_payload_json TEXT,
          response_headers_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_live_payments_state
          ON live_payments(state);
        CREATE INDEX IF NOT EXISTS idx_live_payments_payment_id
          ON live_payments(payment_id);
        CREATE INDEX IF NOT EXISTS idx_live_payments_task_id
          ON live_payments(task_id);
      `);
      this.db
        .prepare(
          `INSERT INTO payment_store_metadata (key, value)
           VALUES ('schema_version', ?)
           ON CONFLICT(key) DO NOTHING`,
        )
        .run(String(PAYMENT_SCHEMA_VERSION));

      const version = this.db
        .prepare("SELECT value FROM payment_store_metadata WHERE key = 'schema_version'")
        .get()?.value;
      if (version !== String(PAYMENT_SCHEMA_VERSION)) {
        throw new PaymentStoreError(
          `Unsupported payment store schema version: ${version}.`,
        );
      }
    } catch (error) {
      if (error instanceof PaymentStoreError) {
        throw error;
      }
      throw storeError("Payment store schema initialization failed.", error);
    }
  }
}

export function createDefaultPaymentStore({ env = process.env, now } = {}) {
  return new SqlitePaymentStore({
    path: env.PAYMENT_STORE_PATH || DEFAULT_PAYMENT_STORE_PATH,
    now,
  });
}

function openDatabase(path) {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  return new DatabaseSync(path);
}

function normalizeFromStates(fromStates) {
  return Array.isArray(fromStates) ? fromStates : [fromStates];
}

function toInsertParams(record, now) {
  return {
    idempotencyKey: record.idempotencyKey,
    taskId: record.taskId,
    requestFingerprint: record.requestFingerprint,
    paymentFingerprint: record.paymentFingerprint,
    paymentId: record.paymentId ?? null,
    mode: record.mode,
    network: record.network,
    asset: record.asset,
    amountAtomic: record.amountAtomic,
    counterparty: record.counterparty,
    state: record.state,
    transactionHash: record.transactionHash ?? null,
    facilitatorReference: record.facilitatorReference ?? null,
    createdAt: now,
    updatedAt: now,
    settledAt: record.settledAt ?? null,
    lastErrorCode: record.lastErrorCode ?? null,
    lastErrorMessage: record.lastErrorMessage ?? null,
    canRetry: record.canRetry ? 1 : 0,
    settlementAttempts: record.settlementAttempts ?? 0,
    paymentRequirementsJson: stringifyJson(record.paymentRequirements),
    paymentRequiredJson: stringifyJson(record.paymentRequired),
    settlementResponseJson: stringifyJson(record.settlementResponse),
    paymentJson: stringifyJson(record.payment),
    responsePayloadJson: stringifyJson(record.taskResponse?.payload),
    responseHeadersJson: stringifyJson(record.taskResponse?.headers),
  };
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
      columns.push([column, value ? 1 : 0]);
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at ?? "",
    lastErrorCode: row.last_error_code ?? "",
    lastErrorMessage: row.last_error_message ?? "",
    canRetry: row.can_retry === 1,
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

  return JSON.parse(value);
}

function toUtcTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function storeError(message, cause) {
  return new PaymentStoreError(message, {
    code: PAYMENT_STORE_ERROR_CODES.STORE_ERROR,
    cause,
  });
}
