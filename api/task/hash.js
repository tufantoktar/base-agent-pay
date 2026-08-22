import { createHash } from "node:crypto";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function sha256Hex(value) {
  const input = typeof value === "string" ? value : stableStringify(value);
  return `0x${createHash("sha256").update(input).digest("hex")}`;
}

export function createTaskReceiptPayload({ request, result, payment, now }) {
  const completedAt = now ?? new Date().toISOString();
  const requestHash = sha256Hex(request);
  const resultHash = sha256Hex({
    provider: result.provider,
    taskType: result.taskType,
    output: result.output,
    metadata: result.metadata,
  });
  const taskId = sha256Hex({
    completedAt,
    paymentReference: payment.reference,
    requestHash,
    resultHash,
  });

  return {
    taskId,
    requestHash,
    resultHash,
    completedAt,
  };
}

