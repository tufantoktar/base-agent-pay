export const STOCK_REGISTRY_CODES = Object.freeze({
  INVALID: "STOCK_REGISTRY_INVALID",
  NOT_SUPPORTED: "STOCK_NOT_SUPPORTED",
});

export class StockRegistryError extends Error {
  constructor(message, { code = STOCK_REGISTRY_CODES.INVALID } = {}) {
    super(message);
    this.name = "StockRegistryError";
    this.code = code;
  }
}

export const BASE_STOCKS_SOURCE =
  "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base#contract-addresses";

const BASE_NETWORK = Object.freeze({
  chainId: 8453,
  caip2: "eip155:8453",
});

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;

const STOCKS = Object.freeze([
  createStock({
    symbol: "AAPLc",
    name: "Apple",
    contractAddress: "0xb200000000000000000000C2e324d24d7eEcd1fb",
  }),
  createStock({
    symbol: "NVDAc",
    name: "NVIDIA",
    contractAddress: "0xb20000000000000000000078ee7ce2fE4908108C",
  }),
  createStock({
    symbol: "METAc",
    name: "Meta",
    contractAddress: "0xb2000000000000000000008bC8786B856E61707C",
  }),
  createStock({
    symbol: "GOOGLc",
    name: "Alphabet",
    contractAddress: "0xb2000000000000000000002D0BA3164cc74f58B7",
  }),
]);

export const DEFAULT_STOCK_REGISTRY = createStockRegistry(STOCKS);

export function createStockRegistry(entries) {
  const stocks = entries.map((entry) => freezeStock(entry));
  validateRegistry(stocks);

  const bySymbol = new Map(
    stocks.map((stock) => [normalizeSymbol(stock.symbol), stock]),
  );
  const byAddress = new Map(
    stocks.map((stock) => [normalizeAddress(stock.contractAddress), stock]),
  );

  return Object.freeze({
    getBySymbol(symbol) {
      const stock = bySymbol.get(normalizeSymbol(symbol));
      if (!stock) {
        throw new StockRegistryError("Stock symbol is not supported.", {
          code: STOCK_REGISTRY_CODES.NOT_SUPPORTED,
        });
      }
      return copyStock(stock);
    },
    getByAddress(address) {
      const normalized = normalizeAddress(address);
      const stock = byAddress.get(normalized);
      if (!stock) {
        throw new StockRegistryError("Stock contract address is not supported.", {
          code: STOCK_REGISTRY_CODES.NOT_SUPPORTED,
        });
      }
      return copyStock(stock);
    },
    listSupportedStocks() {
      return stocks.map((stock) => copyStock(stock));
    },
  });
}

export function getStockBySymbol(symbol) {
  return DEFAULT_STOCK_REGISTRY.getBySymbol(symbol);
}

export function getStockByAddress(address) {
  return DEFAULT_STOCK_REGISTRY.getByAddress(address);
}

export function listSupportedStocks() {
  return DEFAULT_STOCK_REGISTRY.listSupportedStocks();
}

export function validateRegistry(entries) {
  const symbols = new Set();
  const addresses = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw invalidRegistry("Registry entry must be an object.");
    }

    const symbol = normalizeSymbol(entry.symbol);
    const address = normalizeAddress(entry.contractAddress);

    if (!symbol) {
      throw invalidRegistry("Registry entry symbol is invalid.");
    }

    if (!address) {
      throw invalidRegistry(`Registry entry ${entry.symbol} has an invalid address.`);
    }

    if (
      entry.network !== BASE_NETWORK.caip2 ||
      entry.chainId !== BASE_NETWORK.chainId ||
      entry.standard !== "B20" ||
      entry.issuer !== "Coinbase" ||
      entry.status !== "active" ||
      typeof entry.source !== "string" ||
      entry.source.length === 0
    ) {
      throw invalidRegistry(`Registry entry ${entry.symbol} has invalid metadata.`);
    }

    if (symbols.has(symbol)) {
      throw invalidRegistry(`Duplicate stock symbol ${entry.symbol}.`);
    }

    if (addresses.has(address)) {
      throw invalidRegistry(`Duplicate stock address ${entry.contractAddress}.`);
    }

    symbols.add(symbol);
    addresses.add(address);
  }
}

export function isValidEvmAddress(value) {
  return ADDRESS_PATTERN.test(normalizeText(value));
}

export function normalizeAddress(value) {
  const normalized = normalizeText(value);
  return ADDRESS_PATTERN.test(normalized) ? normalized.toLowerCase() : "";
}

function createStock({ symbol, name, contractAddress }) {
  return Object.freeze({
    symbol,
    name,
    network: BASE_NETWORK.caip2,
    chainId: BASE_NETWORK.chainId,
    standard: "B20",
    issuer: "Coinbase",
    contractAddress,
    source: BASE_STOCKS_SOURCE,
    status: "active",
    notes:
      "B20 token metadata is read-only infrastructure data; multiplier and corporate-action semantics must be handled before deriving economic share quantities.",
  });
}

function freezeStock(entry) {
  return Object.freeze({ ...entry });
}

function copyStock(entry) {
  return Object.freeze({ ...entry });
}

function normalizeSymbol(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function invalidRegistry(message) {
  return new StockRegistryError(message, {
    code: STOCK_REGISTRY_CODES.INVALID,
  });
}
