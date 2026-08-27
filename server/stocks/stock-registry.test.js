import assert from "node:assert/strict";
import test from "node:test";

import {
  STOCK_REGISTRY_CODES,
  StockRegistryError,
  createStockRegistry,
  getStockByAddress,
  getStockBySymbol,
  listSupportedStocks,
  validateRegistry,
} from "./stock-registry.js";

const AAPL_ADDRESS = "0xb200000000000000000000C2e324d24d7eEcd1fb";

test("looks up supported symbols", () => {
  const stock = getStockBySymbol("AAPLc");

  assert.equal(stock.symbol, "AAPLc");
  assert.equal(stock.name, "Apple");
  assert.equal(stock.chainId, 8453);
  assert.equal(stock.network, "eip155:8453");
  assert.equal(stock.standard, "B20");
  assert.equal(stock.issuer, "Coinbase");
  assert.equal(stock.contractAddress, AAPL_ADDRESS);
  assert.match(stock.source, /docs\.base\.org/u);
});

test("handles symbol and address casing deterministically", () => {
  assert.equal(getStockBySymbol("aaplc").contractAddress, AAPL_ADDRESS);
  assert.equal(getStockBySymbol("  AAPLC ").contractAddress, AAPL_ADDRESS);
  assert.equal(getStockByAddress(AAPL_ADDRESS.toLowerCase()).symbol, "AAPLc");
});

test("unknown symbols fail closed", () => {
  assert.throws(() => getStockBySymbol("TSLAc"), {
    name: "StockRegistryError",
    code: STOCK_REGISTRY_CODES.NOT_SUPPORTED,
  });
});

test("registry returns defensive immutable copies", () => {
  const stocks = listSupportedStocks();
  assert.equal(stocks.length, 4);
  assert.throws(() => {
    stocks[0].symbol = "WRONG";
  }, TypeError);
  assert.equal(getStockBySymbol("AAPLc").symbol, "AAPLc");
});

test("invalid registry addresses are rejected", () => {
  assert.throws(
    () =>
      validateRegistry([
        {
          symbol: "BADc",
          contractAddress: "0xb200",
        },
      ]),
    (error) =>
      error instanceof StockRegistryError &&
      error.code === STOCK_REGISTRY_CODES.INVALID,
  );
});

test("invalid registry metadata is rejected", () => {
  assert.throws(
    () =>
      validateRegistry([
        {
          ...entry("AAPLc"),
          chainId: 1,
        },
      ]),
    {
      name: "StockRegistryError",
      code: STOCK_REGISTRY_CODES.INVALID,
    },
  );
});

test("duplicate symbols are rejected", () => {
  assert.throws(() => createStockRegistry([entry("AAPLc"), entry("aaplc")]), {
    name: "StockRegistryError",
    code: STOCK_REGISTRY_CODES.INVALID,
  });
});

test("duplicate addresses are rejected", () => {
  assert.throws(
    () =>
      createStockRegistry([
        entry("AAPLc", "0x1111111111111111111111111111111111111111"),
        entry("NVDAc", "0x1111111111111111111111111111111111111111"),
      ]),
    {
      name: "StockRegistryError",
      code: STOCK_REGISTRY_CODES.INVALID,
    },
  );
});

function entry(symbol, contractAddress = "0x2222222222222222222222222222222222222222") {
  return {
    symbol,
    name: symbol,
    network: "eip155:8453",
    chainId: 8453,
    standard: "B20",
    issuer: "Coinbase",
    contractAddress,
    source: "test",
    status: "active",
  };
}
