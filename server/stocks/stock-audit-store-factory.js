import {
  PAYMENT_STORE_DRIVERS,
  isProductionLikeRuntime,
  resolvePaymentStoreDriver,
} from "../task/payment-store-factory.js";
import {
  STOCK_AUDIT_ERROR_CODES,
  StockAuditStoreError,
} from "./stock-audit-store.js";
import {
  DEFAULT_STOCK_AUDIT_STORE_PATH,
  SqliteStockAuditStore,
} from "./stock-audit-store-sqlite.js";
import { PostgresStockAuditStore } from "./stock-audit-store-postgres.js";

export function createDefaultStockAuditStore({
  env = process.env,
  now,
  logger,
} = {}) {
  const driverResult = resolvePaymentStoreDriver({ env });
  if (!driverResult.ok) {
    throw new StockAuditStoreError(driverResult.reason, {
      code: STOCK_AUDIT_ERROR_CODES.STORE_ERROR,
    });
  }

  if (isProductionLikeRuntime(env) && driverResult.driver !== PAYMENT_STORE_DRIVERS.POSTGRES) {
    throw new StockAuditStoreError(
      "Production/serverless stock audit requires PAYMENT_STORE_DRIVER=postgres.",
      {
        code: STOCK_AUDIT_ERROR_CODES.STORE_ERROR,
      },
    );
  }

  if (driverResult.driver === PAYMENT_STORE_DRIVERS.SQLITE) {
    return new SqliteStockAuditStore({
      path: env.PAYMENT_STORE_PATH || DEFAULT_STOCK_AUDIT_STORE_PATH,
      now,
    });
  }

  if (driverResult.driver === PAYMENT_STORE_DRIVERS.POSTGRES) {
    return new PostgresStockAuditStore({
      connectionString: env.PAYMENT_DATABASE_URL,
      now,
      logger,
    });
  }

  throw new StockAuditStoreError("Unsupported stock audit store driver.", {
    code: STOCK_AUDIT_ERROR_CODES.STORE_ERROR,
  });
}

export { PAYMENT_STORE_DRIVERS as STOCK_AUDIT_STORE_DRIVERS };
