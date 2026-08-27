import { B20DataAdapter, STOCK_RPC_CODES, StockRpcError } from "./b20-data-adapter.js";

export const STOCK_ANALYSIS_TYPES = Object.freeze({
  SNAPSHOT: "snapshot",
  RISK_CHECK: "risk-check",
});

export const STOCK_ANALYSIS_CODES = Object.freeze({
  INVALID_REQUEST: "STOCK_ANALYSIS_INVALID_REQUEST",
  TYPE_NOT_SUPPORTED: "STOCK_ANALYSIS_TYPE_NOT_SUPPORTED",
  FAILED: "STOCK_ANALYSIS_FAILED",
});

export class StockAnalysisError extends Error {
  constructor(message, { code = STOCK_ANALYSIS_CODES.FAILED, cause } = {}) {
    super(message, { cause });
    this.name = "StockAnalysisError";
    this.code = code;
  }
}

export class StockAnalysisEngine {
  constructor({ dataAdapter, clock = () => new Date() } = {}) {
    if (!dataAdapter || typeof dataAdapter.getStockSnapshot !== "function") {
      throw new StockAnalysisError("A stock data adapter is required.");
    }

    this.dataAdapter = dataAdapter;
    this.clock = clock;
  }

  async analyze({ symbol, analysisType } = {}) {
    const normalizedType = normalizeAnalysisType(analysisType);
    if (!Object.values(STOCK_ANALYSIS_TYPES).includes(normalizedType)) {
      throw new StockAnalysisError("Stock analysis type is not supported.", {
        code: STOCK_ANALYSIS_CODES.TYPE_NOT_SUPPORTED,
      });
    }

    const snapshot = await this.dataAdapter.getStockSnapshot(symbol);

    if (normalizedType === STOCK_ANALYSIS_TYPES.SNAPSHOT) {
      return createSnapshotAnalysis(snapshot);
    }

    return createRiskCheckAnalysis(snapshot, this.clock());
  }
}

export function createStockAnalysisEngine({ rpcClient, registry, clock } = {}) {
  return new StockAnalysisEngine({
    dataAdapter: new B20DataAdapter({ rpcClient, registry, clock }),
    clock,
  });
}

function createSnapshotAnalysis(snapshot) {
  return Object.freeze({
    ok: true,
    analysisType: STOCK_ANALYSIS_TYPES.SNAPSHOT,
    asset: snapshot.asset,
    network: snapshot.network,
    snapshot: snapshot.onchain,
    provenance: snapshot.provenance,
  });
}

function createRiskCheckAnalysis(snapshot, now) {
  const flags = [];
  const checks = {
    registryMatched: Boolean(snapshot.asset?.symbol && snapshot.asset?.contractAddress),
    symbolMatched:
      snapshot.onchain?.tokenSymbol !== null &&
      normalizeSymbol(snapshot.onchain?.tokenSymbol) === normalizeSymbol(snapshot.asset?.symbol),
    namePresent: Boolean(snapshot.onchain?.tokenName),
    decimalsPresent: snapshot.onchain?.decimals !== null,
    totalSupplyPresent: snapshot.onchain?.totalSupplyAtomic !== null,
    provenancePresent: Boolean(
      snapshot.provenance?.registrySource && snapshot.provenance?.observedAt,
    ),
    blockNumberPresent: Boolean(snapshot.onchain?.blockNumber),
  };

  if (!checks.registryMatched) {
    flags.push("UNSUPPORTED_ASSET");
  }
  if (snapshot.onchain?.tokenSymbol === null) {
    flags.push("TOKEN_SYMBOL_MISSING");
  } else if (!checks.symbolMatched) {
    flags.push("SYMBOL_MISMATCH");
  }
  if (!checks.namePresent) {
    flags.push("TOKEN_NAME_MISSING");
  }
  if (!checks.decimalsPresent) {
    flags.push("DECIMALS_MISSING");
  }
  if (!checks.totalSupplyPresent) {
    flags.push("TOTAL_SUPPLY_MISSING");
  }
  if (!checks.blockNumberPresent) {
    flags.push("RPC_STALE_BLOCK_UNKNOWN");
  }
  if (!checks.provenancePresent) {
    flags.push("REGISTRY_SOURCE_MISSING");
  }

  const failFlags = new Set(["UNSUPPORTED_ASSET", "SYMBOL_MISMATCH"]);
  const status = flags.some((flag) => failFlags.has(flag))
    ? "FAIL"
    : flags.length > 0
      ? "WARN"
      : "PASS";

  return Object.freeze({
    ok: true,
    analysisType: STOCK_ANALYSIS_TYPES.RISK_CHECK,
    symbol: snapshot.asset.symbol,
    risk: Object.freeze({
      status,
      flags: Object.freeze(flags),
      checks: Object.freeze(checks),
      evaluatedAt: now.toISOString(),
    }),
    snapshot: Object.freeze({
      asset: snapshot.asset,
      network: snapshot.network,
      onchain: snapshot.onchain,
    }),
    provenance: snapshot.provenance,
  });
}

function normalizeAnalysisType(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSymbol(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export { STOCK_RPC_CODES, StockRpcError };
