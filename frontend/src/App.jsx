import { useEffect, useMemo, useRef, useState } from "react";
import { isAddress } from "viem";

import {
  createTaskIdempotencyKey,
  requestPaymentRequirement,
  submitLivePaidTask,
  submitMockPaidTask,
} from "./apiClient.js";
import { BASE_BUILDER_CODE } from "./builderAttribution.js";
import {
  BASE_NETWORK,
  BASE_NETWORK_EXPLORER_URL,
  BASE_NETWORK_HEX_CHAIN_ID,
  LIVE_PAYMENT_MAX_USDC,
  PAYMENT_MODE,
  RECEIPT_CONTRACT_ADDRESS,
  publicClient,
} from "./config.js";
import {
  getReceipt,
  hasReceipt,
  recordReceipt,
} from "./receiptContract.js";
import {
  DEMO_COUNTERPARTY,
  DEMO_CURRENCY,
  DEMO_REQUEST_AMOUNT,
  createDefaultMandate,
  evaluateMandatePreflight,
  mandateDecisionMessage,
} from "./mandatePolicy.js";
import { createInFlightActionGuard } from "./paymentActionGuard.js";
import {
  connectWallet,
  discoverWallets,
  requestBaseNetwork,
  shortAddress,
} from "./walletDiscovery.js";
import {
  createLivePaymentSignatureHeaders,
  parsePaymentRequiredHeader,
  validateLivePaymentRequirement,
} from "./x402Client.js";

const TASK_TYPES = [
  { value: "summarize", label: "Summarize" },
  { value: "rewrite", label: "Rewrite" },
  { value: "classify", label: "Classify" },
  { value: "structured-answer", label: "Structured Answer" },
];

const PAYMENT_STATUS = {
  idle: "Not requested",
  preparing: "Preparing payment",
  required: "Payment required",
  signing: "Awaiting signature",
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
    "Base Agent Pay lets a user request a small AI task, complete an x402-style mock payment flow, and optionally record a task receipt on Base Mainnet.",
  );
  const [requestedAmount, setRequestedAmount] = useState(DEMO_REQUEST_AMOUNT);
  const [counterparty, setCounterparty] = useState(DEMO_COUNTERPARTY);
  const [mandateMaxSpend, setMandateMaxSpend] = useState("0.10");
  const [mandateCounterparty, setMandateCounterparty] = useState(DEMO_COUNTERPARTY);
  const [mandateExpiresAt, setMandateExpiresAt] = useState(
    () => createDefaultMandate({ taskType: "summarize" }).expiresAt,
  );
  const [mandateScope, setMandateScope] = useState("summarize");
  const [paymentRequest, setPaymentRequest] = useState(null);
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
  const livePaymentActionGuard = useRef(createInFlightActionGuard());

  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.id === selectedWalletId) ?? wallets[0],
    [selectedWalletId, wallets],
  );
  const taskRequest = useMemo(() => {
    const mandate = {
      mandateId: `mandate-demo-${taskType}`,
      maxSpendPerTask: mandateMaxSpend,
      currency: DEMO_CURRENCY,
      allowedCounterparties: [mandateCounterparty],
      expiresAt: mandateExpiresAt,
      allowedScopes: [mandateScope],
    };

    return {
      taskType,
      input,
      scope: taskType,
      counterparty,
      amount: requestedAmount,
      currency: DEMO_CURRENCY,
      mandate,
    };
  }, [
    counterparty,
    input,
    mandateCounterparty,
    mandateExpiresAt,
    mandateMaxSpend,
    mandateScope,
    requestedAmount,
    taskType,
  ]);
  const mandateDecision = useMemo(
    () => evaluateMandatePreflight({
      request: taskRequest,
      mandate: taskRequest.mandate,
    }),
    [taskRequest],
  );
  const receiptPolicyRequest = paymentRequest ?? taskRequest;
  const receiptMandateDecision = useMemo(
    () => evaluateMandatePreflight({
      request: receiptPolicyRequest,
      mandate: receiptPolicyRequest.mandate,
    }),
    [receiptPolicyRequest],
  );
  const mandateSummary = useMemo(
    () => ({
      maxSpend: `${taskRequest.mandate.maxSpendPerTask} ${taskRequest.mandate.currency}`,
      counterparty: taskRequest.mandate.allowedCounterparties[0],
      scope: taskRequest.mandate.allowedScopes[0],
      expiresAt: taskRequest.mandate.expiresAt,
    }),
    [taskRequest],
  );

  const receiptAddressConfigured =
    RECEIPT_CONTRACT_ADDRESS && isAddress(RECEIPT_CONTRACT_ADDRESS);
  const hasReceiptPayload = Boolean(
    taskResult?.taskId && taskResult?.requestHash && taskResult?.resultHash,
  );
  const walletConnected = Boolean(walletState.address);
  const walletOnBaseNetwork =
    walletState.chainId?.toLowerCase() === BASE_NETWORK_HEX_CHAIN_ID;
  const isLivePaymentMode = PAYMENT_MODE === "live";
  const livePaymentRequirements = isLivePaymentMode
    ? paymentRequirement?.accepts?.[0]
    : null;
  const paymentRequestInFlight =
    paymentStatus === "preparing" ||
    paymentStatus === "signing" ||
    paymentStatus === "awaiting";
  const receiptWritePending =
    receiptState.status === "confirming" || receiptState.status === "pending";
  const canRecordReceipt = Boolean(
    hasReceiptPayload &&
      selectedWallet &&
      walletConnected &&
      walletOnBaseNetwork &&
      receiptAddressConfigured &&
      receiptMandateDecision.allowed &&
      receiptState.isRecorded === false &&
      !receiptWritePending,
  );
  const contractExplorerUrl = receiptAddressConfigured
    ? `${BASE_NETWORK_EXPLORER_URL}/address/${RECEIPT_CONTRACT_ADDRESS}`
    : "";
  const txExplorerUrl = receiptState.txHash
    ? `${BASE_NETWORK_EXPLORER_URL}/tx/${receiptState.txHash}`
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
        message: `Checking ${BASE_NETWORK.name} for an existing receipt.`,
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
            message: `Receipt already recorded on ${BASE_NETWORK.name}.`,
            txHash: "",
            receipt: receiptStatus.receipt,
            isRecorded: true,
          });
          return;
        }

        setReceiptState({
          status: "ready",
          message: `Ready to record on ${BASE_NETWORK.name} with your connected wallet.`,
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

  function handleTaskTypeChange(nextTaskType) {
    setTaskType(nextTaskType);
    setMandateScope(nextTaskType);
  }

  async function handleRequestTask(event) {
    event.preventDefault();
    if (paymentRequestInFlight) {
      return;
    }

    setError("");
    setTaskResult(null);
    setPaymentRequirement(null);
    setPaymentRequest(null);
    setPaymentStatus("idle");
    setReceiptState({
      status: "waiting",
      message: "Complete a paid task before recording an onchain receipt.",
      txHash: "",
      receipt: null,
      isRecorded: null,
    });

    const submissionRequest = {
      ...taskRequest,
      idempotencyKey: createTaskIdempotencyKey(),
    };
    const submissionMandateDecision = evaluateMandatePreflight({
      request: submissionRequest,
      mandate: submissionRequest.mandate,
    });

    if (!submissionMandateDecision.allowed) {
      setError(
        `Blocked by mandate: ${mandateDecisionMessage(submissionMandateDecision)}`,
      );
      setPaymentStatus("failed");
      return;
    }

    try {
      setPaymentStatus("preparing");
      const requirementResponse = await requestPaymentRequirement(submissionRequest);
      const requirement = isLivePaymentMode
        ? {
            ...parsePaymentRequiredHeader(
              requirementResponse.paymentRequiredHeader,
            ),
            paymentRequiredHeader: requirementResponse.paymentRequiredHeader,
          }
        : requirementResponse;
      setPaymentRequest(submissionRequest);
      setPaymentRequirement(requirement);
      setPaymentStatus("required");
    } catch (requestError) {
      setError(requestError.message);
      setPaymentStatus("failed");
    }
  }

  async function handleMockPayment() {
    if (isLivePaymentMode || !paymentRequirement?.mockPaymentHeader) {
      return;
    }

    const paidRequest = paymentRequest ?? taskRequest;
    setError("");
    setPaymentStatus("awaiting");
    try {
      const result = await submitMockPaidTask(
        paidRequest,
        paymentRequirement.mockPaymentHeader,
      );
      setTaskResult(result);
      setPaymentStatus("verified");
    } catch (paymentError) {
      setError(paymentError.message);
      setPaymentStatus("failed");
    }
  }

  async function handleLivePayment() {
    if (!isLivePaymentMode || !paymentRequirement || paymentRequestInFlight) {
      return;
    }

    await livePaymentActionGuard.current.run(async () => {
      const paidRequest = paymentRequest ?? taskRequest;
      setError("");

      if (!selectedWallet) {
        setError("No injected wallet detected.");
        setPaymentStatus("failed");
        return;
      }

      if (!walletConnected) {
        setError("Connect your wallet before signing the live payment.");
        setPaymentStatus("failed");
        return;
      }

      if (!walletOnBaseNetwork) {
        setError(`Switch your wallet to ${BASE_NETWORK.name} before signing.`);
        setPaymentStatus("failed");
        return;
      }

      const liveValidation = validateLivePaymentRequirement({
        paymentRequired: paymentRequirement,
        request: paidRequest,
        liveMaxUsdc: LIVE_PAYMENT_MAX_USDC,
      });
      if (!liveValidation.ok) {
        setError(liveValidation.reason);
        setPaymentStatus("failed");
        return;
      }

      try {
        setPaymentStatus("signing");
        const { headers } = await createLivePaymentSignatureHeaders({
          paymentRequired: paymentRequirement,
          provider: selectedWallet.provider,
          account: walletState.address,
          rpcUrl: BASE_NETWORK.rpcUrls.default.http[0],
        });
        setPaymentStatus("awaiting");
        const result = await submitLivePaidTask(paidRequest, headers);
        setTaskResult(result);
        setPaymentStatus("verified");
      } catch (paymentError) {
        setError(paymentError.message);
        setPaymentStatus("failed");
      }
    });
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
      await requestBaseNetwork(selectedWallet);
      const nextWalletState = await connectWallet(selectedWallet);
      setWalletState(nextWalletState);
    } catch (switchError) {
      setError(switchError.message);
    }
  }

  async function handleRecordReceipt() {
    setError("");

    const latestReceiptMandateDecision = evaluateMandatePreflight({
      request: receiptPolicyRequest,
      mandate: receiptPolicyRequest.mandate,
    });
    if (!latestReceiptMandateDecision.allowed) {
      setReceiptState({
        status: "failed",
        message: `Blocked by mandate: ${mandateDecisionMessage(latestReceiptMandateDecision)}`,
        txHash: "",
        receipt: null,
        isRecorded: false,
      });
      return;
    }

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

    if (!walletOnBaseNetwork) {
      setReceiptState({
        status: "failed",
        message: `Switch your wallet to ${BASE_NETWORK.name} before recording.`,
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
        message: `Transaction submitted. Waiting for ${BASE_NETWORK.name} confirmation.`,
        txHash,
        receipt: null,
        isRecorded: false,
      });

      const txReceipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      if (txReceipt.status !== "success") {
        throw new Error(`Receipt transaction reverted on ${BASE_NETWORK.name}.`);
      }

      const afterWrite = await readReceiptStatus(taskResult.taskId);
      if (!afterWrite.isRecorded) {
        throw new Error("Transaction succeeded, but the receipt was not found.");
      }

      setReceiptState({
        status: "recorded",
        message: `Receipt recorded on ${BASE_NETWORK.name}.`,
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
          <p className="eyebrow">{BASE_NETWORK.name} target</p>
          <h1>Base Agent Pay</h1>
          <p className="subtitle">Pay an agent. Get a result. Prove it onchain.</p>
        </div>
        <div className="network-panel" aria-label="Network status">
          <span>Network</span>
          <strong>{BASE_NETWORK.name}</strong>
          <small>Chain ID {BASE_NETWORK.id}</small>
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
          Use {BASE_NETWORK.name}
        </button>
        <div className="wallet-state">
          <span>{walletState.address ? shortAddress(walletState.address) : "Not connected"}</span>
          <small>
            {walletState.chainId === BASE_NETWORK_HEX_CHAIN_ID
              ? BASE_NETWORK.name
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
              onChange={(event) => handleTaskTypeChange(event.target.value)}
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

          <button
            type="submit"
            className="primary"
            disabled={paymentRequestInFlight}
          >
            Request AI Task
          </button>
          {isLivePaymentMode ? (
            <div className="live-warning" role="alert">
              <strong>This task may spend real USDC.</strong>
              <small>Maximum allowed: {LIVE_PAYMENT_MAX_USDC} USDC.</small>
            </div>
          ) : null}
        </section>

        <section className="panel mandate">
          <div className="section-heading">
            <p>2</p>
            <h2>Mandate</h2>
          </div>

          <div
            className={`status-card status-${mandateDecision.allowed ? "verified" : "failed"}`}
          >
            <span>Policy</span>
            <strong>{mandateDecision.allowed ? "Allowed" : "Blocked"}</strong>
            <small>{mandateDecision.reason}</small>
          </div>

          <div className="mandate-grid">
            <div className="field">
              <label htmlFor="requestedAmount">Requested spend</label>
              <input
                id="requestedAmount"
                inputMode="decimal"
                value={requestedAmount}
                onChange={(event) => setRequestedAmount(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="counterparty">Task counterparty</label>
              <input
                id="counterparty"
                value={counterparty}
                onChange={(event) => setCounterparty(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="mandateMaxSpend">Max spend per task</label>
              <input
                id="mandateMaxSpend"
                inputMode="decimal"
                value={mandateMaxSpend}
                onChange={(event) => setMandateMaxSpend(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="mandateCounterparty">Allowed counterparty</label>
              <input
                id="mandateCounterparty"
                value={mandateCounterparty}
                onChange={(event) => setMandateCounterparty(event.target.value)}
              />
            </div>
            <div className="field wide">
              <label htmlFor="mandateExpiresAt">Expires at UTC</label>
              <input
                id="mandateExpiresAt"
                value={mandateExpiresAt}
                onChange={(event) => setMandateExpiresAt(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="mandateScope">Allowed scope</label>
              <select
                id="mandateScope"
                value={mandateScope}
                onChange={(event) => setMandateScope(event.target.value)}
              >
                {TASK_TYPES.map((task) => (
                  <option key={task.value} value={task.value}>
                    {task.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <dl className="facts mandate-summary">
            <div>
              <dt>Max spend</dt>
              <dd>{mandateSummary.maxSpend}</dd>
            </div>
            <div>
              <dt>Counterparty</dt>
              <dd>{mandateSummary.counterparty}</dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>{mandateSummary.scope}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{mandateSummary.expiresAt}</dd>
            </div>
          </dl>
        </section>

        <section className="panel payment">
          <div className="section-heading">
            <p>3</p>
            <h2>Payment</h2>
          </div>

          <div className={`status-card status-${paymentStatus}`}>
            <span>Status</span>
            <strong>{PAYMENT_STATUS[paymentStatus]}</strong>
          </div>

          <div className="mode-card">
            <span>Payment mode</span>
            <strong>{isLivePaymentMode ? "LIVE" : "MOCK"}</strong>
            <small>
              {isLivePaymentMode
                ? `This task may spend real USDC. Maximum allowed: ${LIVE_PAYMENT_MAX_USDC} USDC.`
                : "No real payment, token transfer, or blockchain transaction."}
            </small>
          </div>

          <dl className="facts">
            <div>
              <dt>Network</dt>
              <dd>{BASE_NETWORK.name}</dd>
            </div>
            <div>
              <dt>Asset</dt>
              <dd>
                {livePaymentRequirements?.extra?.name ??
                  paymentRequirement?.paymentRequirements?.asset?.symbol ??
                  paymentRequirement?.paymentRequirements?.extra?.name ??
                  (isLivePaymentMode ? "USDC" : "mock-USDC")}
              </dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>
                {isLivePaymentMode
                  ? `${paymentRequest?.amount ?? requestedAmount} USDC`
                  : paymentRequirement?.paymentRequirements?.amount ?? "0.01"}
              </dd>
            </div>
            <div>
              <dt>{isLivePaymentMode ? "Payment target" : "Facilitator"}</dt>
              <dd>
                {isLivePaymentMode
                  ? livePaymentRequirements?.payTo ?? "Configured server-side"
                  : paymentRequirement?.paymentRequirements?.facilitator ??
                    "local-mock-facilitator"}
              </dd>
            </div>
          </dl>

          {isLivePaymentMode ? (
            <>
              <button
                type="button"
                className="primary"
                onClick={handleLivePayment}
                disabled={!paymentRequirement || paymentRequestInFlight}
              >
                Sign Live Payment
              </button>
              <small className="payment-note">
                Review the wallet EIP-712 request before signing. The app does
                not auto-sign or auto-pay.
              </small>
            </>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={handleMockPayment}
              disabled={!paymentRequirement || paymentStatus === "awaiting"}
            >
              Complete Mock Payment
            </button>
          )}
        </section>

        <section className="panel result">
          <div className="section-heading">
            <p>4</p>
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
            <p>5</p>
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
            Receipt writes are real {BASE_NETWORK.name} transactions and must be confirmed
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
    return `Receipt transaction reverted on ${BASE_NETWORK.name}.`;
  }

  if (/network|rpc|fetch|timeout/iu.test(message)) {
    return `${BASE_NETWORK.name} RPC error. Check the network and try again.`;
  }

  return message || "Receipt recording failed.";
}
