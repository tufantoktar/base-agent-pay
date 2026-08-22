import { BASE_SEPOLIA, MOCK_PAYMENT, PAYMENT_HEADER } from "./constants.js";
import { sha256Hex, stableStringify } from "./hash.js";

const MOCK_SIGNATURE_SALT = "base-agent-pay-local-mock-v1";

export class PaymentAdapter {
  createPaymentRequired() {
    throw new Error("PaymentAdapter.createPaymentRequired must be implemented");
  }

  verifyPayment() {
    throw new Error("PaymentAdapter.verifyPayment must be implemented");
  }
}

export class MockPaymentAdapter extends PaymentAdapter {
  createPaymentRequired({ requestHash }) {
    const requirement = createMockPaymentRequirement(requestHash);
    return {
      error: "Payment Required",
      code: "PAYMENT_REQUIRED",
      message:
        "Development Payment Mode: retry with the mock X-PAYMENT header to simulate an x402 payment.",
      mode: "mock",
      x402Version: "2",
      network: {
        name: BASE_SEPOLIA.name,
        chainId: BASE_SEPOLIA.chainId,
        caip2: BASE_SEPOLIA.caip2,
        rpcUrl: BASE_SEPOLIA.rpcUrl,
      },
      accepts: [requirement],
      paymentRequirements: requirement,
      mockPaymentHeader: createMockPaymentHeader(requirement),
    };
  }

  verifyPayment({ headers, requestHash }) {
    const headerValue = readHeader(headers, PAYMENT_HEADER);

    if (!headerValue) {
      return {
        ok: false,
        code: "PAYMENT_REQUIRED",
        reason: "Missing X-PAYMENT header.",
      };
    }

    const parsed = parseMockPaymentHeader(headerValue);
    if (!parsed.ok) {
      return {
        ok: false,
        code: "PAYMENT_INVALID",
        reason: parsed.reason,
      };
    }

    const { claim } = parsed;
    if (claim.requestHash !== requestHash) {
      return {
        ok: false,
        code: "PAYMENT_INVALID",
        reason: "Mock payment was created for a different request hash.",
      };
    }

    if (claim.mode !== "mock" || claim.network.chainId !== BASE_SEPOLIA.chainId) {
      return {
        ok: false,
        code: "PAYMENT_INVALID",
        reason: "Mock payment network or mode is invalid.",
      };
    }

    return {
      ok: true,
      payment: {
        mode: "mock",
        scheme: claim.scheme,
        network: claim.network,
        asset: claim.asset,
        amount: claim.amount,
        recipient: claim.recipient,
        facilitator: claim.facilitator,
        reference: sha256Hex(headerValue),
        verifiedAt: new Date().toISOString(),
      },
    };
  }
}

export function getPaymentAdapter() {
  const mode = process.env.X402_MODE ?? "mock";

  if (mode !== "mock") {
    throw new Error(
      "Only X402_MODE=mock is implemented. Add an official x402 adapter before enabling live verification.",
    );
  }

  return new MockPaymentAdapter();
}

export function createMockPaymentRequirement(requestHash) {
  return {
    mode: "mock",
    scheme: MOCK_PAYMENT.scheme,
    description: MOCK_PAYMENT.description,
    network: {
      name: BASE_SEPOLIA.name,
      chainId: BASE_SEPOLIA.chainId,
      caip2: BASE_SEPOLIA.caip2,
      rpcUrl: BASE_SEPOLIA.rpcUrl,
    },
    asset: {
      symbol: MOCK_PAYMENT.assetSymbol,
      address: MOCK_PAYMENT.assetAddress,
    },
    amount: MOCK_PAYMENT.amount,
    recipient: MOCK_PAYMENT.recipient,
    facilitator: MOCK_PAYMENT.facilitator,
    resource: "/api/task",
    requestHash,
  };
}

export function createMockPaymentHeader(requirement) {
  const claim = {
    ...requirement,
    issuedAt: "mock-static-issued-at",
  };
  const payload = base64UrlEncode(stableStringify(claim));
  const signature = sha256Hex(`${payload}:${MOCK_SIGNATURE_SALT}`).slice(2);
  return `mock.${payload}.${signature}`;
}

function parseMockPaymentHeader(headerValue) {
  const parts = String(headerValue).split(".");
  if (parts.length !== 3 || parts[0] !== "mock") {
    return { ok: false, reason: "X-PAYMENT is not a mock payment header." };
  }

  const [, payload, signature] = parts;
  const expectedSignature = sha256Hex(`${payload}:${MOCK_SIGNATURE_SALT}`).slice(2);
  if (signature !== expectedSignature) {
    return { ok: false, reason: "Mock payment signature is invalid." };
  }

  try {
    return {
      ok: true,
      claim: JSON.parse(base64UrlDecode(payload)),
    };
  } catch {
    return { ok: false, reason: "Mock payment payload is not valid JSON." };
  }
}

function readHeader(headers, name) {
  if (!headers) {
    return undefined;
  }

  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Buffer.from(padded.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString(
    "utf8",
  );
}

