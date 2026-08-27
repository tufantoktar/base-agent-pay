import {
  DEFAULT_STOCK_REGISTRY,
  STOCK_REGISTRY_CODES,
  StockRegistryError,
  normalizeAddress,
} from "./stock-registry.js";

export const STOCK_RPC_CODES = Object.freeze({
  NOT_SUPPORTED: "STOCK_NOT_SUPPORTED",
  REGISTRY_INVALID: "STOCK_REGISTRY_INVALID",
  CHAIN_MISMATCH: "STOCK_RPC_CHAIN_MISMATCH",
  TIMEOUT: "STOCK_RPC_TIMEOUT",
  INVALID_RESPONSE: "STOCK_RPC_INVALID_RESPONSE",
  METADATA_MISMATCH: "STOCK_METADATA_MISMATCH",
});

export class StockRpcError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = "StockRpcError";
    this.code = code ?? STOCK_RPC_CODES.INVALID_RESPONSE;
  }
}

export const ERC20_METADATA_SELECTORS = Object.freeze({
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
});

const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_ID_BIGINT = 8453n;
const BASE_CHAIN_ID_HEX = "0x2105";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/u;

export class B20DataAdapter {
  constructor({
    rpcClient,
    registry = DEFAULT_STOCK_REGISTRY,
    clock = () => new Date(),
    rpcSource = "Base Mainnet",
  } = {}) {
    if (!rpcClient || typeof rpcClient.request !== "function") {
      throw new StockRpcError("A read-only RPC client is required.", {
        code: STOCK_RPC_CODES.INVALID_RESPONSE,
      });
    }

    this.rpcClient = rpcClient;
    this.registry = registry;
    this.clock = clock;
    this.rpcSource = rpcSource;
  }

  async getStockSnapshot(symbol) {
    const stock = this.resolveStock(symbol);
    const chainId = await this.readChainId();

    if (chainId !== BASE_CHAIN_ID_BIGINT) {
      throw new StockRpcError("Stock RPC must be connected to Base Mainnet.", {
        code: STOCK_RPC_CODES.CHAIN_MISMATCH,
      });
    }

    const [blockNumber, tokenName, tokenSymbol, decimals, totalSupplyAtomic] =
      await Promise.all([
        this.callRpc("eth_blockNumber", []),
        this.readOptionalString(stock.contractAddress, ERC20_METADATA_SELECTORS.name),
        this.readOptionalString(stock.contractAddress, ERC20_METADATA_SELECTORS.symbol),
        this.readOptionalUint(stock.contractAddress, ERC20_METADATA_SELECTORS.decimals),
        this.readOptionalUint(stock.contractAddress, ERC20_METADATA_SELECTORS.totalSupply),
      ]);

    if (!isHexQuantity(blockNumber)) {
      throw new StockRpcError("Base RPC returned an invalid block number.", {
        code: STOCK_RPC_CODES.INVALID_RESPONSE,
      });
    }

    validateMetadata({ stock, tokenName, tokenSymbol });

    return Object.freeze({
      asset: Object.freeze({
        symbol: stock.symbol,
        name: stock.name,
        standard: stock.standard,
        issuer: stock.issuer,
        contractAddress: stock.contractAddress,
      }),
      network: Object.freeze({
        chainId: BASE_CHAIN_ID,
        caip2: "eip155:8453",
      }),
      onchain: Object.freeze({
        tokenName,
        tokenSymbol,
        decimals,
        totalSupplyAtomic,
        blockNumber: BigInt(blockNumber).toString(),
      }),
      provenance: Object.freeze({
        registrySource: stock.source,
        rpcSource: this.rpcSource,
        observedAt: this.clock().toISOString(),
      }),
    });
  }

  resolveStock(symbol) {
    try {
      return this.registry.getBySymbol(symbol);
    } catch (error) {
      if (error instanceof StockRegistryError) {
        throw new StockRpcError(error.message, {
          code:
            error.code === STOCK_REGISTRY_CODES.NOT_SUPPORTED
              ? STOCK_RPC_CODES.NOT_SUPPORTED
              : STOCK_RPC_CODES.REGISTRY_INVALID,
          cause: error,
        });
      }
      throw error;
    }
  }

  async readChainId() {
    const chainId = await this.callRpc("eth_chainId", []);
    if (!isHexQuantity(chainId)) {
      throw new StockRpcError("Base RPC returned an invalid chain ID.", {
        code: STOCK_RPC_CODES.INVALID_RESPONSE,
      });
    }
    return BigInt(chainId);
  }

  async readOptionalString(contractAddress, selector) {
    const result = await this.ethCall(contractAddress, selector);
    if (result === null) {
      return null;
    }
    return parseAbiString(result);
  }

  async readOptionalUint(contractAddress, selector) {
    const result = await this.ethCall(contractAddress, selector);
    if (result === null) {
      return null;
    }
    return parseAbiUint(result);
  }

  async ethCall(contractAddress, selector) {
    const result = await this.callRpc("eth_call", [
      {
        to: contractAddress,
        data: selector,
      },
      "latest",
    ]);

    if (result === "0x") {
      return null;
    }

    if (!isHexData(result)) {
      throw new StockRpcError("Base RPC returned malformed eth_call data.", {
        code: STOCK_RPC_CODES.INVALID_RESPONSE,
      });
    }

    return result;
  }

  async callRpc(method, params) {
    if (!["eth_chainId", "eth_blockNumber", "eth_call"].includes(method)) {
      throw new StockRpcError("Unsupported stock RPC method.", {
        code: STOCK_RPC_CODES.INVALID_RESPONSE,
      });
    }

    try {
      return await this.rpcClient.request({ method, params });
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === STOCK_RPC_CODES.TIMEOUT) {
        throw new StockRpcError("Stock RPC request timed out.", {
          code: STOCK_RPC_CODES.TIMEOUT,
          cause: error,
        });
      }
      throw new StockRpcError("Stock RPC request failed.", {
        code: STOCK_RPC_CODES.INVALID_RESPONSE,
        cause: error,
      });
    }
  }
}

export function createJsonRpcClient({
  rpcUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!isValidUrl(rpcUrl)) {
    throw new StockRpcError("A valid Base RPC URL is required.", {
      code: STOCK_RPC_CODES.INVALID_RESPONSE,
    });
  }

  if (typeof fetchImpl !== "function") {
    throw new StockRpcError("Fetch is unavailable for stock RPC reads.", {
      code: STOCK_RPC_CODES.INVALID_RESPONSE,
    });
  }

  return Object.freeze({
    async request({ method, params }) {
      if (!["eth_chainId", "eth_blockNumber", "eth_call"].includes(method)) {
        throw new StockRpcError("Unsupported stock RPC method.", {
          code: STOCK_RPC_CODES.INVALID_RESPONSE,
        });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(rpcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
          }),
          signal: controller.signal,
        });

        const text = await response.text();
        const body = text.length > 0 ? JSON.parse(text) : {};

        if (!response.ok || body?.error || !("result" in body)) {
          throw new StockRpcError("Base RPC returned an invalid response.", {
            code: STOCK_RPC_CODES.INVALID_RESPONSE,
          });
        }

        return body.result;
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new StockRpcError("Stock RPC request timed out.", {
            code: STOCK_RPC_CODES.TIMEOUT,
            cause: error,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

function validateMetadata({ stock, tokenName, tokenSymbol }) {
  if (
    tokenSymbol !== null &&
    normalizeStockSymbol(tokenSymbol) !== normalizeStockSymbol(stock.symbol)
  ) {
    throw new StockRpcError("Onchain token symbol does not match registry.", {
      code: STOCK_RPC_CODES.METADATA_MISMATCH,
    });
  }

  if (tokenName !== null && !nameMatchesRegistry(tokenName, stock.name)) {
    throw new StockRpcError("Onchain token name does not match registry.", {
      code: STOCK_RPC_CODES.METADATA_MISMATCH,
    });
  }
}

function parseAbiString(hex) {
  const bytes = hexToBytes(hex);

  if (bytes.length === 32) {
    return decodeBytes32String(bytes);
  }

  if (bytes.length < 64) {
    throw new StockRpcError("ERC-20 string response is too short.", {
      code: STOCK_RPC_CODES.INVALID_RESPONSE,
    });
  }

  const offset = wordToNumber(bytes.slice(0, 32));
  const length = wordToNumber(bytes.slice(offset, offset + 32));
  const start = offset + 32;
  const end = start + length;

  if (offset !== 32 || end > bytes.length) {
    throw new StockRpcError("ERC-20 string response has invalid ABI offsets.", {
      code: STOCK_RPC_CODES.INVALID_RESPONSE,
    });
  }

  return new TextDecoder().decode(bytes.slice(start, end));
}

function parseAbiUint(hex) {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) {
    throw new StockRpcError("ERC-20 uint response must be 32 bytes.", {
      code: STOCK_RPC_CODES.INVALID_RESPONSE,
    });
  }
  return bytesToBigInt(bytes).toString();
}

function decodeBytes32String(bytes) {
  const end = bytes.findIndex((byte) => byte === 0);
  return new TextDecoder().decode(bytes.slice(0, end === -1 ? bytes.length : end));
}

function wordToNumber(bytes) {
  const value = bytesToBigInt(bytes);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StockRpcError("ABI offset exceeds safe integer range.", {
      code: STOCK_RPC_CODES.INVALID_RESPONSE,
    });
  }
  return Number(value);
}

function bytesToBigInt(bytes) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return BigInt(`0x${hex}`);
}

function hexToBytes(hex) {
  if (!isHexData(hex) || hex.length % 2 !== 0) {
    throw new StockRpcError("Hex data is malformed.", {
      code: STOCK_RPC_CODES.INVALID_RESPONSE,
    });
  }

  const body = hex.slice(2);
  const bytes = [];
  for (let index = 0; index < body.length; index += 2) {
    bytes.push(Number.parseInt(body.slice(index, index + 2), 16));
  }
  return Uint8Array.from(bytes);
}

function isHexData(value) {
  return typeof value === "string" && HEX_PATTERN.test(value) && value.length >= 2;
}

function isHexQuantity(value) {
  return typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value);
}

function nameMatchesRegistry(tokenName, registryName) {
  const token = normalizeName(tokenName);
  const registry = normalizeName(registryName);
  return token === registry || token.includes(registry) || registry.includes(token);
}

function normalizeStockSymbol(value) {
  return String(value).trim().toUpperCase();
}

function normalizeName(value) {
  return String(value).trim().toLowerCase();
}

function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function assertRegistryAddressOnly({ requestedAddress, stock }) {
  if (normalizeAddress(requestedAddress) !== normalizeAddress(stock?.contractAddress)) {
    throw new StockRpcError("Arbitrary stock contract addresses are not supported.", {
      code: STOCK_RPC_CODES.NOT_SUPPORTED,
    });
  }
}

export { BASE_CHAIN_ID, BASE_CHAIN_ID_HEX };
