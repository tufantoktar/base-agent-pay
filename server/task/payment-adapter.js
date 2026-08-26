import { PaymentAdapter } from "./payment-adapter-base.js";
import { MockPaymentAdapter } from "./payment-adapter-mock.js";
import {
  LIVE_PAYMENT_CODES,
  LIVE_PAYMENT_STATES,
  LivePaymentAdapter,
} from "./payment-adapter-live.js";

export { PaymentAdapter } from "./payment-adapter-base.js";
export {
  MockPaymentAdapter,
  createMockPaymentHeader,
  createMockPaymentRequirement,
} from "./payment-adapter-mock.js";
export {
  HttpX402FacilitatorClient,
  LIVE_PAYMENT_CODES,
  LIVE_PAYMENT_ID_PATTERN,
  LIVE_PAYMENT_STATES,
  LivePaymentAdapter,
  CDP_X402_FACILITATOR_URL,
  createLivePaymentRequired,
  createLivePaymentRequirements,
  createCdpAuthHeaderFactory,
  encodePaymentSignatureForTest,
  parsePaymentSignatureHeader,
  resolveLivePaymentConfig,
} from "./payment-adapter-live.js";
export {
  PAYMENT_SCHEMA_VERSION,
  PAYMENT_STATES,
  PAYMENT_STORE_ERROR_CODES,
  PaymentStore,
  PaymentStoreError,
} from "./payment-store.js";
export {
  DEFAULT_PAYMENT_STORE_PATH,
  SqlitePaymentStore,
} from "./payment-store-sqlite.js";
export {
  DEFAULT_POSTGRES_SCHEMA,
  PostgresPaymentStore,
} from "./payment-store-postgres.js";
export {
  PAYMENT_STORE_DRIVERS,
  createDefaultPaymentStore,
  isProductionLikeRuntime,
  resolvePaymentStoreDriver,
} from "./payment-store-factory.js";

export function getPaymentAdapter({
  env = process.env,
  facilitatorClient,
  paymentStore,
  idempotencyStore,
  fetchImpl,
} = {}) {
  const mode = normalizeMode(env.X402_MODE);

  if (mode === "mock") {
    return new MockPaymentAdapter();
  }

  if (mode === "live") {
    return new LivePaymentAdapter({
      env,
      facilitatorClient,
      paymentStore,
      idempotencyStore,
      fetchImpl,
    });
  }

  return new BlockedPaymentAdapter({
    mode,
    code: LIVE_PAYMENT_CODES.BLOCKED,
    reason: "X402_MODE must be mock or live.",
  });
}

class BlockedPaymentAdapter extends PaymentAdapter {
  constructor({ mode, code, reason }) {
    super({ mode });
    this.code = code;
    this.reason = reason;
  }

  createPaymentRequired() {
    return {
      ok: false,
      error: this.code,
      code: this.code,
      message: this.reason,
      mode: this.mode,
      status: LIVE_PAYMENT_STATES.BLOCKED,
    };
  }

  verifyPayment() {
    return {
      ok: false,
      code: this.code,
      reason: this.reason,
      statusCode: 403,
      state: LIVE_PAYMENT_STATES.BLOCKED,
    };
  }
}

function normalizeMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode || "mock";
}
