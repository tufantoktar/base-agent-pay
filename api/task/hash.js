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
  const paymentAudit = createPaymentAudit(payment);
  const taskId = sha256Hex({
    completedAt,
    paymentAudit,
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

function createPaymentAudit(payment) {
  if (payment?.mode === "live") {
    return {
      mode: payment.mode,
      status: payment.status,
      paymentId: payment.paymentId,
      network: payment.network?.caip2,
      asset: payment.asset?.address,
      amount: payment.atomicAmount,
      currency: payment.currency,
      counterparty: payment.payee ?? payment.recipient,
      transactionHash: payment.transactionHash,
    };
  }

  return {
    mode: payment?.mode,
    reference: payment?.reference,
  };
}
