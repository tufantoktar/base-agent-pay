import { PaymentAdapter } from "./payment-adapter-base.js";
import {
  TASK_RESOURCE_DESCRIPTION,
  TASK_RESOURCE_PATH,
  createTaskBazaarDiscoveryExtensions,
} from "./bazaar-discovery.js";
import { BASE_NETWORK, MOCK_PAYMENT, PAYMENT_HEADER } from "./constants.js";
import { sha256Hex, stableStringify } from "./hash.js";

const MOCK_SIGNATURE_SALT = "base-agent-pay-local-mock-v1";

export class MockPaymentAdapter extends PaymentAdapter {
  constructor(resourceConfig = {}) {
    super({ mode: "mock" });
    this.resourceConfig = resolveResourceConfig(resourceConfig);
  }

  createPaymentRequired({ requestHash }) {
    const requirement = createMockPaymentRequirement(requestHash, this.resourceConfig);
    return {
      error: "Payment Required",
      code: "PAYMENT_REQUIRED",
      message:
        "Development Payment Mode: retry with the mock X-PAYMENT header to simulate an x402 payment.",
      mode: "mock",
      x402Version: "2",
      network: {
        name: this.resourceConfig.network.name,
        chainId: this.resourceConfig.network.chainId,
        caip2: this.resourceConfig.network.caip2,
        rpcUrl: this.resourceConfig.network.rpcUrl,
      },
      resource: {
        url: this.resourceConfig.resourcePath,
        description: this.resourceConfig.resourceDescription,
        mimeType: this.resourceConfig.mimeType,
        serviceName: this.resourceConfig.serviceName,
        tags: this.resourceConfig.tags,
      },
      accepts: [requirement],
      extensions: this.resourceConfig.createDiscoveryExtensions(),
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

    if (
      claim.mode !== "mock" ||
      claim.network.chainId !== this.resourceConfig.network.chainId
    ) {
      return {
        ok: false,
        code: "PAYMENT_INVALID",
        reason: "Mock payment network or mode is invalid.",
      };
    }

    if (!matchesResourceConfig(claim, this.resourceConfig)) {
      return {
        ok: false,
        code: "PAYMENT_INVALID",
        reason: "Mock payment requirement does not match this resource.",
      };
    }

    return {
      ok: true,
      payment: {
        mode: "mock",
        scheme: claim.scheme,
        network: claim.network,
        asset: claim.asset,
        currency: claim.currency,
        amount: claim.amount,
        recipient: claim.recipient,
        facilitator: claim.facilitator,
        reference: sha256Hex(headerValue),
        verifiedAt: new Date().toISOString(),
      },
    };
  }
}

export function createMockPaymentRequirement(requestHash, resourceConfig = {}) {
  const config = resolveResourceConfig(resourceConfig);

  return {
    mode: "mock",
    scheme: MOCK_PAYMENT.scheme,
    description: config.paymentDescription,
    network: {
      name: config.network.name,
      chainId: config.network.chainId,
      caip2: config.network.caip2,
      rpcUrl: config.network.rpcUrl,
    },
    asset: {
      symbol: config.assetSymbol,
      address: config.assetAddress,
    },
    currency: config.currency,
    amount: config.paymentAmount,
    recipient: config.recipient,
    facilitator: config.facilitator,
    resource: config.resourcePath,
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

function resolveResourceConfig(config = {}) {
  return {
    resourcePath: normalizeText(config.resourcePath) || TASK_RESOURCE_PATH,
    resourceDescription:
      normalizeText(config.resourceDescription) || TASK_RESOURCE_DESCRIPTION,
    mimeType: normalizeText(config.mimeType) || "application/json",
    serviceName: normalizeText(config.serviceName) || "Base Agent Pay",
    tags: normalizeTags(config.tags),
    network: normalizeNetwork(config.network),
    paymentDescription: normalizeText(config.paymentDescription) || MOCK_PAYMENT.description,
    paymentAmount: normalizeText(config.paymentAmount) || MOCK_PAYMENT.amount,
    currency: normalizeText(config.currency) || "USDC",
    assetSymbol: normalizeText(config.assetSymbol) || MOCK_PAYMENT.assetSymbol,
    assetAddress: config.assetAddress === undefined ? MOCK_PAYMENT.assetAddress : config.assetAddress,
    recipient: normalizeText(config.recipient) || MOCK_PAYMENT.recipient,
    facilitator: normalizeText(config.facilitator) || MOCK_PAYMENT.facilitator,
    createDiscoveryExtensions:
      typeof config.createDiscoveryExtensions === "function"
        ? config.createDiscoveryExtensions
        : createTaskBazaarDiscoveryExtensions,
  };
}

function matchesResourceConfig(claim, config) {
  return (
    claim.resource === config.resourcePath &&
    claim.amount === config.paymentAmount &&
    claim.currency === config.currency &&
    claim.recipient === config.recipient &&
    claim.facilitator === config.facilitator &&
    claim.network?.caip2 === config.network.caip2 &&
    claim.asset?.symbol === config.assetSymbol &&
    (claim.asset?.address ?? null) === (config.assetAddress ?? null)
  );
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return ["base", "ai", "x402"];
  }

  const tags = value.map((tag) => normalizeText(tag)).filter(Boolean);
  return tags.length > 0 ? tags : ["base", "ai", "x402"];
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNetwork(value) {
  if (
    value &&
    typeof value === "object" &&
    Number.isInteger(value.chainId) &&
    normalizeText(value.caip2)
  ) {
    return {
      name: normalizeText(value.name) || `Chain ${value.chainId}`,
      chainId: value.chainId,
      caip2: normalizeText(value.caip2),
      rpcUrl: normalizeText(value.rpcUrl),
    };
  }

  return BASE_NETWORK;
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
