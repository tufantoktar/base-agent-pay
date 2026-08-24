export const BASE_MAINNET = Object.freeze({
  chainId: 8453,
  chainIdHex: "0x2105",
  caip2: "eip155:8453",
  name: "Base Mainnet",
  rpcUrl:
    process.env.BASE_MAINNET_RPC_URL ??
    process.env.BASE_RPC_URL ??
    "https://mainnet.base.org",
  blockExplorerUrl: "https://basescan.org",
});

export const BASE_SEPOLIA = Object.freeze({
  chainId: 84532,
  chainIdHex: "0x14a34",
  caip2: "eip155:84532",
  name: "Base Sepolia",
  rpcUrl:
    process.env.BASE_SEPOLIA_RPC_URL ??
    "https://base-sepolia-rpc.publicnode.com",
  blockExplorerUrl: "https://sepolia.basescan.org",
});

const TARGET_CHAIN_ID = Number(
  process.env.BASE_CHAIN_ID ?? process.env.CHAIN_ID ?? BASE_MAINNET.chainId,
);

export const BASE_NETWORK = Object.freeze(
  TARGET_CHAIN_ID === BASE_SEPOLIA.chainId ? BASE_SEPOLIA : BASE_MAINNET,
);

export const MOCK_PAYMENT = Object.freeze({
  mode: "mock",
  scheme: "mock-x402",
  assetSymbol: process.env.MOCK_PAYMENT_ASSET ?? "mock-USDC",
  assetAddress: null,
  amount: process.env.MOCK_PAYMENT_AMOUNT ?? "0.01",
  recipient:
    process.env.MOCK_PAYMENT_RECIPIENT ??
    "0x0000000000000000000000000000000000004020",
  facilitator: "local-mock-facilitator",
  description:
    process.env.MOCK_PAYMENT_DESCRIPTION ??
    `Development-only mock payment requirement for a ${BASE_NETWORK.name} AI task.`,
});

export const PAYMENT_HEADER = "x-payment";
export const PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";
