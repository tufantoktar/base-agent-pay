import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { STOCK_RPC_CODES, StockRpcError } from "./b20-data-adapter.js";
import { handleStockAnalysisRequest } from "./stock-analysis-handler.js";

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
    registrySource: "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base#contract-addresses",
    rpcSource: "Base Mainnet",
    observedAt: "2026-08-27T10:00:00.000Z",
  }),
});

test("POST /api/stock-analysis snapshot returns safe normalized data", async () => {
  const response = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "snapshot",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.analysisType, "snapshot");
  assert.equal(response.body.asset.symbol, "AAPLc");
  assert.equal(response.body.network.chainId, 8453);
  assert.equal(response.body.snapshot.totalSupplyAtomic, "461502990000");
  assert.equal(typeof response.body.snapshot.totalSupplyAtomic, "string");
  assert.equal(response.body.provenance.rpcSource, "Base Mainnet");
});

test("POST /api/stock-analysis risk-check returns PASS for healthy snapshot", async () => {
  const response = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "risk-check",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.risk.status, "PASS");
  assert.deepEqual(response.body.risk.flags, []);
});

test("missing symbol is rejected", async () => {
  const response = await callStockAnalysis({ analysisType: "snapshot" });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "STOCK_ANALYSIS_INVALID_REQUEST");
});

test("missing analysisType is rejected", async () => {
  const response = await callStockAnalysis({ symbol: "AAPLc" });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "STOCK_ANALYSIS_INVALID_REQUEST");
});

test("unsupported symbol maps to STOCK_NOT_SUPPORTED", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "TSLAc",
      analysisType: "snapshot",
    },
    {
      dataAdapter: throwingAdapter(STOCK_RPC_CODES.NOT_SUPPORTED),
    },
  );

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.code, STOCK_RPC_CODES.NOT_SUPPORTED);
});

test("unsupported analysis type is rejected before adapter use", async () => {
  let calls = 0;
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "forecast",
    },
    {
      dataAdapter: {
        async getStockSnapshot() {
          calls += 1;
          return SNAPSHOT;
        },
      },
    },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "STOCK_ANALYSIS_TYPE_NOT_SUPPORTED");
  assert.equal(calls, 0);
});

test("arbitrary contract address field is rejected", async () => {
  const response = await callStockAnalysis({
    symbol: "AAPLc",
    analysisType: "snapshot",
    contractAddress: "0x1111111111111111111111111111111111111111",
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "STOCK_ANALYSIS_INVALID_REQUEST");
});

test("timeout maps safely without raw upstream details", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
    },
    {
      dataAdapter: throwingAdapter(STOCK_RPC_CODES.TIMEOUT, "sensitive upstream timeout"),
    },
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, STOCK_RPC_CODES.TIMEOUT);
  assert.doesNotMatch(JSON.stringify(response.body), /sensitive upstream/u);
});

test("malformed response maps safely", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
    },
    {
      dataAdapter: throwingAdapter(STOCK_RPC_CODES.INVALID_RESPONSE),
    },
  );

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, STOCK_RPC_CODES.INVALID_RESPONSE);
});

test("chain mismatch maps safely", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "snapshot",
    },
    {
      dataAdapter: throwingAdapter(STOCK_RPC_CODES.CHAIN_MISMATCH),
    },
  );

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, STOCK_RPC_CODES.CHAIN_MISMATCH);
});

test("metadata mismatch maps safely", async () => {
  const response = await callStockAnalysis(
    {
      symbol: "AAPLc",
      analysisType: "risk-check",
    },
    {
      dataAdapter: throwingAdapter(STOCK_RPC_CODES.METADATA_MISMATCH),
    },
  );

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, STOCK_RPC_CODES.METADATA_MISMATCH);
});

test("security regression: stock-analysis implementation exposes no write surface", async () => {
  const fs = await import("node:fs/promises");
  const files = [
    new URL("../../api/stock-analysis.js", import.meta.url),
    new URL("./stock-analysis-engine.js", import.meta.url),
    new URL("./stock-analysis-handler.js", import.meta.url),
  ];
  const source = (await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).join("\n");

  for (const banned of [
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "approve",
    "transfer",
    "transferFrom",
    "signer",
    "wallet",
    "private key",
  ]) {
    assert.equal(source.includes(banned), false, `${banned} must not appear`);
  }
});

async function callStockAnalysis(body, options = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  req.headers = {
    "content-type": "application/json",
  };

  const chunks = [];
  const responseHeaders = new Map();
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      responseHeaders.set(name.toLowerCase(), value);
    },
    end(chunk) {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
    },
  };

  await handleStockAnalysisRequest(req, res, {
    dataAdapter:
      options.dataAdapter ??
      {
        async getStockSnapshot() {
          return SNAPSHOT;
        },
      },
    clock: () => new Date("2026-08-27T12:00:00.000Z"),
  });

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: res.statusCode,
    headers: responseHeaders,
    body: rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
  };
}

function throwingAdapter(code, message = "upstream internals") {
  return {
    async getStockSnapshot() {
      throw new StockRpcError(message, { code });
    },
  };
}
