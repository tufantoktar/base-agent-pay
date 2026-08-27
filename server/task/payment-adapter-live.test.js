import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";

import { handleTaskRequest } from "./handler.js";
import { BASE_SETTLEMENT_VERIFICATION_CODES } from "./base-settlement-verifier.js";
import { sha256Hex } from "./hash.js";
import { evaluateMandate, MANDATE_CODES } from "./mandate.js";
import {
  CDP_X402_FACILITATOR_URL,
  LIVE_PAYMENT_CODES,
  LIVE_PAYMENT_STATES,
  LivePaymentAdapter,
  MockPaymentAdapter,
  SqlitePaymentStore,
  createCdpAuthHeaderFactory,
  encodePaymentSignatureForTest,
  getPaymentAdapter,
} from "./payment-adapter.js";
import { BASE_MAINNET_USDC, X402_PAYMENT_REQUIRED_HEADER } from "./constants.js";

const NOW = "2026-08-22T00:00:00.000Z";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"a".repeat(64)}`;
const openStores = new Set();

test.afterEach(() => {
  for (const store of openStores) {
    store.close();
  }
  openStores.clear();
});

test("default payment mode selects MOCK", () => {
  const adapter = getPaymentAdapter({ env: {} });

  assert.ok(adapter instanceof MockPaymentAdapter);
  assert.equal(adapter.mode, "mock");
});

test("live without X402_LIVE_CONFIRM is blocked", () => {
  const adapter = getPaymentAdapter({
    env: {
      X402_MODE: "live",
    },
  });
  const request = liveRequest();
  const paymentRequired = adapter.createPaymentRequired({
    request,
    requestHash: sha256Hex(request),
    now: NOW,
    evaluateMandate,
  });

  assert.ok(adapter instanceof LivePaymentAdapter);
  assert.equal(paymentRequired.mode, "live");
  assert.equal(paymentRequired.code, LIVE_PAYMENT_CODES.CONFIG_INVALID);
  assert.match(paymentRequired.message, /X402_LIVE_CONFIRM/u);
});

test("live with confirm but missing CDP credentials and recipient is blocked", () => {
  const adapter = getPaymentAdapter({
    env: {
      X402_MODE: "live",
      X402_LIVE_CONFIRM: "true",
    },
  });
  const request = liveRequest();
  const paymentRequired = adapter.createPaymentRequired({
    request,
    requestHash: sha256Hex(request),
    now: NOW,
    evaluateMandate,
  });

  assert.equal(paymentRequired.code, LIVE_PAYMENT_CODES.CONFIG_INVALID);
  assert.match(paymentRequired.message, /CDP_API_KEY_ID/u);
  assert.match(paymentRequired.message, /CDP_API_KEY_SECRET/u);
  assert.match(paymentRequired.message, /X402_PAYMENT_RECIPIENT/u);
});

test("mock mode remains available in production-like runtime", () => {
  const adapter = getPaymentAdapter({
    env: {
      NODE_ENV: "production",
      VERCEL: "1",
      X402_MODE: "mock",
      PAYMENT_STORE_DRIVER: "sqlite",
    },
  });

  assert.ok(adapter instanceof MockPaymentAdapter);
  assert.equal(adapter.mode, "mock");
});

test("production live mode requires a shared Postgres payment store", () => {
  const adapter = getPaymentAdapter({
    env: {
      ...liveEnv(),
      NODE_ENV: "production",
      PAYMENT_STORE_DRIVER: "sqlite",
    },
  });
  const request = liveRequest();
  const paymentRequired = adapter.createPaymentRequired({
    request,
    requestHash: sha256Hex(request),
    now: NOW,
    evaluateMandate,
  });

  assert.equal(paymentRequired.code, LIVE_PAYMENT_CODES.CONFIG_INVALID);
  assert.match(paymentRequired.message, /PAYMENT_STORE_DRIVER=postgres/u);
});

test("postgres payment store requires an explicit database URL", () => {
  const adapter = getPaymentAdapter({
    env: {
      ...liveEnv(),
      PAYMENT_STORE_DRIVER: "postgres",
      PAYMENT_DATABASE_URL: "",
    },
  });
  const request = liveRequest();
  const paymentRequired = adapter.createPaymentRequired({
    request,
    requestHash: sha256Hex(request),
    now: NOW,
    evaluateMandate,
  });

  assert.equal(paymentRequired.code, LIVE_PAYMENT_CODES.CONFIG_INVALID);
  assert.match(paymentRequired.message, /PAYMENT_DATABASE_URL/u);
});

test("live cap configuration cannot exceed 0.10 USDC", () => {
  const adapter = getPaymentAdapter({
    env: {
      ...liveEnv({
        X402_MAX_LIVE_PAYMENT_USDC: "0.100001",
      }),
    },
  });
  const request = liveRequest();
  const paymentRequired = adapter.createPaymentRequired({
    request,
    requestHash: sha256Hex(request),
    now: NOW,
    evaluateMandate,
  });

  assert.equal(paymentRequired.code, LIVE_PAYMENT_CODES.CONFIG_INVALID);
  assert.match(paymentRequired.message, /0\.10 USDC or less/u);
});

test("CDP auth header factory generates short-lived endpoint-bound JWT headers", async () => {
  const calls = [];
  const createAuthHeaders = createCdpAuthHeaderFactory({
    facilitatorUrl: CDP_X402_FACILITATOR_URL,
    cdpApiKeyId: "test-key-id",
    cdpApiKeySecret: "test-secret-value",
    expiresIn: 120,
    async generateJwtImpl(options) {
      calls.push(options);
      return `jwt-for-${options.requestPath.split("/").at(-1)}`;
    },
  });

  const headers = await createAuthHeaders();

  assert.deepEqual(headers, {
    verify: { Authorization: "Bearer jwt-for-verify" },
    settle: { Authorization: "Bearer jwt-for-settle" },
    supported: { Authorization: "Bearer jwt-for-supported" },
  });
  assert.deepEqual(
    calls.map((call) => [
      call.requestMethod,
      call.requestHost,
      call.requestPath,
      call.expiresIn,
    ]).sort(),
    [
      ["GET", "api.cdp.coinbase.com", "/platform/v2/x402/supported", 120],
      ["POST", "api.cdp.coinbase.com", "/platform/v2/x402/settle", 120],
      ["POST", "api.cdp.coinbase.com", "/platform/v2/x402/verify", 120],
    ],
  );
  assert.ok(calls.every((call) => call.apiKeyId === "test-key-id"));
  assert.ok(calls.every((call) => call.apiKeySecret === "test-secret-value"));
  assert.doesNotMatch(
    JSON.stringify(headers),
    /test-secret-value/u,
  );
});

test("HTTPFacilitatorClient getSupported reads supported header from no-arg CDP callback", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  let authCallbackCalls = 0;
  const client = new HTTPFacilitatorClient({
    url: CDP_X402_FACILITATOR_URL,
    createAuthHeaders: async () => {
      authCallbackCalls += 1;
      return {
        verify: { Authorization: "Bearer jwt-for-verify" },
        settle: { Authorization: "Bearer jwt-for-settle" },
        supported: { Authorization: "Bearer jwt-for-supported" },
      };
    },
  });

  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({
      url,
      method: options.method,
      authorization: options.headers.Authorization,
    });
    return new Response(JSON.stringify({ kinds: [] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    const supported = await client.getSupported();

    assert.deepEqual(supported, {
      kinds: [],
      extensions: [],
      signers: {},
    });
    assert.equal(authCallbackCalls, 1);
    assert.deepEqual(fetchCalls, [
      {
        url: `${CDP_X402_FACILITATOR_URL}/supported`,
        method: "GET",
        authorization: "Bearer jwt-for-supported",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CDP auth header factory surfaces JWT generation failures", async () => {
  const createAuthHeaders = createCdpAuthHeaderFactory({
    cdpApiKeyId: "test-key-id",
    cdpApiKeySecret: "test-secret-value",
    async generateJwtImpl() {
      throw new Error("invalid CDP credentials");
    },
  });

  await assert.rejects(
    () => createAuthHeaders(),
    /invalid CDP credentials/u,
  );
});

test("unsupported X402_MODE fails closed without falling back to MOCK", async () => {
  const adapter = getPaymentAdapter({
    env: {
      X402_MODE: "liveish",
    },
  });
  const verification = await adapter.verifyPayment();

  assert.equal(adapter.mode, "liveish");
  assert.equal(verification.ok, false);
  assert.equal(verification.statusCode, 403);
  assert.equal(verification.code, LIVE_PAYMENT_CODES.BLOCKED);
});

test("valid live config returns an x402 v2 payment challenge", async () => {
  const facilitator = createMockFacilitator();
  const response = await callTask(liveRequest(), {}, {
    paymentAdapter: createLiveAdapter({ facilitator }),
  });
  const paymentRequiredHeader = response.headers.get(
    X402_PAYMENT_REQUIRED_HEADER.toLowerCase(),
  );
  const decodedHeader = decodePaymentRequiredHeader(paymentRequiredHeader);
  const requirements = response.body.accepts[0];

  assert.equal(response.statusCode, 402);
  assert.equal(response.body.x402Version, 2);
  assert.equal("idempotencyKey" in response.body, false);
  assert.equal("paymentRequirements" in response.body, false);
  assert.deepEqual(decodedHeader, {
    x402Version: response.body.x402Version,
    error: response.body.error,
    resource: response.body.resource,
    accepts: response.body.accepts,
  });
  assert.equal(requirements.scheme, "exact");
  assert.equal(requirements.network, "eip155:8453");
  assert.equal(requirements.asset, BASE_MAINNET_USDC.address);
  assert.equal(requirements.payTo, PAY_TO);
  assert.equal(requirements.extra.assetTransferMethod, "eip3009");
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

for (const {
  name,
  signature,
  verifyResponses,
  expectedReason,
  expectedVerifyCalls = 0,
} of [
  {
    name: "malformed signature payload",
    signature: () => "not-base64-json",
    expectedReason: /PAYMENT-SIGNATURE/u,
  },
  {
    name: "invalid x402 version",
    signature: ({ adapter, request }) =>
      createPaymentSignature({ adapter, request, x402Version: 1 }),
    expectedReason: /x402Version 2/u,
  },
  {
    name: "unsupported network",
    signature: ({ adapter, request }) =>
      createPaymentSignature({
        adapter,
        request,
        acceptedOverrides: { network: "eip155:1" },
      }),
    expectedReason: /accepted\.network/u,
  },
  {
    name: "wrong asset",
    signature: ({ adapter, request }) =>
      createPaymentSignature({
        adapter,
        request,
        acceptedOverrides: {
          asset: "0x3333333333333333333333333333333333333333",
        },
      }),
    expectedReason: /accepted\.asset/u,
  },
  {
    name: "wrong payTo",
    signature: ({ adapter, request }) =>
      createPaymentSignature({
        adapter,
        request,
        acceptedOverrides: {
          payTo: "0x3333333333333333333333333333333333333333",
        },
      }),
    expectedReason: /accepted\.payTo/u,
  },
  {
    name: "amount mismatch",
    signature: ({ adapter, request }) =>
      createPaymentSignature({
        adapter,
        request,
        authorizationOverrides: { value: "99999" },
      }),
    expectedReason: /authorization amount/u,
  },
  {
    name: "recipient modified after signing",
    signature: ({ adapter, request }) =>
      createPaymentSignature({
        adapter,
        request,
        authorizationOverrides: {
          to: "0x3333333333333333333333333333333333333333",
        },
      }),
    expectedReason: /authorization recipient/u,
  },
  {
    name: "expired authorization",
    signature: ({ adapter, request }) =>
      createPaymentSignature({
        adapter,
        request,
        authorizationOverrides: { validBefore: "1" },
      }),
    expectedReason: /expired/u,
  },
  {
    name: "wrong signer",
    signature: ({ adapter, request }) => createPaymentSignature({ adapter, request }),
    verifyResponses: [
      {
        isValid: true,
        payer: "0x3333333333333333333333333333333333333333",
      },
    ],
    expectedReason: /payer does not match/u,
    expectedVerifyCalls: 1,
  },
]) {
  test(`live payment rejects ${name}`, async () => {
    const facilitator = createMockFacilitator({ verifyResponses });
    const request = liveRequest({
      idempotencyKey: `task_live_reject_${name.replaceAll(" ", "_")}`,
    });
    const adapter = createLiveAdapter({ facilitator });
    const calls = createDownstreamCounters();
    const response = await callTask(
      request,
      {
        "payment-signature": signature({ adapter, request }),
      },
      {
        paymentAdapter: adapter,
        ...calls.options,
      },
    );

    assert.equal(response.statusCode, 402);
    assert.match(response.body.reason, expectedReason);
    assert.equal(facilitator.calls.verify, expectedVerifyCalls);
    assert.equal(facilitator.calls.settle, 0);
    assert.equal(calls.aiRun, 0);
    assert.equal(calls.receipt, 0);
  });
}

test("spend over mandate denies before live adapter call", async () => {
  const calls = {
    paymentVerify: 0,
  };
  const response = await callTask(
    liveRequest({
      amount: "0.11",
      mandate: {
        maxSpendPerTask: "0.10",
      },
    }),
    {},
    {
      paymentAdapter: {
        verifyPayment() {
          calls.paymentVerify += 1;
          throw new Error("live adapter must not be called");
        },
      },
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, MANDATE_CODES.SPEND_EXCEEDED);
  assert.equal(calls.paymentVerify, 0);
});

test("spend over global live cap denies before settlement", async () => {
  const facilitator = createMockFacilitator();
  const response = await callTask(
    liveRequest({
      amount: "0.11",
      mandate: {
        maxSpendPerTask: "0.20",
      },
    }),
    {},
    {
      paymentAdapter: createLiveAdapter({ facilitator }),
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, LIVE_PAYMENT_CODES.SPEND_EXCEEDS_CAP);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("hard live cap allows exact max and blocks one atomic unit over", async () => {
  const exactFacilitator = createMockFacilitator();
  const exactResponse = await callTask(
    liveRequest({
      amount: "0.10",
      idempotencyKey: "task_live_cap_exact_0001",
      mandate: {
        maxSpendPerTask: "0.10",
      },
    }),
    {},
    {
      paymentAdapter: createLiveAdapter({ facilitator: exactFacilitator }),
    },
  );
  const overFacilitator = createMockFacilitator();
  const overResponse = await callTask(
    liveRequest({
      amount: "0.100001",
      idempotencyKey: "task_live_cap_over_0001",
      mandate: {
        maxSpendPerTask: "0.100001",
      },
    }),
    {},
    {
      paymentAdapter: createLiveAdapter({ facilitator: overFacilitator }),
    },
  );

  assert.equal(exactResponse.statusCode, 402);
  assert.equal(exactResponse.body.x402Version, 2);
  assert.equal(exactResponse.body.error, "PAYMENT-SIGNATURE header is required");
  assert.equal(exactResponse.body.accepts[0].amount, "100000");
  assert.equal(exactFacilitator.calls.verify, 0);
  assert.equal(exactFacilitator.calls.settle, 0);
  assert.equal(overResponse.statusCode, 403);
  assert.equal(overResponse.body.error, LIVE_PAYMENT_CODES.SPEND_EXCEEDS_CAP);
  assert.equal(overFacilitator.calls.verify, 0);
  assert.equal(overFacilitator.calls.settle, 0);
});

test("invalid live amount, currency, and network fail before facilitator calls", async () => {
  for (const {
    name,
    request,
    env,
    expectedError,
  } of [
    {
      name: "malformed amount",
      request: liveRequest({
        amount: "0.1000001",
        idempotencyKey: "task_live_invalid_malformed_amount",
        mandate: {
          maxSpendPerTask: "0.10",
        },
      }),
      expectedError: MANDATE_CODES.AMOUNT_INVALID,
    },
    {
      name: "negative amount",
      request: liveRequest({
        amount: "-0.01",
        idempotencyKey: "task_live_invalid_negative_amount",
      }),
      expectedError: MANDATE_CODES.AMOUNT_INVALID,
    },
    {
      name: "zero amount",
      request: liveRequest({
        amount: "0",
        idempotencyKey: "task_live_invalid_zero_amount",
      }),
      expectedError: MANDATE_CODES.AMOUNT_INVALID,
    },
    {
      name: "non-USDC currency",
      request: liveRequest({
        currency: "EUR",
        idempotencyKey: "task_live_invalid_currency",
        mandate: {
          currency: "EUR",
        },
      }),
      expectedError: MANDATE_CODES.CURRENCY_NOT_ALLOWED,
    },
    {
      name: "unexpected configured network",
      request: liveRequest({
        idempotencyKey: "task_live_invalid_network",
      }),
      env: liveEnv({ X402_NETWORK: "eip155:1" }),
      expectedError: LIVE_PAYMENT_CODES.CONFIG_INVALID,
    },
  ]) {
    const facilitator = createMockFacilitator();
    const response = await callTask(request, {}, {
      paymentAdapter: createLiveAdapter({ facilitator, env }),
    });

    assert.equal(response.statusCode, 403, name);
    assert.equal(response.body.error, expectedError, name);
    assert.equal(facilitator.calls.verify, 0, name);
    assert.equal(facilitator.calls.settle, 0, name);
  }
});

test("counterparty mismatch denies before settlement", async () => {
  const facilitator = createMockFacilitator();
  const response = await callTask(
    liveRequest({
      counterparty: "base-agent-pay",
      mandate: {
        allowedCounterparties: ["base-agent-pay"],
      },
    }),
    {},
    {
      paymentAdapter: createLiveAdapter({ facilitator }),
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, LIVE_PAYMENT_CODES.COUNTERPARTY_MISMATCH);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("expired mandate denies before live settlement", async () => {
  const facilitator = createMockFacilitator();
  const response = await callTask(
    liveRequest({
      mandate: {
        expiresAt: "2026-08-21T00:00:00.000Z",
      },
    }),
    {},
    {
      paymentAdapter: createLiveAdapter({ facilitator }),
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, MANDATE_CODES.EXPIRED);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("scope mismatch denies before live settlement", async () => {
  const facilitator = createMockFacilitator();
  const response = await callTask(
    liveRequest({
      scope: "summarize",
      mandate: {
        allowedScopes: ["classify"],
      },
    }),
    {},
    {
      paymentAdapter: createLiveAdapter({ facilitator }),
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, MANDATE_CODES.SCOPE_NOT_ALLOWED);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("successful live settlement runs AI and returns receipt-eligible hashes", async () => {
  const facilitator = createMockFacilitator();
  const settlementVerifier = createSuccessfulSettlementVerifier();
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator, settlementVerifier });
  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
    },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.mode, "live");
  assert.equal(response.body.payment.settled, true);
  assert.equal(response.body.payment.transactionHash, TX_HASH);
  assert.equal(response.body.receipt.eligible, true);
  assert.deepEqual(
    decodePaymentResponseHeader(
      response.headers.get("payment-response"),
    ),
    {
      success: true,
      payer: PAYER,
      transaction: TX_HASH,
      network: "eip155:8453",
      amount: "10000",
    },
  );
  assert.match(response.body.taskId, /^0x[0-9a-f]{64}$/u);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
  assert.equal(settlementVerifier.calls, 1);
});

test("read-only payment state endpoint returns safe SETTLED durable state", async () => {
  const facilitator = createMockFacilitator();
  const paymentStore = createTempPaymentStore();
  const adapter = createLiveAdapter({ facilitator, paymentStore });
  const request = liveRequest({
    idempotencyKey: "task_live_state_read_0001",
  });

  const settled = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
    },
  );
  const state = await callTaskState(request.idempotencyKey, {
    paymentAdapter: adapter,
  });

  assert.equal(settled.statusCode, 200);
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.payment.status, LIVE_PAYMENT_STATES.SETTLED);
  assert.equal(state.body.payment.taskId, settled.body.taskId);
  assert.equal(state.body.payment.idempotencyKey, request.idempotencyKey);
  assert.equal(state.body.payment.paymentId, request.idempotencyKey);
  assert.equal(state.body.payment.transactionHash, TX_HASH);
  assert.equal(state.body.payment.receipt.settlementVerified, true);
  assert.equal(state.body.payment.receipt.eligible, true);
  assert.equal(state.body.payment.task.taskId, settled.body.taskId);
  assert.equal(state.body.payment.task.requestHash, settled.body.requestHash);
  assert.equal(state.body.payment.task.resultHash, settled.body.resultHash);
  assert.equal("paymentRequired" in state.body.payment, false);
  assert.equal("paymentRequirements" in state.body.payment, false);
  assert.equal("settlementResponse" in state.body.payment, false);
  assert.equal("payment" in state.body.payment, false);
  assert.doesNotMatch(JSON.stringify(state.body), /PAYMENT-SIGNATURE|signature|authorization|Bearer|test-cdp/u);

  const stateByFinalTaskId = await callTaskState(settled.body.taskId, {
    paymentAdapter: adapter,
  });
  assert.equal(stateByFinalTaskId.statusCode, 200);
  assert.equal(stateByFinalTaskId.body.payment.status, LIVE_PAYMENT_STATES.SETTLED);
  assert.equal(
    stateByFinalTaskId.body.payment.idempotencyKey,
    request.idempotencyKey,
  );
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
});

test("failed live settlement runs AI but prevents receipt payload creation", async () => {
  const facilitator = createMockFacilitator({
    settleResponses: [
      {
        success: false,
        errorReason: "insufficient_funds",
        transaction: "",
        network: "eip155:8453",
      },
    ],
  });
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator });
  const calls = createDownstreamCounters();
  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
      ...calls.options,
    },
  );

  assert.equal(response.statusCode, 402);
  assert.equal(response.body.message, "insufficient_funds");
  assert.equal(calls.aiRun, 1);
  assert.equal(calls.receipt, 0);
});

test("pending live settlement runs AI but prevents receipt payload creation", async () => {
  const facilitator = createMockFacilitator({
    settleResponses: [
      {
        success: false,
        errorReason: "settlement_pending",
        transaction: TX_HASH,
        network: "eip155:8453",
      },
    ],
  });
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator });
  const calls = createDownstreamCounters();
  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
      ...calls.options,
    },
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.message, "settlement_pending");
  assert.equal(calls.aiRun, 1);
  assert.equal(calls.receipt, 0);
});

test("unknown settlement response runs AI but prevents receipt payload creation", async () => {
  const facilitator = createMockFacilitator({
    settleResponses: [
      {
        success: true,
        transaction: "",
        network: "eip155:8453",
      },
    ],
  });
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator });
  const calls = createDownstreamCounters();
  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
      ...calls.options,
    },
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, LIVE_PAYMENT_CODES.SETTLEMENT_UNKNOWN);
  assert.equal(calls.aiRun, 1);
  assert.equal(calls.receipt, 0);
});

test("facilitator success without Base USDC proof is not persisted as SETTLED", async () => {
  const facilitator = createMockFacilitator();
  const settlementVerifier = async () => ({
    ok: false,
    code: BASE_SETTLEMENT_VERIFICATION_CODES.TRANSFER_MISSING,
    reason: "Expected Base USDC transfer was not found.",
  });
  const request = liveRequest();
  const paymentStore = createTempPaymentStore();
  const adapter = createLiveAdapter({
    facilitator,
    paymentStore,
    settlementVerifier,
  });
  const calls = createDownstreamCounters();
  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
      ...calls.options,
    },
  );
  const stored = paymentStore.getPayment(request.idempotencyKey);

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, LIVE_PAYMENT_CODES.SETTLEMENT_UNKNOWN);
  assert.equal(stored.state, LIVE_PAYMENT_STATES.UNKNOWN);
  assert.equal(stored.transactionHash, TX_HASH);
  assert.equal(calls.aiRun, 1);
  assert.equal(calls.receipt, 0);
  assert.equal(facilitator.calls.settle, 1);
});

test("settlement timeout checks status and does not retry ambiguous payment", async () => {
  const facilitator = createMockFacilitator({
    settleError: new Error("timeout while waiting for settlement"),
    statusResponses: [
      {
        success: false,
        errorReason: "settlement_pending",
        transaction: TX_HASH,
        network: "eip155:8453",
      },
    ],
  });
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator });
  const calls = createDownstreamCounters();
  const headers = {
    "payment-signature": createPaymentSignature({ adapter, request }),
  };
  const first = await callTask(request, headers, {
    paymentAdapter: adapter,
    ...calls.options,
  });
  const second = await callTask(request, headers, {
    paymentAdapter: adapter,
    ...calls.options,
  });

  assert.equal(first.statusCode, 409);
  assert.equal(second.statusCode, 409);
  assert.equal(facilitator.calls.settle, 1);
  assert.equal(facilitator.calls.status, 1);
  assert.equal(calls.aiRun, 1);
  assert.equal(calls.receipt, 0);
});

test("duplicate settled request reuses cached task response without new settlement", async () => {
  const facilitator = createMockFacilitator();
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator });
  const headers = {
    "payment-signature": createPaymentSignature({ adapter, request }),
  };
  const calls = createDownstreamCounters({
    output: "Paid once.",
  });

  const first = await callTask(request, headers, {
    paymentAdapter: adapter,
    ...calls.options,
  });
  const second = await callTask(request, headers, {
    paymentAdapter: adapter,
    ...calls.options,
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(facilitator.calls.settle, 1);
  assert.equal(calls.aiRun, 1);
  assert.equal(calls.receipt, 1);
});

test("retry after known settlement failure can settle once facilitator succeeds", async () => {
  const facilitator = createMockFacilitator({
    settleResponses: [
      {
        success: false,
        errorReason: "insufficient_funds",
        transaction: "",
        network: "eip155:8453",
      },
      {
        success: true,
        payer: PAYER,
        transaction: TX_HASH,
        network: "eip155:8453",
        amount: "10000",
      },
    ],
  });
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator });
  const headers = {
    "payment-signature": createPaymentSignature({ adapter, request }),
  };

  const first = await callTask(request, headers, {
    paymentAdapter: adapter,
  });
  const second = await callTask(request, headers, {
    paymentAdapter: adapter,
  });

  assert.equal(first.statusCode, 402);
  assert.equal(second.statusCode, 200);
  assert.equal(facilitator.calls.settle, 2);
});

test("ambiguous settlement state blocks retry and avoids double settlement", async () => {
  const facilitator = createMockFacilitator({
    settleResponses: [
      {
        success: false,
        errorReason: "settlement_pending",
        transaction: TX_HASH,
        network: "eip155:8453",
      },
    ],
  });
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator });
  const headers = {
    "payment-signature": createPaymentSignature({ adapter, request }),
  };

  const first = await callTask(request, headers, {
    paymentAdapter: adapter,
  });
  const second = await callTask(request, headers, {
    paymentAdapter: adapter,
  });

  assert.equal(first.statusCode, 409);
  assert.equal(second.statusCode, 409);
  assert.equal(facilitator.calls.settle, 1);
});

test("authorized payment plus AI failure does not settle or create success receipt", async () => {
  const facilitator = createMockFacilitator();
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator });
  let receiptCalls = 0;
  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
      aiProvider: {
        async run() {
          throw new Error("AI unavailable");
        },
      },
      createReceiptPayload() {
        receiptCalls += 1;
        return {};
      },
    },
  );

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, "AI_TASK_FAILED");
  assert.equal(response.body.receipt.eligible, false);
  assert.equal(receiptCalls, 0);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 0);
});

test("authorized payment plus AI timeout does not settle or create success receipt", async () => {
  const facilitator = createMockFacilitator();
  const request = liveRequest({
    idempotencyKey: "task_live_ai_timeout_0001",
  });
  const adapter = createLiveAdapter({ facilitator });
  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
      aiProvider: {
        async run() {
          const error = new Error("AI task timed out");
          error.code = "AI_TIMEOUT";
          throw error;
        },
      },
      createReceiptPayload() {
        throw new Error("receipt must not be created");
      },
    },
  );

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, "AI_TASK_FAILED");
  assert.equal(response.body.receipt.eligible, false);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 0);
});

test("malformed AI result does not settle or create success receipt", async () => {
  const facilitator = createMockFacilitator();
  const paymentStore = createTempPaymentStore();
  const request = liveRequest({
    idempotencyKey: "task_live_malformed_ai_result_0001",
  });
  const adapter = createLiveAdapter({ facilitator, paymentStore });
  let receiptCalls = 0;
  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
      aiProvider: {
        async run() {
          return {
            provider: "mock",
            taskType: request.taskType,
          };
        },
      },
      createReceiptPayload() {
        receiptCalls += 1;
        return {};
      },
    },
  );
  const stored = paymentStore.getPayment(request.idempotencyKey);

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, "AI_TASK_FAILED");
  assert.equal(response.body.receipt.eligible, false);
  assert.equal(stored.state, LIVE_PAYMENT_STATES.FAILED);
  assert.equal(receiptCalls, 0);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 0);
});

test("settled payment plus AI success reaches receipt path", async () => {
  const facilitator = createMockFacilitator();
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator });
  const calls = createDownstreamCounters();
  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
      ...calls.options,
    },
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.receipt.eligible, true);
  assert.equal(calls.aiRun, 1);
  assert.equal(calls.receipt, 1);
});

test("same key concurrent requests make one settlement attempt", async () => {
  const facilitator = createMockFacilitator({
    verifyDelayMs: 15,
  });
  const request = liveRequest();
  const paymentStore = createTempPaymentStore();
  const adapter = createLiveAdapter({ facilitator, paymentStore });
  const headers = {
    "payment-signature": createPaymentSignature({ adapter, request }),
  };

  const [first, second] = await Promise.all([
    callTask(request, headers, { paymentAdapter: adapter }),
    callTask(request, headers, { paymentAdapter: adapter }),
  ]);
  const statuses = [first.statusCode, second.statusCode].sort();

  assert.deepEqual(statuses, [200, 409]);
  assert.equal(facilitator.calls.settle, 1);
  assert.equal(paymentStore.getPayment(request.idempotencyKey).state, LIVE_PAYMENT_STATES.SETTLED);
});

test("same key and same fingerprint returns existing challenge state", async () => {
  const facilitator = createMockFacilitator();
  const paymentStore = createTempPaymentStore();
  const adapter = createLiveAdapter({ facilitator, paymentStore });
  const request = liveRequest();

  const first = await callTask(request, {}, { paymentAdapter: adapter });
  const second = await callTask(request, {}, { paymentAdapter: adapter });
  const stored = paymentStore.getPayment(request.idempotencyKey);

  assert.equal(first.statusCode, 402);
  assert.equal(second.statusCode, 402);
  assert.equal(stored.state, LIVE_PAYMENT_STATES.CHALLENGED);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("same key with a different fingerprint is denied", async () => {
  const facilitator = createMockFacilitator();
  const paymentStore = createTempPaymentStore();
  const adapter = createLiveAdapter({ facilitator, paymentStore });
  const first = liveRequest();
  const second = liveRequest({
    amount: "0.02",
    idempotencyKey: first.idempotencyKey,
  });

  const firstResponse = await callTask(first, {}, { paymentAdapter: adapter });
  const secondResponse = await callTask(second, {}, { paymentAdapter: adapter });

  assert.equal(firstResponse.statusCode, 402);
  assert.equal(secondResponse.statusCode, 409);
  assert.equal(secondResponse.body.error, LIVE_PAYMENT_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(facilitator.calls.settle, 0);
});

test("settled duplicate survives restart and does not settle again", async () => {
  const fixture = createStoreFixture();
  const firstStore = createFixturePaymentStore(fixture);
  const firstFacilitator = createMockFacilitator();
  const request = liveRequest();
  const firstAdapter = createLiveAdapter({
    facilitator: firstFacilitator,
    paymentStore: firstStore,
  });
  const headers = {
    "payment-signature": createPaymentSignature({ adapter: firstAdapter, request }),
  };

  const firstResponse = await callTask(request, headers, {
    paymentAdapter: firstAdapter,
  });
  firstStore.close();

  const secondStore = createFixturePaymentStore(fixture);
  const secondFacilitator = createMockFacilitator();
  const secondAdapter = createLiveAdapter({
    facilitator: secondFacilitator,
    paymentStore: secondStore,
  });
  const secondResponse = await callTask(request, {}, {
    paymentAdapter: secondAdapter,
  });

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);
  assert.deepEqual(secondResponse.body, firstResponse.body);
  assert.equal(firstFacilitator.calls.settle, 1);
  assert.equal(secondFacilitator.calls.settle, 0);

  secondStore.close();
  fixture.cleanup();
});

test("persisted SETTLING row reconciles SETTLED but does not rerun AI without cached task response", async () => {
  const paymentStore = createTempPaymentStore();
  const facilitator = createMockFacilitator({
    statusResponses: [
      {
        success: true,
        payer: PAYER,
        transaction: TX_HASH,
        network: "eip155:8453",
        amount: "10000",
      },
    ],
  });
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator, paymentStore });
  const calls = createDownstreamCounters();
  persistPreparedSettlement({
    adapter,
    paymentStore,
    request,
    state: LIVE_PAYMENT_STATES.SETTLING,
  });

  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
      ...calls.options,
    },
  );
  const stored = paymentStore.getPayment(request.idempotencyKey);

  assert.equal(response.statusCode, 409);
  assert.equal(stored.state, LIVE_PAYMENT_STATES.SETTLED);
  assert.equal(stored.transactionHash, TX_HASH);
  assert.equal(facilitator.calls.status, 1);
  assert.equal(facilitator.calls.settle, 0);
  assert.equal(calls.aiRun, 0);
  assert.equal(calls.receipt, 0);
});

test("persisted SETTLING row without status lookup becomes UNKNOWN and blocks retry", async () => {
  const paymentStore = createTempPaymentStore();
  const facilitator = {
    calls: {
      verify: 0,
      settle: 0,
    },
    async verify() {
      facilitator.calls.verify += 1;
      return { isValid: true, payer: PAYER };
    },
    async settle() {
      facilitator.calls.settle += 1;
      return {
        success: true,
        payer: PAYER,
        transaction: TX_HASH,
        network: "eip155:8453",
        amount: "10000",
      };
    },
  };
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator, paymentStore });
  persistPreparedSettlement({
    adapter,
    paymentStore,
    request,
    state: LIVE_PAYMENT_STATES.SETTLING,
  });

  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
    },
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN);
  assert.equal(paymentStore.getPayment(request.idempotencyKey).state, LIVE_PAYMENT_STATES.UNKNOWN);
  assert.equal(facilitator.calls.settle, 0);
});

test("UNKNOWN persisted state denies retry without settlement", async () => {
  const paymentStore = createTempPaymentStore();
  const facilitator = createMockFacilitator();
  const request = liveRequest();
  const adapter = createLiveAdapter({ facilitator, paymentStore });
  persistPreparedSettlement({
    adapter,
    paymentStore,
    request,
    state: LIVE_PAYMENT_STATES.UNKNOWN,
  });

  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
    },
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN);
  assert.equal(facilitator.calls.settle, 0);
});

test("payment store failure fails closed before facilitator calls", async () => {
  const facilitator = createMockFacilitator();
  const request = liveRequest();
  const adapter = createLiveAdapter({
    facilitator,
    paymentStore: {
      createPayment() {
        throw new Error("db offline");
      },
    },
  });
  const response = await callTask(
    request,
    {
      "payment-signature": createPaymentSignature({ adapter, request }),
    },
    {
      paymentAdapter: adapter,
    },
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, LIVE_PAYMENT_CODES.PAYMENT_STORE_ERROR);
  assert.doesNotMatch(JSON.stringify(response.body), /db offline/u);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("resource execution claim failure blocks AI and receipt", async () => {
  const request = liveRequest();
  const calls = createDownstreamCounters();
  const response = await callTask(request, {}, {
    paymentAdapter: {
      mode: "live",
      async verifyPayment() {
        return {
          ok: true,
          payment: {
            mode: "live",
            status: LIVE_PAYMENT_STATES.AUTHORIZED,
            reference: request.idempotencyKey,
          },
        };
      },
      async claimResourceExecution() {
        return {
          ok: false,
          code: LIVE_PAYMENT_CODES.PAYMENT_STORE_ERROR,
          reason: "Payment store operation failed.",
          statusCode: 503,
          state: LIVE_PAYMENT_STATES.BLOCKED,
        };
      },
    },
    ...calls.options,
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, LIVE_PAYMENT_CODES.PAYMENT_STORE_ERROR);
  assert.equal(calls.aiRun, 0);
  assert.equal(calls.receipt, 0);
});

function liveRequest(overrides = {}) {
  const mandateOverrides = overrides.mandate ?? {};
  const taskType = overrides.taskType ?? "summarize";
  return {
    taskType,
    input: overrides.input ?? "Live x402 safety test input.",
    scope: overrides.scope ?? taskType,
    counterparty: overrides.counterparty ?? PAY_TO,
    amount: overrides.amount ?? "0.01",
    currency: overrides.currency ?? "USDC",
    idempotencyKey: overrides.idempotencyKey ?? "task_live_000000000001",
    mandate: {
      mandateId: "mandate-live-test",
      maxSpendPerTask: "0.10",
      currency: "USDC",
      allowedCounterparties: [PAY_TO],
      expiresAt: "2026-08-25T12:00:00.000Z",
      allowedScopes: [taskType],
      ...mandateOverrides,
    },
  };
}

function liveEnv(overrides = {}) {
  return {
    X402_MODE: "live",
    X402_LIVE_CONFIRM: "true",
    X402_FACILITATOR_URL: CDP_X402_FACILITATOR_URL,
    CDP_API_KEY_ID: "test-cdp-key-id",
    CDP_API_KEY_SECRET: "test-cdp-key-secret",
    X402_PAYMENT_RECIPIENT: PAY_TO,
    X402_MAX_LIVE_PAYMENT_USDC: "0.10",
    X402_PAYMENT_ASSET: "USDC",
    X402_NETWORK: "base",
    BASE_MAINNET_RPC_URL: "https://mainnet.base.org",
    ...overrides,
  };
}

function createLiveAdapter({
  facilitator,
  env = liveEnv(),
  paymentStore,
  settlementVerifier = createSuccessfulSettlementVerifier(),
} = {}) {
  return new LivePaymentAdapter({
    env,
    facilitatorClient: facilitator ?? createMockFacilitator(),
    paymentStore: paymentStore ?? createTempPaymentStore(),
    settlementVerifier,
  });
}

function createTempPaymentStore() {
  const fixture = createStoreFixture();
  const store = createFixturePaymentStore(fixture);
  const originalClose = store.close.bind(store);
  let closed = false;
  store.close = () => {
    if (closed) {
      return;
    }
    closed = true;
    originalClose();
    fixture.cleanup();
  };
  return store;
}

function createFixturePaymentStore(fixture) {
  const store = new SqlitePaymentStore({
    path: fixture.path,
    now: () => new Date(NOW),
  });
  const originalClose = store.close.bind(store);
  let closed = false;
  store.close = () => {
    if (closed) {
      return;
    }
    closed = true;
    originalClose();
    openStores.delete(store);
  };
  openStores.add(store);
  return store;
}

function createStoreFixture() {
  const directory = mkdtempSync(join(tmpdir(), "base-agent-pay-store-"));
  return {
    path: join(directory, "payments.sqlite"),
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function persistPreparedSettlement({ adapter, paymentStore, request, state }) {
  const requestHash = sha256Hex(request);
  const prepared = adapter.preparePayment({
    request,
    requestHash,
    now: NOW,
    evaluateMandate,
  });

  assert.equal(prepared.ok, true);
  paymentStore.createPayment({
    idempotencyKey: prepared.idempotencyKey,
    taskId: prepared.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
    paymentFingerprint: prepared.paymentFingerprint,
    paymentId: prepared.idempotencyKey,
    mode: "live",
    network: "eip155:8453",
    asset: BASE_MAINNET_USDC.address,
    amountAtomic: prepared.requestedAtomicUnits.toString(),
    counterparty: PAY_TO,
    state,
    paymentRequirements: prepared.paymentRequirements,
    paymentRequired: prepared.paymentRequired,
    canRetry: state === LIVE_PAYMENT_STATES.FAILED,
    settlementAttempts: state === LIVE_PAYMENT_STATES.SETTLING ? 1 : 0,
  });
}

function createPaymentSignature({
  adapter,
  request,
  x402Version = 2,
  acceptedOverrides = {},
  authorizationOverrides = {},
  payloadOverrides = {},
} = {}) {
  const requestHash = sha256Hex(request);
  const paymentRequired = adapter.createPaymentRequired({
    request,
    requestHash,
    now: NOW,
    evaluateMandate,
  });
  const paymentRequirements = paymentRequired.accepts[0];

  return encodePaymentSignatureForTest({
    x402Version,
    resource: paymentRequired.resource,
    accepted: {
      ...paymentRequirements,
      ...acceptedOverrides,
      extra: {
        ...paymentRequirements.extra,
        ...acceptedOverrides.extra,
      },
    },
    payload: {
      signature: `0x${"b".repeat(130)}`,
      authorization: {
        from: PAYER,
        to: paymentRequirements.payTo,
        value: paymentRequirements.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"c".repeat(64)}`,
        ...authorizationOverrides,
      },
      ...payloadOverrides,
    },
  });
}

function createSuccessfulSettlementVerifier() {
  const verifier = async () => {
    verifier.calls += 1;
    return {
      ok: true,
    };
  };
  verifier.calls = 0;
  return verifier;
}

function createMockFacilitator({
  verifyResponses,
  verifyDelayMs = 0,
  settleResponses,
  settleError,
  statusResponses,
} = {}) {
  const calls = {
    verify: 0,
    settle: 0,
    status: 0,
  };
  return {
    calls,
    async verify() {
      if (verifyDelayMs > 0) {
        await delay(verifyDelayMs);
      }
      const response = verifyResponses?.[calls.verify] ?? {
        isValid: true,
        payer: PAYER,
      };
      calls.verify += 1;
      return response;
    },
    async settle() {
      calls.settle += 1;
      if (settleError) {
        throw settleError;
      }
      return (
        settleResponses?.[calls.settle - 1] ?? {
          success: true,
          payer: PAYER,
          transaction: TX_HASH,
          network: "eip155:8453",
          amount: "10000",
        }
      );
    },
    async getSettlementStatus() {
      const response =
        statusResponses?.[calls.status] ?? {
          success: false,
          errorReason: "settlement_pending",
          transaction: TX_HASH,
          network: "eip155:8453",
        };
      calls.status += 1;
      return response;
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createDownstreamCounters({ output = "Task complete." } = {}) {
  const counters = {
    aiRun: 0,
    receipt: 0,
    options: {
      aiProvider: {
        async run(request) {
          counters.aiRun += 1;
          return {
            provider: "mock",
            taskType: request.taskType,
            output,
            metadata: {
              inputCharacters: request.input.length,
              inputWords: request.input.split(/\s+/u).length,
            },
          };
        },
      },
      createReceiptPayload() {
        counters.receipt += 1;
        return {
          taskId: `0x${"d".repeat(64)}`,
          requestHash: `0x${"e".repeat(64)}`,
          resultHash: `0x${"f".repeat(64)}`,
          completedAt: NOW,
        };
      },
    },
  };

  return counters;
}

async function callTask(body, headers = {}, options = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  req.headers = {
    "content-type": "application/json",
    ...headers,
  };

  const chunks = [];
  const responseHeaders = new Map();
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      responseHeaders.set(name.toLowerCase(), value);
    },
    end(chunk) {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
    },
  };

  await handleTaskRequest(req, res, {
    now: NOW,
    mandateLogger: () => {},
    paymentLogger: () => {},
    ...options,
  });

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: res.statusCode,
    headers: responseHeaders,
    body: rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
  };
}

async function callTaskState(taskId, options = {}) {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = `/api/task?taskId=${encodeURIComponent(taskId)}`;
  req.headers = {};

  const chunks = [];
  const responseHeaders = new Map();
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      responseHeaders.set(name.toLowerCase(), value);
    },
    end(chunk) {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
    },
  };

  await handleTaskRequest(req, res, {
    now: NOW,
    mandateLogger: () => {},
    paymentLogger: () => {},
    ...options,
  });

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: res.statusCode,
    headers: responseHeaders,
    body: rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
  };
}
