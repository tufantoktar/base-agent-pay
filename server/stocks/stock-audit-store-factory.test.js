import assert from "node:assert/strict";
import test from "node:test";

import {
  STOCK_AUDIT_ERROR_CODES,
  StockAuditStoreError,
} from "./stock-audit-store.js";
import { createDefaultStockAuditStore } from "./stock-audit-store-factory.js";
import { PostgresStockAuditStore } from "./stock-audit-store-postgres.js";
import { SqliteStockAuditStore } from "./stock-audit-store-sqlite.js";

test("stock audit store defaults to SQLite outside production", () => {
  const store = createDefaultStockAuditStore({
    env: {
      PAYMENT_STORE_PATH: ":memory:",
    },
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });

  assert.ok(store instanceof SqliteStockAuditStore);
  assert.equal(store.driver, "sqlite");
  store.close();
});

test("stock audit store requires Postgres in production-like runtime", () => {
  assert.throws(
    () =>
      createDefaultStockAuditStore({
        env: {
          NODE_ENV: "production",
          VERCEL: "1",
          PAYMENT_STORE_DRIVER: "sqlite",
        },
      }),
    (error) => {
      assert.ok(error instanceof StockAuditStoreError);
      assert.equal(error.code, STOCK_AUDIT_ERROR_CODES.STORE_ERROR);
      assert.match(error.message, /PAYMENT_STORE_DRIVER=postgres/u);
      return true;
    },
  );
});

test("stock audit store selects Postgres when payment store driver is Postgres", () => {
  const store = createDefaultStockAuditStore({
    env: {
      PAYMENT_STORE_DRIVER: "postgres",
      PAYMENT_DATABASE_URL: "postgres://user:pass@example.invalid/db",
    },
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });

  assert.ok(store instanceof PostgresStockAuditStore);
  assert.equal(store.driver, "postgres");
  return store.close();
});

test("stock audit store rejects unsupported drivers without fallback", () => {
  assert.throws(
    () =>
      createDefaultStockAuditStore({
        env: {
          PAYMENT_STORE_DRIVER: "memory",
        },
      }),
    (error) => {
      assert.ok(error instanceof StockAuditStoreError);
      assert.equal(error.code, STOCK_AUDIT_ERROR_CODES.STORE_ERROR);
      assert.match(error.message, /sqlite or postgres/u);
      return true;
    },
  );
});
