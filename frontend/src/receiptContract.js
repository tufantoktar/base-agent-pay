import { createWalletClient, custom, getAddress } from "viem";

import {
  BASE_NETWORK,
  RECEIPT_CONTRACT_ADDRESS,
  publicClient,
} from "./config.js";
import { BUILDER_DATA_SUFFIX } from "./builderAttribution.js";

export const agentTaskReceiptAbi = [
  {
    type: "function",
    name: "recordReceipt",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "requestHash", type: "bytes32" },
      { name: "resultHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "hasReceipt",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getReceipt",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "requester", type: "address" },
          { name: "taskId", type: "bytes32" },
          { name: "requestHash", type: "bytes32" },
          { name: "resultHash", type: "bytes32" },
          { name: "timestamp", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getReceiptCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

export async function hasReceipt(taskId) {
  return publicClient.readContract({
    address: RECEIPT_CONTRACT_ADDRESS,
    abi: agentTaskReceiptAbi,
    functionName: "hasReceipt",
    args: [taskId],
  });
}

export async function getReceipt(taskId) {
  const receipt = await publicClient.readContract({
    address: RECEIPT_CONTRACT_ADDRESS,
    abi: agentTaskReceiptAbi,
    functionName: "getReceipt",
    args: [taskId],
  });

  return normalizeReceipt(receipt);
}

export async function getReceiptCount() {
  return publicClient.readContract({
    address: RECEIPT_CONTRACT_ADDRESS,
    abi: agentTaskReceiptAbi,
    functionName: "getReceiptCount",
  });
}

export async function recordReceipt({
  provider,
  account,
  taskId,
  requestHash,
  resultHash,
}) {
  const walletClient = createWalletClient({
    account: getAddress(account),
    chain: BASE_NETWORK,
    transport: custom(provider),
    dataSuffix: BUILDER_DATA_SUFFIX,
  });

  return walletClient.writeContract({
    address: RECEIPT_CONTRACT_ADDRESS,
    abi: agentTaskReceiptAbi,
    functionName: "recordReceipt",
    args: [taskId, requestHash, resultHash],
  });
}

function normalizeReceipt(receipt) {
  return {
    requester: receipt.requester ?? receipt[0],
    taskId: receipt.taskId ?? receipt[1],
    requestHash: receipt.requestHash ?? receipt[2],
    resultHash: receipt.resultHash ?? receipt[3],
    timestamp: receipt.timestamp ?? receipt[4],
  };
}
