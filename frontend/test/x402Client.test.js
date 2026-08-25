import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";

import {
  createLivePaymentSignatureHeaders,
  parsePaymentRequiredHeader,
  validateLivePaymentRequirement,
} from "../src/x402Client.js";
import {
  BASE_MAINNET_CAIP2,
  BASE_MAINNET_USDC_ADDRESS,
} from "../src/config.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const SIGNATURE = `0x${"b".repeat(130)}`;

test("parses valid x402 PaymentRequired headers", () => {
  const paymentRequired = createPaymentRequired();
  const header = encodePaymentRequiredHeader(paymentRequired);

  assert.deepEqual(parsePaymentRequiredHeader(header), paymentRequired);
});

test("validates exact Base USDC payment requirements before signing", () => {
  const decision = validateLivePaymentRequirement({
    paymentRequired: createPaymentRequired(),
    request: createTaskRequest(),
    liveMaxUsdc: "0.10",
    now: new Date("2026-08-22T00:00:00.000Z"),
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.requirements.network, BASE_MAINNET_CAIP2);
  assert.equal(decision.requirements.asset, BASE_MAINNET_USDC_ADDRESS);
  assert.equal(decision.requirements.payTo, PAY_TO);
});

for (const { name, paymentRequired, request, liveMaxUsdc, expectedReason } of [
  {
    name: "unsupported network",
    paymentRequired: createPaymentRequired({ network: "eip155:1" }),
    request: createTaskRequest(),
    liveMaxUsdc: "0.10",
    expectedReason: /exact Base Mainnet USDC/u,
  },
  {
    name: "wrong asset",
    paymentRequired: createPaymentRequired({
      asset: "0x3333333333333333333333333333333333333333",
    }),
    request: createTaskRequest(),
    liveMaxUsdc: "0.10",
    expectedReason: /exact Base Mainnet USDC/u,
  },
  {
    name: "wrong payTo",
    paymentRequired: createPaymentRequired({
      payTo: "0x3333333333333333333333333333333333333333",
    }),
    request: createTaskRequest(),
    liveMaxUsdc: "0.10",
    expectedReason: /recipient does not match/u,
  },
  {
    name: "amount modified",
    paymentRequired: createPaymentRequired({ amount: "20000" }),
    request: createTaskRequest(),
    liveMaxUsdc: "0.10",
    expectedReason: /amount does not match/u,
  },
  {
    name: "global cap exceeded",
    paymentRequired: createPaymentRequired(),
    request: createTaskRequest({ amount: "0.01" }),
    liveMaxUsdc: "0.005",
    expectedReason: /global live cap/u,
  },
  {
    name: "expired mandate",
    paymentRequired: createPaymentRequired(),
    request: createTaskRequest({
      mandate: {
        expiresAt: "2026-08-21T00:00:00.000Z",
      },
    }),
    liveMaxUsdc: "0.10",
    expectedReason: /Mandate is expired/u,
  },
]) {
  test(`rejects ${name} before wallet signing`, () => {
    const decision = validateLivePaymentRequirement({
      paymentRequired,
      request,
      liveMaxUsdc,
      now: new Date("2026-08-22T00:00:00.000Z"),
    });

    assert.equal(decision.ok, false);
    assert.match(decision.reason, expectedReason);
  });
}

test("creates EIP-712/EIP-3009 PAYMENT-SIGNATURE headers with connected wallet", async () => {
  const provider = createMockProvider();
  const paymentRequired = createPaymentRequired();

  const result = await createLivePaymentSignatureHeaders({
    paymentRequired,
    provider,
    account: PAYER,
    rpcUrl: "https://mainnet.base.org",
  });
  const paymentPayload = decodePaymentSignatureHeader(
    result.headers["PAYMENT-SIGNATURE"],
  );

  assert.equal(paymentPayload.x402Version, 2);
  assert.deepEqual(paymentPayload.accepted, paymentRequired.accepts[0]);
  assert.equal(paymentPayload.payload.signature, SIGNATURE);
  assert.equal(paymentPayload.payload.authorization.from, PAYER);
  assert.equal(paymentPayload.payload.authorization.to, PAY_TO);
  assert.equal(paymentPayload.payload.authorization.value, "10000");
  assert.match(paymentPayload.payload.authorization.nonce, /^0x[0-9a-fA-F]{64}$/u);
  assert.ok(BigInt(paymentPayload.payload.authorization.validBefore) > 0n);
  assert.equal(provider.typedData.domain.chainId, 8453);
  assert.equal(provider.typedData.domain.verifyingContract, BASE_MAINNET_USDC_ADDRESS);
  assert.equal(provider.typedData.primaryType, "TransferWithAuthorization");
});

test("surfaces user-declined wallet signature without creating a payment header", async () => {
  const provider = createMockProvider({
    async signTypedData() {
      throw new Error("User rejected the signature request");
    },
  });

  await assert.rejects(
    () =>
      createLivePaymentSignatureHeaders({
        paymentRequired: createPaymentRequired(),
        provider,
        account: PAYER,
        rpcUrl: "https://mainnet.base.org",
      }),
    /User rejected/u,
  );
});

test("rejects signing when the connected wallet account changes", async () => {
  const provider = createMockProvider({
    accounts: ["0x3333333333333333333333333333333333333333"],
  });

  await assert.rejects(
    () =>
      createLivePaymentSignatureHeaders({
        paymentRequired: createPaymentRequired(),
        provider,
        account: PAYER,
        rpcUrl: "https://mainnet.base.org",
      }),
    /account changed/u,
  );
});

function createPaymentRequired(requirementOverrides = {}) {
  const requirements = {
    scheme: "exact",
    network: BASE_MAINNET_CAIP2,
    amount: "10000",
    asset: BASE_MAINNET_USDC_ADDRESS,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: {
      name: "USD Coin",
      version: "2",
      decimals: 6,
      assetTransferMethod: "eip3009",
    },
    ...requirementOverrides,
  };

  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: "/api/task",
      description: "Base Agent Pay live AI task",
      mimeType: "application/json",
      serviceName: "Base Agent Pay",
      tags: ["base", "ai"],
    },
    accepts: [requirements],
  };
}

function createTaskRequest(overrides = {}) {
  const mandateOverrides = overrides.mandate ?? {};
  const requestOverrides = { ...overrides };
  delete requestOverrides.mandate;
  return {
    taskType: "summarize",
    input: "Frontend signing test.",
    scope: "summarize",
    counterparty: PAY_TO,
    amount: "0.01",
    currency: "USDC",
    mandate: {
      mandateId: "mandate-x402-test",
      maxSpendPerTask: "0.10",
      currency: "USDC",
      allowedCounterparties: [PAY_TO],
      expiresAt: "2026-08-25T12:00:00.000Z",
      allowedScopes: ["summarize"],
      ...mandateOverrides,
    },
    ...requestOverrides,
  };
}

function createMockProvider({
  accounts = [PAYER],
  signTypedData = async () => SIGNATURE,
} = {}) {
  return {
    typedData: null,
    async request({ method, params }) {
      if (method === "eth_accounts") {
        return accounts;
      }

      if (method === "eth_signTypedData_v4") {
        this.typedData = JSON.parse(params[1]);
        return signTypedData({ method, params, typedData: this.typedData });
      }

      throw new Error(`Unexpected wallet method: ${method}`);
    },
  };
}
