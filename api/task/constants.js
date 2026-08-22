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
    "Development-only mock payment requirement for a Base Sepolia AI task.",
});

export const PAYMENT_HEADER = "x-payment";
export const PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";

