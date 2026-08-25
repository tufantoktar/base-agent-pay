import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_SETTLEMENT_VERIFICATION_CODES,
  BaseSettlementVerificationError,
  ERC20_TRANSFER_TOPIC,
  verifyBaseUsdcTransfer,
} from "./base-settlement-verifier.js";
import { BASE_MAINNET, BASE_MAINNET_USDC } from "./constants.js";

const TX_HASH = `0x${"a".repeat(64)}`;
const PAYER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const AMOUNT = "10000";

test("verifies successful Base USDC Transfer receipt", async () => {
  const result = await verifyBaseUsdcTransfer({
    rpcUrl: BASE_MAINNET.rpcUrl,
    transactionHash: TX_HASH,
    payer: PAYER,
    recipient: RECIPIENT,
    amountAtomic: AMOUNT,
    fetchImpl: createRpcFetch({
      receipt: receiptWithLogs([
        usdcTransferLog({
          from: PAYER,
          to: RECIPIENT,
          amount: AMOUNT,
        }),
      ]),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.transferLog.address, BASE_MAINNET_USDC.address);
});

for (const { name, receipt, expectedCode } of [
  {
    name: "failed tx",
    receipt: receiptWithLogs([], { status: "0x0" }),
    expectedCode: BASE_SETTLEMENT_VERIFICATION_CODES.TX_FAILED,
  },
  {
    name: "missing receipt",
    receipt: null,
    expectedCode: BASE_SETTLEMENT_VERIFICATION_CODES.RECEIPT_MISSING,
  },
  {
    name: "wrong token contract",
    receipt: receiptWithLogs([
      usdcTransferLog({
        token: "0x3333333333333333333333333333333333333333",
        from: PAYER,
        to: RECIPIENT,
        amount: AMOUNT,
      }),
    ]),
    expectedCode: BASE_SETTLEMENT_VERIFICATION_CODES.TRANSFER_MISSING,
  },
  {
    name: "wrong recipient",
    receipt: receiptWithLogs([
      usdcTransferLog({
        from: PAYER,
        to: "0x3333333333333333333333333333333333333333",
        amount: AMOUNT,
      }),
    ]),
    expectedCode: BASE_SETTLEMENT_VERIFICATION_CODES.TRANSFER_MISSING,
  },
  {
    name: "wrong sender",
    receipt: receiptWithLogs([
      usdcTransferLog({
        from: "0x3333333333333333333333333333333333333333",
        to: RECIPIENT,
        amount: AMOUNT,
      }),
    ]),
    expectedCode: BASE_SETTLEMENT_VERIFICATION_CODES.TRANSFER_MISSING,
  },
  {
    name: "wrong amount",
    receipt: receiptWithLogs([
      usdcTransferLog({
        from: PAYER,
        to: RECIPIENT,
        amount: "9999",
      }),
    ]),
    expectedCode: BASE_SETTLEMENT_VERIFICATION_CODES.TRANSFER_MISSING,
  },
  {
    name: "missing Transfer",
    receipt: receiptWithLogs([]),
    expectedCode: BASE_SETTLEMENT_VERIFICATION_CODES.TRANSFER_MISSING,
  },
  {
    name: "malformed logs",
    receipt: receiptWithLogs([
      {
        address: BASE_MAINNET_USDC.address,
        topics: [ERC20_TRANSFER_TOPIC, "0x1234"],
        data: "0x1234",
      },
    ]),
    expectedCode: BASE_SETTLEMENT_VERIFICATION_CODES.TRANSFER_MISSING,
  },
]) {
  test(`rejects settlement proof with ${name}`, async () => {
    const result = await verifyBaseUsdcTransfer({
      rpcUrl: BASE_MAINNET.rpcUrl,
      transactionHash: TX_HASH,
      payer: PAYER,
      recipient: RECIPIENT,
      amountAtomic: AMOUNT,
      fetchImpl: createRpcFetch({ receipt }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, expectedCode);
  });
}

test("rejects settlement proof from non-Base RPC context", async () => {
  const result = await verifyBaseUsdcTransfer({
    rpcUrl: BASE_MAINNET.rpcUrl,
    transactionHash: TX_HASH,
    payer: PAYER,
    recipient: RECIPIENT,
    amountAtomic: AMOUNT,
    fetchImpl: createRpcFetch({
      chainId: "0x1",
      receipt: receiptWithLogs([
        usdcTransferLog({
          from: PAYER,
          to: RECIPIENT,
          amount: AMOUNT,
        }),
      ]),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, BASE_SETTLEMENT_VERIFICATION_CODES.WRONG_CHAIN);
});

test("surfaces Base RPC errors without masking them as success", async () => {
  await assert.rejects(
    () =>
      verifyBaseUsdcTransfer({
        rpcUrl: BASE_MAINNET.rpcUrl,
        transactionHash: TX_HASH,
        payer: PAYER,
        recipient: RECIPIENT,
        amountAtomic: AMOUNT,
        fetchImpl: createRpcFetch({ rpcError: true }),
      }),
    (error) => {
      assert.ok(error instanceof BaseSettlementVerificationError);
      assert.equal(error.code, BASE_SETTLEMENT_VERIFICATION_CODES.RPC_ERROR);
      return true;
    },
  );
});

function createRpcFetch({
  chainId = BASE_MAINNET.chainIdHex,
  receipt,
  rpcError = false,
} = {}) {
  return async (_url, init) => {
    const request = JSON.parse(init.body);
    const result = request.method === "eth_chainId" ? chainId : receipt;
    const body = rpcError
      ? {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: "test rpc error",
          },
        }
      : {
          jsonrpc: "2.0",
          id: request.id,
          result,
        };

    return {
      ok: !rpcError,
      async text() {
        return JSON.stringify(body);
      },
    };
  };
}

function receiptWithLogs(logs, overrides = {}) {
  return {
    status: "0x1",
    logs,
    ...overrides,
  };
}

function usdcTransferLog({
  token = BASE_MAINNET_USDC.address,
  from,
  to,
  amount,
}) {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, topicAddress(from), topicAddress(to)],
    data: wordHex(amount),
  };
}

function topicAddress(address) {
  return `0x${"0".repeat(24)}${address.toLowerCase().slice(2)}`;
}

function wordHex(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}
