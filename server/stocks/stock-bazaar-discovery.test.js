import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { validateDiscoveryExtension } from "@x402/extensions/bazaar";

import {
  STOCK_RESOURCE_DESCRIPTION,
  STOCK_RESOURCE_METHOD,
  STOCK_RESOURCE_PATH,
  createStockBazaarDiscoveryExtensions,
} from "./stock-bazaar-discovery.js";
import { handleStockAnalysisRequest } from "./stock-analysis-handler.js";

const SENSITIVE_PATTERNS = [
  /CDP_API_KEY_SECRET/u,
  /CDP_API_KEY_ID/u,
  /PAYMENT_DATABASE_URL/u,
  /PAYMENT-SIGNATURE/u,
  /authorization payload/i,
  /authorization/i,
  /privateKey/u,
  /seed phrase/i,
  /wallet secret/i,
  /contractAddress/u,
];

test("stock Bazaar discovery declaration validates with official helper", () => {
  const extensions = createStockBazaarDiscoveryExtensions();
  const validation = validateDiscoveryExtension(extensions.bazaar);
  const bodySchema = extensions.bazaar.schema.properties.input.properties.body;
  const outputSchema = extensions.bazaar.schema.properties.output.properties.example;
  const mandateSchema = bodySchema.properties.mandate;

  assert.equal(validation.valid, true, validation.errors?.join(", "));
  assert.equal(extensions.bazaar.info.input.type, "http");
  assert.equal(extensions.bazaar.info.input.method, STOCK_RESOURCE_METHOD);
  assert.equal(extensions.bazaar.info.input.bodyType, "json");
  assert.equal(extensions.bazaar.info.input.body.scope, "stock-analysis");
  assert.equal(extensions.bazaar.info.output.example.payment.status, "VERIFIED");
  assert.notEqual(extensions.bazaar.info.output.example.payment.status, "SETTLED");
  assert.match(
    extensions.bazaar.info.output.example.audit.auditId,
    /^[0-9a-f-]{36}$/iu,
  );
  assert.match(
    extensions.bazaar.info.output.example.audit.requestId,
    /^[0-9a-f-]{36}$/iu,
  );
  assert.match(
    extensions.bazaar.info.output.example.audit.resultHash,
    /^sha256:[a-f0-9]{64}$/u,
  );
  for (const variant of outputSchema.anyOf) {
    assert.equal(variant.required.includes("audit"), true);
    assert.deepEqual(variant.properties.audit.required, [
      "auditId",
      "requestId",
      "resultHash",
    ]);
    assert.equal(
      variant.properties.audit.properties.resultHash.pattern,
      "^sha256:[a-f0-9]{64}$",
    );
  }
  assert.deepEqual(bodySchema.properties.symbol.enum, [
    "AAPLc",
    "NVDAc",
    "METAc",
    "GOOGLc",
  ]);
  assert.deepEqual(bodySchema.properties.analysisType.enum, [
    "snapshot",
    "risk-check",
  ]);
  assert.equal(bodySchema.properties.scope.const, "stock-analysis");
  assert.equal(bodySchema.required.includes("scope"), true);
  assert.equal(bodySchema.additionalProperties, false);
  assert.deepEqual(Object.keys(mandateSchema.properties).sort(), [
    "allowedAnalysisTypes",
    "allowedAssets",
    "allowedCounterparties",
    "allowedScopes",
    "currency",
    "expiresAt",
    "mandateId",
    "maxSpendPerTask",
  ]);
  assert.deepEqual(mandateSchema.required, [
    "mandateId",
    "allowedAssets",
    "allowedAnalysisTypes",
    "allowedScopes",
    "expiresAt",
  ]);
  assert.equal(mandateSchema.additionalProperties, false);
  assert.deepEqual(mandateSchema.properties.allowedAssets.items.enum, [
    "AAPLc",
    "NVDAc",
    "METAc",
    "GOOGLc",
  ]);
  assert.deepEqual(mandateSchema.properties.allowedAnalysisTypes.items.enum, [
    "snapshot",
    "risk-check",
  ]);
  assert.equal(mandateSchema.properties.allowedScopes.items.const, "stock-analysis");
});

test("stock Bazaar metadata stays free of secrets and trading language", () => {
  const serialized = JSON.stringify(createStockBazaarDiscoveryExtensions());

  for (const pattern of SENSITIVE_PATTERNS) {
    assert.doesNotMatch(serialized, pattern);
  }

  for (const unsafe of [
    /price target/i,
    /\bbuy\b/i,
    /\bsell\b/i,
    /\breturns?\b/i,
    /market cap/i,
    /portfolio execution/i,
    /trade capability/i,
    /listed on bazaar/i,
  ]) {
    assert.doesNotMatch(serialized, unsafe);
  }
});

test("unpaid stock request returns Bazaar-compatible payment metadata", async () => {
  const extensions = createStockBazaarDiscoveryExtensions();
  const response = await callStockAnalysis(extensions.bazaar.info.input.body);
  const bazaar = response.body.extensions?.bazaar;

  assert.equal(response.statusCode, 402);
  assert.equal(response.body.code, "PAYMENT_REQUIRED");
  assert.equal(response.body.resource.url, STOCK_RESOURCE_PATH);
  assert.equal(response.body.resource.description, STOCK_RESOURCE_DESCRIPTION);
  assert.equal(response.body.accepts[0].resource, STOCK_RESOURCE_PATH);
  assert.equal(response.body.accepts[0].network.caip2, "eip155:8453");
  assert.equal(response.body.accepts[0].amount, "0.01");
  assert.equal(response.body.accepts[0].currency, "USDC");
  assert.equal(response.body.accepts[0].asset.symbol, "USDC");
  assert.ok(response.body.mockPaymentHeader.startsWith("mock."));
  assert.ok(bazaar);
  assert.equal(bazaar.info.input.method, STOCK_RESOURCE_METHOD);
  assert.equal(bazaar.info.input.body.scope, "stock-analysis");
});

async function callStockAnalysis(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  req.headers = {
    "content-type": "application/json",
  };

  const chunks = [];
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk) {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
    },
  };

  await handleStockAnalysisRequest(req, res, {
    clock: () => new Date("2026-08-27T12:00:00.000Z"),
    env: { X402_MODE: "mock" },
    dataAdapter: {
      async getStockSnapshot() {
        throw new Error("Stock data adapter must not run before payment.");
      },
    },
  });

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: res.statusCode,
    body: JSON.parse(rawBody),
  };
}
