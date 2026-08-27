import assert from "node:assert/strict";
import test from "node:test";

import {
  DURABLE_PAYMENT_STATES,
  canSignLivePayment,
  getPaymentStateMessage,
  isReceiptEligibleForDurablePayment,
  taskResultFromPaymentState,
  toPaymentUiStatus,
} from "../src/paymentReconciliation.js";

const TX_HASH = `0x${"a".repeat(64)}`;

test("hydrated SETTLED state renders as settled and disables signing", () => {
  const paymentState = {
    status: DURABLE_PAYMENT_STATES.SETTLED,
    transactionHash: TX_HASH,
    receipt: {
      settlementVerified: true,
    },
  };

  assert.equal(toPaymentUiStatus(paymentState), "settled");
  assert.equal(getPaymentStateMessage(paymentState), "Payment settled.");
  assert.equal(
    canSignLivePayment({
      paymentRequirement: { x402Version: 2 },
      paymentRequestInFlight: false,
      paymentState,
    }),
    false,
  );
  assert.equal(isReceiptEligibleForDurablePayment(paymentState), true);
});

for (const status of [
  DURABLE_PAYMENT_STATES.CREATED,
  DURABLE_PAYMENT_STATES.CHALLENGED,
  DURABLE_PAYMENT_STATES.AUTHORIZED,
  DURABLE_PAYMENT_STATES.RESOURCE_RUNNING,
  DURABLE_PAYMENT_STATES.RESOURCE_SUCCEEDED,
  DURABLE_PAYMENT_STATES.SETTLING,
  DURABLE_PAYMENT_STATES.FAILED,
  DURABLE_PAYMENT_STATES.UNKNOWN,
  DURABLE_PAYMENT_STATES.BLOCKED,
]) {
  test(`receipt is disabled for ${status}`, () => {
    assert.equal(
      isReceiptEligibleForDurablePayment({
        status,
        transactionHash: TX_HASH,
        receipt: {
          settlementVerified: true,
        },
      }),
      false,
    );
  });
}

test("SETTLING disables signing and warns not to retry", () => {
  const paymentState = { status: DURABLE_PAYMENT_STATES.SETTLING };

  assert.equal(toPaymentUiStatus(paymentState), "settling");
  assert.match(getPaymentStateMessage(paymentState), /Do not retry/u);
  assert.equal(
    canSignLivePayment({
      paymentRequirement: { x402Version: 2 },
      paymentRequestInFlight: false,
      paymentState,
    }),
    false,
  );
});

test("UNKNOWN disables signing and requires manual verification", () => {
  const paymentState = { status: DURABLE_PAYMENT_STATES.UNKNOWN };

  assert.equal(toPaymentUiStatus(paymentState), "unknown");
  assert.match(getPaymentStateMessage(paymentState), /Manual verification/u);
  assert.equal(
    canSignLivePayment({
      paymentRequirement: { x402Version: 2 },
      paymentRequestInFlight: false,
      paymentState,
    }),
    false,
  );
});

test("CHALLENGED remains signable when guards allow it", () => {
  assert.equal(
    canSignLivePayment({
      paymentRequirement: { x402Version: 2 },
      paymentRequestInFlight: false,
      paymentState: { status: DURABLE_PAYMENT_STATES.CHALLENGED },
    }),
    true,
  );
});

test("task response hydrates after frontend reload", () => {
  const task = {
    status: "complete",
    taskId: `0x${"b".repeat(64)}`,
    requestHash: `0x${"c".repeat(64)}`,
    resultHash: `0x${"d".repeat(64)}`,
    result: { output: "done" },
  };

  assert.deepEqual(taskResultFromPaymentState({ task }), task);
});
