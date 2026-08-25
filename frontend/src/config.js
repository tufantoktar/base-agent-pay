import { createPublicClient, defineChain, http } from "viem";

export const BASE_MAINNET_EXPLORER_URL = "https://basescan.org";
export const BASE_SEPOLIA_EXPLORER_URL = "https://sepolia.basescan.org";
export const DEFAULT_BASE_MAINNET_RECEIPT_CONTRACT_ADDRESS =
  "0x89365D56D7a8795e141e2e6Cf50Fc6015d988be2";
export const DEFAULT_BASE_SEPOLIA_RECEIPT_CONTRACT_ADDRESS =
  "0x2C1bBa87705eE87465c6da9B00fC941f4557c241";

const BASE_MAINNET_CHAIN_ID = 8453;
const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_MAINNET_CAIP2 = "eip155:8453";
export const BASE_MAINNET_USDC_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const viteEnv = import.meta.env ?? {};
const TARGET_CHAIN_ID = Number(viteEnv.VITE_CHAIN_ID ?? BASE_MAINNET_CHAIN_ID);

const NETWORK_CONFIG = {
  [BASE_MAINNET_CHAIN_ID]: {
    id: BASE_MAINNET_CHAIN_ID,
    name: "Base Mainnet",
    nativeCurrency: {
      decimals: 18,
      name: "Ether",
      symbol: "ETH",
    },
    rpcUrl:
      viteEnv.VITE_BASE_MAINNET_RPC_URL ??
      viteEnv.VITE_RPC_URL ??
      "https://mainnet.base.org",
    blockExplorerUrl: BASE_MAINNET_EXPLORER_URL,
    receiptContractAddress:
      viteEnv.VITE_BASE_MAINNET_CONTRACT_ADDRESS?.trim() ||
      viteEnv.VITE_CONTRACT_ADDRESS?.trim() ||
      viteEnv.VITE_RECEIPT_CONTRACT_ADDRESS?.trim() ||
      DEFAULT_BASE_MAINNET_RECEIPT_CONTRACT_ADDRESS,
    testnet: false,
  },
  [BASE_SEPOLIA_CHAIN_ID]: {
    id: BASE_SEPOLIA_CHAIN_ID,
    name: "Base Sepolia",
    nativeCurrency: {
      decimals: 18,
      name: "Sepolia Ether",
      symbol: "ETH",
    },
    rpcUrl:
      viteEnv.VITE_BASE_SEPOLIA_RPC_URL ??
      "https://base-sepolia-rpc.publicnode.com",
    blockExplorerUrl: BASE_SEPOLIA_EXPLORER_URL,
    receiptContractAddress:
      viteEnv.VITE_BASE_SEPOLIA_RECEIPT_CONTRACT_ADDRESS?.trim() ||
      viteEnv.VITE_RECEIPT_CONTRACT_ADDRESS?.trim() ||
      DEFAULT_BASE_SEPOLIA_RECEIPT_CONTRACT_ADDRESS,
    testnet: true,
  },
};

export const BASE_NETWORK_CONFIG =
  NETWORK_CONFIG[TARGET_CHAIN_ID] ?? NETWORK_CONFIG[BASE_MAINNET_CHAIN_ID];

export const BASE_NETWORK = defineChain({
  id: BASE_NETWORK_CONFIG.id,
  name: BASE_NETWORK_CONFIG.name,
  nativeCurrency: BASE_NETWORK_CONFIG.nativeCurrency,
  rpcUrls: {
    default: {
      http: [BASE_NETWORK_CONFIG.rpcUrl],
    },
  },
  blockExplorers: {
    default: {
      name: "BaseScan",
      url: BASE_NETWORK_CONFIG.blockExplorerUrl,
    },
  },
  testnet: BASE_NETWORK_CONFIG.testnet,
});

export const BASE_NETWORK_EXPLORER_URL = BASE_NETWORK_CONFIG.blockExplorerUrl;
export const BASE_NETWORK_HEX_CHAIN_ID = `0x${BASE_NETWORK.id.toString(16)}`;
export const RECEIPT_CONTRACT_ADDRESS = BASE_NETWORK_CONFIG.receiptContractAddress;
export const API_URL = viteEnv.VITE_API_URL ?? "/api/task";
export const PAYMENT_MODE =
  viteEnv.VITE_X402_MODE?.trim().toLowerCase() === "live" ? "live" : "mock";
export const LIVE_PAYMENT_MAX_USDC =
  viteEnv.VITE_X402_MAX_LIVE_PAYMENT_USDC?.trim() || "0.10";

export const publicClient = createPublicClient({
  chain: BASE_NETWORK,
  transport: http(BASE_NETWORK.rpcUrls.default.http[0]),
});
