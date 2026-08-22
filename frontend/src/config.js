import { createPublicClient, defineChain, http } from "viem";

export const BASE_SEPOLIA = defineChain({
  id: Number(import.meta.env.VITE_CHAIN_ID ?? 84532),
  name: "Base Sepolia",
  nativeCurrency: {
    decimals: 18,
    name: "Sepolia Ether",
    symbol: "ETH",
  },
  rpcUrls: {
    default: {
      http: [
        import.meta.env.VITE_BASE_SEPOLIA_RPC_URL ??
          "https://base-sepolia-rpc.publicnode.com",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "BaseScan",
      url: "https://sepolia.basescan.org",
    },
  },
  testnet: true,
});

export const BASE_SEPOLIA_HEX_CHAIN_ID = `0x${BASE_SEPOLIA.id.toString(16)}`;
export const RECEIPT_CONTRACT_ADDRESS =
  import.meta.env.VITE_RECEIPT_CONTRACT_ADDRESS ?? "";
export const API_URL = import.meta.env.VITE_API_URL ?? "/api/task";

export const publicClient = createPublicClient({
  chain: BASE_SEPOLIA,
  transport: http(BASE_SEPOLIA.rpcUrls.default.http[0]),
});

