import {
  STOCK_AUDIT_ERROR_CODES,
} from "./stock-audit-store.js";
import { createDefaultStockAuditStore } from "./stock-audit-store-factory.js";
import {
  publicStockAuditVerification,
  verifyStockAuditRecord,
} from "./stock-audit-verification.js";

const AUDIT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function handleStockAnalysisAuditVerifyRequest(req, res, options = {}) {
  applyCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET is supported for stock analysis audit verification.",
    });
  }

  const auditId = readAuditId(req);
  if (!AUDIT_ID_PATTERN.test(auditId)) {
    return sendJson(res, 400, {
      ok: false,
      error: STOCK_AUDIT_ERROR_CODES.INVALID_LOOKUP,
      code: STOCK_AUDIT_ERROR_CODES.INVALID_LOOKUP,
      message: "A valid audit id is required.",
    });
  }

  let ownedAuditStore;

  try {
    const auditStore =
      options.auditStore ??
      (ownedAuditStore = createDefaultStockAuditStore({
        env: options.env ?? process.env,
        now: options.clock,
        logger: options.auditLogger,
      }));
    const record = await auditStore.getAuditRecord(auditId);

    if (!record) {
      return sendJson(res, 404, {
        ok: false,
        error: STOCK_AUDIT_ERROR_CODES.NOT_FOUND,
        code: STOCK_AUDIT_ERROR_CODES.NOT_FOUND,
        message: "Stock analysis audit record was not found.",
      });
    }

    const verification = verifyStockAuditRecord(record, {
      now: options.now ?? options.clock?.() ?? new Date(),
    });
    logVerificationEvent(options.auditLogger, record, verification);

    return sendJson(res, 200, {
      ok: true,
      verification: publicStockAuditVerification(verification),
    });
  } catch {
    return sendJson(res, 500, {
      ok: false,
      error: STOCK_AUDIT_ERROR_CODES.STORE_ERROR,
      code: STOCK_AUDIT_ERROR_CODES.STORE_ERROR,
      message: "Stock analysis audit verification failed closed.",
    });
  } finally {
    await closeOwnedAuditStore(ownedAuditStore);
  }
}

function readAuditId(req) {
  const query = req.query && typeof req.query === "object" ? req.query : {};
  return normalizeText(query.id ?? parseRequestUrl(req.url).searchParams.get("id"));
}

function parseRequestUrl(value) {
  try {
    return new URL(value ?? "", "http://127.0.0.1");
  } catch {
    return new URL("http://127.0.0.1");
  }
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.statusCode = statusCode;
  for (const [name, value] of Object.entries({
    "Content-Type": "application/json",
    ...headers,
  })) {
    res.setHeader(name, value);
  }
  res.end(statusCode === 204 ? undefined : JSON.stringify(payload));
}

function applyCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function logVerificationEvent(logger, record, verification) {
  if (typeof logger !== "function") {
    return;
  }

  try {
    logger({
      event: "stock_analysis_audit_verified",
      auditId: record.auditId,
      requestId: record.requestId,
      symbol: record.symbol,
      analysisType: record.analysisType,
      status: verification.status,
    });
  } catch {
    // Verification logging is best-effort and must not affect read-only checks.
  }
}

async function closeOwnedAuditStore(auditStore) {
  if (!auditStore || typeof auditStore.close !== "function") {
    return;
  }

  try {
    await auditStore.close();
  } catch {
    // Lookup persistence resources are internally managed when no store is injected.
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
