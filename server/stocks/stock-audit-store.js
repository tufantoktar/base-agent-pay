export const STOCK_AUDIT_SCHEMA_VERSION = 2;

export const STOCK_AUDIT_ERROR_CODES = Object.freeze({
  INVALID_RECORD: "STOCK_AUDIT_INVALID_RECORD",
  INVALID_LOOKUP: "STOCK_AUDIT_INVALID_LOOKUP",
  NOT_FOUND: "STOCK_AUDIT_NOT_FOUND",
  PERSISTENCE_FAILED: "STOCK_AUDIT_PERSISTENCE_FAILED",
  STORE_ERROR: "STOCK_AUDIT_STORE_ERROR",
});

export class StockAuditStoreError extends Error {
  constructor(message, { code = STOCK_AUDIT_ERROR_CODES.STORE_ERROR, cause } = {}) {
    super(message, { cause });
    this.name = "StockAuditStoreError";
    this.code = code;
  }
}

export class StockAuditStore {
  createAuditRecord() {
    throw new Error("StockAuditStore.createAuditRecord must be implemented");
  }

  getAuditRecord() {
    throw new Error("StockAuditStore.getAuditRecord must be implemented");
  }

  close() {}
}

export function publicStockAuditRecord(record) {
  return {
    auditId: record.auditId,
    requestId: record.requestId,
    mandateId: record.mandateId,
    symbol: record.symbol,
    analysisType: record.analysisType,
    scope: record.scope,
    payment: {
      mode: record.paymentMode,
      status: record.paymentStatus,
      scheme: record.paymentScheme,
      amount: record.paymentAmount,
      currency: record.paymentCurrency,
      reference: record.paymentReference,
    },
    network: {
      chainId: record.chainId,
      caip2: record.caip2,
    },
    asset: {
      contractAddress: record.contractAddress,
    },
    resultStatus: record.resultStatus,
    resultHash: record.resultHash,
    observedBlockNumber: record.observedBlockNumber,
    observedAt: record.observedAt,
    createdAt: record.createdAt,
    requestHash: record.requestHash,
    policyDecisionCode: record.policyDecisionCode,
    provenance: {
      registrySource: record.registrySource,
      rpcSource: record.rpcSource,
    },
  };
}

export function minimalStockAuditRecord(record) {
  return {
    auditId: record.auditId,
    requestId: record.requestId,
    resultHash: record.resultHash,
  };
}

export function assertValidStockAuditRecord(record) {
  for (const field of [
    "auditId",
    "requestId",
    "mandateId",
    "symbol",
    "analysisType",
    "scope",
    "paymentMode",
    "paymentStatus",
    "paymentScheme",
    "paymentAmount",
    "paymentCurrency",
    "paymentReference",
    "caip2",
    "contractAddress",
    "resultStatus",
    "resultHash",
    "proofPayloadJson",
    "observedBlockNumber",
    "observedAt",
    "createdAt",
  ]) {
    if (!isNonEmptyString(record?.[field])) {
      throw new StockAuditStoreError(`Stock audit record ${field} is required.`, {
        code: STOCK_AUDIT_ERROR_CODES.INVALID_RECORD,
      });
    }
  }

  if (record.paymentMode !== "mock" || record.paymentStatus !== "VERIFIED") {
    throw new StockAuditStoreError("Stock audit records must use MOCK VERIFIED.", {
      code: STOCK_AUDIT_ERROR_CODES.INVALID_RECORD,
    });
  }

  if (record.paymentStatus === "SETTLED") {
    throw new StockAuditStoreError("Mock stock audit records cannot be settled.", {
      code: STOCK_AUDIT_ERROR_CODES.INVALID_RECORD,
    });
  }

  if (record.chainId !== 8453 || record.caip2 !== "eip155:8453") {
    throw new StockAuditStoreError("Stock audit records must stay on Base Mainnet.", {
      code: STOCK_AUDIT_ERROR_CODES.INVALID_RECORD,
    });
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
