import { PaymentAdapter } from "../task/payment-adapter-base.js";
import { MockPaymentAdapter } from "../task/payment-adapter-mock.js";
import {
  STOCK_PAYMENT_AMOUNT,
  STOCK_RESOURCE_DESCRIPTION,
  STOCK_RESOURCE_PATH,
  createStockBazaarDiscoveryExtensions,
} from "./stock-bazaar-discovery.js";

export const STOCK_PAYMENT_CODES = Object.freeze({
  LIVE_DISABLED: "STOCK_X402_LIVE_DISABLED",
  MODE_UNSUPPORTED: "STOCK_X402_MODE_UNSUPPORTED",
});

export const STOCK_PAYMENT_STATES = Object.freeze({
  BLOCKED: "BLOCKED",
});

const STOCK_BASE_MAINNET_NETWORK = Object.freeze({
  name: "Base Mainnet",
  chainId: 8453,
  caip2: "eip155:8453",
  rpcUrl: "https://mainnet.base.org",
});

export function createStockPaymentAdapter({ env = process.env } = {}) {
  const mode = normalizeMode(env?.X402_MODE);

  if (mode === "mock") {
    return new MockPaymentAdapter({
      resourcePath: STOCK_RESOURCE_PATH,
      resourceDescription: STOCK_RESOURCE_DESCRIPTION,
      network: STOCK_BASE_MAINNET_NETWORK,
      tags: ["base", "stocks", "b20", "x402"],
      paymentDescription:
        "Development-only mock payment requirement for policy-controlled read-only tokenized stock analysis on Base.",
      paymentAmount: STOCK_PAYMENT_AMOUNT,
      currency: "USDC",
      assetSymbol: "USDC",
      createDiscoveryExtensions: createStockBazaarDiscoveryExtensions,
    });
  }

  if (mode === "live") {
    return new BlockedStockPaymentAdapter({
      mode,
      code: STOCK_PAYMENT_CODES.LIVE_DISABLED,
      reason: "Live x402 is not enabled for stock analysis in Phase 2F.",
    });
  }

  return new BlockedStockPaymentAdapter({
    mode,
    code: STOCK_PAYMENT_CODES.MODE_UNSUPPORTED,
    reason: "X402_MODE must be mock for stock analysis in Phase 2F.",
  });
}

class BlockedStockPaymentAdapter extends PaymentAdapter {
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
      status: STOCK_PAYMENT_STATES.BLOCKED,
    };
  }

  verifyPayment() {
    return {
      ok: false,
      code: this.code,
      reason: this.reason,
      statusCode: 403,
      state: STOCK_PAYMENT_STATES.BLOCKED,
    };
  }
}

function normalizeMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode || "mock";
}
