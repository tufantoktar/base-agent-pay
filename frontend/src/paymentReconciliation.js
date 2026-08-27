const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/u;

export const DURABLE_PAYMENT_STATES = Object.freeze({
  CREATED: "CREATED",
  CHALLENGED: "CHALLENGED",
  AUTHORIZED: "AUTHORIZED",
  RESOURCE_RUNNING: "RESOURCE_RUNNING",
  RESOURCE_SUCCEEDED: "RESOURCE_SUCCEEDED",
  SETTLING: "SETTLING",
  SETTLED: "SETTLED",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN",
  BLOCKED: "BLOCKED",
});

const LIVE_SIGNABLE_STATES = new Set([DURABLE_PAYMENT_STATES.CHALLENGED]);

const DURABLE_STATUS_TO_UI_STATUS = Object.freeze({
  [DURABLE_PAYMENT_STATES.CREATED]: "required",
  [DURABLE_PAYMENT_STATES.CHALLENGED]: "required",
  [DURABLE_PAYMENT_STATES.AUTHORIZED]: "authorized",
  [DURABLE_PAYMENT_STATES.RESOURCE_RUNNING]: "resourceRunning",
  [DURABLE_PAYMENT_STATES.RESOURCE_SUCCEEDED]: "resourceSucceeded",
  [DURABLE_PAYMENT_STATES.SETTLING]: "settling",
  [DURABLE_PAYMENT_STATES.SETTLED]: "settled",
  [DURABLE_PAYMENT_STATES.FAILED]: "failed",
  [DURABLE_PAYMENT_STATES.UNKNOWN]: "unknown",
  [DURABLE_PAYMENT_STATES.BLOCKED]: "blocked",
});

export function toPaymentUiStatus(paymentState) {
  return DURABLE_STATUS_TO_UI_STATUS[paymentState?.status] ?? "idle";
}

export function canSignLivePayment({
  paymentRequirement,
  paymentRequestInFlight,
  paymentState,
}) {
  if (!paymentRequirement || paymentRequestInFlight) {
    return false;
  }

  if (!paymentState?.status) {
    return true;
  }

  return LIVE_SIGNABLE_STATES.has(paymentState.status);
}

export function getPaymentStateMessage(paymentState) {
  switch (paymentState?.status) {
    case DURABLE_PAYMENT_STATES.SETTLED:
      return "Payment settled.";
    case DURABLE_PAYMENT_STATES.SETTLING:
      return "Settlement in progress. Do not retry.";
    case DURABLE_PAYMENT_STATES.UNKNOWN:
      return "Payment state unknown. Manual verification required.";
    case DURABLE_PAYMENT_STATES.AUTHORIZED:
      return "Payment authorized. Do not create another authorization.";
    case DURABLE_PAYMENT_STATES.RESOURCE_RUNNING:
      return "Task execution is already running for this payment.";
    case DURABLE_PAYMENT_STATES.RESOURCE_SUCCEEDED:
      return "Task execution succeeded and settlement is being finalized.";
    case DURABLE_PAYMENT_STATES.FAILED:
      return paymentState.canRetry
        ? "Payment failed. Retry is allowed only by backend policy."
        : "Payment failed and cannot be retried.";
    case DURABLE_PAYMENT_STATES.BLOCKED:
      return "Payment is blocked.";
    case DURABLE_PAYMENT_STATES.CHALLENGED:
      return "Payment challenge is ready.";
    case DURABLE_PAYMENT_STATES.CREATED:
      return "Payment challenge is being prepared.";
    default:
      return "";
  }
}

export function isReceiptEligibleForDurablePayment(paymentState) {
  return (
    paymentState?.status === DURABLE_PAYMENT_STATES.SETTLED &&
    isValidTransactionHash(paymentState.transactionHash) &&
    paymentState.receipt?.settlementVerified === true
  );
}

export function isValidTransactionHash(value) {
  return typeof value === "string" && TX_HASH_PATTERN.test(value);
}

export function taskResultFromPaymentState(paymentState) {
  const task = paymentState?.task;
  if (!task?.taskId || !task.requestHash || !task.resultHash) {
    return null;
  }

  return task;
}
