import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
const PAYER_ACCOUNT = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const MISMATCHED_SIGNER_ACCOUNT = privateKeyToAccount(
  "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
);
const PAYER = PAYER_ACCOUNT.address;

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

test("accepts lower-case Base USDC asset address before signing", () => {
  const decision = validateLivePaymentRequirement({
    paymentRequired: createPaymentRequired({
      asset: BASE_MAINNET_USDC_ADDRESS.toLowerCase(),
    }),
    request: createTaskRequest(),
    liveMaxUsdc: "0.10",
    now: new Date("2026-08-22T00:00:00.000Z"),
  });

  assert.equal(decision.ok, true);
  assert.equal(
    decision.requirements.asset.toLowerCase(),
    BASE_MAINNET_USDC_ADDRESS.toLowerCase(),
  );
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
    name: "expired authorization",
    paymentRequired: createPaymentRequired({ maxTimeoutSeconds: 0 }),
    request: createTaskRequest(),
    liveMaxUsdc: "0.10",
    expectedReason: /authorization expiry/u,
  },
  {
    name: "wrong USDC address",
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
  assert.match(paymentPayload.payload.signature, /^0x[0-9a-fA-F]{130}$/u);
  assert.equal(paymentPayload.payload.authorization.from, PAYER);
  assert.equal(paymentPayload.payload.authorization.to, PAY_TO);
  assert.equal(paymentPayload.payload.authorization.value, "10000");
  assert.match(paymentPayload.payload.authorization.nonce, /^0x[0-9a-fA-F]{64}$/u);
  assert.ok(BigInt(paymentPayload.payload.authorization.validBefore) > 0n);
  assert.equal(provider.typedData.domain.name, "USD Coin");
  assert.equal(provider.typedData.domain.version, "2");
  assert.equal(provider.typedData.domain.chainId, 8453);
  assert.equal(
    provider.typedData.domain.verifyingContract.toLowerCase(),
    BASE_MAINNET_USDC_ADDRESS.toLowerCase(),
  );
  assert.equal(provider.typedData.primaryType, "TransferWithAuthorization");

  const recoveredAddress = await recoverTypedDataAddress({
    ...provider.typedData,
    signature: paymentPayload.payload.signature,
  });
  assert.equal(recoveredAddress.toLowerCase(), PAYER.toLowerCase());
});

test("fails closed when recovered signer does not match connected account", async () => {
  const provider = createMockProvider({
    signerAccount: MISMATCHED_SIGNER_ACCOUNT,
  });

  await assert.rejects(
    () =>
      createLivePaymentSignatureHeaders({
        paymentRequired: createPaymentRequired(),
        provider,
        account: PAYER,
        rpcUrl: "https://mainnet.base.org",
      }),
    /signature recovery does not match/u,
  );
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
  signerAccount = PAYER_ACCOUNT,
  signTypedData,
} = {}) {
  return {
    typedData: null,
    async request({ method, params }) {
      if (method === "eth_accounts") {
        return accounts;
      }

      if (method === "eth_signTypedData_v4") {
        this.typedData = JSON.parse(params[1]);
        return (
          signTypedData?.({ method, params, typedData: this.typedData }) ??
          signerAccount.signTypedData(this.typedData)
        );
      }

      throw new Error(`Unexpected wallet method: ${method}`);
    },
  };
}
