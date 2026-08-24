import { MockAiProvider, normalizeInput, normalizeTaskType } from "./ai-provider.js";
import { PAYMENT_RESPONSE_HEADER } from "./constants.js";
import { createTaskReceiptPayload, sha256Hex } from "./hash.js";
import { evaluateMandate, MANDATE_CODES } from "./mandate.js";
import { getPaymentAdapter } from "./payment-adapter.js";

export async function handleTaskRequest(req, res, options = {}) {
  applyCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      error: "Method Not Allowed",
      code: "METHOD_NOT_ALLOWED",
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, {
      error: "Invalid JSON",
      code: "INVALID_JSON",
    });
  }

  let request;
  try {
    request = normalizeTaskRequest(body);
  } catch (error) {
    return sendJson(res, 400, {
      error: "Invalid task request",
      code: "INVALID_TASK_REQUEST",
      message: error.message,
    });
  }

  const mandateDecision = evaluateRequestMandate({
    evaluator: options.evaluateMandate ?? evaluateMandate,
    request,
    mandate: request.mandate,
    now: options.now,
  });
  logMandateEvents(options.mandateLogger ?? console.info, mandateDecision, request);

  if (!mandateDecision.allowed) {
    return sendJson(res, 403, {
      ok: false,
      error: mandateDecision.code,
      message: mandateDecision.reason,
      mandateDecision,
    });
  }

  const requestHash = sha256Hex(request);
  const paymentAdapter = options.paymentAdapter ?? getPaymentAdapter();
  const verification = paymentAdapter.verifyPayment({
    headers: req.headers ?? {},
    requestHash,
  });

  if (!verification.ok) {
    const paymentRequired = paymentAdapter.createPaymentRequired({ requestHash });
    return sendJson(
      res,
      402,
      {
        ...paymentRequired,
        reason: verification.reason,
      },
      {
        [PAYMENT_RESPONSE_HEADER]: JSON.stringify({
          mode: "mock",
          verified: false,
          code: verification.code,
        }),
      },
    );
  }

  const aiProvider = options.aiProvider ?? new MockAiProvider();
  const result = await aiProvider.run(request);
  const createReceiptPayload = options.createReceiptPayload ?? createTaskReceiptPayload;
  const receipt = createReceiptPayload({
    request,
    result,
    payment: verification.payment,
    now: options.now,
  });

  return sendJson(
    res,
    200,
    {
      status: "complete",
      mode: "mock",
      taskId: receipt.taskId,
      requestHash: receipt.requestHash,
      resultHash: receipt.resultHash,
      completedAt: receipt.completedAt,
      result,
      payment: {
        mode: verification.payment.mode,
        scheme: verification.payment.scheme,
        verified: true,
        network: verification.payment.network,
        amount: verification.payment.amount,
        asset: verification.payment.asset,
        recipient: verification.payment.recipient,
        reference: verification.payment.reference,
      },
      receipt: {
        registry: "AgentTaskReceipt",
        onchain: false,
        message:
          "No blockchain transaction was sent. Use the receipt contract later to record this taskId/requestHash/resultHash.",
      },
    },
    {
      [PAYMENT_RESPONSE_HEADER]: JSON.stringify({
        mode: "mock",
        verified: true,
        paymentReference: verification.payment.reference,
      }),
    },
  );
}

export function normalizeTaskRequest(body) {
  const taskType = normalizeTaskType(body?.taskType);
  const input = normalizeInput(body?.input);
  const scope = normalizePolicyText(body?.scope);
  const counterparty = normalizePolicyText(body?.counterparty);
  const amount = normalizePolicyText(body?.amount);
  const currency = normalizePolicyText(body?.currency);

  if (input.length < 1) {
    throw new Error("Task input is required.");
  }

  if (input.length > 2000) {
    throw new Error("Task input must be 2,000 characters or less.");
  }

  return {
    taskType,
    input,
    scope,
    counterparty,
    amount,
    currency,
    mandate: body?.mandate,
  };
}

function evaluateRequestMandate({ evaluator, request, mandate, now }) {
  try {
    const decision = evaluator({ request, mandate, now });
    if (
      !decision ||
      typeof decision.allowed !== "boolean" ||
      typeof decision.code !== "string"
    ) {
      return {
        allowed: false,
        code: MANDATE_CODES.INTERNAL_ERROR,
        reason: "Mandate evaluation returned an unknown policy state.",
      };
    }
    return decision;
  } catch {
    return {
      allowed: false,
      code: MANDATE_CODES.INTERNAL_ERROR,
      reason: "Mandate evaluation failed closed.",
    };
  }
}

function logMandateEvents(logger, decision, request) {
  if (typeof logger !== "function") {
    return;
  }

  const event = {
    mandateId:
      typeof request?.mandate?.mandateId === "string"
        ? request.mandate.mandateId.trim()
        : "",
    scope: request?.scope ?? "",
    counterparty: request?.counterparty ?? "",
    requestedAmount:
      request?.amount && request?.currency
        ? `${request.amount} ${request.currency}`
        : request?.amount ?? "",
    decisionCode: decision.code,
  };

  try {
    logger({ event: "mandate_evaluated", ...event });
    logger({
      event: decision.allowed ? "mandate_allowed" : "mandate_denied",
      ...event,
    });
  } catch {
    // Mandate logging is best-effort and must not affect policy enforcement.
  }
}

function normalizePolicyText(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function readJsonBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      return req.body.length === 0 ? {} : JSON.parse(req.body);
    }
    return req.body;
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }

  return raw.length === 0 ? {} : JSON.parse(raw);
}

function applyCorsHeaders(res) {
  setHeader(res, "Access-Control-Allow-Origin", "*");
  setHeader(res, "Access-Control-Allow-Methods", "POST, OPTIONS");
  setHeader(res, "Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  setHeader(res, "Access-Control-Expose-Headers", PAYMENT_RESPONSE_HEADER);
}

function sendJson(res, statusCode, payload, headers = {}) {
  for (const [name, value] of Object.entries(headers)) {
    setHeader(res, name, value);
  }

  setHeader(res, "Content-Type", "application/json; charset=utf-8");

  if (typeof res.status === "function" && typeof res.json === "function") {
    return res.status(statusCode).json(payload);
  }

  res.statusCode = statusCode;
  if (statusCode === 204) {
    return res.end();
  }

  return res.end(JSON.stringify(payload, null, 2));
}

function setHeader(res, name, value) {
  if (typeof res.setHeader === "function") {
    res.setHeader(name, value);
  }
}
