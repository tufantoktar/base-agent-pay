import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../task/hash.js";
import { MockPaymentAdapter } from "../task/payment-adapter-mock.js";
import { STOCK_RESOURCE_PATH } from "./stock-bazaar-discovery.js";
import {
  STOCK_PAYMENT_CODES,
  createStockPaymentAdapter,
} from "./stock-payment.js";

const BASE_MAINNET = Object.freeze({
  name: "Base Mainnet",
  chainId: 8453,
  caip2: "eip155:8453",
  rpcUrl: "https://mainnet.base.org",
});

test("stock mock payment challenge targets stock analysis on Base Mainnet", () => {
  const adapter = createStockPaymentAdapter({
    env: { X402_MODE: "mock" },
  });
  const paymentRequired = adapter.createPaymentRequired({
    requestHash: sha256Hex({ symbol: "AAPLc", scope: "stock-analysis" }),
  });

  assert.equal(adapter.mode, "mock");
  assert.equal(paymentRequired.resource.url, STOCK_RESOURCE_PATH);
  assert.equal(paymentRequired.accepts[0].resource, STOCK_RESOURCE_PATH);
  assert.equal(paymentRequired.accepts[0].network.caip2, "eip155:8453");
  assert.equal(paymentRequired.accepts[0].network.chainId, 8453);
  assert.equal(paymentRequired.accepts[0].amount, "0.01");
  assert.equal(paymentRequired.accepts[0].currency, "USDC");
  assert.equal(paymentRequired.accepts[0].asset.symbol, "USDC");
  assert.ok(paymentRequired.extensions.bazaar);
  assert.ok(paymentRequired.mockPaymentHeader.startsWith("mock."));
});

test("stock mock payment proof verifies without settlement state", () => {
  const adapter = createStockPaymentAdapter({
    env: { X402_MODE: "mock" },
  });
  const requestHash = sha256Hex({
    symbol: "AAPLc",
    analysisType: "snapshot",
    scope: "stock-analysis",
  });
  const paymentRequired = adapter.createPaymentRequired({ requestHash });
  const verification = adapter.verifyPayment({
    headers: { "x-payment": paymentRequired.mockPaymentHeader },
    requestHash,
  });

  assert.equal(verification.ok, true);
  assert.equal(verification.payment.mode, "mock");
  assert.equal(verification.payment.amount, "0.01");
  assert.equal(verification.payment.currency, "USDC");
  assert.equal(verification.payment.status, undefined);
  assert.equal(verification.payment.settledAt, undefined);
});

test("task mock payment proof cannot pay stock analysis", () => {
  const requestHash = sha256Hex({ symbol: "AAPLc", scope: "stock-analysis" });
  const taskPaymentRequired = new MockPaymentAdapter({
    network: BASE_MAINNET,
  }).createPaymentRequired({ requestHash });
  const stockAdapter = createStockPaymentAdapter({
    env: { X402_MODE: "mock" },
  });
  const verification = stockAdapter.verifyPayment({
    headers: { "x-payment": taskPaymentRequired.mockPaymentHeader },
    requestHash,
  });

  assert.equal(verification.ok, false);
  assert.equal(verification.code, "PAYMENT_INVALID");
  assert.match(verification.reason, /resource/u);
});

test("live x402 is blocked for stock analysis in Phase 2E", () => {
  const adapter = createStockPaymentAdapter({
    env: {
      X402_MODE: "live",
      X402_LIVE_CONFIRM: "true",
    },
  });
  const verification = adapter.verifyPayment({
    headers: { "x-payment": "live-payment-not-used" },
    requestHash: sha256Hex({ symbol: "AAPLc" }),
  });
  const challenge = adapter.createPaymentRequired();

  assert.equal(adapter.mode, "live");
  assert.equal(verification.ok, false);
  assert.equal(verification.statusCode, 403);
  assert.equal(verification.code, STOCK_PAYMENT_CODES.LIVE_DISABLED);
  assert.equal(challenge.code, STOCK_PAYMENT_CODES.LIVE_DISABLED);
  assert.equal(challenge.mockPaymentHeader, undefined);
});
