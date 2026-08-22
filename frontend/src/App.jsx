import { useEffect, useMemo, useState } from "react";
import { isAddress } from "viem";

import { requestPaymentRequirement, submitMockPaidTask } from "./apiClient.js";
import {
  BASE_SEPOLIA,
  BASE_SEPOLIA_HEX_CHAIN_ID,
  RECEIPT_CONTRACT_ADDRESS,
  publicClient,
} from "./config.js";
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
  const [rpcStatus, setRpcStatus] = useState("Checking");

  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.id === selectedWalletId) ?? wallets[0],
    [selectedWalletId, wallets],
  );

  const receiptAddressConfigured =
    RECEIPT_CONTRACT_ADDRESS && isAddress(RECEIPT_CONTRACT_ADDRESS);

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

  async function handleRequestTask(event) {
    event.preventDefault();
    setError("");
    setTaskResult(null);
    setPaymentRequirement(null);
    setPaymentStatus("idle");

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

          <dl className="facts">
            <div>
              <dt>Receipt contract</dt>
              <dd>
                {receiptAddressConfigured
                  ? RECEIPT_CONTRACT_ADDRESS
                  : "Receipt contract not deployed yet."}
              </dd>
            </div>
            <div>
              <dt>Registry</dt>
              <dd>AgentTaskReceipt</dd>
            </div>
          </dl>

          <button type="button" disabled>
            Record Receipt Onchain
          </button>
          <small className="proof-note">
            Local demo writes are disabled until a Base Sepolia receipt contract is deployed and configured.
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

