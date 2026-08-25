import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PAYMENT_SCHEMA_VERSION,
  PAYMENT_STATES,
  PaymentStoreError,
  SqlitePaymentStore,
} from "./payment-adapter.js";

const NOW = "2026-08-22T00:00:00.000Z";

test("initializes schema version and persists required payment fields", () => {
  const store = createStore();
  const record = store.createPayment(paymentRecord());

  assert.equal(schemaVersion(store), String(PAYMENT_SCHEMA_VERSION));
  assert.equal(record.idempotencyKey, "task_store_00000001");
  assert.equal(record.taskId, "task_store_00000001");
  assert.equal(record.requestFingerprint, "0xrequest");
  assert.equal(record.paymentFingerprint, "0xpayment");
  assert.equal(record.paymentId, "pay_store_00000001");
  assert.equal(record.mode, "live");
  assert.equal(record.network, "eip155:8453");
  assert.equal(record.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(record.amountAtomic, "10000");
  assert.equal(record.counterparty, "0x1111111111111111111111111111111111111111");
  assert.equal(record.state, PAYMENT_STATES.CREATED);
  assert.equal(record.createdAt, NOW);
  assert.equal(record.updatedAt, NOW);
});

test("idempotency key uniqueness returns the existing row", () => {
  const store = createStore();
  const first = store.createPayment(paymentRecord());
  const second = store.createPayment(
    paymentRecord({
      requestFingerprint: "0xdifferent",
      paymentFingerprint: "0xdifferent-payment",
      amountAtomic: "20000",
    }),
  );

  assert.equal(second.id, first.id);
  assert.equal(second.requestFingerprint, first.requestFingerprint);
  assert.equal(countPayments(store), 1);
});

test("payment fingerprint uniqueness prevents duplicate durable records", () => {
  const store = createStore();
  store.createPayment(paymentRecord());

  assert.throws(
    () =>
      store.createPayment(
        paymentRecord({
          idempotencyKey: "task_store_00000002",
          taskId: "task_store_00000002",
        }),
      ),
    PaymentStoreError,
  );
  assert.equal(countPayments(store), 1);
});

test("state transitions are explicit and invalid jumps are rejected", () => {
  const store = createStore();
  store.createPayment(paymentRecord());
  const challenged = store.transitionPayment({
    idempotencyKey: "task_store_00000001",
    fromStates: [PAYMENT_STATES.CREATED],
    toState: PAYMENT_STATES.CHALLENGED,
  });
  const authorized = store.transitionPayment({
    idempotencyKey: "task_store_00000001",
    fromStates: [PAYMENT_STATES.CHALLENGED],
    toState: PAYMENT_STATES.AUTHORIZED,
  });
  const resourceRunning = store.transitionPayment({
    idempotencyKey: "task_store_00000001",
    fromStates: [PAYMENT_STATES.AUTHORIZED],
    toState: PAYMENT_STATES.RESOURCE_RUNNING,
  });
  const resourceSucceeded = store.transitionPayment({
    idempotencyKey: "task_store_00000001",
    fromStates: [PAYMENT_STATES.RESOURCE_RUNNING],
    toState: PAYMENT_STATES.RESOURCE_SUCCEEDED,
  });
  const settling = store.claimSettlement({
    idempotencyKey: "task_store_00000001",
  });
  const settled = store.transitionPayment({
    idempotencyKey: "task_store_00000001",
    fromStates: [PAYMENT_STATES.SETTLING],
    toState: PAYMENT_STATES.SETTLED,
    updates: {
      transactionHash: `0x${"a".repeat(64)}`,
      facilitatorReference: `0x${"a".repeat(64)}`,
      settledAt: NOW,
      payment: {
        mode: "live",
        status: PAYMENT_STATES.SETTLED,
      },
    },
  });

  assert.equal(challenged.state, PAYMENT_STATES.CHALLENGED);
  assert.equal(authorized.state, PAYMENT_STATES.AUTHORIZED);
  assert.equal(resourceRunning.state, PAYMENT_STATES.RESOURCE_RUNNING);
  assert.equal(resourceSucceeded.state, PAYMENT_STATES.RESOURCE_SUCCEEDED);
  assert.equal(settling.state, PAYMENT_STATES.SETTLING);
  assert.equal(settling.settlementAttempts, 1);
  assert.equal(settled.state, PAYMENT_STATES.SETTLED);
  assert.throws(
    () =>
      store.transitionPayment({
        idempotencyKey: "task_store_00000001",
        fromStates: [PAYMENT_STATES.SETTLED],
        toState: PAYMENT_STATES.SETTLING,
      }),
    PaymentStoreError,
  );
});

test("atomic settlement claim succeeds once", () => {
  const store = createStore();
  store.createPayment(paymentRecord({ state: PAYMENT_STATES.RESOURCE_SUCCEEDED }));
  const first = store.claimSettlement({
    idempotencyKey: "task_store_00000001",
  });
  const second = store.claimSettlement({
    idempotencyKey: "task_store_00000001",
  });

  assert.equal(first.state, PAYMENT_STATES.SETTLING);
  assert.equal(first.settlementAttempts, 1);
  assert.equal(second, null);
});

test("state survives store restart", () => {
  const fixture = createStoreFixture();
  const first = new SqlitePaymentStore({
    path: fixture.path,
    now: () => new Date(NOW),
  });
  first.createPayment(paymentRecord({ state: PAYMENT_STATES.AUTHORIZED }));
  first.close();

  const second = new SqlitePaymentStore({
    path: fixture.path,
    now: () => new Date(NOW),
  });
  const persisted = second.getPayment("task_store_00000001");

  assert.equal(persisted.state, PAYMENT_STATES.AUTHORIZED);
  assert.equal(persisted.requestFingerprint, "0xrequest");
  assert.equal(persisted.paymentFingerprint, "0xpayment");

  second.close();
  fixture.cleanup();
});

function paymentRecord(overrides = {}) {
  return {
    idempotencyKey: "task_store_00000001",
    taskId: "task_store_00000001",
    requestFingerprint: "0xrequest",
    paymentFingerprint: "0xpayment",
    paymentId: "pay_store_00000001",
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

function createStore() {
  const fixture = createStoreFixture();
  const store = new SqlitePaymentStore({
    path: fixture.path,
    now: () => new Date(NOW),
  });
  const originalClose = store.close.bind(store);
  store.close = () => {
    originalClose();
    fixture.cleanup();
  };
  test.after(() => store.close());
  return store;
}

function createStoreFixture() {
  const directory = mkdtempSync(join(tmpdir(), "base-agent-pay-store-test-"));
  return {
    path: join(directory, "payments.sqlite"),
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function schemaVersion(store) {
  return store.db
    .prepare("SELECT value FROM payment_store_metadata WHERE key = 'schema_version'")
    .get().value;
}

function countPayments(store) {
  return store.db.prepare("SELECT COUNT(*) AS count FROM live_payments").get().count;
}
