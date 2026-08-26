import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import {
  createWalletClient,
  custom,
  getAddress,
  isAddress,
  recoverTypedDataAddress,
} from "viem";

import {
  BASE_MAINNET_CAIP2,
  BASE_MAINNET_USDC_ADDRESS,
  BASE_NETWORK,
} from "./config.js";
import { DEMO_CURRENCY, parseUsdcAmount } from "./mandatePolicy.js";

const BASE_MAINNET_CHAIN_ID = 8453;

export function parsePaymentRequiredHeader(headerValue) {
  if (!headerValue) {
    throw new Error("PAYMENT-REQUIRED header is missing.");
  }

  return decodePaymentRequiredHeader(headerValue);
}

export function selectLivePaymentRequirements(paymentRequired) {
  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
  return (
    accepts.find(
      (entry) =>
        entry?.scheme === "exact" &&
        entry.network === BASE_MAINNET_CAIP2 &&
        normalizeAddress(entry.asset) === normalizeAddress(BASE_MAINNET_USDC_ADDRESS),
    ) ?? null
  );
}

export function validateLivePaymentRequirement({
  paymentRequired,
  request,
  liveMaxUsdc,
  now = new Date(),
}) {
  const requirements = selectLivePaymentRequirements(paymentRequired);
  if (!requirements) {
    return deny("Live payment does not offer exact Base Mainnet USDC.");
  }

  if (
    normalizeAddress(requirements.asset) !==
    normalizeAddress(BASE_MAINNET_USDC_ADDRESS)
  ) {
    return deny("Live payment asset is not official Base USDC.");
  }

  if (requirements.network !== BASE_MAINNET_CAIP2) {
    return deny("Live payment network is not Base Mainnet.");
  }

  if (requirements.extra?.assetTransferMethod !== "eip3009") {
    return deny("Live payment must use EIP-3009 authorization.");
  }

  const maxTimeoutSeconds = Number(requirements.maxTimeoutSeconds);
  if (!Number.isFinite(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    return deny("Live payment authorization expiry is invalid.");
  }

  if (request.currency !== DEMO_CURRENCY || request.mandate?.currency !== DEMO_CURRENCY) {
    return deny("Live payment requires a USDC mandate.");
  }

  if (!isAddress(requirements.payTo)) {
    return deny("Live payment recipient is invalid.");
  }

  if (normalizeAddress(request.counterparty) !== normalizeAddress(requirements.payTo)) {
    return deny("Live payment recipient does not match the task counterparty.");
  }

  const allowedCounterparties = Array.isArray(request.mandate?.allowedCounterparties)
    ? request.mandate.allowedCounterparties.map((entry) => normalizeAddress(entry))
    : [];
  if (!allowedCounterparties.includes(normalizeAddress(requirements.payTo))) {
    return deny("Live payment recipient is not allowed by the mandate.");
  }

  if (!request.mandate?.allowedScopes?.includes(request.scope)) {
    return deny("Task scope is not allowed by the mandate.");
  }

  const expiresAt = Date.parse(request.mandate?.expiresAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs) || nowMs >= expiresAt) {
    return deny("Mandate is expired or invalid.");
  }

  let requestedAmount;
  let mandateMax;
  let liveMax;
  try {
    requestedAmount = parseUsdcAmount(request.amount);
    mandateMax = parseUsdcAmount(request.mandate.maxSpendPerTask);
    liveMax = parseUsdcAmount(liveMaxUsdc);
  } catch {
    return deny("USDC amount is invalid.");
  }

  if (requestedAmount <= 0n || requestedAmount !== BigInt(requirements.amount)) {
    return deny("Live payment amount does not match the requested spend.");
  }

  if (requestedAmount > mandateMax) {
    return deny("Live payment exceeds mandate max spend.");
  }

  if (requestedAmount > liveMax) {
    return deny("Live payment exceeds the global live cap.");
  }

  return {
    ok: true,
    requirements,
  };
}

export async function createLivePaymentSignatureHeaders({
  paymentRequired,
  provider,
  account,
  rpcUrl,
}) {
  const signer = await createInjectedWalletSigner({ provider, account });
  const client = new x402Client((version, requirements) => {
    const selected = requirements.find(
      (entry) =>
        version === 2 &&
        entry.scheme === "exact" &&
        entry.network === BASE_MAINNET_CAIP2 &&
        normalizeAddress(entry.asset) === normalizeAddress(BASE_MAINNET_USDC_ADDRESS),
    );

    if (!selected) {
      throw new Error("No supported exact Base USDC payment requirements found.");
    }

    return selected;
  });

  registerExactEvmScheme(client, {
    signer,
    networks: [BASE_MAINNET_CAIP2],
    schemeOptions: {
      [BASE_NETWORK.id]: {
        rpcUrl: rpcUrl ?? BASE_NETWORK.rpcUrls.default.http[0],
      },
    },
  });

  const httpClient = new x402HTTPClient(client);
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const authorization = paymentPayload?.payload?.authorization;
  if (normalizeAddress(authorization?.from) !== normalizeAddress(account)) {
    throw new Error("Wallet signer does not match the connected account.");
  }
  assertAuthorizationFresh(authorization);

  return {
    headers: httpClient.encodePaymentSignatureHeader(paymentPayload),
    paymentPayload,
  };
}

async function createInjectedWalletSigner({ provider, account }) {
  if (!provider?.request) {
    throw new Error("Injected wallet provider is unavailable.");
  }

  const address = getAddress(account);
  const walletClient = createWalletClient({
    account: address,
    chain: BASE_NETWORK,
    transport: custom(provider),
  });
  const accounts = await provider
    .request({ method: "eth_accounts" })
    .catch(() => []);
  if (
    Array.isArray(accounts) &&
    accounts.length > 0 &&
    !accounts.some((entry) => normalizeAddress(entry) === normalizeAddress(address))
  ) {
    throw new Error("Connected wallet account changed before signing.");
  }

  return {
    address,
    async signTypedData(typedData) {
      assertBaseUsdcEip3009TypedData(typedData);
      const signature = await walletClient.signTypedData({
        account: address,
        ...typedData,
      });
      const recoveredAddress = await recoverTypedDataAddress({
        ...typedData,
        signature,
      });
      if (normalizeAddress(recoveredAddress) !== normalizeAddress(address)) {
        throw new Error("Wallet signature recovery does not match the connected account.");
      }

      return signature;
    },
  };
}

function assertBaseUsdcEip3009TypedData(typedData) {
  const domain = typedData?.domain ?? {};
  if (
    domain.name !== "USD Coin" ||
    domain.version !== "2" ||
    Number(domain.chainId) !== BASE_MAINNET_CHAIN_ID ||
    normalizeAddress(domain.verifyingContract) !==
      normalizeAddress(BASE_MAINNET_USDC_ADDRESS) ||
    typedData?.primaryType !== "TransferWithAuthorization"
  ) {
    throw new Error("Live payment signature domain is not Base Mainnet USDC EIP-3009.");
  }
}

function assertAuthorizationFresh(authorization) {
  const validBefore = Number(authorization?.validBefore);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(validBefore) || validBefore <= now) {
    throw new Error("Live payment authorization is expired.");
  }
}

function deny(reason) {
  return {
    ok: false,
    reason,
  };
}

function normalizeAddress(value) {
  return typeof value === "string" && isAddress(value) ? getAddress(value).toLowerCase() : "";
}
