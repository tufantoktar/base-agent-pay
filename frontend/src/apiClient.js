import { API_URL } from "./config.js";

export async function requestPaymentRequirement(task) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(task),
  });
  const body = await readJson(response);

  if (response.status !== 402) {
    throw new Error(body?.message ?? body?.error ?? "Expected payment requirement.");
  }

  return {
    ...body,
    paymentRequiredHeader: response.headers.get("PAYMENT-REQUIRED") ?? "",
  };
}

export async function submitMockPaidTask(task, paymentHeader) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": paymentHeader,
    },
    body: JSON.stringify(task),
  });
  const body = await readJson(response);

  if (!response.ok) {
    throw new Error(body?.reason ?? body?.message ?? "Task request failed.");
  }

  return body;
}

export async function submitLivePaidTask(task, paymentSignatureHeaders) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...paymentSignatureHeaders,
    },
    body: JSON.stringify(task),
  });
  const body = await readJson(response);

  if (!response.ok) {
    throw createApiError(
      body?.reason ?? body?.message ?? "Live task request failed.",
      response,
      body,
    );
  }

  return body;
}

export async function fetchPaymentState({ taskId, paymentId, idempotencyKey }) {
  const url = new URL(API_URL, window.location.origin);
  if (taskId) {
    url.searchParams.set("taskId", taskId);
  }
  if (paymentId) {
    url.searchParams.set("paymentId", paymentId);
  }
  if (idempotencyKey) {
    url.searchParams.set("idempotencyKey", idempotencyKey);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
  });
  const body = await readJson(response);

  if (!response.ok) {
    throw createApiError(
      body?.message ?? body?.error ?? "Payment state lookup failed.",
      response,
      body,
    );
  }

  return body.payment;
}

async function readJson(response) {
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : {};
}

function createApiError(message, response, body) {
  const error = new Error(message);
  error.status = response.status;
  error.body = body;
  return error;
}

export function createTaskIdempotencyKey({
  prefix = "task",
  now = Date.now,
  randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
} = {}) {
  const entropy =
    typeof randomUUID === "function"
      ? randomUUID().replaceAll("-", "")
      : Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);

  return `${prefix}_${now().toString(36)}_${entropy.slice(0, 32)}`;
}
