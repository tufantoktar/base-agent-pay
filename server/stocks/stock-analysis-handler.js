import {
  STOCK_RPC_CODES,
  StockRpcError,
  createJsonRpcClient,
} from "./b20-data-adapter.js";
import {
  STOCK_ANALYSIS_CODES,
  StockAnalysisEngine,
  StockAnalysisError,
} from "./stock-analysis-engine.js";

const DEFAULT_BASE_MAINNET_RPC_URL = "https://mainnet.base.org";
const ALLOWED_REQUEST_KEYS = Object.freeze(["symbol", "analysisType"]);

export async function handleStockAnalysisRequest(req, res, options = {}) {
  applyCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      code: "METHOD_NOT_ALLOWED",
      message: "Only POST is supported for stock analysis.",
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, {
      ok: false,
      error: "INVALID_JSON",
      code: "INVALID_JSON",
      message: "Request body must be valid JSON.",
    });
  }

  const request = normalizeStockAnalysisRequest(body);
  if (!request.ok) {
    return sendJson(res, 400, {
      ok: false,
      error: request.code,
      code: request.code,
      message: request.reason,
    });
  }

  const engine =
    options.analysisEngine ??
    new StockAnalysisEngine({
      dataAdapter:
        options.dataAdapter ??
        createDefaultStockDataAdapter({
          env: options.env ?? process.env,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
        }),
      clock: options.clock,
    });

  try {
    const result = await engine.analyze(request.value);
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, mapErrorStatus(error), createSafeErrorPayload(error));
  }
}

export function normalizeStockAnalysisRequest(body) {
  if (!isPlainObject(body)) {
    return invalid("Request body must be an object.");
  }

  const extraKeys = Object.keys(body).filter((key) => !ALLOWED_REQUEST_KEYS.includes(key));
  if (extraKeys.length > 0) {
    return invalid("Request body contains unsupported fields.");
  }

  const symbol = normalizeText(body.symbol);
  if (!symbol) {
    return invalid("symbol is required.");
  }

  const analysisType = normalizeText(body.analysisType);
  if (!analysisType) {
    return invalid("analysisType is required.");
  }

  if (!["snapshot", "risk-check"].includes(analysisType)) {
    return {
      ok: false,
      code: STOCK_ANALYSIS_CODES.TYPE_NOT_SUPPORTED,
      reason: "analysisType is not supported.",
    };
  }

  return {
    ok: true,
    value: {
      symbol,
      analysisType,
    },
  };
}

function createDefaultStockDataAdapter({ env, fetchImpl, timeoutMs } = {}) {
  const rpcUrl =
    normalizeText(env?.BASE_MAINNET_RPC_URL) ||
    normalizeText(env?.BASE_RPC_URL) ||
    DEFAULT_BASE_MAINNET_RPC_URL;

  return {
    async getStockSnapshot(symbol) {
      const { B20DataAdapter } = await import("./b20-data-adapter.js");
      const adapter = new B20DataAdapter({
        rpcClient: createJsonRpcClient({
          rpcUrl,
          fetchImpl,
          timeoutMs,
        }),
      });
      return adapter.getStockSnapshot(symbol);
    },
  };
}

function mapErrorStatus(error) {
  if (error instanceof StockAnalysisError) {
    return error.code === STOCK_ANALYSIS_CODES.TYPE_NOT_SUPPORTED ? 400 : 500;
  }

  if (error instanceof StockRpcError) {
    switch (error.code) {
      case STOCK_RPC_CODES.NOT_SUPPORTED:
        return 404;
      case STOCK_RPC_CODES.TIMEOUT:
        return 503;
      case STOCK_RPC_CODES.CHAIN_MISMATCH:
      case STOCK_RPC_CODES.INVALID_RESPONSE:
      case STOCK_RPC_CODES.METADATA_MISMATCH:
      case STOCK_RPC_CODES.REGISTRY_INVALID:
        return 502;
      default:
        return 502;
    }
  }

  return 500;
}

function createSafeErrorPayload(error) {
  const code =
    error instanceof StockAnalysisError || error instanceof StockRpcError
      ? error.code
      : STOCK_ANALYSIS_CODES.FAILED;

  return {
    ok: false,
    error: code,
    code,
    message: safeErrorMessage(code),
  };
}

function safeErrorMessage(code) {
  switch (code) {
    case STOCK_ANALYSIS_CODES.TYPE_NOT_SUPPORTED:
      return "Stock analysis type is not supported.";
    case STOCK_RPC_CODES.NOT_SUPPORTED:
      return "Stock symbol is not supported.";
    case STOCK_RPC_CODES.CHAIN_MISMATCH:
      return "Stock RPC is not connected to Base Mainnet.";
    case STOCK_RPC_CODES.TIMEOUT:
      return "Stock RPC request timed out.";
    case STOCK_RPC_CODES.METADATA_MISMATCH:
      return "Stock metadata does not match the trusted registry.";
    case STOCK_RPC_CODES.INVALID_RESPONSE:
    case STOCK_RPC_CODES.REGISTRY_INVALID:
    default:
      return "Stock analysis failed closed.";
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) {
    throw new Error("empty body");
  }
  return JSON.parse(raw);
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function invalid(reason) {
  return {
    ok: false,
    code: STOCK_ANALYSIS_CODES.INVALID_REQUEST,
    reason,
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}
