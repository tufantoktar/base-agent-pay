import { MockAiProvider, normalizeInput, normalizeTaskType } from "./ai-provider.js";
import {
  PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
} from "./constants.js";
import { createTaskReceiptPayload, sha256Hex } from "./hash.js";
import { evaluateMandate, MANDATE_CODES } from "./mandate.js";
import { getPaymentAdapter } from "./payment-adapter.js";

export async function handleTaskRequest(req, res, options = {}) {
  applyCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  if (req.method === "GET") {
    return handlePaymentStateRequest(req, res, options);
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
  const verification = await paymentAdapter.verifyPayment({
    headers: req.headers ?? {},
    request,
    requestHash,
    now: options.now,
    evaluateMandate: options.evaluateMandate ?? evaluateMandate,
    logger: options.paymentLogger ?? console.info,
  });

  if (!verification.ok) {
    const paymentRequired =
      verification.paymentRequired ??
      createPaymentFailurePayload({
        paymentAdapter,
        request,
        requestHash,
        verification,
        now: options.now,
        evaluateMandate: options.evaluateMandate ?? evaluateMandate,
      });
    return sendJson(
      res,
      verification.statusCode ?? 402,
      {
        ...paymentRequired,
        reason: verification.reason,
      },
      createUnverifiedPaymentHeaders({ paymentAdapter, paymentRequired, verification }),
    );
  }

  let cachedTaskResponse = verification.cachedTaskResponse;
  if (!cachedTaskResponse) {
    cachedTaskResponse = await paymentAdapter.getCachedTaskResponse?.({
      request,
      requestHash,
      payment: verification.payment,
    });
  }
  if (cachedTaskResponse) {
    return sendJson(
      res,
      cachedTaskResponse.statusCode ?? 200,
      cachedTaskResponse.payload,
      cachedTaskResponse.headers ?? verification.responseHeaders ?? {},
    );
  }

  const resourceClaim = await paymentAdapter.claimResourceExecution?.({
    request,
    requestHash,
    payment: verification.payment,
    logger: options.paymentLogger ?? console.info,
  });
  if (resourceClaim && !resourceClaim.ok) {
    return sendJson(
      res,
      resourceClaim.statusCode ?? 409,
      {
        ok: false,
        error: resourceClaim.code,
        code: resourceClaim.code,
        message: resourceClaim.reason,
        mode: paymentAdapter.mode,
        status: resourceClaim.state,
      },
      resourceClaim.responseHeaders ?? verification.responseHeaders ?? {},
    );
  }

  if (resourceClaim?.ok && resourceClaim.payment) {
    verification.payment = resourceClaim.payment;
  }

  const aiProvider = options.aiProvider ?? new MockAiProvider();
  let result;
  try {
    result = await aiProvider.run(request);
  } catch (aiError) {
    await paymentAdapter.markResourceFailed?.({
      request,
      payment: verification.payment,
      error: aiError,
      logger: options.paymentLogger ?? console.info,
    });
    return sendJson(
      res,
      500,
      {
        ok: false,
        error: "AI_TASK_FAILED",
        message:
          "The task failed after payment verification. No success receipt payload was created.",
        payment: createPaymentResponse(verification.payment),
        receipt: {
          eligible: false,
          onchain: false,
        },
      },
      verification.responseHeaders ?? {},
    );
  }

  const resultValidation = validateTaskResult({ result, request });
  if (!resultValidation.ok) {
    await paymentAdapter.markResourceFailed?.({
      request,
      payment: verification.payment,
      error: new Error(resultValidation.reason),
      logger: options.paymentLogger ?? console.info,
    });
    return sendJson(
      res,
      500,
      {
        ok: false,
        error: "AI_TASK_FAILED",
        message:
          "The task returned an invalid result after payment verification. No settlement or receipt payload was created.",
        payment: createPaymentResponse(verification.payment),
        receipt: {
          eligible: false,
          onchain: false,
        },
      },
      verification.responseHeaders ?? {},
    );
  }

  const settlement = await paymentAdapter.settleAfterResource?.({
    request,
    requestHash,
    verification,
    result,
    now: options.now,
    evaluateMandate: options.evaluateMandate ?? evaluateMandate,
    logger: options.paymentLogger ?? console.info,
  });
  if (settlement && !settlement.ok) {
    return sendJson(
      res,
      settlement.statusCode ?? 409,
      {
        ok: false,
        error: settlement.code,
        code: settlement.code,
        message: settlement.reason,
        mode: paymentAdapter.mode,
        status: settlement.state,
        payment: createPaymentResponse(verification.payment),
        receipt: {
          eligible: false,
          onchain: false,
        },
      },
      settlement.responseHeaders ?? verification.responseHeaders ?? {},
    );
  }

  if (settlement?.ok) {
    verification.payment = settlement.payment;
    verification.responseHeaders =
      settlement.responseHeaders ?? verification.responseHeaders;
  }

  const createReceiptPayload = options.createReceiptPayload ?? createTaskReceiptPayload;
  const receipt = createReceiptPayload({
    request,
    result,
    payment: verification.payment,
    now: options.now,
  });
  const responseHeaders = createVerifiedPaymentHeaders({ verification });
  const responsePayload = {
    status: "complete",
    mode: verification.payment.mode,
    taskId: receipt.taskId,
    requestHash: receipt.requestHash,
    resultHash: receipt.resultHash,
    completedAt: receipt.completedAt,
    result,
    payment: createPaymentResponse(verification.payment),
    receipt: {
      registry: "AgentTaskReceipt",
      onchain: false,
      eligible: true,
      message:
        "No blockchain receipt transaction was sent by the API. Use the receipt contract later to record this taskId/requestHash/resultHash.",
    },
  };
  await paymentAdapter.storeCompletedTaskResponse?.({
    request,
    requestHash,
    payment: verification.payment,
    responsePayload,
    responseHeaders,
  });

  return sendJson(res, 200, responsePayload, responseHeaders);
}

async function handlePaymentStateRequest(req, res, options = {}) {
  const lookup = readPaymentStateLookup(req);
  if (!lookup.taskId && !lookup.paymentId && !lookup.idempotencyKey) {
    return sendJson(res, 400, {
      ok: false,
      error: "PAYMENT_STATE_LOOKUP_REQUIRED",
      code: "PAYMENT_STATE_LOOKUP_REQUIRED",
      message: "Provide taskId, paymentId, or idempotencyKey.",
    });
  }

  const paymentAdapter = options.paymentAdapter ?? getPaymentAdapter();
  if (typeof paymentAdapter.getPaymentState !== "function") {
    return sendJson(res, 404, {
      ok: false,
      error: "PAYMENT_STATE_UNAVAILABLE",
      code: "PAYMENT_STATE_UNAVAILABLE",
      message: "Durable live payment state is unavailable for this payment mode.",
    });
  }

  const result = await paymentAdapter.getPaymentState(lookup);
  if (!result.ok) {
    return sendJson(res, result.statusCode ?? 404, {
      ok: false,
      error: result.code,
      code: result.code,
      message: result.reason,
    });
  }

  return sendJson(res, 200, {
    ok: true,
    payment: result.paymentState,
  });
}

export function normalizeTaskRequest(body) {
  const taskType = normalizeTaskType(body?.taskType);
  const input = normalizeInput(body?.input);
  const scope = normalizePolicyText(body?.scope);
  const counterparty = normalizePolicyText(body?.counterparty);
  const amount = normalizePolicyText(body?.amount);
  const currency = normalizePolicyText(body?.currency);
  const idempotencyKey = normalizePolicyText(body?.idempotencyKey);

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
    ...(idempotencyKey ? { idempotencyKey } : {}),
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

function validateTaskResult({ result, request }) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, reason: "AI task result must be an object." };
  }

  if (typeof result.provider !== "string" || result.provider.trim().length === 0) {
    return { ok: false, reason: "AI task result provider is invalid." };
  }

  if (result.taskType !== request.taskType) {
    return { ok: false, reason: "AI task result type does not match the request." };
  }

  if (typeof result.output !== "string") {
    return { ok: false, reason: "AI task result output is invalid." };
  }

  if (
    result.metadata !== undefined &&
    (!result.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata))
  ) {
    return { ok: false, reason: "AI task result metadata is invalid." };
  }

  return { ok: true };
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

function readPaymentStateLookup(req) {
  const query = req.query && typeof req.query === "object" ? req.query : {};
  const url = parseRequestUrl(req.url);

  return {
    taskId: normalizePolicyText(query.taskId ?? url.searchParams.get("taskId")),
    paymentId: normalizePolicyText(query.paymentId ?? url.searchParams.get("paymentId")),
    idempotencyKey: normalizePolicyText(
      query.idempotencyKey ?? url.searchParams.get("idempotencyKey"),
    ),
  };
}

function parseRequestUrl(value) {
  try {
    return new URL(value ?? "", "http://127.0.0.1");
  } catch {
    return new URL("http://127.0.0.1");
  }
}

function createUnverifiedPaymentHeaders({ paymentAdapter, paymentRequired, verification }) {
  if (verification.responseHeaders) {
    return verification.responseHeaders;
  }

  return {
    [PAYMENT_RESPONSE_HEADER]: JSON.stringify({
      mode: paymentRequired?.mode ?? paymentAdapter.mode,
      verified: false,
      code: verification.code,
    }),
  };
}

function createPaymentFailurePayload({
  paymentAdapter,
  request,
  requestHash,
  verification,
  now,
  evaluateMandate,
}) {
  if (paymentAdapter.mode === "mock" || verification.code === "PAYMENT_REQUIRED") {
    return paymentAdapter.createPaymentRequired({
      request,
      requestHash,
      now,
      evaluateMandate,
    });
  }

  return {
    ok: false,
    error: verification.code,
    code: verification.code,
    message: verification.reason,
    mode: paymentAdapter.mode,
    status: verification.state,
  };
}

function createVerifiedPaymentHeaders({ verification }) {
  if (verification.responseHeaders) {
    return verification.responseHeaders;
  }

  return {
    [PAYMENT_RESPONSE_HEADER]: JSON.stringify({
      mode: verification.payment.mode,
      verified: true,
      paymentReference: verification.payment.reference,
    }),
  };
}

function createPaymentResponse(payment) {
  if (payment?.mode === "live") {
    return {
      mode: "live",
      scheme: payment.scheme,
      verified: true,
      settled: payment.status === "SETTLED",
      status: payment.status,
      settlementStatus: payment.settlementStatus,
      network: payment.network,
      amount: payment.amount,
      atomicAmount: payment.atomicAmount,
      currency: payment.currency,
      asset: payment.asset,
      recipient: payment.recipient,
      payee: payment.payee,
      payer: payment.payer,
      paymentId: payment.paymentId,
      idempotencyKey: payment.idempotencyKey,
      transactionHash: payment.transactionHash,
      reference: payment.reference,
      settledAt: payment.settledAt,
    };
  }

  return {
    mode: payment.mode,
    scheme: payment.scheme,
    verified: true,
    network: payment.network,
    amount: payment.amount,
    asset: payment.asset,
    recipient: payment.recipient,
    reference: payment.reference,
  };
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
  setHeader(res, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  setHeader(
    res,
    "Access-Control-Allow-Headers",
    "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE",
  );
  setHeader(
    res,
    "Access-Control-Expose-Headers",
    `${PAYMENT_RESPONSE_HEADER}, ${X402_PAYMENT_REQUIRED_HEADER}, ${X402_PAYMENT_RESPONSE_HEADER}`,
  );
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
