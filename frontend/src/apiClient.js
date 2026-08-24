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

  return body;
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

async function readJson(response) {
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : {};
}
