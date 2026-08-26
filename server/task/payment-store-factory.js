import {
  PAYMENT_STORE_ERROR_CODES,
  PaymentStoreError,
} from "./payment-store.js";
import {
  DEFAULT_PAYMENT_STORE_PATH,
  SqlitePaymentStore,
} from "./payment-store-sqlite.js";
import { PostgresPaymentStore } from "./payment-store-postgres.js";

export const PAYMENT_STORE_DRIVERS = Object.freeze({
  SQLITE: "sqlite",
  POSTGRES: "postgres",
});

export function createDefaultPaymentStore({
  env = process.env,
  now,
  logger,
} = {}) {
  const driverResult = resolvePaymentStoreDriver({ env });
  if (!driverResult.ok) {
    throw new PaymentStoreError(driverResult.reason, {
      code: PAYMENT_STORE_ERROR_CODES.STORE_ERROR,
    });
  }

  if (driverResult.driver === PAYMENT_STORE_DRIVERS.SQLITE) {
    return new SqlitePaymentStore({
      path: env.PAYMENT_STORE_PATH || DEFAULT_PAYMENT_STORE_PATH,
      now,
    });
  }

  if (driverResult.driver === PAYMENT_STORE_DRIVERS.POSTGRES) {
    return new PostgresPaymentStore({
      connectionString: env.PAYMENT_DATABASE_URL,
      now,
      logger,
    });
  }

  throw new PaymentStoreError("Unsupported payment store driver.", {
    code: PAYMENT_STORE_ERROR_CODES.STORE_ERROR,
  });
}

export function resolvePaymentStoreDriver({ env = process.env } = {}) {
  const driver = normalizeText(env.PAYMENT_STORE_DRIVER || PAYMENT_STORE_DRIVERS.SQLITE)
    .toLowerCase();

  if (Object.values(PAYMENT_STORE_DRIVERS).includes(driver)) {
    return { ok: true, driver };
  }

  return {
    ok: false,
    reason: "PAYMENT_STORE_DRIVER must be sqlite or postgres.",
  };
}

export function isProductionLikeRuntime(env = process.env) {
  return (
    normalizeText(env.NODE_ENV).toLowerCase() === "production" ||
    normalizeText(env.VERCEL) === "1" ||
    normalizeText(env.VERCEL_ENV).length > 0 ||
    normalizeText(env.AWS_LAMBDA_FUNCTION_NAME).length > 0 ||
    normalizeText(env.K_SERVICE).length > 0
  );
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
