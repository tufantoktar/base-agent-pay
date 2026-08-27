import assert from "node:assert/strict";
import test from "node:test";

import {
  B20DataAdapter,
  ERC20_METADATA_SELECTORS,
  STOCK_RPC_CODES,
  StockRpcError,
  assertRegistryAddressOnly,
  createJsonRpcClient,
} from "./b20-data-adapter.js";
import { getStockBySymbol } from "./stock-registry.js";

const AAPL = getStockBySymbol("AAPLc");
const FIXED_NOW = new Date("2026-08-27T12:00:00.000Z");

test("accepts Base Mainnet chain ID and normalizes a valid metadata snapshot", async () => {
  const calls = [];
  const adapter = new B20DataAdapter({
    rpcClient: createFakeRpcClient({ calls }),
    clock: () => FIXED_NOW,
  });

  const snapshot = await adapter.getStockSnapshot("AAPLc");

  assert.deepEqual(
    calls.map((call) => call.method),
    ["eth_chainId", "eth_blockNumber", "eth_call", "eth_call", "eth_call", "eth_call"],
  );
  assert.deepEqual(
    calls
      .filter((call) => call.method === "eth_call")
      .map((call) => call.params[0].data),
    [
      ERC20_METADATA_SELECTORS.name,
      ERC20_METADATA_SELECTORS.symbol,
      ERC20_METADATA_SELECTORS.decimals,
      ERC20_METADATA_SELECTORS.totalSupply,
    ],
  );
  assert.equal(snapshot.asset.symbol, "AAPLc");
  assert.equal(snapshot.asset.contractAddress, AAPL.contractAddress);
  assert.equal(snapshot.network.chainId, 8453);
  assert.equal(snapshot.network.caip2, "eip155:8453");
  assert.equal(snapshot.onchain.tokenName, "Apple Coinbase Tokenized Stock");
  assert.equal(snapshot.onchain.tokenSymbol, "AAPLc");
  assert.equal(snapshot.onchain.decimals, "18");
  assert.equal(snapshot.onchain.totalSupplyAtomic, "123456789012345678901234567890");
  assert.equal(snapshot.onchain.blockNumber, "291");
  assert.equal(snapshot.provenance.rpcSource, "Base Mainnet");
  assert.equal(snapshot.provenance.observedAt, FIXED_NOW.toISOString());
  assert.match(snapshot.provenance.registrySource, /docs\.base\.org/u);
});

test("rejects non-Base chain IDs", async () => {
  const adapter = new B20DataAdapter({
    rpcClient: createFakeRpcClient({ chainId: "0x1" }),
  });

  await assert.rejects(() => adapter.getStockSnapshot("AAPLc"), {
    name: "StockRpcError",
    code: STOCK_RPC_CODES.CHAIN_MISMATCH,
  });
});

test("rejects arbitrary unsupported symbols before RPC reads", async () => {
  const calls = [];
  const adapter = new B20DataAdapter({
    rpcClient: createFakeRpcClient({ calls }),
  });

  await assert.rejects(() => adapter.getStockSnapshot("TSLAc"), {
    name: "StockRpcError",
    code: STOCK_RPC_CODES.NOT_SUPPORTED,
  });
  assert.deepEqual(calls, []);
});

test("rejects arbitrary user-provided contract addresses", () => {
  assert.throws(
    () =>
      assertRegistryAddressOnly({
        requestedAddress: "0x1111111111111111111111111111111111111111",
        stock: AAPL,
      }),
    {
      name: "StockRpcError",
      code: STOCK_RPC_CODES.NOT_SUPPORTED,
    },
  );
});

test("malformed RPC responses fail closed", async () => {
  const adapter = new B20DataAdapter({
    rpcClient: createFakeRpcClient({ blockNumber: "latest" }),
  });

  await assert.rejects(() => adapter.getStockSnapshot("AAPLc"), {
    name: "StockRpcError",
    code: STOCK_RPC_CODES.INVALID_RESPONSE,
  });
});

test("timeout errors are reported explicitly", async () => {
  const adapter = new B20DataAdapter({
    rpcClient: {
      async request() {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    },
  });

  await assert.rejects(() => adapter.getStockSnapshot("AAPLc"), {
    name: "StockRpcError",
    code: STOCK_RPC_CODES.TIMEOUT,
  });
});

test("symbol mismatches fail closed", async () => {
  const adapter = new B20DataAdapter({
    rpcClient: createFakeRpcClient({ tokenSymbol: "FAKEc" }),
  });

  await assert.rejects(() => adapter.getStockSnapshot("AAPLc"), {
    name: "StockRpcError",
    code: STOCK_RPC_CODES.METADATA_MISMATCH,
  });
});

test("name mismatches fail closed", async () => {
  const adapter = new B20DataAdapter({
    rpcClient: createFakeRpcClient({ tokenName: "Fake Stock" }),
  });

  await assert.rejects(() => adapter.getStockSnapshot("AAPLc"), {
    name: "StockRpcError",
    code: STOCK_RPC_CODES.METADATA_MISMATCH,
  });
});

test("optional ERC-20 methods may be absent", async () => {
  const adapter = new B20DataAdapter({
    rpcClient: createFakeRpcClient({
      tokenName: null,
      tokenSymbol: null,
      decimals: null,
      totalSupply: null,
    }),
  });

  const snapshot = await adapter.getStockSnapshot("AAPLc");

  assert.equal(snapshot.onchain.tokenName, null);
  assert.equal(snapshot.onchain.tokenSymbol, null);
  assert.equal(snapshot.onchain.decimals, null);
  assert.equal(snapshot.onchain.totalSupplyAtomic, null);
});

test("createJsonRpcClient validates response shape and uses only read methods", async () => {
  const requests = [];
  const client = createJsonRpcClient({
    rpcUrl: "https://mainnet.base.org",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: "0x2105",
          });
        },
      };
    },
  });

  assert.equal(await client.request({ method: "eth_chainId", params: [] }), "0x2105");
  await assert.rejects(
    () => client.request({ method: "eth_sendTransaction", params: [] }),
    StockRpcError,
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    ["eth_chainId"],
  );
});

test("security regression: stock modules expose no write transaction surface", async () => {
  const fs = await import("node:fs/promises");
  const files = [
    new URL("./b20-data-adapter.js", import.meta.url),
    new URL("./stock-registry.js", import.meta.url),
  ];
  const source = (await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).join("\n");

  assert.doesNotMatch(source, /eth_sendTransaction/u);
  assert.doesNotMatch(source, /eth_sendRawTransaction/u);
  assert.doesNotMatch(source, /\bapprove\b/u);
  assert.doesNotMatch(source, /\btransfer\b/u);
  assert.doesNotMatch(source, /\btransferFrom\b/u);
});

function createFakeRpcClient({
  calls = [],
  chainId = "0x2105",
  blockNumber = "0x123",
  tokenName = "Apple Coinbase Tokenized Stock",
  tokenSymbol = "AAPLc",
  decimals = 18n,
  totalSupply = 123456789012345678901234567890n,
} = {}) {
  return {
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_chainId") {
        return chainId;
      }
      if (method === "eth_blockNumber") {
        return blockNumber;
      }
      if (method === "eth_call") {
        assert.equal(params[0].to, AAPL.contractAddress);
        switch (params[0].data) {
          case ERC20_METADATA_SELECTORS.name:
            return tokenName === null ? "0x" : encodeAbiString(tokenName);
          case ERC20_METADATA_SELECTORS.symbol:
            return tokenSymbol === null ? "0x" : encodeAbiString(tokenSymbol);
          case ERC20_METADATA_SELECTORS.decimals:
            return decimals === null ? "0x" : encodeAbiUint(decimals);
          case ERC20_METADATA_SELECTORS.totalSupply:
            return totalSupply === null ? "0x" : encodeAbiUint(totalSupply);
          default:
            throw new Error(`unexpected selector ${params[0].data}`);
        }
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

function encodeAbiString(value) {
  const bytes = new TextEncoder().encode(value);
  const length = encodeAbiUint(BigInt(bytes.length)).slice(2);
  const paddedLength = Math.ceil(bytes.length / 32) * 32;
  const data = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(paddedLength * 2, "0");
  return `0x${encodeAbiUint(32n).slice(2)}${length}${data}`;
}

function encodeAbiUint(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}
