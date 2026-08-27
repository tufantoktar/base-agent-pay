import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { validateDiscoveryExtension } from "@x402/extensions/bazaar";

import {
  TASK_RESOURCE_DESCRIPTION,
  TASK_RESOURCE_METHOD,
  TASK_RESOURCE_PATH,
  createTaskBazaarDiscoveryExtensions,
} from "./bazaar-discovery.js";
import { BASE_NETWORK } from "./constants.js";
import { handleTaskRequest } from "./handler.js";
import { MANDATE_CODES } from "./mandate.js";

const SAFE_REQUEST = {
  taskType: "summarize",
  input: "Summarize the x402 Bazaar discovery metadata.",
  scope: "summarize",
  counterparty: "base-agent-pay",
  amount: "0.01",
  currency: "USDC",
  mandate: {
    mandateId: "mandate-bazaar-test",
    maxSpendPerTask: "0.10",
    currency: "USDC",
    allowedCounterparties: ["base-agent-pay"],
    expiresAt: "2026-08-25T12:00:00.000Z",
    allowedScopes: ["summarize"],
  },
};

const SENSITIVE_PATTERNS = [
  /CDP_API_KEY_SECRET/u,
  /CDP_API_KEY_ID/u,
  /PAYMENT_DATABASE_URL/u,
  /authorization/i,
  /PAYMENT-SIGNATURE/u,
  /privateKey/u,
  /seed/i,
  /JWT/u,
];

test("Bazaar discovery declaration validates with official x402 extension helper", () => {
  const extensions = createTaskBazaarDiscoveryExtensions();
  const validation = validateDiscoveryExtension(extensions.bazaar);

  assert.equal(validation.valid, true, validation.errors?.join(", "));
  assert.equal(extensions.bazaar.info.input.type, "http");
  assert.equal(extensions.bazaar.info.input.method, TASK_RESOURCE_METHOD);
  assert.equal(extensions.bazaar.info.input.bodyType, "json");
  assert.equal(extensions.bazaar.info.input.body.scope, "summarize");
});

test("unpaid mock task request returns Bazaar-compatible PaymentRequired metadata", async () => {
  const response = await callTask(SAFE_REQUEST);
  const bazaar = response.body.extensions?.bazaar;
  const requirement = response.body.accepts[0];
  const serializedExtension = JSON.stringify(bazaar);

  assert.equal(response.statusCode, 402);
  assert.equal(response.body.code, "PAYMENT_REQUIRED");
  assert.equal(response.body.mode, "mock");
  assert.ok(bazaar);
  assert.equal(response.body.resource?.url, TASK_RESOURCE_PATH);
  assert.equal(response.body.resource?.description, TASK_RESOURCE_DESCRIPTION);
  assert.equal(bazaar.info.input.method, TASK_RESOURCE_METHOD);
  assert.equal(bazaar.info.input.type, "http");
  assert.equal(bazaar.info.input.bodyType, "json");
  assert.equal(bazaar.info.input.body.taskType, "summarize");
  assert.equal(bazaar.info.input.body.scope, "summarize");
  assert.equal(
    bazaar.schema.properties.input.properties.body.properties.taskType.enum.includes(
      "structured-answer",
    ),
    true,
  );
  assert.deepEqual(
    bazaar.schema.properties.input.properties.body.properties.scope.enum,
    ["summarize", "rewrite", "classify", "structured-answer"],
  );
  assert.equal(
    bazaar.schema.properties.input.properties.body.required.includes("scope"),
    true,
  );
  assert.equal(
    bazaar.schema.properties.input.properties.body.additionalProperties,
    false,
  );
  assert.equal(bazaar.info.output.type, "json");
  assert.equal(bazaar.info.output.example.payment.status, "SETTLED");
  assert.equal(bazaar.schema.properties.output.properties.example.type, "object");

  assert.equal(requirement.mode, "mock");
  assert.equal(requirement.scheme, "mock-x402");
  assert.equal(requirement.network.chainId, BASE_NETWORK.chainId);
  assert.equal(requirement.resource, TASK_RESOURCE_PATH);
  assert.ok(response.body.mockPaymentHeader.startsWith("mock."));

  for (const pattern of SENSITIVE_PATTERNS) {
    assert.doesNotMatch(serializedExtension, pattern);
  }
});

test("advertised Bazaar example request reaches payment challenge with scope", async () => {
  const extensions = createTaskBazaarDiscoveryExtensions();
  const exampleRequest = extensions.bazaar.info.input.body;
  const response = await callTask(exampleRequest);

  assert.equal(response.statusCode, 402);
  assert.equal(response.body.code, "PAYMENT_REQUIRED");
  assert.notEqual(response.body.error, MANDATE_CODES.SCOPE_NOT_ALLOWED);
});

test("Bazaar task resource description is truthful and non-listing language", () => {
  assert.equal(
    TASK_RESOURCE_DESCRIPTION,
    "Policy-controlled AI task execution paid via x402 on Base.",
  );
  assert.doesNotMatch(TASK_RESOURCE_DESCRIPTION, /listed on bazaar/i);
});

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
    now: "2026-08-22T00:00:00.000Z",
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
