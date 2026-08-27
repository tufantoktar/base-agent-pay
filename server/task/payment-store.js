export const PAYMENT_SCHEMA_VERSION = 1;

export const PAYMENT_STORE_ERROR_CODES = Object.freeze({
  KEY_REUSE_MISMATCH: "IDEMPOTENCY_KEY_REUSE_MISMATCH",
  ALREADY_SETTLED: "PAYMENT_ALREADY_SETTLED",
  IN_PROGRESS: "PAYMENT_IN_PROGRESS",
  STATUS_UNKNOWN: "PAYMENT_STATUS_UNKNOWN",
  RETRY_NOT_SAFE: "PAYMENT_RETRY_NOT_SAFE",
  STORE_ERROR: "PAYMENT_STORE_ERROR",
});

export const PAYMENT_STATES = Object.freeze({
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

export const TERMINAL_PAYMENT_STATES = new Set([
  PAYMENT_STATES.SETTLED,
  PAYMENT_STATES.BLOCKED,
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  [PAYMENT_STATES.CREATED]: new Set([
    PAYMENT_STATES.CHALLENGED,
    PAYMENT_STATES.AUTHORIZED,
    PAYMENT_STATES.FAILED,
    PAYMENT_STATES.UNKNOWN,
    PAYMENT_STATES.BLOCKED,
  ]),
  [PAYMENT_STATES.CHALLENGED]: new Set([
    PAYMENT_STATES.AUTHORIZED,
    PAYMENT_STATES.FAILED,
    PAYMENT_STATES.UNKNOWN,
    PAYMENT_STATES.BLOCKED,
  ]),
  [PAYMENT_STATES.AUTHORIZED]: new Set([
    PAYMENT_STATES.RESOURCE_RUNNING,
    PAYMENT_STATES.FAILED,
    PAYMENT_STATES.UNKNOWN,
    PAYMENT_STATES.BLOCKED,
  ]),
  [PAYMENT_STATES.RESOURCE_RUNNING]: new Set([
    PAYMENT_STATES.RESOURCE_SUCCEEDED,
    PAYMENT_STATES.FAILED,
    PAYMENT_STATES.UNKNOWN,
  ]),
  [PAYMENT_STATES.RESOURCE_SUCCEEDED]: new Set([
    PAYMENT_STATES.SETTLING,
    PAYMENT_STATES.FAILED,
    PAYMENT_STATES.UNKNOWN,
  ]),
  [PAYMENT_STATES.SETTLING]: new Set([
    PAYMENT_STATES.SETTLED,
    PAYMENT_STATES.FAILED,
    PAYMENT_STATES.UNKNOWN,
  ]),
  [PAYMENT_STATES.FAILED]: new Set([
    PAYMENT_STATES.AUTHORIZED,
    PAYMENT_STATES.RESOURCE_RUNNING,
    PAYMENT_STATES.SETTLING,
    PAYMENT_STATES.BLOCKED,
  ]),
  [PAYMENT_STATES.UNKNOWN]: new Set([]),
  [PAYMENT_STATES.SETTLED]: new Set([]),
  [PAYMENT_STATES.BLOCKED]: new Set([]),
});

export class PaymentStoreError extends Error {
  constructor(message, { code = PAYMENT_STORE_ERROR_CODES.STORE_ERROR, cause } = {}) {
    super(message, { cause });
    this.name = "PaymentStoreError";
    this.code = code;
  }
}

export class PaymentStore {
  getPayment() {
    throw new Error("PaymentStore.getPayment must be implemented");
  }

  getPaymentByLookup() {
    throw new Error("PaymentStore.getPaymentByLookup must be implemented");
  }

  createPayment() {
    throw new Error("PaymentStore.createPayment must be implemented");
  }

  transitionPayment() {
    throw new Error("PaymentStore.transitionPayment must be implemented");
  }

  claimSettlement() {
    throw new Error("PaymentStore.claimSettlement must be implemented");
  }

  storeTaskResponse() {
    throw new Error("PaymentStore.storeTaskResponse must be implemented");
  }

  close() {}
}

export function assertValidStateTransition(fromState, toState) {
  if (fromState === toState) {
    return;
  }

  const allowed = ALLOWED_TRANSITIONS[fromState];
  if (!allowed?.has(toState)) {
    throw new PaymentStoreError(
      `Invalid payment state transition: ${fromState} -> ${toState}.`,
      { code: PAYMENT_STORE_ERROR_CODES.STORE_ERROR },
    );
  }
}

export function assertKnownPaymentState(state) {
  if (!Object.values(PAYMENT_STATES).includes(state)) {
    throw new PaymentStoreError(`Unknown payment state: ${state}.`);
  }
}
