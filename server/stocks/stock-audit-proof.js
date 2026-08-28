import { createHash, randomUUID } from "node:crypto";

import { stableStringify } from "../task/hash.js";
import {
  STOCK_AUDIT_ERROR_CODES,
  StockAuditStoreError,
} from "./stock-audit-store.js";

export const STOCK_AUDIT_PAYMENT_STATUS = "VERIFIED";
export const STOCK_AUDIT_RESULT_STATUS = "OK";

export function createStockAnalysisAuditRecord({
  request,
  result,
  mandateDecision,
  payment,
  requestHash,
  now = new Date(),
  createAuditId = randomUUID,
  createRequestId = randomUUID,
} = {}) {
  const normalized = normalizeAuditInputs({
    request,
    result,
    mandateDecision,
    payment,
    requestHash,
    createdAt: toUtcTimestamp(now),
  });
  const { canonicalRequest, ...auditFields } = normalized;

  return {
    auditId: createAuditId(),
    requestId: createRequestId(),
    ...auditFields,
    resultHash: createStockResultHash({
      request: canonicalRequest,
      result,
      mandateId: normalized.mandateId,
      paymentReference: normalized.paymentReference,
    }),
  };
}

export function createStockResultHash({
  request,
  result,
  mandateId,
  paymentReference,
} = {}) {
  return `sha256:${hashHex(
    createCanonicalStockResultPayload({
      request,
      result,
      mandateId,
      paymentReference,
    }),
  )}`;
}

export function createCanonicalStockResultPayload({
  request,
  result,
  mandateId,
  paymentReference,
} = {}) {
  const safeResult = extractResultFields(result);

  return removeUndefined({
    symbol: safeResult.symbol,
    analysisType: safeResult.analysisType || request?.analysisType,
    chainId: safeResult.chainId,
    caip2: safeResult.caip2,
    contractAddress: safeResult.contractAddress,
    analysis: safeResult.analysis,
    observed: {
      blockNumber: safeResult.observedBlockNumber,
      observedAt: safeResult.observedAt,
      registrySource: safeResult.registrySource,
      rpcSource: safeResult.rpcSource,
    },
    mandateId,
    payment: {
      reference: paymentReference,
    },
  });
}

function normalizeAuditInputs({
  request,
  result,
  mandateDecision,
  payment,
  requestHash,
  createdAt,
}) {
  const safeResult = extractResultFields(result);
  const mandateId = normalizeText(mandateDecision?.mandateId || request?.mandate?.mandateId);
  const paymentStatus = normalizeText(payment?.status) || STOCK_AUDIT_PAYMENT_STATUS;
  const paymentReference = normalizeText(payment?.reference);

  if (payment?.mode !== "mock" || paymentStatus !== STOCK_AUDIT_PAYMENT_STATUS) {
    throw invalidAuditRecord("Stock audit requires a verified mock payment.");
  }

  if (
    !mandateId ||
    !safeResult.symbol ||
    !safeResult.analysisType ||
    !normalizeText(request?.scope)
  ) {
    throw invalidAuditRecord("Stock audit record is missing required identity fields.");
  }

  if (
    !paymentReference ||
    !normalizeText(payment?.scheme) ||
    !normalizeText(payment?.amount) ||
    !normalizeText(payment?.currency)
  ) {
    throw invalidAuditRecord("Stock audit record is missing required payment fields.");
  }

  if (
    safeResult.chainId !== 8453 ||
    safeResult.caip2 !== "eip155:8453" ||
    !safeResult.contractAddress
  ) {
    throw invalidAuditRecord("Stock audit record must be pinned to Base Mainnet.");
  }

  if (!safeResult.observedBlockNumber || !safeResult.observedAt) {
    throw invalidAuditRecord("Stock audit record is missing required observation fields.");
  }

  return removeUndefined({
    canonicalRequest: removeUndefined({
      symbol: safeResult.symbol,
      analysisType: safeResult.analysisType,
      scope: normalizeText(request?.scope),
    }),
    mandateId,
    symbol: safeResult.symbol,
    analysisType: safeResult.analysisType,
    scope: normalizeText(request?.scope),
    paymentMode: "mock",
    paymentStatus,
    paymentScheme: normalizeText(payment?.scheme),
    paymentAmount: normalizeText(payment?.amount),
    paymentCurrency: normalizeText(payment?.currency),
    paymentReference,
    chainId: safeResult.chainId,
    caip2: safeResult.caip2,
    contractAddress: safeResult.contractAddress,
    resultStatus: STOCK_AUDIT_RESULT_STATUS,
    observedBlockNumber: safeResult.observedBlockNumber,
    observedAt: safeResult.observedAt,
    createdAt,
    requestHash: normalizeText(requestHash),
    policyDecisionCode: normalizeText(mandateDecision?.code),
    registrySource: safeResult.registrySource,
    rpcSource: safeResult.rpcSource,
  });
}

function extractResultFields(result) {
  if (!result || result.ok !== true) {
    throw invalidAuditRecord("Only successful stock analysis results can be audited.");
  }

  const asset = result.asset ?? result.snapshot?.asset;
  const network = result.network ?? result.snapshot?.network;
  const onchain = result.snapshot?.onchain ?? result.snapshot;
  const provenance = result.provenance;
  const symbol = normalizeText(asset?.symbol ?? result.symbol);
  const analysisType = normalizeText(result.analysisType);

  return removeUndefined({
    symbol,
    analysisType,
    chainId: Number(network?.chainId),
    caip2: normalizeText(network?.caip2),
    contractAddress: normalizeText(asset?.contractAddress),
    observedBlockNumber: normalizeText(onchain?.blockNumber),
    observedAt: normalizeText(provenance?.observedAt),
    registrySource: normalizeText(provenance?.registrySource),
    rpcSource: normalizeText(provenance?.rpcSource),
    analysis:
      analysisType === "risk-check"
        ? {
            risk: result.risk,
            snapshot: onchain,
          }
        : {
            snapshot: onchain,
          },
  });
}

function hashHex(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function removeUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => removeUndefined(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined && entry !== "")
      .map(([key, entry]) => [key, removeUndefined(entry)]),
  );
}

function toUtcTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function invalidAuditRecord(message) {
  return new StockAuditStoreError(message, {
    code: STOCK_AUDIT_ERROR_CODES.INVALID_RECORD,
  });
}
