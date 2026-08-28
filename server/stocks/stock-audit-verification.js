import {
  STOCK_AUDIT_PAYMENT_STATUS,
  STOCK_AUDIT_PROOF_VERSION,
  STOCK_AUDIT_RESULT_STATUS,
  createStockResultHashFromProofPayload,
} from "./stock-audit-proof.js";

export const STOCK_AUDIT_VERIFICATION_STATUSES = Object.freeze({
  VALID: "VALID",
  INVALID: "INVALID",
  UNVERIFIABLE: "UNVERIFIABLE",
});

const RESULT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function verifyStockAuditRecord(record, { now = new Date() } = {}) {
  const verifiedAt = toUtcTimestamp(now);
  const storedResultHash = normalizeText(record?.resultHash);
  const proof = parseProofPayload(record?.proofPayloadJson);

  if (!record || !proof.ok || !RESULT_HASH_PATTERN.test(storedResultHash)) {
    return createVerification({
      record,
      status: STOCK_AUDIT_VERIFICATION_STATUSES.UNVERIFIABLE,
      storedResultHash,
      computedResultHash: null,
      verifiedAt,
    });
  }

  const proofValidation = validateProofPayload(proof.payload);
  if (!proofValidation.ok) {
    return createVerification({
      record,
      status: STOCK_AUDIT_VERIFICATION_STATUSES.UNVERIFIABLE,
      storedResultHash,
      computedResultHash: null,
      verifiedAt,
    });
  }

  const computedResultHash = createStockResultHashFromProofPayload(proof.payload);
  const matches =
    storedResultHash === computedResultHash &&
    auditRecordMatchesProofPayload(record, proof.payload);

  return createVerification({
    record,
    status: matches
      ? STOCK_AUDIT_VERIFICATION_STATUSES.VALID
      : STOCK_AUDIT_VERIFICATION_STATUSES.INVALID,
    storedResultHash,
    computedResultHash,
    verifiedAt,
  });
}

export function publicStockAuditVerification(verification) {
  return {
    auditId: verification.auditId,
    requestId: verification.requestId,
    status: verification.status,
    storedResultHash: verification.storedResultHash,
    computedResultHash: verification.computedResultHash,
    matches: verification.matches,
    verifiedAt: verification.verifiedAt,
  };
}

function createVerification({
  record,
  status,
  storedResultHash,
  computedResultHash,
  verifiedAt,
}) {
  return {
    auditId: normalizeText(record?.auditId),
    requestId: normalizeText(record?.requestId),
    status,
    storedResultHash,
    computedResultHash,
    matches: status === STOCK_AUDIT_VERIFICATION_STATUSES.VALID,
    verifiedAt,
  };
}

function parseProofPayload(proofPayloadJson) {
  if (!isNonEmptyString(proofPayloadJson)) {
    return { ok: false };
  }

  try {
    const payload = JSON.parse(proofPayloadJson);
    return isPlainObject(payload) ? { ok: true, payload } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function validateProofPayload(payload) {
  if (payload.version !== STOCK_AUDIT_PROOF_VERSION) {
    return { ok: false };
  }

  for (const field of ["mandateId", "symbol", "analysisType", "scope", "resultStatus"]) {
    if (!isNonEmptyString(payload[field])) {
      return { ok: false };
    }
  }

  if (payload.resultStatus !== STOCK_AUDIT_RESULT_STATUS) {
    return { ok: false };
  }

  if (
    !isPlainObject(payload.payment) ||
    payload.payment.mode !== "mock" ||
    payload.payment.status !== STOCK_AUDIT_PAYMENT_STATUS
  ) {
    return { ok: false };
  }

  for (const field of ["scheme", "amount", "currency", "reference"]) {
    if (!isNonEmptyString(payload.payment[field])) {
      return { ok: false };
    }
  }

  if (
    !isPlainObject(payload.network) ||
    payload.network.chainId !== 8453 ||
    payload.network.caip2 !== "eip155:8453"
  ) {
    return { ok: false };
  }

  if (
    !isPlainObject(payload.asset) ||
    !isNonEmptyString(payload.asset.contractAddress)
  ) {
    return { ok: false };
  }

  if (
    !isPlainObject(payload.observed) ||
    !isNonEmptyString(payload.observed.blockNumber) ||
    !isNonEmptyString(payload.observed.observedAt) ||
    !isNonEmptyString(payload.observed.registrySource) ||
    !isNonEmptyString(payload.observed.rpcSource)
  ) {
    return { ok: false };
  }

  if (!isPlainObject(payload.analysis)) {
    return { ok: false };
  }

  if (payload.analysisType === "snapshot") {
    return { ok: isPlainObject(payload.analysis.snapshot) };
  }

  if (payload.analysisType === "risk-check") {
    return {
      ok:
        isPlainObject(payload.analysis.risk) &&
        isPlainObject(payload.analysis.snapshot),
    };
  }

  return { ok: false };
}

function auditRecordMatchesProofPayload(record, payload) {
  const expected = {
    mandateId: payload.mandateId,
    symbol: payload.symbol,
    analysisType: payload.analysisType,
    scope: payload.scope,
    paymentMode: payload.payment.mode,
    paymentStatus: payload.payment.status,
    paymentScheme: payload.payment.scheme,
    paymentAmount: payload.payment.amount,
    paymentCurrency: payload.payment.currency,
    paymentReference: payload.payment.reference,
    chainId: payload.network.chainId,
    caip2: payload.network.caip2,
    contractAddress: payload.asset.contractAddress,
    resultStatus: payload.resultStatus,
    observedBlockNumber: payload.observed.blockNumber,
    observedAt: payload.observed.observedAt,
    registrySource: payload.observed.registrySource,
    rpcSource: payload.observed.rpcSource,
  };

  return Object.entries(expected).every(([field, value]) => {
    if (field === "chainId") {
      return Number(record[field]) === value;
    }
    return normalizeText(record[field]) === value;
  });
}

function toUtcTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isNonEmptyString(value) {
  return normalizeText(value).length > 0;
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}
