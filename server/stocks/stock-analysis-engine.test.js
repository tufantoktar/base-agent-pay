import assert from "node:assert/strict";
import test from "node:test";

import {
  STOCK_ANALYSIS_CODES,
  StockAnalysisEngine,
} from "./stock-analysis-engine.js";

const SNAPSHOT = Object.freeze({
  asset: Object.freeze({
    symbol: "AAPLc",
    name: "Apple",
    standard: "B20",
    issuer: "Coinbase",
    contractAddress: "0xb200000000000000000000C2e324d24d7eEcd1fb",
  }),
  network: Object.freeze({
    chainId: 8453,
    caip2: "eip155:8453",
  }),
  onchain: Object.freeze({
    tokenName: "Apple Inc.",
    tokenSymbol: "AAPLc",
    decimals: "8",
    totalSupplyAtomic: "461502990000",
    blockNumber: "123456",
  }),
  provenance: Object.freeze({
    registrySource:
      "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base#contract-addresses",
    rpcSource: "Base Mainnet",
    observedAt: "2026-08-27T10:00:00.000Z",
  }),
});

test("snapshot analysis returns normalized Phase 2A snapshot data", async () => {
  const engine = createEngine(SNAPSHOT);
  const result = await engine.analyze({
    symbol: "AAPLc",
    analysisType: "snapshot",
  });

  assert.equal(result.ok, true);
  assert.equal(result.analysisType, "snapshot");
  assert.equal(result.asset.symbol, "AAPLc");
  assert.equal(result.network.chainId, 8453);
  assert.equal(result.snapshot.decimals, "8");
  assert.equal(result.snapshot.totalSupplyAtomic, "461502990000");
  assert.equal(typeof result.snapshot.totalSupplyAtomic, "string");
  assert.equal(result.provenance.rpcSource, "Base Mainnet");
});

test("risk-check returns PASS for healthy infrastructure metadata", async () => {
  const engine = createEngine(SNAPSHOT);
  const result = await engine.analyze({
    symbol: "AAPLc",
    analysisType: "risk-check",
  });

  assert.equal(result.ok, true);
  assert.equal(result.analysisType, "risk-check");
  assert.equal(result.symbol, "AAPLc");
  assert.equal(result.risk.status, "PASS");
  assert.deepEqual(result.risk.flags, []);
  assert.equal(result.risk.checks.registryMatched, true);
  assert.equal(result.risk.checks.symbolMatched, true);
  assert.equal(result.risk.checks.provenancePresent, true);
  assert.equal(result.risk.evaluatedAt, "2026-08-27T12:00:00.000Z");
});

test("risk-check returns WARN for missing optional metadata", async () => {
  const engine = createEngine({
    ...SNAPSHOT,
    onchain: {
      ...SNAPSHOT.onchain,
      tokenName: null,
      tokenSymbol: null,
      decimals: null,
      totalSupplyAtomic: null,
    },
  });

  const result = await engine.analyze({
    symbol: "AAPLc",
    analysisType: "risk-check",
  });

  assert.equal(result.risk.status, "WARN");
  assert.deepEqual(result.risk.flags, [
    "TOKEN_SYMBOL_MISSING",
    "TOKEN_NAME_MISSING",
    "DECIMALS_MISSING",
    "TOTAL_SUPPLY_MISSING",
  ]);
});

test("risk-check returns FAIL for a mismatched symbol if adapter supplies one", async () => {
  const engine = createEngine({
    ...SNAPSHOT,
    onchain: {
      ...SNAPSHOT.onchain,
      tokenSymbol: "FAKEc",
    },
  });

  const result = await engine.analyze({
    symbol: "AAPLc",
    analysisType: "risk-check",
  });

  assert.equal(result.risk.status, "FAIL");
  assert.deepEqual(result.risk.flags, ["SYMBOL_MISMATCH"]);
});

test("unsupported analysis type fails closed", async () => {
  const engine = createEngine(SNAPSHOT);

  await assert.rejects(
    () =>
      engine.analyze({
        symbol: "AAPLc",
        analysisType: "forecast",
      }),
    {
      name: "StockAnalysisError",
      code: STOCK_ANALYSIS_CODES.TYPE_NOT_SUPPORTED,
    },
  );
});

test("risk-check emits no recommendation fields", async () => {
  const engine = createEngine(SNAPSHOT);
  const result = await engine.analyze({
    symbol: "AAPLc",
    analysisType: "risk-check",
  });

  const serialized = JSON.stringify(result).toLowerCase();
  for (const banned of [
    "buy",
    "sell",
    "hold",
    "outperform",
    "underperform",
    "targetprice",
    "target price",
    "valuation",
    "expectedreturn",
    "expected return",
  ]) {
    assert.equal(serialized.includes(banned), false, `${banned} must not appear`);
  }
});

function createEngine(snapshot) {
  return new StockAnalysisEngine({
    dataAdapter: {
      async getStockSnapshot() {
        return snapshot;
      },
    },
    clock: () => new Date("2026-08-27T12:00:00.000Z"),
  });
}
