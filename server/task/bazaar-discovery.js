import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

export const TASK_RESOURCE_PATH = "/api/task";
export const TASK_RESOURCE_METHOD = "POST";
export const TASK_RESOURCE_DESCRIPTION =
  "Policy-controlled AI task execution paid via x402 on Base.";

const TASK_TYPES = Object.freeze([
  "summarize",
  "rewrite",
  "classify",
  "structured-answer",
]);

const TASK_INPUT_EXAMPLE = Object.freeze({
  taskType: "summarize",
  input: "Summarize this Base payment workflow.",
  scope: "summarize",
  counterparty: "base-agent-pay",
  amount: "0.01",
  currency: "USDC",
  idempotencyKey: "task_example_0123456789abcdef",
  mandate: {
    mandateId: "mandate-example",
    maxSpendPerTask: "0.10",
    currency: "USDC",
    allowedCounterparties: ["base-agent-pay"],
    expiresAt: "2026-12-31T23:59:59.000Z",
    allowedScopes: ["summarize"],
  },
});

const TASK_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    taskType: {
      type: "string",
      enum: TASK_TYPES,
      description: "Requested AI task type.",
    },
    input: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
      description: "Text input for the AI task.",
    },
    scope: {
      type: "string",
      enum: TASK_TYPES,
      description: "Mandate scope for the requested task.",
    },
    counterparty: {
      type: "string",
      description: "Requested service counterparty.",
    },
    amount: {
      type: "string",
      pattern: "^[0-9]+(\\.[0-9]{1,6})?$",
      description: "Requested USDC amount as a decimal string.",
    },
    currency: {
      type: "string",
      const: "USDC",
    },
    idempotencyKey: {
      type: "string",
      minLength: 16,
      maxLength: 128,
      description: "Client-generated key for live payment idempotency.",
    },
    mandate: {
      type: "object",
      additionalProperties: false,
      properties: {
        mandateId: { type: "string" },
        maxSpendPerTask: {
          type: "string",
          pattern: "^[0-9]+(\\.[0-9]{1,6})?$",
        },
        currency: {
          type: "string",
          const: "USDC",
        },
        allowedCounterparties: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        expiresAt: {
          type: "string",
          description: "UTC ISO-8601 mandate expiry timestamp.",
        },
        allowedScopes: {
          type: "array",
          items: { type: "string", enum: TASK_TYPES },
          minItems: 1,
        },
      },
      required: [
        "mandateId",
        "maxSpendPerTask",
        "currency",
        "allowedCounterparties",
        "expiresAt",
        "allowedScopes",
      ],
    },
  },
  required: [
    "taskType",
    "input",
    "scope",
    "counterparty",
    "amount",
    "currency",
    "idempotencyKey",
    "mandate",
  ],
  additionalProperties: false,
});

const TASK_OUTPUT_EXAMPLE = Object.freeze({
  taskId: "0x0000000000000000000000000000000000000000000000000000000000000000",
  result: {
    provider: "mock",
    mode: "deterministic",
    taskType: "summarize",
    output: "Summary text.",
  },
  requestHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
  resultHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
  payment: {
    mode: "live",
    network: "eip155:8453",
    asset: "USDC",
    status: "SETTLED",
  },
});

const TASK_OUTPUT_SCHEMA = Object.freeze({
  properties: {
    taskId: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
    result: { type: "object" },
    requestHash: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
    resultHash: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
    payment: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["mock", "live"] },
        network: { type: "string" },
        asset: { type: "string" },
        status: { type: "string" },
      },
    },
  },
});

export function createTaskBazaarDiscoveryExtensions() {
  return declareDiscoveryExtension({
    method: TASK_RESOURCE_METHOD,
    bodyType: "json",
    input: TASK_INPUT_EXAMPLE,
    inputSchema: TASK_INPUT_SCHEMA,
    output: {
      example: TASK_OUTPUT_EXAMPLE,
      schema: TASK_OUTPUT_SCHEMA,
    },
  });
}
