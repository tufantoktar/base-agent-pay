import { BASE_NETWORK, BASE_NETWORK_HEX_CHAIN_ID } from "./config.js";

export function discoverWallets(onChange) {
  const providers = new Map();

  function addProvider(detail, fallbackName = "Injected Wallet") {
    if (!detail?.provider) {
      return;
    }

    const info = detail.info ?? {};
    const id =
      info.uuid ??
      info.rdns ??
      info.name ??
      fallbackName;

    providers.set(id, {
      id,
      name: info.name ?? fallbackName,
      rdns: info.rdns ?? "",
      icon: info.icon ?? "",
      provider: detail.provider,
      isRabby:
        /rabby/iu.test(info.name ?? "") || /rabby/iu.test(info.rdns ?? ""),
    });

    onChange(sortWallets([...providers.values()]));
  }

  const announce = (event) => addProvider(event.detail);
  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  if (window.ethereum) {
    addProvider(
      {
        info: {
          name: window.ethereum.isRabby ? "Rabby" : "Browser Wallet",
          rdns: window.ethereum.isRabby ? "io.rabby" : "legacy.injected",
        },
        provider: window.ethereum,
      },
      "Browser Wallet",
    );
  }

  return () => {
    window.removeEventListener("eip6963:announceProvider", announce);
  };
}

export async function connectWallet(wallet) {
  const accounts = await wallet.provider.request({
    method: "eth_requestAccounts",
  });
  const chainId = await wallet.provider.request({
    method: "eth_chainId",
  });

  return {
    address: accounts[0],
    chainId,
  };
}

export async function requestBaseNetwork(wallet) {
  try {
    await wallet.provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_NETWORK_HEX_CHAIN_ID }],
    });
  } catch (error) {
    if (error?.code !== 4902) {
      throw error;
    }

    await wallet.provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: BASE_NETWORK_HEX_CHAIN_ID,
          chainName: BASE_NETWORK.name,
          nativeCurrency: BASE_NETWORK.nativeCurrency,
          rpcUrls: BASE_NETWORK.rpcUrls.default.http,
          blockExplorerUrls: [BASE_NETWORK.blockExplorers.default.url],
        },
      ],
    });
  }
}

export function shortAddress(address) {
  if (!address) {
    return "";
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function sortWallets(wallets) {
  return wallets.sort((a, b) => {
    if (a.isRabby && !b.isRabby) {
      return -1;
    }
    if (!a.isRabby && b.isRabby) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
}
