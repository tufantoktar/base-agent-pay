import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { MockAiProvider } from "./ai-provider.js";
import { handleTaskRequest } from "./handler.js";
import { createTaskReceiptPayload, sha256Hex } from "./hash.js";

const requestBody = {
  taskType: "summarize",
  input: "Pay an agent, get a deterministic local result, and prove the task later on Base Mainnet.",
};

test("unpaid request returns payment required", async () => {
  const response = await callTask(requestBody);

  assert.equal(response.statusCode, 402);
  assert.equal(response.body.code, "PAYMENT_REQUIRED");
  assert.equal(response.body.mode, "mock");
  assert.equal(response.body.network.chainId, 8453);
  assert.ok(response.body.mockPaymentHeader.startsWith("mock."));
});

test("valid mock payment allows task", async () => {
  const challenge = await callTask(requestBody);
  const paid = await callTask(requestBody, {
    "x-payment": challenge.body.mockPaymentHeader,
  });

  assert.equal(paid.statusCode, 200);
  assert.equal(paid.body.status, "complete");
  assert.equal(paid.body.payment.verified, true);
  assert.equal(paid.body.result.provider, "mock");
});

test("invalid payment is rejected", async () => {
  const response = await callTask(requestBody, {
    "x-payment": "mock.invalid.header",
  });

  assert.equal(response.statusCode, 402);
  assert.equal(response.body.code, "PAYMENT_REQUIRED");
  assert.match(response.body.reason, /invalid/i);
});

test("mock AI provider is deterministic", async () => {
  const provider = new MockAiProvider();
  const first = await provider.run(requestBody);
  const second = await provider.run(requestBody);

  assert.deepEqual(first, second);
});

test("taskId generation is deterministic for fixed inputs", () => {
  const result = {
    provider: "mock",
    taskType: "summarize",
    output: "A fixed output.",
    metadata: { inputCharacters: 10, inputWords: 2 },
  };
  const payment = { reference: "0xabc" };
  const first = createTaskReceiptPayload({
    request: requestBody,
    result,
    payment,
    now: "2026-08-22T00:00:00.000Z",
  });
  const second = createTaskReceiptPayload({
    request: requestBody,
    result,
    payment,
    now: "2026-08-22T00:00:00.000Z",
  });

  assert.equal(first.taskId, second.taskId);
  assert.match(first.taskId, /^0x[0-9a-f]{64}$/u);
});

test("request and result hashes are bytes32 hex strings", () => {
  const result = {
    provider: "mock",
    taskType: "classify",
    output: "Classification: technical.",
    metadata: { inputCharacters: 16, inputWords: 2 },
  };
  const payload = createTaskReceiptPayload({
    request: { taskType: "classify", input: "contract task" },
    result,
    payment: { reference: "0xdef" },
    now: "2026-08-22T00:00:00.000Z",
  });

  assert.match(payload.requestHash, /^0x[0-9a-f]{64}$/u);
  assert.match(payload.resultHash, /^0x[0-9a-f]{64}$/u);
  assert.equal(
    payload.requestHash,
    sha256Hex({ taskType: "classify", input: "contract task" }),
  );
});

async function callTask(body, headers = {}) {
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
    now: "2026-08-22T00:00:00.000Z",
  });

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: res.statusCode,
    headers: responseHeaders,
    body: rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
  };
}
