import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import {
  PAYMENT_SCHEMA_VERSION,
  PAYMENT_STATES,
  PAYMENT_STORE_ERROR_CODES,
  PaymentStoreError,
  PostgresPaymentStore,
} from "./payment-adapter.js";

const { Pool } = pg;
const NOW = "2026-08-22T00:00:00.000Z";
const POSTGRES_TEST_DATABASE_URL = process.env.PAYMENT_TEST_DATABASE_URL;
const POSTGRES_SKIP_REASON =
  "Set PAYMENT_TEST_DATABASE_URL to run real Postgres payment-store tests.";

postgresTest("creates schema version and persists payment records", async (fixture) => {
  const store = fixture.createStore();
  const record = await store.createPayment(paymentRecord());
  const fetched = await store.getPayment("task_pg_00000001");

  assert.equal(await schemaVersion(store), String(PAYMENT_SCHEMA_VERSION));
  assert.equal(record.idempotencyKey, "task_pg_00000001");
  assert.equal(fetched.paymentFingerprint, "0xpayment");
  assert.equal(fetched.amountAtomic, "10000");
  assert.equal(fetched.createdAt, NOW);
  assert.equal(fetched.updatedAt, NOW);
});

postgresTest("idempotency key duplicates return the existing row", async (fixture) => {
  const store = fixture.createStore();
  const first = await store.createPayment(paymentRecord());
  const second = await store.createPayment(
    paymentRecord({
      requestFingerprint: "0xdifferent",
      paymentFingerprint: "0xdifferent-payment",
      amountAtomic: "20000",
    }),
  );

  assert.equal(second.id, first.id);
  assert.equal(second.requestFingerprint, first.requestFingerprint);
  assert.equal(await countPayments(store), 1);
});

postgresTest("payment fingerprint duplicates are rejected by Postgres", async (fixture) => {
  const store = fixture.createStore();
  await store.createPayment(paymentRecord());

  await assert.rejects(
    () =>
      store.createPayment(
        paymentRecord({
          idempotencyKey: "task_pg_00000002",
          taskId: "task_pg_00000002",
        }),
      ),
    PaymentStoreError,
  );
  assert.equal(await countPayments(store), 1);
});

postgresTest("state transitions are explicit and invalid jumps fail", async (fixture) => {
  const store = fixture.createStore();
  await store.createPayment(paymentRecord());

  const challenged = await store.transitionPayment({
    idempotencyKey: "task_pg_00000001",
    fromStates: [PAYMENT_STATES.CREATED],
    toState: PAYMENT_STATES.CHALLENGED,
  });
  const authorized = await store.transitionPayment({
    idempotencyKey: "task_pg_00000001",
    fromStates: [PAYMENT_STATES.CHALLENGED],
    toState: PAYMENT_STATES.AUTHORIZED,
  });
  const resourceRunning = await store.transitionPayment({
    idempotencyKey: "task_pg_00000001",
    fromStates: [PAYMENT_STATES.AUTHORIZED],
    toState: PAYMENT_STATES.RESOURCE_RUNNING,
  });
  const resourceSucceeded = await store.transitionPayment({
    idempotencyKey: "task_pg_00000001",
    fromStates: [PAYMENT_STATES.RESOURCE_RUNNING],
    toState: PAYMENT_STATES.RESOURCE_SUCCEEDED,
  });
  const settling = await store.claimSettlement({
    idempotencyKey: "task_pg_00000001",
  });
  const settled = await store.transitionPayment({
    idempotencyKey: "task_pg_00000001",
    fromStates: [PAYMENT_STATES.SETTLING],
    toState: PAYMENT_STATES.SETTLED,
    updates: settledUpdates(),
  });

  assert.equal(challenged.state, PAYMENT_STATES.CHALLENGED);
  assert.equal(authorized.state, PAYMENT_STATES.AUTHORIZED);
  assert.equal(resourceRunning.state, PAYMENT_STATES.RESOURCE_RUNNING);
  assert.equal(resourceSucceeded.state, PAYMENT_STATES.RESOURCE_SUCCEEDED);
  assert.equal(settling.state, PAYMENT_STATES.SETTLING);
  assert.equal(settling.settlementAttempts, 1);
  assert.equal(settled.state, PAYMENT_STATES.SETTLED);
  await assert.rejects(
    () =>
      store.transitionPayment({
        idempotencyKey: "task_pg_00000001",
        fromStates: [PAYMENT_STATES.SETTLED],
        toState: PAYMENT_STATES.SETTLING,
      }),
    PaymentStoreError,
  );
});

postgresTest("atomic settlement claim succeeds once", async (fixture) => {
  const store = fixture.createStore();
  await store.createPayment(
    paymentRecord({ state: PAYMENT_STATES.RESOURCE_SUCCEEDED }),
  );

  const results = await Promise.all([
    store.claimSettlement({ idempotencyKey: "task_pg_00000001" }),
    store.claimSettlement({ idempotencyKey: "task_pg_00000001" }),
  ]);
  const claimed = results.filter(Boolean);

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].state, PAYMENT_STATES.SETTLING);
  assert.equal(claimed[0].settlementAttempts, 1);
});

postgresTest("two store instances claim one settlement across the same DB", async (fixture) => {
  const firstStore = fixture.createStore();
  const secondStore = fixture.createStore();
  await firstStore.createPayment(
    paymentRecord({ state: PAYMENT_STATES.RESOURCE_SUCCEEDED }),
  );

  const results = await Promise.all([
    firstStore.claimSettlement({ idempotencyKey: "task_pg_00000001" }),
    secondStore.claimSettlement({ idempotencyKey: "task_pg_00000001" }),
  ]);
  const claimed = results.filter(Boolean);
  const persisted = await firstStore.getPayment("task_pg_00000001");

  assert.equal(claimed.length, 1);
  assert.equal(persisted.state, PAYMENT_STATES.SETTLING);
  assert.equal(persisted.settlementAttempts, 1);
});

postgresTest("state survives reconnect", async (fixture) => {
  const firstStore = fixture.createStore();
  await firstStore.createPayment(
    paymentRecord({ state: PAYMENT_STATES.AUTHORIZED }),
  );
  await firstStore.close();

  const secondStore = fixture.createStore();
  const persisted = await secondStore.getPayment("task_pg_00000001");

  assert.equal(persisted.state, PAYMENT_STATES.AUTHORIZED);
  assert.equal(persisted.requestFingerprint, "0xrequest");
  assert.equal(persisted.paymentFingerprint, "0xpayment");
});

postgresTest("duplicate SETTLED row returns existing state", async (fixture) => {
  const store = fixture.createStore();
  await store.createPayment(
    paymentRecord({
      state: PAYMENT_STATES.SETTLED,
      canRetry: false,
      ...settledUpdates(),
    }),
  );

  const duplicate = await store.createPayment(paymentRecord());

  assert.equal(duplicate.state, PAYMENT_STATES.SETTLED);
  assert.equal(duplicate.transactionHash, `0x${"a".repeat(64)}`);
  assert.equal(await countPayments(store), 1);
});

postgresTest("duplicate SETTLING row returns existing state", async (fixture) => {
  const store = fixture.createStore();
  await store.createPayment(
    paymentRecord({
      state: PAYMENT_STATES.SETTLING,
      canRetry: false,
      settlementAttempts: 1,
    }),
  );

  const duplicate = await store.createPayment(paymentRecord());

  assert.equal(duplicate.state, PAYMENT_STATES.SETTLING);
  assert.equal(duplicate.settlementAttempts, 1);
  assert.equal(await countPayments(store), 1);
});

postgresTest("UNKNOWN state cannot be settlement-claimed", async (fixture) => {
  const store = fixture.createStore();
  await store.createPayment(
    paymentRecord({
      state: PAYMENT_STATES.UNKNOWN,
      canRetry: false,
      lastErrorCode: PAYMENT_STORE_ERROR_CODES.STATUS_UNKNOWN,
    }),
  );

  const claim = await store.claimSettlement({
    idempotencyKey: "task_pg_00000001",
  });

  assert.equal(claim, null);
  assert.equal(
    (await store.getPayment("task_pg_00000001")).state,
    PAYMENT_STATES.UNKNOWN,
  );
});

postgresTest("FAILED retry-safe state can reauthorize and claim", async (fixture) => {
  const store = fixture.createStore();
  await store.createPayment(
    paymentRecord({
      state: PAYMENT_STATES.FAILED,
      canRetry: true,
      lastErrorCode: "X402_SETTLEMENT_FAILED",
    }),
  );

  const authorized = await store.transitionPayment({
    idempotencyKey: "task_pg_00000001",
    fromStates: [PAYMENT_STATES.FAILED],
    toState: PAYMENT_STATES.AUTHORIZED,
  });
  const resourceRunning = await store.transitionPayment({
    idempotencyKey: "task_pg_00000001",
    fromStates: [PAYMENT_STATES.AUTHORIZED],
    toState: PAYMENT_STATES.RESOURCE_RUNNING,
  });
  const resourceSucceeded = await store.transitionPayment({
    idempotencyKey: "task_pg_00000001",
    fromStates: [PAYMENT_STATES.RESOURCE_RUNNING],
    toState: PAYMENT_STATES.RESOURCE_SUCCEEDED,
  });
  const claim = await store.claimSettlement({
    idempotencyKey: "task_pg_00000001",
  });

  assert.equal(authorized.state, PAYMENT_STATES.AUTHORIZED);
  assert.equal(resourceRunning.state, PAYMENT_STATES.RESOURCE_RUNNING);
  assert.equal(resourceSucceeded.state, PAYMENT_STATES.RESOURCE_SUCCEEDED);
  assert.equal(claim.state, PAYMENT_STATES.SETTLING);
});

test("postgres connection failure is wrapped without leaking internals", async () => {
  const store = new PostgresPaymentStore({
    pool: {
      async connect() {
        throw new Error("internal postgres connection details");
      },
    },
    now: () => new Date(NOW),
  });

  await assert.rejects(
    () => store.createPayment(paymentRecord()),
    (error) => {
      assert.ok(error instanceof PaymentStoreError);
      assert.equal(error.code, PAYMENT_STORE_ERROR_CODES.STORE_ERROR);
      assert.equal(error.message, "Payment store schema initialization failed.");
      assert.doesNotMatch(error.message, /internal postgres connection details/u);
      return true;
    },
  );
});

function postgresTest(name, fn) {
  test(
    name,
    POSTGRES_TEST_DATABASE_URL ? {} : { skip: POSTGRES_SKIP_REASON },
    async () => {
      const fixture = await createPostgresFixture();
      try {
        await fn(fixture);
      } finally {
        await fixture.cleanup();
      }
    },
  );
}

async function createPostgresFixture() {
  const schema = `payment_store_test_${randomUUID().replaceAll("-", "_")}`;
  const adminPool = new Pool({
    connectionString: POSTGRES_TEST_DATABASE_URL,
    max: 2,
    allowExitOnIdle: true,
  });
  const stores = new Set();

  await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);

  return {
    schema,
    createStore() {
      const store = new PostgresPaymentStore({
        connectionString: POSTGRES_TEST_DATABASE_URL,
        schema,
        now: () => new Date(NOW),
        max: 3,
      });
      stores.add(store);
      return store;
    },
    async cleanup() {
      for (const store of stores) {
        await store.close();
      }
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await adminPool.end();
    },
  };
}

function paymentRecord(overrides = {}) {
  return {
    idempotencyKey: "task_pg_00000001",
    taskId: "task_pg_00000001",
    requestFingerprint: "0xrequest",
    paymentFingerprint: "0xpayment",
    paymentId: "pay_pg_00000001",
    mode: "live",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amountAtomic: "10000",
    counterparty: "0x1111111111111111111111111111111111111111",
    state: PAYMENT_STATES.CREATED,
    canRetry: true,
    paymentRequirements: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "10000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
    },
    ...overrides,
  };
}

function settledUpdates() {
  return {
    transactionHash: `0x${"a".repeat(64)}`,
    facilitatorReference: `0x${"a".repeat(64)}`,
    settledAt: NOW,
    payment: {
      mode: "live",
      status: PAYMENT_STATES.SETTLED,
    },
    settlementResponse: {
      success: true,
      transaction: `0x${"a".repeat(64)}`,
      network: "eip155:8453",
      amount: "10000",
    },
  };
}

async function schemaVersion(store) {
  await store.ensureInitialized();
  const result = await store.pool.query(
    `SELECT value FROM ${store.table("payment_store_metadata")}
     WHERE key = 'schema_version'`,
  );
  return result.rows[0]?.value;
}

async function countPayments(store) {
  await store.ensureInitialized();
  const result = await store.pool.query(
    `SELECT COUNT(*)::integer AS count FROM ${store.table("live_payments")}`,
  );
  return result.rows[0].count;
}

function quoteIdentifier(identifier) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(identifier)) {
    throw new Error("Invalid identifier.");
  }
  return `"${identifier}"`;
}
