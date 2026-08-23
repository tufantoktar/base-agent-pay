import { useEffect, useMemo, useState } from "react";
import { isAddress } from "viem";

import { requestPaymentRequirement, submitMockPaidTask } from "./apiClient.js";
import { BASE_BUILDER_CODE } from "./builderAttribution.js";
import {
  BASE_SEPOLIA,
  BASE_SEPOLIA_EXPLORER_URL,
  BASE_SEPOLIA_HEX_CHAIN_ID,
  RECEIPT_CONTRACT_ADDRESS,
  publicClient,
} from "./config.js";
import {
  getReceipt,
  hasReceipt,
  recordReceipt,
} from "./receiptContract.js";
import {
  connectWallet,
  discoverWallets,
  requestBaseSepolia,
  shortAddress,
} from "./walletDiscovery.js";

const TASK_TYPES = [
  { value: "summarize", label: "Summarize" },
  { value: "rewrite", label: "Rewrite" },
  { value: "classify", label: "Classify" },
  { value: "structured-answer", label: "Structured Answer" },
];

const PAYMENT_STATUS = {
  idle: "Not requested",
  required: "Payment required",
  awaiting: "Awaiting payment",
  verified: "Payment verified",
  failed: "Failed",
};

const RECEIPT_STATUS = {
  waiting: "Ready to record",
  ready: "Ready to record",
  confirming: "Confirm in wallet",
  pending: "Transaction pending",
  recorded: "Receipt recorded",
  already: "Already recorded",
  failed: "Failed",
};

export default function App() {
  const [taskType, setTaskType] = useState("summarize");
  const [input, setInput] = useState(
    "Base Agent Pay lets a user request a small AI task, complete an x402-style payment flow on Base Sepolia, and optionally record a task receipt onchain.",
  );
  const [paymentStatus, setPaymentStatus] = useState("idle");
  const [paymentRequirement, setPaymentRequirement] = useState(null);
  const [taskResult, setTaskResult] = useState(null);
  const [error, setError] = useState("");
  const [wallets, setWallets] = useState([]);
  const [selectedWalletId, setSelectedWalletId] = useState("");
  const [walletState, setWalletState] = useState({
    address: "",
    chainId: "",
  });
  const [receiptState, setReceiptState] = useState({
    status: "waiting",
    message: "Complete a mock-paid task before recording an onchain receipt.",
    txHash: "",
    receipt: null,
    isRecorded: null,
  });
  const [rpcStatus, setRpcStatus] = useState("Checking");

  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.id === selectedWalletId) ?? wallets[0],
    [selectedWalletId, wallets],
  );

  const receiptAddressConfigured =
    RECEIPT_CONTRACT_ADDRESS && isAddress(RECEIPT_CONTRACT_ADDRESS);
  const hasReceiptPayload = Boolean(
    taskResult?.taskId && taskResult?.requestHash && taskResult?.resultHash,
  );
  const walletConnected = Boolean(walletState.address);
  const walletOnBaseSepolia =
    walletState.chainId?.toLowerCase() === BASE_SEPOLIA_HEX_CHAIN_ID;
  const receiptWritePending =
    receiptState.status === "confirming" || receiptState.status === "pending";
  const canRecordReceipt = Boolean(
    hasReceiptPayload &&
      selectedWallet &&
      walletConnected &&
      walletOnBaseSepolia &&
      receiptAddressConfigured &&
      receiptState.isRecorded === false &&
      !receiptWritePending,
  );
  const contractExplorerUrl = receiptAddressConfigured
    ? `${BASE_SEPOLIA_EXPLORER_URL}/address/${RECEIPT_CONTRACT_ADDRESS}`
    : "";
  const txExplorerUrl = receiptState.txHash
    ? `${BASE_SEPOLIA_EXPLORER_URL}/tx/${receiptState.txHash}`
    : "";

  useEffect(() => discoverWallets(setWallets), []);

  useEffect(() => {
    if (!selectedWalletId && wallets[0]) {
      setSelectedWalletId(wallets[0].id);
    }
  }, [selectedWalletId, wallets]);

  useEffect(() => {
    let cancelled = false;

    publicClient
      .getBlockNumber()
      .then(() => {
        if (!cancelled) {
          setRpcStatus("Online");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRpcStatus("Unavailable");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const provider = selectedWallet?.provider;
    if (!provider?.on) {
      return undefined;
    }

    function handleAccountsChanged(accounts = []) {
      setWalletState((current) => ({
        ...current,
        address: accounts[0] ?? "",
      }));

      if (!accounts[0]) {
        setReceiptState((current) => ({
          ...current,
          status: current.status === "pending" ? "failed" : current.status,
          message:
            current.status === "pending"
              ? "Wallet disconnected before the transaction finished."
              : current.message,
        }));
      }
    }

    function handleChainChanged(chainId) {
      setWalletState((current) => ({
        ...current,
        chainId,
      }));
    }

    function handleDisconnect() {
      setWalletState({
        address: "",
        chainId: "",
      });
      setReceiptState((current) => ({
        ...current,
        status: current.status === "pending" ? "failed" : current.status,
        message:
          current.status === "pending"
            ? "Wallet disconnected before the transaction finished."
            : current.message,
      }));
    }

    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);
    provider.on("disconnect", handleDisconnect);

    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
      provider.removeListener?.("disconnect", handleDisconnect);
    };
  }, [selectedWallet]);

  useEffect(() => {
    let cancelled = false;

    async function checkReceiptState() {
      if (!hasReceiptPayload) {
        setReceiptState({
          status: "waiting",
          message: "Complete a mock-paid task before recording an onchain receipt.",
          txHash: "",
          receipt: null,
          isRecorded: null,
        });
        return;
      }

      if (!receiptAddressConfigured) {
        setReceiptState({
          status: "failed",
          message: "Receipt contract address is not configured.",
          txHash: "",
          receipt: null,
          isRecorded: null,
        });
        return;
      }

      setReceiptState({
        status: "ready",
        message: "Checking Base Sepolia for an existing receipt.",
        txHash: "",
        receipt: null,
        isRecorded: null,
      });

      try {
        const receiptStatus = await readReceiptStatus(taskResult.taskId);
        if (cancelled) {
          return;
        }

        if (receiptStatus.isRecorded) {
          setReceiptState({
            status: "already",
            message: "Receipt already recorded on Base Sepolia.",
            txHash: "",
            receipt: receiptStatus.receipt,
            isRecorded: true,
          });
          return;
        }

        setReceiptState({
          status: "ready",
          message: "Ready to record on Base Sepolia with your connected wallet.",
          txHash: "",
          receipt: null,
          isRecorded: false,
        });
      } catch (readError) {
        if (cancelled) {
          return;
        }

        setReceiptState({
          status: "failed",
          message: toReceiptErrorMessage(readError),
          txHash: "",
          receipt: null,
          isRecorded: null,
        });
      }
    }

    checkReceiptState();

    return () => {
      cancelled = true;
    };
  }, [
    hasReceiptPayload,
    receiptAddressConfigured,
    taskResult?.taskId,
    taskResult?.requestHash,
    taskResult?.resultHash,
  ]);

  async function handleRequestTask(event) {
    event.preventDefault();
    setError("");
    setTaskResult(null);
    setPaymentRequirement(null);
    setPaymentStatus("idle");
    setReceiptState({
      status: "waiting",
      message: "Complete a mock-paid task before recording an onchain receipt.",
      txHash: "",
      receipt: null,
      isRecorded: null,
    });

    try {
      const requirement = await requestPaymentRequirement({
        taskType,
        input,
      });
      setPaymentRequirement(requirement);
      setPaymentStatus("required");
    } catch (requestError) {
      setError(requestError.message);
      setPaymentStatus("failed");
    }
  }

  async function handleMockPayment() {
    if (!paymentRequirement?.mockPaymentHeader) {
      return;
    }

    setError("");
    setPaymentStatus("awaiting");
    try {
      const result = await submitMockPaidTask(
        { taskType, input },
        paymentRequirement.mockPaymentHeader,
      );
      setTaskResult(result);
      setPaymentStatus("verified");
    } catch (paymentError) {
      setError(paymentError.message);
      setPaymentStatus("failed");
    }
  }

  async function handleConnectWallet() {
    if (!selectedWallet) {
      setError("No injected wallet detected.");
      return;
    }

    setError("");
    try {
      const nextWalletState = await connectWallet(selectedWallet);
      setWalletState(nextWalletState);
    } catch (connectError) {
      setError(connectError.message);
    }
  }

  async function handleSwitchNetwork() {
    if (!selectedWallet) {
      return;
    }

    setError("");
    try {
      await requestBaseSepolia(selectedWallet);
      const nextWalletState = await connectWallet(selectedWallet);
      setWalletState(nextWalletState);
    } catch (switchError) {
      setError(switchError.message);
    }
  }

  async function handleRecordReceipt() {
    setError("");

    if (!hasReceiptPayload) {
      setReceiptState({
        status: "failed",
        message: "Generate a task result before recording a receipt.",
        txHash: "",
        receipt: null,
        isRecorded: null,
      });
      return;
    }

    if (!selectedWallet) {
      setReceiptState({
        status: "failed",
        message: "Select an injected wallet before recording a receipt.",
        txHash: "",
        receipt: null,
        isRecorded: false,
      });
      return;
    }

    if (!walletConnected) {
      setReceiptState({
        status: "failed",
        message: "Connect your wallet before recording a receipt.",
        txHash: "",
        receipt: null,
        isRecorded: false,
      });
      return;
    }

    if (!walletOnBaseSepolia) {
      setReceiptState({
        status: "failed",
        message: "Switch your wallet to Base Sepolia before recording.",
        txHash: "",
        receipt: null,
        isRecorded: false,
      });
      return;
    }

    if (!receiptAddressConfigured) {
      setReceiptState({
        status: "failed",
        message: "Receipt contract address is not configured.",
        txHash: "",
        receipt: null,
        isRecorded: null,
      });
      return;
    }

    if (receiptWritePending) {
      return;
    }

    try {
      setReceiptState({
        status: "confirming",
        message: "Checking for duplicates, then confirm in your wallet.",
        txHash: "",
        receipt: null,
        isRecorded: false,
      });

      const beforeWrite = await readReceiptStatus(taskResult.taskId);
      if (beforeWrite.isRecorded) {
        setReceiptState({
          status: "already",
          message: "Receipt already recorded.",
          txHash: "",
          receipt: beforeWrite.receipt,
          isRecorded: true,
        });
        return;
      }

      const txHash = await recordReceipt({
        provider: selectedWallet.provider,
        account: walletState.address,
        taskId: taskResult.taskId,
        requestHash: taskResult.requestHash,
        resultHash: taskResult.resultHash,
      });

      setReceiptState({
        status: "pending",
        message: "Transaction submitted. Waiting for Base Sepolia confirmation.",
        txHash,
        receipt: null,
        isRecorded: false,
      });

      const txReceipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      if (txReceipt.status !== "success") {
        throw new Error("Receipt transaction reverted on Base Sepolia.");
      }

      const afterWrite = await readReceiptStatus(taskResult.taskId);
      if (!afterWrite.isRecorded) {
        throw new Error("Transaction succeeded, but the receipt was not found.");
      }

      setReceiptState({
        status: "recorded",
        message: "Receipt recorded on Base Sepolia.",
        txHash,
        receipt: afterWrite.receipt,
        isRecorded: true,
      });
    } catch (recordError) {
      if (isDuplicateReceiptError(recordError)) {
        try {
          const duplicateReceipt = await readReceiptStatus(taskResult.taskId);
          setReceiptState({
            status: "already",
            message: "Receipt already recorded.",
            txHash: receiptState.txHash,
            receipt: duplicateReceipt.receipt,
            isRecorded: true,
          });
          return;
        } catch {
          setReceiptState({
            status: "already",
            message: "Receipt already recorded.",
            txHash: receiptState.txHash,
            receipt: null,
            isRecorded: true,
          });
          return;
        }
      }

      setReceiptState((current) => ({
        ...current,
        status: "failed",
        message: toReceiptErrorMessage(recordError),
        isRecorded: false,
      }));
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Base Sepolia target</p>
          <h1>Base Agent Pay</h1>
          <p className="subtitle">Pay an agent. Get a result. Prove it onchain.</p>
        </div>
        <div className="network-panel" aria-label="Network status">
          <span>Network</span>
          <strong>Base Sepolia</strong>
          <small>Chain ID {BASE_SEPOLIA.id}</small>
          <small>RPC {rpcStatus}</small>
        </div>
      </header>

      <section className="wallet-band" aria-label="Wallet">
        <div className="field compact">
          <label htmlFor="wallet">Wallet</label>
          <select
            id="wallet"
            value={selectedWalletId}
            onChange={(event) => setSelectedWalletId(event.target.value)}
          >
            {wallets.length === 0 ? (
              <option>No injected wallet detected</option>
            ) : (
              wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.isRabby ? "Rabby - " : ""}
                  {wallet.name}
                </option>
              ))
            )}
          </select>
        </div>
        <button type="button" onClick={handleConnectWallet}>
          Connect Wallet
        </button>
        <button
          type="button"
          className="secondary"
          onClick={handleSwitchNetwork}
          disabled={!selectedWallet}
        >
          Use Base Sepolia
        </button>
        <div className="wallet-state">
          <span>{walletState.address ? shortAddress(walletState.address) : "Not connected"}</span>
          <small>
            {walletState.chainId === BASE_SEPOLIA_HEX_CHAIN_ID
              ? "Base Sepolia"
              : walletState.chainId || "No chain"}
          </small>
        </div>
      </section>

      <form className="layout-grid" onSubmit={handleRequestTask}>
        <section className="panel ai-task">
          <div className="section-heading">
            <p>1</p>
            <h2>AI Task</h2>
          </div>

          <div className="field">
            <label htmlFor="taskType">Task type</label>
            <select
              id="taskType"
              value={taskType}
              onChange={(event) => setTaskType(event.target.value)}
            >
              {TASK_TYPES.map((task) => (
                <option key={task.value} value={task.value}>
                  {task.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="input">Text</label>
            <textarea
              id="input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              rows={9}
              maxLength={2000}
            />
            <small>{input.length}/2000</small>
          </div>

          <button type="submit" className="primary">
            Request AI Task
          </button>
        </section>

        <section className="panel payment">
          <div className="section-heading">
            <p>2</p>
            <h2>Payment</h2>
          </div>

          <div className={`status-card status-${paymentStatus}`}>
            <span>Status</span>
            <strong>{PAYMENT_STATUS[paymentStatus]}</strong>
          </div>

          <div className="mode-card">
            <span>Development Payment Mode</span>
            <strong>MOCK</strong>
            <small>No real payment, token transfer, or blockchain transaction.</small>
          </div>

          <dl className="facts">
            <div>
              <dt>Network</dt>
              <dd>Base Sepolia</dd>
            </div>
            <div>
              <dt>Asset</dt>
              <dd>{paymentRequirement?.paymentRequirements?.asset?.symbol ?? "mock-USDC"}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>{paymentRequirement?.paymentRequirements?.amount ?? "0.01"}</dd>
            </div>
            <div>
              <dt>Facilitator</dt>
              <dd>{paymentRequirement?.paymentRequirements?.facilitator ?? "local-mock-facilitator"}</dd>
            </div>
          </dl>

          <button
            type="button"
            className="primary"
            onClick={handleMockPayment}
            disabled={!paymentRequirement || paymentStatus === "awaiting"}
          >
            Complete Mock Payment
          </button>
        </section>

        <section className="panel result">
          <div className="section-heading">
            <p>3</p>
            <h2>Result</h2>
          </div>

          <output className="result-box" aria-live="polite">
            {taskResult?.result?.output ?? "No result yet."}
          </output>

          <dl className="hash-list">
            <div>
              <dt>taskId</dt>
              <dd>{taskResult?.taskId ?? "Pending"}</dd>
            </div>
            <div>
              <dt>requestHash</dt>
              <dd>{taskResult?.requestHash ?? "Pending"}</dd>
            </div>
            <div>
              <dt>resultHash</dt>
              <dd>{taskResult?.resultHash ?? "Pending"}</dd>
            </div>
          </dl>
        </section>

        <section className="panel proof">
          <div className="section-heading">
            <p>4</p>
            <h2>Onchain Proof</h2>
          </div>

          <div className={`status-card receipt-status status-${receiptState.status}`}>
            <span>Proof status</span>
            <strong>{RECEIPT_STATUS[receiptState.status]}</strong>
            <small>{receiptState.message}</small>
          </div>

          <dl className="facts">
            <div>
              <dt>Receipt contract</dt>
              <dd>
                {receiptAddressConfigured ? (
                  <a
                    href={contractExplorerUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {RECEIPT_CONTRACT_ADDRESS}
                  </a>
                ) : (
                  "Receipt contract not deployed yet."
                )}
              </dd>
            </div>
            <div>
              <dt>Registry</dt>
              <dd>AgentTaskReceipt</dd>
            </div>
            <div>
              <dt>Transaction</dt>
              <dd>
                {receiptState.txHash ? (
                  <a href={txExplorerUrl} target="_blank" rel="noreferrer">
                    {receiptState.txHash}
                  </a>
                ) : (
                  "Pending"
                )}
              </dd>
            </div>
            {receiptState.receipt ? (
              <>
                <div>
                  <dt>Requester</dt>
                  <dd>{receiptState.receipt.requester}</dd>
                </div>
                <div>
                  <dt>Timestamp</dt>
                  <dd>{formatReceiptTimestamp(receiptState.receipt.timestamp)}</dd>
                </div>
              </>
            ) : null}
          </dl>

          <button
            type="button"
            className="primary"
            onClick={handleRecordReceipt}
            disabled={!canRecordReceipt}
          >
            Record Receipt Onchain
          </button>
          <small className="proof-note">
            Receipt writes are real Base Sepolia transactions and must be confirmed
            interactively in your injected wallet.
          </small>
          <small className="proof-note">
            Builder attribution: {BASE_BUILDER_CODE} (ERC-8021 enabled)
          </small>
        </section>
      </form>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}
    </main>
  );
}

async function readReceiptStatus(taskId) {
  const isRecorded = await hasReceipt(taskId);

  if (!isRecorded) {
    return {
      isRecorded: false,
      receipt: null,
    };
  }

  return {
    isRecorded: true,
    receipt: await getReceipt(taskId),
  };
}

function formatReceiptTimestamp(timestamp) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "Unknown";
  }

  return new Date(seconds * 1000).toLocaleString();
}

function isDuplicateReceiptError(error) {
  const message = String(error?.shortMessage ?? error?.message ?? error ?? "");
  return /DuplicateTaskId|duplicate|already recorded/iu.test(message);
}

function toReceiptErrorMessage(error) {
  const code = error?.code ?? error?.cause?.code;
  const message = String(error?.shortMessage ?? error?.message ?? error ?? "");

  if (code === 4001 || /reject|denied|cancel/iu.test(message)) {
    return "Transaction was rejected in the wallet.";
  }

  if (/DuplicateTaskId|duplicate|already recorded/iu.test(message)) {
    return "Receipt already recorded.";
  }

  if (/revert/iu.test(message)) {
    return "Receipt transaction reverted on Base Sepolia.";
  }

  if (/network|rpc|fetch|timeout/iu.test(message)) {
    return "Base Sepolia RPC error. Check the network and try again.";
  }

  return message || "Receipt recording failed.";
}
