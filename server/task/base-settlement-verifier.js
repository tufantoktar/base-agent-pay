import { BASE_MAINNET, BASE_MAINNET_USDC } from "./constants.js";

export const BASE_SETTLEMENT_VERIFICATION_CODES = Object.freeze({
  CONFIG_INVALID: "BASE_SETTLEMENT_CONFIG_INVALID",
  RPC_ERROR: "BASE_SETTLEMENT_RPC_ERROR",
  WRONG_CHAIN: "BASE_SETTLEMENT_WRONG_CHAIN",
  RECEIPT_MISSING: "BASE_SETTLEMENT_RECEIPT_MISSING",
  TX_FAILED: "BASE_SETTLEMENT_TX_FAILED",
  TRANSFER_MISSING: "BASE_SETTLEMENT_TRANSFER_MISSING",
});

export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;
const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/u;
const WORD_HEX_PATTERN = /^0x[a-fA-F0-9]{64}$/u;
const JSON_RPC_TIMEOUT_MS = 10_000;

export class BaseSettlementVerificationError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = "BaseSettlementVerificationError";
    this.code = code ?? BASE_SETTLEMENT_VERIFICATION_CODES.RPC_ERROR;
  }
}

export async function verifyBaseUsdcTransfer({
  rpcUrl = BASE_MAINNET.rpcUrl,
  transactionHash,
  payer,
  recipient,
  amountAtomic,
  fetchImpl = globalThis.fetch,
  timeoutMs = JSON_RPC_TIMEOUT_MS,
} = {}) {
  const expectedTxHash = normalizeTxHash(transactionHash);
  const expectedPayer = normalizeAddress(payer);
  const expectedRecipient = normalizeAddress(recipient);
  const expectedAmount = normalizeAtomicAmount(amountAtomic);

  if (!isValidUrl(rpcUrl) || !expectedTxHash || !expectedPayer || !expectedRecipient) {
    return fail(
      BASE_SETTLEMENT_VERIFICATION_CODES.CONFIG_INVALID,
      "Base settlement verification input is invalid.",
    );
  }

  if (expectedAmount === null) {
    return fail(
      BASE_SETTLEMENT_VERIFICATION_CODES.CONFIG_INVALID,
      "Base settlement amount is invalid.",
    );
  }

  let chainId;
  let receipt;
  try {
    chainId = await callJsonRpc({
      rpcUrl,
      method: "eth_chainId",
      params: [],
      fetchImpl,
      timeoutMs,
    });
    receipt = await callJsonRpc({
      rpcUrl,
      method: "eth_getTransactionReceipt",
      params: [expectedTxHash],
      fetchImpl,
      timeoutMs,
    });
  } catch (error) {
    throw new BaseSettlementVerificationError("Base RPC verification failed.", {
      code: BASE_SETTLEMENT_VERIFICATION_CODES.RPC_ERROR,
      cause: error,
    });
  }

  if (normalizeHexQuantity(chainId) !== BASE_MAINNET.chainIdHex) {
    return fail(
      BASE_SETTLEMENT_VERIFICATION_CODES.WRONG_CHAIN,
      "Base RPC did not report chain ID 8453.",
    );
  }

  if (!receipt || typeof receipt !== "object") {
    return fail(
      BASE_SETTLEMENT_VERIFICATION_CODES.RECEIPT_MISSING,
      "Settlement transaction receipt was not found.",
    );
  }

  if (!isSuccessfulReceiptStatus(receipt.status)) {
    return fail(
      BASE_SETTLEMENT_VERIFICATION_CODES.TX_FAILED,
      "Settlement transaction did not succeed.",
    );
  }

  const transferLog = findMatchingUsdcTransfer({
    logs: Array.isArray(receipt.logs) ? receipt.logs : [],
    expectedPayer,
    expectedRecipient,
    expectedAmount,
  });

  if (!transferLog) {
    return fail(
      BASE_SETTLEMENT_VERIFICATION_CODES.TRANSFER_MISSING,
      "Settlement transaction did not include the expected USDC transfer.",
    );
  }

  return {
    ok: true,
    receipt,
    transferLog,
  };
}

async function callJsonRpc({ rpcUrl, method, params, fetchImpl, timeoutMs }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch is unavailable for Base RPC verification.");
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

    if (!response.ok || body?.error) {
      throw new Error("Base RPC returned an error.");
    }

    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}

function findMatchingUsdcTransfer({
  logs,
  expectedPayer,
  expectedRecipient,
  expectedAmount,
}) {
  return logs.find((log) => {
    const address = normalizeAddress(log?.address);
    const topics = Array.isArray(log?.topics) ? log.topics : [];
    if (
      address !== normalizeAddress(BASE_MAINNET_USDC.address) ||
      normalizeText(topics[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC
    ) {
      return false;
    }

    const from = addressFromTopic(topics[1]);
    const to = addressFromTopic(topics[2]);
    const value = amountFromData(log?.data);

    return from === expectedPayer && to === expectedRecipient && value === expectedAmount;
  });
}

function addressFromTopic(topic) {
  const normalized = normalizeText(topic);
  if (!WORD_HEX_PATTERN.test(normalized)) {
    return "";
  }

  return normalizeAddress(`0x${normalized.slice(-40)}`);
}

function amountFromData(data) {
  const normalized = normalizeText(data);
  if (!WORD_HEX_PATTERN.test(normalized)) {
    return null;
  }

  return BigInt(normalized).toString();
}

function normalizeAtomicAmount(amount) {
  const value = normalizeText(amount);
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    return null;
  }

  return BigInt(value).toString();
}

function normalizeHexQuantity(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!/^0x[0-9a-f]+$/u.test(normalized)) {
    return "";
  }

  return `0x${BigInt(normalized).toString(16)}`;
}

function normalizeAddress(value) {
  const normalized = normalizeText(value);
  return ADDRESS_PATTERN.test(normalized) ? normalized.toLowerCase() : "";
}

function normalizeTxHash(value) {
  const normalized = normalizeText(value);
  return TX_HASH_PATTERN.test(normalized) ? normalized : "";
}

function isSuccessfulReceiptStatus(status) {
  const normalized = normalizeText(status).toLowerCase();
  return normalized === "0x1" || normalized === "success";
}

function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function fail(code, reason) {
  return {
    ok: false,
    code,
    reason,
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
