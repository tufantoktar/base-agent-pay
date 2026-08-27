import { generateJwt } from "@coinbase/cdp-sdk/auth";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";

import { PaymentAdapter } from "./payment-adapter-base.js";
import {
  BASE_SETTLEMENT_VERIFICATION_CODES,
  BaseSettlementVerificationError,
  verifyBaseUsdcTransfer,
} from "./base-settlement-verifier.js";
import {
  TASK_RESOURCE_DESCRIPTION,
  TASK_RESOURCE_PATH,
  createTaskBazaarDiscoveryExtensions,
} from "./bazaar-discovery.js";
import {
  BASE_MAINNET,
  BASE_MAINNET_USDC,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
} from "./constants.js";
import {
  MANDATE_CODES,
  SUPPORTED_MANDATE_CURRENCY,
  parseUsdcAmountToAtomicUnits,
} from "./mandate.js";
import { sha256Hex } from "./hash.js";
import {
  PAYMENT_STATES,
  PAYMENT_STORE_ERROR_CODES,
  PaymentStoreError,
} from "./payment-store.js";
import {
  createDefaultPaymentStore,
  isProductionLikeRuntime,
  resolvePaymentStoreDriver,
} from "./payment-store-factory.js";

export const LIVE_PAYMENT_STATES = PAYMENT_STATES;

export const LIVE_PAYMENT_CODES = Object.freeze({
  BLOCKED: "X402_LIVE_BLOCKED",
  CONFIG_INVALID: "X402_LIVE_CONFIG_INVALID",
  IDEMPOTENCY_REQUIRED: "X402_IDEMPOTENCY_REQUIRED",
  IDEMPOTENCY_CONFLICT: PAYMENT_STORE_ERROR_CODES.KEY_REUSE_MISMATCH,
  PAYMENT_ALREADY_SETTLED: PAYMENT_STORE_ERROR_CODES.ALREADY_SETTLED,
  PAYMENT_IN_PROGRESS: PAYMENT_STORE_ERROR_CODES.IN_PROGRESS,
  PAYMENT_STATUS_UNKNOWN: PAYMENT_STORE_ERROR_CODES.STATUS_UNKNOWN,
  PAYMENT_RETRY_NOT_SAFE: PAYMENT_STORE_ERROR_CODES.RETRY_NOT_SAFE,
  PAYMENT_STORE_ERROR: PAYMENT_STORE_ERROR_CODES.STORE_ERROR,
  PAYMENT_ID_MISMATCH: "X402_PAYMENT_ID_MISMATCH",
  SPEND_EXCEEDS_CAP: "X402_LIVE_SPEND_EXCEEDS_CAP",
  COUNTERPARTY_MISMATCH: "X402_COUNTERPARTY_MISMATCH",
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
  PAYMENT_INVALID: "PAYMENT_INVALID",
  VERIFY_FAILED: "X402_VERIFY_FAILED",
  SETTLEMENT_FAILED: "X402_SETTLEMENT_FAILED",
  SETTLEMENT_PENDING: "X402_SETTLEMENT_PENDING",
  SETTLEMENT_UNKNOWN: "X402_SETTLEMENT_UNKNOWN",
});

export const LIVE_PAYMENT_ID_PATTERN = /^[a-zA-Z0-9._:-]{16,128}$/u;
export const CDP_X402_FACILITATOR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402";

const DEFAULT_LIVE_CAP_USDC = "0.10";
const HARD_MAX_LIVE_CAP_ATOMIC_UNITS = 100_000n;
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_FACILITATOR_TIMEOUT_MS = 15_000;
const DEFAULT_BASE_VERIFICATION_TIMEOUT_MS = 10_000;
const BASE_MAINNET_CAIP2 = BASE_MAINNET.caip2;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;
const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/u;
const CDP_REQUEST_HOST = "api.cdp.coinbase.com";
const CDP_X402_PATHS = Object.freeze({
  verify: "/platform/v2/x402/verify",
  settle: "/platform/v2/x402/settle",
  supported: "/platform/v2/x402/supported",
});

export class LivePaymentAdapter extends PaymentAdapter {
  constructor({
    env = process.env,
    config,
    facilitatorClient,
    paymentStore,
    idempotencyStore,
    settlementVerifier,
    fetchImpl = globalThis.fetch,
  } = {}) {
    super({ mode: "live" });
    this.configResult = config ?? resolveLivePaymentConfig({ env });
    const storeDriverResult = resolvePaymentStoreDriver({ env });
    this.paymentStoreDriver =
      paymentStore?.driver ??
      idempotencyStore?.driver ??
      (storeDriverResult.ok ? storeDriverResult.driver : "unknown");
    this.paymentStore =
      paymentStore ??
      idempotencyStore ??
      (this.configResult.ok ? createDefaultPaymentStore({ env }) : null);
    this.facilitatorClient =
      facilitatorClient ??
      (this.configResult.ok
        ? new HttpX402FacilitatorClient({
            url: this.configResult.config.facilitatorUrl,
            cdpApiKeyId: this.configResult.config.cdpApiKeyId,
            cdpApiKeySecret: this.configResult.config.cdpApiKeySecret,
            timeoutMs: this.configResult.config.facilitatorTimeoutMs,
          })
        : null);
    this.settlementVerifier =
      settlementVerifier ??
      ((args) =>
        verifyBaseUsdcTransfer({
          ...args,
          rpcUrl: this.configResult.config.baseMainnetRpcUrl,
          fetchImpl,
          timeoutMs: this.configResult.config.baseVerificationTimeoutMs,
        }));
  }

  createPaymentRequired({ request, requestHash, now, evaluateMandate }) {
    const prepared = this.preparePayment({
      request,
      requestHash,
      now,
      evaluateMandate,
    });

    if (!prepared.ok) {
      return {
        ok: false,
        error: prepared.code,
        code: prepared.code,
        message: prepared.reason,
        mode: "live",
        status: prepared.state,
      };
    }

    return prepared.paymentRequired;
  }

  async verifyPayment({
    headers,
    request,
    requestHash,
    now,
    evaluateMandate,
    logger,
  }) {
    const prepared = this.preparePayment({
      request,
      requestHash,
      now,
      evaluateMandate,
    });

    if (!prepared.ok) {
      this.log(logger, "x402_live_blocked", {
        taskId: prepared.idempotencyKey,
        amount: request?.amount,
        asset: request?.currency,
        network: BASE_MAINNET_CAIP2,
        counterparty: request?.counterparty,
        status: prepared.state,
      });
      return failClosed(prepared);
    }

    this.log(logger, "payment_store_selected", {
      mode: "live",
      driver: this.paymentStoreDriver,
    });

    let stored;
    try {
      stored = await this.paymentStore.createPayment(
        createPaymentStoreRecord({
          prepared,
          state: LIVE_PAYMENT_STATES.CREATED,
          canRetry: true,
        }),
      );
      this.log(logger, "payment_store_created", {
        taskId: prepared.idempotencyKey,
        paymentId: prepared.idempotencyKey,
        amount: prepared.requestedAmount,
        asset: BASE_MAINNET_USDC.symbol,
        network: BASE_MAINNET_CAIP2,
        counterparty: prepared.config.paymentRecipient,
        status: stored.state,
      });
      this.logPostgresStoreEvent(logger, "postgres_payment_created", {
        prepared,
        stored,
      });
    } catch (error) {
      return this.failPaymentStore({ error, prepared, logger });
    }

    const duplicate = await this.handleDuplicatePayment({
      existing: stored,
      prepared,
      logger,
    });
    if (duplicate) {
      return duplicate;
    }

    const paymentSignature = readHeader(headers, X402_PAYMENT_SIGNATURE_HEADER);
    if (!paymentSignature) {
      try {
        stored = await this.paymentStore.transitionPayment({
          idempotencyKey: prepared.idempotencyKey,
          fromStates: [
            LIVE_PAYMENT_STATES.CREATED,
            LIVE_PAYMENT_STATES.CHALLENGED,
            LIVE_PAYMENT_STATES.FAILED,
          ],
          toState: LIVE_PAYMENT_STATES.CHALLENGED,
          updates: {
            paymentRequirements: prepared.paymentRequirements,
            paymentRequired: prepared.paymentRequired,
            canRetry: true,
          },
        });
      } catch (error) {
        return this.failPaymentStore({ error, prepared, logger });
      }

      if (!stored) {
        return this.blockFromExistingState({ prepared, logger });
      }
      this.logPaymentStateTransition({ logger, prepared, stored });

      this.log(logger, "x402_live_prepare", {
        taskId: prepared.idempotencyKey,
        paymentId: prepared.idempotencyKey,
        amount: prepared.requestedAmount,
        asset: BASE_MAINNET_USDC.symbol,
        network: BASE_MAINNET_CAIP2,
        counterparty: prepared.config.paymentRecipient,
        status: LIVE_PAYMENT_STATES.CHALLENGED,
      });

      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_REQUIRED,
        reason: "Missing PAYMENT-SIGNATURE header.",
        statusCode: 402,
        state: LIVE_PAYMENT_STATES.CHALLENGED,
        paymentRequired: prepared.paymentRequired,
        responseHeaders: {
          [X402_PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(
            prepared.paymentRequired,
          ),
        },
      };
    }

    const parsedPayment = parsePaymentSignatureHeader(paymentSignature);
    if (!parsedPayment.ok) {
      try {
        await this.paymentStore.transitionPayment({
          idempotencyKey: prepared.idempotencyKey,
          fromStates: [
            LIVE_PAYMENT_STATES.CREATED,
            LIVE_PAYMENT_STATES.CHALLENGED,
            LIVE_PAYMENT_STATES.FAILED,
          ],
          toState: LIVE_PAYMENT_STATES.FAILED,
          updates: {
            paymentRequirements: prepared.paymentRequirements,
            paymentRequired: prepared.paymentRequired,
            lastErrorCode: LIVE_PAYMENT_CODES.PAYMENT_INVALID,
            lastErrorMessage: parsedPayment.reason,
            canRetry: true,
          },
        });
      } catch (error) {
        return this.failPaymentStore({ error, prepared, logger });
      }
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_INVALID,
        reason: parsedPayment.reason,
        statusCode: 402,
        state: LIVE_PAYMENT_STATES.FAILED,
        paymentRequired: prepared.paymentRequired,
        responseHeaders: {
          [X402_PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(
            prepared.paymentRequired,
          ),
        },
      };
    }

    const paymentPayload = parsedPayment.paymentPayload;
    const paymentId = prepared.idempotencyKey;

    const payloadValidation = validatePaymentPayloadBinding({
      paymentPayload,
      paymentRequirements: prepared.paymentRequirements,
      paymentRecipient: prepared.config.paymentRecipient,
      now,
    });
    if (!payloadValidation.ok) {
      try {
        await this.paymentStore.transitionPayment({
          idempotencyKey: prepared.idempotencyKey,
          fromStates: [
            LIVE_PAYMENT_STATES.CREATED,
            LIVE_PAYMENT_STATES.CHALLENGED,
            LIVE_PAYMENT_STATES.FAILED,
          ],
          toState: LIVE_PAYMENT_STATES.FAILED,
          updates: {
            paymentId,
            paymentRequirements: prepared.paymentRequirements,
            paymentRequired: prepared.paymentRequired,
            lastErrorCode: LIVE_PAYMENT_CODES.PAYMENT_INVALID,
            lastErrorMessage: payloadValidation.reason,
            canRetry: true,
          },
        });
      } catch (error) {
        return this.failPaymentStore({ error, prepared, logger });
      }
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_INVALID,
        reason: payloadValidation.reason,
        statusCode: 402,
        state: LIVE_PAYMENT_STATES.FAILED,
        paymentRequired: prepared.paymentRequired,
        responseHeaders: {
          [X402_PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(
            prepared.paymentRequired,
          ),
        },
      };
    }

    let verifyResponse;
    try {
      verifyResponse = await this.facilitatorClient.verify({
        paymentPayload,
        paymentRequirements: prepared.paymentRequirements,
      });
    } catch (error) {
      const reason = safeErrorMessage(error, "Facilitator verification failed.");
      try {
        await this.paymentStore.transitionPayment({
          idempotencyKey: prepared.idempotencyKey,
          fromStates: [
            LIVE_PAYMENT_STATES.CREATED,
            LIVE_PAYMENT_STATES.CHALLENGED,
            LIVE_PAYMENT_STATES.FAILED,
          ],
          toState: LIVE_PAYMENT_STATES.FAILED,
          updates: {
            paymentId,
            paymentRequirements: prepared.paymentRequirements,
            paymentRequired: prepared.paymentRequired,
            lastErrorCode: LIVE_PAYMENT_CODES.VERIFY_FAILED,
            lastErrorMessage: reason,
            canRetry: true,
          },
        });
      } catch (storeError) {
        return this.failPaymentStore({ error: storeError, prepared, logger });
      }
      this.log(logger, "x402_live_failed", {
        taskId: prepared.idempotencyKey,
        paymentId,
        amount: prepared.requestedAmount,
        asset: BASE_MAINNET_USDC.symbol,
        network: BASE_MAINNET_CAIP2,
        counterparty: prepared.config.paymentRecipient,
        status: LIVE_PAYMENT_STATES.FAILED,
      });
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.VERIFY_FAILED,
        reason,
        statusCode: 402,
        state: LIVE_PAYMENT_STATES.FAILED,
        paymentRequired: prepared.paymentRequired,
        responseHeaders: {
          [X402_PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(
            prepared.paymentRequired,
          ),
        },
      };
    }

    if (!verifyResponse || verifyResponse.isValid !== true) {
      const reason =
        normalizeText(verifyResponse?.invalidReason) ||
        "Facilitator rejected the payment payload.";
      try {
        await this.paymentStore.transitionPayment({
          idempotencyKey: prepared.idempotencyKey,
          fromStates: [
            LIVE_PAYMENT_STATES.CREATED,
            LIVE_PAYMENT_STATES.CHALLENGED,
            LIVE_PAYMENT_STATES.FAILED,
          ],
          toState: LIVE_PAYMENT_STATES.FAILED,
          updates: {
            paymentId,
            paymentRequirements: prepared.paymentRequirements,
            paymentRequired: prepared.paymentRequired,
            lastErrorCode: LIVE_PAYMENT_CODES.PAYMENT_INVALID,
            lastErrorMessage: reason,
            canRetry: true,
          },
        });
      } catch (error) {
        return this.failPaymentStore({ error, prepared, logger });
      }
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_INVALID,
        reason,
        statusCode: 402,
        state: LIVE_PAYMENT_STATES.FAILED,
        paymentRequired: prepared.paymentRequired,
        responseHeaders: {
          [X402_PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(
            prepared.paymentRequired,
          ),
        },
      };
    }

    const payerBinding = validateFacilitatorPayerBinding({
      paymentPayload,
      verifyResponse,
    });
    if (!payerBinding.ok) {
      try {
        await this.paymentStore.transitionPayment({
          idempotencyKey: prepared.idempotencyKey,
          fromStates: [
            LIVE_PAYMENT_STATES.CREATED,
            LIVE_PAYMENT_STATES.CHALLENGED,
            LIVE_PAYMENT_STATES.FAILED,
          ],
          toState: LIVE_PAYMENT_STATES.FAILED,
          updates: {
            paymentId,
            paymentRequirements: prepared.paymentRequirements,
            paymentRequired: prepared.paymentRequired,
            lastErrorCode: LIVE_PAYMENT_CODES.PAYMENT_INVALID,
            lastErrorMessage: payerBinding.reason,
            canRetry: true,
          },
        });
      } catch (error) {
        return this.failPaymentStore({ error, prepared, logger });
      }
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_INVALID,
        reason: payerBinding.reason,
        statusCode: 402,
        state: LIVE_PAYMENT_STATES.FAILED,
        paymentRequired: prepared.paymentRequired,
        responseHeaders: {
          [X402_PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(
            prepared.paymentRequired,
          ),
        },
      };
    }

    const authorizedPayment = createLiveAuthorizedPaymentRecord({
      prepared,
      paymentPayload,
      paymentId,
      verifyResponse,
    });
    try {
      stored = await this.paymentStore.transitionPayment({
        idempotencyKey: prepared.idempotencyKey,
        fromStates: [
          LIVE_PAYMENT_STATES.CREATED,
          LIVE_PAYMENT_STATES.CHALLENGED,
          LIVE_PAYMENT_STATES.FAILED,
        ],
        toState: LIVE_PAYMENT_STATES.AUTHORIZED,
        updates: {
          payment: authorizedPayment,
          paymentId,
          paymentRequirements: prepared.paymentRequirements,
          paymentRequired: prepared.paymentRequired,
          lastErrorCode: null,
          lastErrorMessage: null,
          canRetry: true,
        },
      });
    } catch (error) {
      return this.failPaymentStore({ error, prepared, logger });
    }

    if (!stored) {
      return this.blockFromExistingState({ prepared, logger });
    }
    this.logPaymentStateTransition({ logger, prepared, stored });

    this.log(logger, "x402_live_authorized", {
      taskId: prepared.idempotencyKey,
      paymentId,
      amount: prepared.requestedAmount,
      asset: BASE_MAINNET_USDC.symbol,
      network: BASE_MAINNET_CAIP2,
      counterparty: prepared.config.paymentRecipient,
      status: LIVE_PAYMENT_STATES.AUTHORIZED,
    });

    return {
      ok: true,
      payment: stored.payment ?? authorizedPayment,
      prepared,
      paymentPayload,
      paymentRequirements: prepared.paymentRequirements,
      paymentId,
      verifyResponse,
    };
  }

  async claimResourceExecution({ request, logger }) {
    const idempotencyKey = normalizeText(request?.idempotencyKey);
    if (!LIVE_PAYMENT_ID_PATTERN.test(idempotencyKey)) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN,
        reason: "Live payment idempotency state is unavailable.",
        statusCode: 409,
        state: LIVE_PAYMENT_STATES.UNKNOWN,
      };
    }

    const prepared = {
      idempotencyKey,
      requestedAmount: normalizeText(request?.amount),
      config: this.configResult.config ?? {},
    };
    let claimed;
    try {
      claimed = await this.paymentStore.transitionPayment({
        idempotencyKey,
        fromStates: [LIVE_PAYMENT_STATES.AUTHORIZED],
        toState: LIVE_PAYMENT_STATES.RESOURCE_RUNNING,
        updates: {
          canRetry: false,
        },
      });
    } catch (error) {
      return this.failPaymentStore({ error, prepared, logger });
    }

    if (!claimed) {
      return this.blockFromExistingState({ prepared, logger });
    }

    this.logPaymentStateTransition({ logger, prepared, stored: claimed });
    return {
      ok: true,
      payment: claimed.payment,
      state: claimed.state,
    };
  }

  async markResourceFailed({ request, error, logger }) {
    const idempotencyKey = normalizeText(request?.idempotencyKey);
    if (!LIVE_PAYMENT_ID_PATTERN.test(idempotencyKey)) {
      return;
    }

    try {
      await this.paymentStore.transitionPayment({
        idempotencyKey,
        fromStates: [
          LIVE_PAYMENT_STATES.AUTHORIZED,
          LIVE_PAYMENT_STATES.RESOURCE_RUNNING,
        ],
        toState: LIVE_PAYMENT_STATES.FAILED,
        updates: {
          lastErrorCode: "AI_TASK_FAILED",
          lastErrorMessage: safeErrorMessage(error, "AI task failed before settlement."),
          canRetry: false,
        },
      });
    } catch (storeError) {
      this.log(logger, "payment_store_error", {
        taskId: idempotencyKey,
        paymentId: idempotencyKey,
        amount: "",
        asset: BASE_MAINNET_USDC.symbol,
        network: BASE_MAINNET_CAIP2,
        counterparty: "",
        status: LIVE_PAYMENT_STATES.FAILED,
      });
    }
  }

  async settleAfterResource({
    request,
    requestHash,
    verification,
    now,
    evaluateMandate,
    logger,
  }) {
    const prepared = verification?.prepared;
    const paymentPayload = verification?.paymentPayload;
    const paymentId = verification?.paymentId ?? prepared?.idempotencyKey;
    const verifyResponse = verification?.verifyResponse;

    if (!prepared || !paymentPayload) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN,
        reason: "Live payment authorization context is unavailable.",
        statusCode: 409,
        state: LIVE_PAYMENT_STATES.UNKNOWN,
      };
    }

    const settlementSafety = this.validateLiveSafety({
      request,
      requestHash,
      now,
      evaluateMandate,
    });
    if (!settlementSafety.ok) {
      try {
        await this.paymentStore.transitionPayment({
          idempotencyKey: prepared.idempotencyKey,
          fromStates: [
            LIVE_PAYMENT_STATES.AUTHORIZED,
            LIVE_PAYMENT_STATES.RESOURCE_RUNNING,
            LIVE_PAYMENT_STATES.RESOURCE_SUCCEEDED,
            LIVE_PAYMENT_STATES.FAILED,
          ],
          toState: LIVE_PAYMENT_STATES.BLOCKED,
          updates: {
            paymentId,
            lastErrorCode: settlementSafety.code,
            lastErrorMessage: settlementSafety.reason,
            canRetry: false,
          },
        });
      } catch (error) {
        return this.failPaymentStore({ error, prepared, logger });
      }
      this.log(logger, "x402_live_blocked", {
        taskId: prepared.idempotencyKey,
        paymentId,
        amount: prepared.requestedAmount,
        asset: BASE_MAINNET_USDC.symbol,
        network: BASE_MAINNET_CAIP2,
        counterparty: prepared.config.paymentRecipient,
        status: LIVE_PAYMENT_STATES.BLOCKED,
      });
      return failClosed(settlementSafety);
    }

    const freshness = validatePaymentAuthorizationFreshness({ paymentPayload, now });
    if (!freshness.ok) {
      try {
        await this.paymentStore.transitionPayment({
          idempotencyKey: prepared.idempotencyKey,
          fromStates: [
            LIVE_PAYMENT_STATES.AUTHORIZED,
            LIVE_PAYMENT_STATES.RESOURCE_RUNNING,
            LIVE_PAYMENT_STATES.RESOURCE_SUCCEEDED,
          ],
          toState: LIVE_PAYMENT_STATES.FAILED,
          updates: {
            paymentId,
            lastErrorCode: LIVE_PAYMENT_CODES.PAYMENT_INVALID,
            lastErrorMessage: freshness.reason,
            canRetry: false,
          },
        });
      } catch (error) {
        return this.failPaymentStore({ error, prepared, logger });
      }
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_INVALID,
        reason: freshness.reason,
        statusCode: 402,
        state: LIVE_PAYMENT_STATES.FAILED,
      };
    }

    let resourceSucceeded;
    try {
      resourceSucceeded = await this.paymentStore.transitionPayment({
        idempotencyKey: prepared.idempotencyKey,
        fromStates: [LIVE_PAYMENT_STATES.RESOURCE_RUNNING],
        toState: LIVE_PAYMENT_STATES.RESOURCE_SUCCEEDED,
        updates: {
          canRetry: false,
        },
      });
    } catch (error) {
      return this.failPaymentStore({ error, prepared, logger });
    }

    if (!resourceSucceeded) {
      return this.blockFromExistingState({ prepared, logger });
    }
    this.logPaymentStateTransition({
      logger,
      prepared,
      stored: resourceSucceeded,
    });

    let settlementClaim;
    try {
      settlementClaim = await this.paymentStore.claimSettlement({
        idempotencyKey: prepared.idempotencyKey,
        fromStates: [LIVE_PAYMENT_STATES.RESOURCE_SUCCEEDED],
      });
    } catch (error) {
      return this.failPaymentStore({ error, prepared, logger });
    }

    if (!settlementClaim) {
      return this.blockFromExistingState({ prepared, logger });
    }
    this.logPaymentStateTransition({
      logger,
      prepared,
      stored: settlementClaim,
    });
    this.logPostgresStoreEvent(logger, "postgres_payment_claimed", {
      prepared,
      stored: settlementClaim,
    });

    this.log(logger, "x402_live_settlement_started", {
      taskId: prepared.idempotencyKey,
      paymentId,
      amount: prepared.requestedAmount,
      asset: BASE_MAINNET_USDC.symbol,
      network: BASE_MAINNET_CAIP2,
      counterparty: prepared.config.paymentRecipient,
      status: LIVE_PAYMENT_STATES.SETTLING,
    });

    try {
      const settleResponse = await this.facilitatorClient.settle({
        paymentPayload,
        paymentRequirements: prepared.paymentRequirements,
      });
      return this.handleSettlementResponse({
        prepared,
        paymentPayload,
        paymentId,
        settleResponse,
        verifyResponse,
        settlementAttempts: settlementClaim.settlementAttempts,
        logger,
      });
    } catch (error) {
      return this.handleUnknownSettlement({
        prepared,
        paymentPayload,
        paymentId,
        verifyResponse,
        settlementAttempts: settlementClaim.settlementAttempts,
        error,
        logger,
      });
    }
  }

  async getCachedTaskResponse({ request }) {
    const idempotencyKey = normalizeText(request?.idempotencyKey);
    if (!LIVE_PAYMENT_ID_PATTERN.test(idempotencyKey)) {
      return null;
    }

    try {
      const existing = await this.paymentStore.getPayment(idempotencyKey);
      return existing?.taskResponse ?? null;
    } catch {
      return null;
    }
  }

  async getPaymentState({ taskId, paymentId, idempotencyKey } = {}) {
    const lookupId =
      normalizeText(idempotencyKey) ||
      normalizeText(taskId) ||
      normalizeText(paymentId);
    if (!LIVE_PAYMENT_ID_PATTERN.test(lookupId)) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN,
        reason: "A valid live payment taskId or paymentId is required.",
        statusCode: 400,
      };
    }

    let existing;
    try {
      existing =
        typeof this.paymentStore.getPaymentByLookup === "function"
          ? await this.paymentStore.getPaymentByLookup(lookupId)
          : await this.paymentStore.getPayment(lookupId);
    } catch (error) {
      return this.failPaymentStore({
        error,
        prepared: { idempotencyKey: lookupId, requestedAmount: "", config: {} },
      });
    }

    if (!existing) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN,
        reason: "No durable live payment state was found for this task.",
        statusCode: 404,
      };
    }

    return {
      ok: true,
      statusCode: 200,
      paymentState: createSafePaymentState(existing),
    };
  }

  async requireDurableSettlement({ request, logger }) {
    const idempotencyKey = normalizeText(request?.idempotencyKey);
    if (!LIVE_PAYMENT_ID_PATTERN.test(idempotencyKey)) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN,
        reason: "Live payment idempotency state is unavailable.",
        statusCode: 409,
        state: LIVE_PAYMENT_STATES.UNKNOWN,
      };
    }

    let existing;
    try {
      existing = await this.paymentStore.getPayment(idempotencyKey);
    } catch (error) {
      return this.failPaymentStore({
        error,
        prepared: { idempotencyKey, requestedAmount: "", config: {} },
        logger,
      });
    }

    if (
      !existing ||
      existing.state !== LIVE_PAYMENT_STATES.SETTLED ||
      !existing.payment
    ) {
      const state = existing?.state ?? LIVE_PAYMENT_STATES.UNKNOWN;
      const code =
        state === LIVE_PAYMENT_STATES.UNKNOWN
          ? LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN
          : LIVE_PAYMENT_CODES.PAYMENT_IN_PROGRESS;
      return {
        ok: false,
        code,
        reason: paymentStateReason(state),
        statusCode: 409,
        state,
      };
    }

    return {
      ok: true,
      payment: existing.payment,
      responseHeaders: createLiveSettlementHeaders(existing.settlementResponse),
    };
  }

  async storeCompletedTaskResponse({ request, responsePayload, responseHeaders }) {
    const idempotencyKey = normalizeText(request?.idempotencyKey);
    if (!LIVE_PAYMENT_ID_PATTERN.test(idempotencyKey)) {
      return;
    }

    let existing;
    try {
      existing = await this.paymentStore.getPayment(idempotencyKey);
    } catch {
      return;
    }

    if (!existing || existing.state !== LIVE_PAYMENT_STATES.SETTLED) {
      return;
    }

    try {
      await this.paymentStore.storeTaskResponse({
        idempotencyKey,
        taskId: responsePayload.taskId ?? existing.taskId,
        responsePayload,
        responseHeaders,
      });
    } catch {
      // The task already completed; duplicate-response caching is best effort.
    }
  }

  preparePayment({ request, requestHash, now, evaluateMandate } = {}) {
    if (!this.configResult.ok) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.CONFIG_INVALID,
        reason: this.configResult.reason,
        statusCode: 403,
        state: LIVE_PAYMENT_STATES.BLOCKED,
        idempotencyKey: normalizeText(request?.idempotencyKey),
      };
    }

    const safety = this.validateLiveSafety({
      request,
      requestHash,
      now,
      evaluateMandate,
    });
    if (!safety.ok) {
      return safety;
    }

    const config = this.configResult.config;
    const paymentRequirements = createLivePaymentRequirements({
      amountAtomicUnits: safety.requestedAtomicUnits,
      paymentRecipient: config.paymentRecipient,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
    });
    const paymentRequired = createLivePaymentRequired({
      paymentRequirements,
      error: "PAYMENT-SIGNATURE header is required",
      requestHash,
      idempotencyKey: safety.idempotencyKey,
    });
    const requestFingerprint = sha256Hex({
      method: "POST",
      path: "/api/task",
      taskId: safety.idempotencyKey,
      requestHash,
      amount: request.amount,
      currency: request.currency,
      counterparty: request.counterparty,
      scope: request.scope,
      mandateId: request.mandate?.mandateId,
      network: BASE_MAINNET_CAIP2,
    });
    const paymentFingerprint = sha256Hex({
      requestFingerprint,
      idempotencyKey: safety.idempotencyKey,
      paymentRequirements,
    });

    return {
      ok: true,
      config,
      fingerprint: paymentFingerprint,
      paymentFingerprint,
      requestFingerprint,
      idempotencyKey: safety.idempotencyKey,
      paymentRequired,
      paymentRequirements,
      requestedAmount: request.amount,
      requestedAtomicUnits: safety.requestedAtomicUnits,
    };
  }

  validateLiveSafety({ request, requestHash, now, evaluateMandate } = {}) {
    if (!this.configResult.ok) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.CONFIG_INVALID,
        reason: this.configResult.reason,
        statusCode: 403,
        state: LIVE_PAYMENT_STATES.BLOCKED,
      };
    }

    const config = this.configResult.config;
    const idempotencyKey = normalizeText(request?.idempotencyKey);
    if (!LIVE_PAYMENT_ID_PATTERN.test(idempotencyKey)) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.IDEMPOTENCY_REQUIRED,
        reason: "Live x402 requests require a stable idempotencyKey.",
        statusCode: 400,
        state: LIVE_PAYMENT_STATES.BLOCKED,
        idempotencyKey,
      };
    }

    const mandateDecision = safelyEvaluateMandate({
      evaluator: evaluateMandate,
      request,
      now,
    });
    if (!mandateDecision.allowed) {
      return {
        ok: false,
        code: mandateDecision.code,
        reason: mandateDecision.reason,
        statusCode: 403,
        state: LIVE_PAYMENT_STATES.BLOCKED,
        idempotencyKey,
      };
    }

    if (normalizeText(request?.currency) !== SUPPORTED_MANDATE_CURRENCY) {
      return {
        ok: false,
        code: MANDATE_CODES.CURRENCY_NOT_ALLOWED,
        reason: "Live x402 supports USDC only.",
        statusCode: 403,
        state: LIVE_PAYMENT_STATES.BLOCKED,
        idempotencyKey,
      };
    }

    let requestedAtomicUnits;
    try {
      requestedAtomicUnits = parseUsdcAmountToAtomicUnits(request.amount);
    } catch {
      return {
        ok: false,
        code: MANDATE_CODES.AMOUNT_INVALID,
        reason: "Requested live payment amount is invalid.",
        statusCode: 403,
        state: LIVE_PAYMENT_STATES.BLOCKED,
        idempotencyKey,
      };
    }

    if (requestedAtomicUnits <= 0n) {
      return {
        ok: false,
        code: MANDATE_CODES.AMOUNT_INVALID,
        reason: "Requested live payment amount must be greater than zero.",
        statusCode: 403,
        state: LIVE_PAYMENT_STATES.BLOCKED,
        idempotencyKey,
      };
    }

    if (requestedAtomicUnits > config.maxLivePaymentAtomicUnits) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.SPEND_EXCEEDS_CAP,
        reason: "Requested amount exceeds X402_MAX_LIVE_PAYMENT_USDC.",
        statusCode: 403,
        state: LIVE_PAYMENT_STATES.BLOCKED,
        idempotencyKey,
      };
    }

    const requestCounterparty = normalizeText(request?.counterparty);
    const mandateCounterparties = Array.isArray(request?.mandate?.allowedCounterparties)
      ? request.mandate.allowedCounterparties.map((entry) => normalizeText(entry))
      : [];
    const hasWildcardCounterparty = mandateCounterparties.some((entry) =>
      ["*", "all", "any"].includes(entry.toLowerCase()),
    );
    const boundCounterparty =
      requestCounterparty === config.paymentRecipient &&
      mandateCounterparties.length === 1 &&
      mandateCounterparties[0] === config.paymentRecipient;

    if (hasWildcardCounterparty || !boundCounterparty) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.COUNTERPARTY_MISMATCH,
        reason:
          "Live x402 counterparty must exactly match the mandate counterparty and payment recipient.",
        statusCode: 403,
        state: LIVE_PAYMENT_STATES.BLOCKED,
        idempotencyKey,
      };
    }

    return {
      ok: true,
      idempotencyKey,
      requestHash,
      requestedAtomicUnits,
    };
  }

  async handleDuplicatePayment({ existing, prepared, logger }) {
    if (
      existing.requestFingerprint !== prepared.requestFingerprint ||
      existing.paymentFingerprint !== prepared.paymentFingerprint
    ) {
      this.logPostgresStoreEvent(logger, "postgres_duplicate_detected", {
        prepared,
        stored: existing,
      });
      return this.failDuplicateOrMismatch({
        prepared,
        code: LIVE_PAYMENT_CODES.IDEMPOTENCY_CONFLICT,
        reason:
          "Idempotency key was already used for a different live payment request.",
        logger,
      });
    }

    if (existing.taskResponse) {
      this.log(logger, "payment_duplicate_detected", {
        taskId: prepared.idempotencyKey,
        paymentId: existing.paymentId ?? prepared.idempotencyKey,
        amount: prepared.requestedAmount,
        asset: BASE_MAINNET_USDC.symbol,
        network: BASE_MAINNET_CAIP2,
        counterparty: prepared.config.paymentRecipient,
        status: existing.state,
      });
      this.logPostgresStoreEvent(logger, "postgres_duplicate_detected", {
        prepared,
        stored: existing,
      });
      return {
        ok: true,
        payment: existing.payment,
        cachedTaskResponse: existing.taskResponse,
        responseHeaders: existing.taskResponse.headers,
      };
    }

    if (existing.state === LIVE_PAYMENT_STATES.SETTLED && existing.payment) {
      this.log(logger, "payment_duplicate_detected", {
        taskId: prepared.idempotencyKey,
        paymentId: existing.paymentId ?? prepared.idempotencyKey,
        amount: prepared.requestedAmount,
        asset: BASE_MAINNET_USDC.symbol,
        network: BASE_MAINNET_CAIP2,
        counterparty: prepared.config.paymentRecipient,
        status: existing.state,
        transactionHash: existing.transactionHash,
      });
      this.logPostgresStoreEvent(logger, "postgres_duplicate_detected", {
        prepared,
        stored: existing,
      });
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_IN_PROGRESS,
        reason: "Payment settled; task response is still being finalized.",
        statusCode: 409,
        state: existing.state,
        responseHeaders: createLiveSettlementHeaders(existing.settlementResponse),
      };
    }

    if (existing.state === LIVE_PAYMENT_STATES.SETTLING) {
      return this.recoverSettlingPayment({ existing, prepared, logger });
    }

    if (
      [
        LIVE_PAYMENT_STATES.AUTHORIZED,
        LIVE_PAYMENT_STATES.RESOURCE_RUNNING,
        LIVE_PAYMENT_STATES.RESOURCE_SUCCEEDED,
      ].includes(existing.state)
    ) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_IN_PROGRESS,
        reason: paymentStateReason(existing.state),
        statusCode: 409,
        state: existing.state,
      };
    }

    if (existing.state === LIVE_PAYMENT_STATES.UNKNOWN) {
      this.log(logger, "x402_live_blocked", {
        taskId: prepared.idempotencyKey,
        paymentId: existing.paymentId ?? prepared.idempotencyKey,
        amount: prepared.requestedAmount,
        asset: BASE_MAINNET_USDC.symbol,
        network: BASE_MAINNET_CAIP2,
        counterparty: prepared.config.paymentRecipient,
        status: existing.state,
      });
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN,
        reason:
          "Prior settlement state is ambiguous; manual reconciliation is required before retry.",
        statusCode: 409,
        state: existing.state,
      };
    }

    if (existing.state === LIVE_PAYMENT_STATES.FAILED && existing.canRetry !== true) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.PAYMENT_RETRY_NOT_SAFE,
        reason: "Previous live payment attempt failed and is not retryable.",
        statusCode: 402,
        state: LIVE_PAYMENT_STATES.FAILED,
      };
    }

    if (existing.state === LIVE_PAYMENT_STATES.BLOCKED) {
      return {
        ok: false,
        code: LIVE_PAYMENT_CODES.BLOCKED,
        reason: existing.lastErrorMessage || "Live payment is blocked.",
        statusCode: 403,
        state: LIVE_PAYMENT_STATES.BLOCKED,
      };
    }

    return null;
  }

  async recoverSettlingPayment({ existing, prepared, logger }) {
    this.log(logger, "payment_recovery_started", {
      taskId: prepared.idempotencyKey,
      paymentId: existing.paymentId ?? prepared.idempotencyKey,
      amount: prepared.requestedAmount,
      asset: BASE_MAINNET_USDC.symbol,
      network: BASE_MAINNET_CAIP2,
      counterparty: prepared.config.paymentRecipient,
      status: existing.state,
      transactionHash: existing.transactionHash,
    });

    const status = await this.reconcileUnknownSettlement({
      paymentRequirements: existing.paymentRequirements ?? prepared.paymentRequirements,
      paymentId: existing.paymentId || prepared.idempotencyKey,
    });

    if (status.ok && status.settleResponse) {
      const settlement = verifySettlementResponse({
        settleResponse: status.settleResponse,
        paymentRequirements: existing.paymentRequirements ?? prepared.paymentRequirements,
      });
      if (settlement.ok) {
        const recoveryPayer =
          existing.payment?.payer ?? status.settleResponse.payer ?? "";
        let baseVerification;
        try {
          baseVerification = await this.settlementVerifier({
            transactionHash: status.settleResponse.transaction,
            payer: recoveryPayer,
            recipient: prepared.config.paymentRecipient,
            amountAtomic: prepared.paymentRequirements.amount,
          });
        } catch (error) {
          return this.markSettlementUnknown({
            prepared,
            paymentId: existing.paymentId || prepared.idempotencyKey,
            settleResponse: status.settleResponse,
            reason:
              error instanceof BaseSettlementVerificationError
                ? error.message
                : "Base settlement verification failed.",
            code:
              error?.code ??
              BASE_SETTLEMENT_VERIFICATION_CODES.RPC_ERROR,
            logger,
          });
        }

        if (!baseVerification?.ok) {
          return this.markSettlementUnknown({
            prepared,
            paymentId: existing.paymentId || prepared.idempotencyKey,
            settleResponse: status.settleResponse,
            reason:
              baseVerification?.reason ??
              "Base settlement verification did not prove the expected transfer.",
            code:
              baseVerification?.code ??
              BASE_SETTLEMENT_VERIFICATION_CODES.TRANSFER_MISSING,
            logger,
          });
        }

        const payment = createLivePaymentRecord({
          prepared,
          paymentPayload: {
            payload: {
              authorization: {
                from: recoveryPayer,
              },
            },
          },
          paymentId: existing.paymentId || prepared.idempotencyKey,
          settleResponse: status.settleResponse,
          verifyResponse: {},
        });
        try {
          const settled = await this.paymentStore.transitionPayment({
            idempotencyKey: prepared.idempotencyKey,
            fromStates: [LIVE_PAYMENT_STATES.SETTLING],
            toState: LIVE_PAYMENT_STATES.SETTLED,
            updates: {
              payment,
              settlementResponse: status.settleResponse,
              transactionHash: payment.transactionHash,
              facilitatorReference: payment.reference,
              settledAt: payment.settledAt,
              lastErrorCode: null,
              lastErrorMessage: null,
              canRetry: false,
            },
          });
          this.logPaymentStateTransition({ logger, prepared, stored: settled });
          this.log(logger, "payment_reconciled", {
            taskId: prepared.idempotencyKey,
            paymentId: payment.paymentId,
            amount: prepared.requestedAmount,
            asset: BASE_MAINNET_USDC.symbol,
            network: BASE_MAINNET_CAIP2,
            counterparty: prepared.config.paymentRecipient,
            status: LIVE_PAYMENT_STATES.SETTLED,
            transactionHash: payment.transactionHash,
          });
          return {
            ok: true,
            payment: settled.payment,
            responseHeaders: createLiveSettlementHeaders(status.settleResponse),
          };
        } catch (error) {
          return this.failPaymentStore({ error, prepared, logger });
        }
      }
    }

    const state =
      status.state === LIVE_PAYMENT_STATES.FAILED
        ? LIVE_PAYMENT_STATES.FAILED
        : LIVE_PAYMENT_STATES.UNKNOWN;
    const code =
      state === LIVE_PAYMENT_STATES.FAILED
        ? LIVE_PAYMENT_CODES.SETTLEMENT_FAILED
        : LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN;
    const reason =
      status.reason ??
      "Persisted SETTLING payment could not be reconciled as settled.";

    try {
      await this.paymentStore.transitionPayment({
        idempotencyKey: prepared.idempotencyKey,
        fromStates: [LIVE_PAYMENT_STATES.SETTLING],
        toState: state,
        updates: {
          lastErrorCode: code,
          lastErrorMessage: reason,
          canRetry: state === LIVE_PAYMENT_STATES.FAILED,
        },
      });
    } catch (error) {
      return this.failPaymentStore({ error, prepared, logger });
    }

    this.log(logger, state === LIVE_PAYMENT_STATES.FAILED ? "payment_reconciled" : "payment_recovery_blocked", {
      taskId: prepared.idempotencyKey,
      paymentId: existing.paymentId ?? prepared.idempotencyKey,
      amount: prepared.requestedAmount,
      asset: BASE_MAINNET_USDC.symbol,
      network: BASE_MAINNET_CAIP2,
      counterparty: prepared.config.paymentRecipient,
      status: state,
      transactionHash: existing.transactionHash,
    });

    return {
      ok: false,
      code,
      reason,
      statusCode: state === LIVE_PAYMENT_STATES.FAILED ? 402 : 409,
      state,
    };
  }

  async blockFromExistingState({ prepared, logger }) {
    let existing;
    try {
      existing = await this.paymentStore.getPayment(prepared.idempotencyKey);
    } catch (error) {
      return this.failPaymentStore({ error, prepared, logger });
    }

    const state = existing?.state ?? LIVE_PAYMENT_STATES.UNKNOWN;
    const code =
      state === LIVE_PAYMENT_STATES.SETTLED
        ? LIVE_PAYMENT_CODES.PAYMENT_ALREADY_SETTLED
        : state === LIVE_PAYMENT_STATES.UNKNOWN
          ? LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN
          : LIVE_PAYMENT_CODES.PAYMENT_IN_PROGRESS;

    this.log(logger, "payment_duplicate_detected", {
      taskId: prepared.idempotencyKey,
      paymentId: existing?.paymentId ?? prepared.idempotencyKey,
      amount: prepared.requestedAmount,
      asset: BASE_MAINNET_USDC.symbol,
      network: BASE_MAINNET_CAIP2,
      counterparty: prepared.config.paymentRecipient,
      status: state,
      transactionHash: existing?.transactionHash ?? "",
    });
    this.logPostgresStoreEvent(logger, "postgres_duplicate_detected", {
      prepared,
      stored: existing,
    });

    return {
      ok: false,
      code,
      reason: paymentStateReason(state),
      statusCode: state === LIVE_PAYMENT_STATES.SETTLED ? 409 : 409,
      state,
    };
  }

  failPaymentStore({ error, prepared, logger }) {
    const reason = "Payment store operation failed.";
    this.log(logger, "x402_live_blocked", {
      taskId: prepared?.idempotencyKey ?? "",
      paymentId: prepared?.idempotencyKey ?? "",
      amount: prepared?.requestedAmount ?? "",
      asset: BASE_MAINNET_USDC.symbol,
      network: BASE_MAINNET_CAIP2,
      counterparty: prepared?.config?.paymentRecipient ?? "",
      status: LIVE_PAYMENT_STATES.BLOCKED,
    });
    this.logPostgresStoreEvent(logger, "postgres_store_error", {
      prepared,
      stored: null,
    });

    return {
      ok: false,
      code: LIVE_PAYMENT_CODES.PAYMENT_STORE_ERROR,
      reason,
      statusCode: 503,
      state: LIVE_PAYMENT_STATES.BLOCKED,
    };
  }

  failDuplicateOrMismatch({ prepared, code, reason, logger }) {
    this.log(logger, "x402_live_blocked", {
      taskId: prepared.idempotencyKey,
      paymentId: prepared.idempotencyKey,
      amount: prepared.requestedAmount,
      asset: BASE_MAINNET_USDC.symbol,
      network: BASE_MAINNET_CAIP2,
      counterparty: prepared.config.paymentRecipient,
      status: LIVE_PAYMENT_STATES.BLOCKED,
    });
    return {
      ok: false,
      code,
      reason,
      statusCode: 409,
      state: LIVE_PAYMENT_STATES.BLOCKED,
    };
  }

  async handleSettlementResponse({
    prepared,
    paymentPayload,
    paymentId,
    settleResponse,
    verifyResponse,
    settlementAttempts,
    logger,
  }) {
    const settlement = verifySettlementResponse({
      settleResponse,
      paymentRequirements: prepared.paymentRequirements,
    });

    if (!settlement.ok) {
      const state =
        settlement.ambiguous === true
          ? LIVE_PAYMENT_STATES.UNKNOWN
          : LIVE_PAYMENT_STATES.FAILED;
      const canRetry = settlement.ambiguous !== true;
      try {
        await this.paymentStore.transitionPayment({
          idempotencyKey: prepared.idempotencyKey,
          fromStates: [LIVE_PAYMENT_STATES.SETTLING],
          toState: state,
          updates: {
            paymentId,
            settlementResponse: settleResponse,
            transactionHash: safeTransactionHash(settleResponse?.transaction),
            lastErrorCode:
              settlement.code ??
              (settlement.ambiguous
                ? LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN
                : LIVE_PAYMENT_CODES.SETTLEMENT_FAILED),
            lastErrorMessage: settlement.reason,
            canRetry,
          },
        });
      } catch (error) {
        return this.failPaymentStore({ error, prepared, logger });
      }
      this.log(logger, settlement.ambiguous ? "x402_live_unknown" : "x402_live_failed", {
        taskId: prepared.idempotencyKey,
        paymentId,
        amount: prepared.requestedAmount,
        asset: BASE_MAINNET_USDC.symbol,
        network: BASE_MAINNET_CAIP2,
        counterparty: prepared.config.paymentRecipient,
        status: state,
        transactionHash: safeTransactionHash(settleResponse?.transaction),
      });
      return {
        ok: false,
        code:
          settlement.code ??
          (settlement.ambiguous
            ? LIVE_PAYMENT_CODES.SETTLEMENT_UNKNOWN
            : LIVE_PAYMENT_CODES.SETTLEMENT_FAILED),
        reason: settlement.reason,
        statusCode: settlement.ambiguous ? 409 : 402,
        state,
        responseHeaders: createLiveSettlementHeaders(settleResponse),
      };
    }

    const baseVerification = await this.verifySettlementOnBase({
      prepared,
      paymentPayload,
      settleResponse,
      paymentId,
      logger,
    });
    if (!baseVerification.ok) {
      return baseVerification;
    }

    const payment = createLivePaymentRecord({
      prepared,
      paymentPayload,
      paymentId,
      settleResponse,
      verifyResponse,
    });
    let persistedSettlement;
    try {
      persistedSettlement = await this.paymentStore.transitionPayment({
        idempotencyKey: prepared.idempotencyKey,
        fromStates: [LIVE_PAYMENT_STATES.SETTLING],
        toState: LIVE_PAYMENT_STATES.SETTLED,
        updates: {
          payment,
          paymentId,
          settlementResponse: settleResponse,
          transactionHash: payment.transactionHash,
          facilitatorReference: payment.reference,
          settledAt: payment.settledAt,
          lastErrorCode: null,
          lastErrorMessage: null,
          canRetry: false,
        },
      });
    } catch (error) {
      return this.failPaymentStore({ error, prepared, logger });
    }

    if (!persistedSettlement || persistedSettlement.state !== LIVE_PAYMENT_STATES.SETTLED) {
      return this.failPaymentStore({
        error: new PaymentStoreError("Failed to persist settled payment state."),
        prepared,
        logger,
      });
    }
    this.logPaymentStateTransition({
      logger,
      prepared,
      stored: persistedSettlement,
    });
    this.log(logger, "x402_live_settled", {
      taskId: prepared.idempotencyKey,
      paymentId,
      amount: prepared.requestedAmount,
      asset: BASE_MAINNET_USDC.symbol,
      network: BASE_MAINNET_CAIP2,
      counterparty: prepared.config.paymentRecipient,
      status: LIVE_PAYMENT_STATES.SETTLED,
      transactionHash: payment.transactionHash,
    });

    return {
      ok: true,
      payment: persistedSettlement.payment,
      responseHeaders: createLiveSettlementHeaders(settleResponse),
    };
  }

  async verifySettlementOnBase({
    prepared,
    paymentPayload,
    settleResponse,
    paymentId,
    logger,
  }) {
    const authorization = paymentPayload?.payload?.authorization;
    let verification;
    try {
      verification = await this.settlementVerifier({
        transactionHash: settleResponse.transaction,
        payer: authorization?.from ?? settleResponse.payer,
        recipient: prepared.config.paymentRecipient,
        amountAtomic: prepared.paymentRequirements.amount,
      });
    } catch (error) {
      const reason =
        error instanceof BaseSettlementVerificationError
          ? error.message
          : "Base settlement verification failed.";
      return this.markSettlementUnknown({
        prepared,
        paymentId,
        settleResponse,
        reason,
        code:
          error?.code ??
          BASE_SETTLEMENT_VERIFICATION_CODES.RPC_ERROR,
        logger,
      });
    }

    if (!verification?.ok) {
      return this.markSettlementUnknown({
        prepared,
        paymentId,
        settleResponse,
        reason:
          verification?.reason ??
          "Base settlement verification did not prove the expected transfer.",
        code:
          verification?.code ??
          BASE_SETTLEMENT_VERIFICATION_CODES.TRANSFER_MISSING,
        logger,
      });
    }

    return { ok: true };
  }

  async markSettlementUnknown({
    prepared,
    paymentId,
    settleResponse,
    reason,
    code,
    logger,
  }) {
    try {
      await this.paymentStore.transitionPayment({
        idempotencyKey: prepared.idempotencyKey,
        fromStates: [LIVE_PAYMENT_STATES.SETTLING],
        toState: LIVE_PAYMENT_STATES.UNKNOWN,
        updates: {
          paymentId,
          settlementResponse: settleResponse,
          transactionHash: safeTransactionHash(settleResponse?.transaction),
          lastErrorCode: code,
          lastErrorMessage: reason,
          canRetry: false,
        },
      });
    } catch (error) {
      return this.failPaymentStore({ error, prepared, logger });
    }

    this.log(logger, "x402_live_unknown", {
      taskId: prepared.idempotencyKey,
      paymentId,
      amount: prepared.requestedAmount,
      asset: BASE_MAINNET_USDC.symbol,
      network: BASE_MAINNET_CAIP2,
      counterparty: prepared.config.paymentRecipient,
      status: LIVE_PAYMENT_STATES.UNKNOWN,
      transactionHash: safeTransactionHash(settleResponse?.transaction),
    });

    return {
      ok: false,
      code: LIVE_PAYMENT_CODES.SETTLEMENT_UNKNOWN,
      reason,
      statusCode: 409,
      state: LIVE_PAYMENT_STATES.UNKNOWN,
      responseHeaders: createLiveSettlementHeaders(settleResponse),
    };
  }

  async handleUnknownSettlement({
    prepared,
    paymentPayload,
    paymentId,
    verifyResponse,
    settlementAttempts,
    error,
    logger,
  }) {
    const status = await this.reconcileUnknownSettlement({
      paymentPayload,
      paymentRequirements: prepared.paymentRequirements,
      paymentId,
    });

    if (status.ok && status.settleResponse) {
      return this.handleSettlementResponse({
        prepared,
        paymentPayload,
        paymentId,
        settleResponse: status.settleResponse,
        verifyResponse,
        settlementAttempts,
        logger,
      });
    }

    const state =
      status.state === LIVE_PAYMENT_STATES.FAILED
        ? LIVE_PAYMENT_STATES.FAILED
        : LIVE_PAYMENT_STATES.UNKNOWN;
    const canRetry = state === LIVE_PAYMENT_STATES.FAILED;
    try {
      await this.paymentStore.transitionPayment({
        idempotencyKey: prepared.idempotencyKey,
        fromStates: [LIVE_PAYMENT_STATES.SETTLING],
        toState: state,
        updates: {
          paymentId,
          lastErrorCode:
            state === LIVE_PAYMENT_STATES.FAILED
              ? LIVE_PAYMENT_CODES.SETTLEMENT_FAILED
              : LIVE_PAYMENT_CODES.PAYMENT_STATUS_UNKNOWN,
          lastErrorMessage:
            status.reason ??
            safeErrorMessage(
              error,
              "Settlement status is unknown; manual reconciliation is required before retry.",
            ),
          canRetry,
        },
      });
    } catch (storeError) {
      return this.failPaymentStore({ error: storeError, prepared, logger });
    }
    this.log(logger, state === LIVE_PAYMENT_STATES.FAILED ? "x402_live_failed" : "x402_live_unknown", {
      taskId: prepared.idempotencyKey,
      paymentId,
      amount: prepared.requestedAmount,
      asset: BASE_MAINNET_USDC.symbol,
      network: BASE_MAINNET_CAIP2,
      counterparty: prepared.config.paymentRecipient,
      status: state,
    });

    return {
      ok: false,
      code:
        state === LIVE_PAYMENT_STATES.FAILED
          ? LIVE_PAYMENT_CODES.SETTLEMENT_FAILED
          : LIVE_PAYMENT_CODES.SETTLEMENT_UNKNOWN,
      reason:
        status.reason ??
        safeErrorMessage(
          error,
          "Settlement status is unknown; manual reconciliation is required before retry.",
        ),
      statusCode: state === LIVE_PAYMENT_STATES.FAILED ? 402 : 409,
      state,
    };
  }

  async reconcileUnknownSettlement({ paymentPayload, paymentRequirements, paymentId }) {
    if (typeof this.facilitatorClient?.getSettlementStatus !== "function") {
      return {
        ok: false,
        state: LIVE_PAYMENT_STATES.UNKNOWN,
        reason:
          "Facilitator status lookup is unavailable; settlement state is ambiguous.",
      };
    }

    try {
      const statusResponse = await this.facilitatorClient.getSettlementStatus({
        paymentId,
        paymentPayload,
        paymentRequirements,
      });
      const settlement = verifySettlementResponse({
        settleResponse: statusResponse,
        paymentRequirements,
      });
      if (settlement.ok) {
        return {
          ok: true,
          state: LIVE_PAYMENT_STATES.SETTLED,
          settleResponse: statusResponse,
        };
      }

      if (settlement.ambiguous) {
        return {
          ok: false,
          state: LIVE_PAYMENT_STATES.UNKNOWN,
          reason: settlement.reason,
        };
      }

      return {
        ok: false,
        state: LIVE_PAYMENT_STATES.FAILED,
        reason: settlement.reason,
      };
    } catch {
      return {
        ok: false,
        state: LIVE_PAYMENT_STATES.UNKNOWN,
        reason:
          "Facilitator status lookup failed; settlement state is ambiguous.",
      };
    }
  }

  log(logger, event, fields) {
    if (typeof logger !== "function") {
      return;
    }

    try {
      logger({ event, ...fields });
    } catch {
      // Payment logging is best-effort and must not affect safety decisions.
    }
  }

  logPaymentStateTransition({ logger, prepared, stored }) {
    if (!stored) {
      return;
    }

    this.log(logger, "payment_state_transition", {
      taskId: stored.taskId ?? prepared.idempotencyKey,
      paymentId: stored.paymentId ?? prepared.idempotencyKey,
      amount: prepared.requestedAmount ?? "",
      asset: BASE_MAINNET_USDC.symbol,
      network: stored.network ?? BASE_MAINNET_CAIP2,
      counterparty: stored.counterparty ?? prepared.config?.paymentRecipient ?? "",
      status: stored.state,
    });
    this.logPostgresStoreEvent(logger, "postgres_state_transition", {
      prepared,
      stored,
    });
  }

  logPostgresStoreEvent(logger, event, { prepared, stored }) {
    if (this.paymentStoreDriver !== "postgres") {
      return;
    }

    this.log(logger, event, {
      taskId: stored?.taskId ?? prepared?.idempotencyKey ?? "",
      paymentId: stored?.paymentId ?? prepared?.idempotencyKey ?? "",
      amount: prepared?.requestedAmount ?? "",
      asset: BASE_MAINNET_USDC.symbol,
      network: stored?.network ?? BASE_MAINNET_CAIP2,
      counterparty:
        stored?.counterparty ?? prepared?.config?.paymentRecipient ?? "",
      status: stored?.state ?? LIVE_PAYMENT_STATES.BLOCKED,
    });
  }
}

export class HttpX402FacilitatorClient {
  constructor({
    url = CDP_X402_FACILITATOR_URL,
    cdpApiKeyId,
    cdpApiKeySecret,
    timeoutMs = DEFAULT_FACILITATOR_TIMEOUT_MS,
    createAuthHeaders,
    generateJwtImpl = generateJwt,
  }) {
    this.url = normalizeText(url).replace(/\/+$/u, "");
    this.client = new HTTPFacilitatorClient({
      url: this.url,
      timeoutMs,
      createAuthHeaders:
        createAuthHeaders ??
        createCdpAuthHeaderFactory({
          facilitatorUrl: this.url,
          cdpApiKeyId,
          cdpApiKeySecret,
          generateJwtImpl,
        }),
    });
  }

  verify({ paymentPayload, paymentRequirements }) {
    return this.client.verify(paymentPayload, paymentRequirements);
  }

  settle({ paymentPayload, paymentRequirements }) {
    return this.client.settle(paymentPayload, paymentRequirements);
  }

  getSupported() {
    return this.client.getSupported();
  }
}

export function createCdpAuthHeaderFactory({
  facilitatorUrl = CDP_X402_FACILITATOR_URL,
  cdpApiKeyId,
  cdpApiKeySecret,
  generateJwtImpl = generateJwt,
  expiresIn = 120,
} = {}) {
  return async () => {
    const [verify, settle, supported] = await Promise.all([
      createCdpAuthorizationHeader({
        facilitatorUrl,
        operation: "verify",
        method: "POST",
        cdpApiKeyId,
        cdpApiKeySecret,
        generateJwtImpl,
        expiresIn,
      }),
      createCdpAuthorizationHeader({
        facilitatorUrl,
        operation: "settle",
        method: "POST",
        cdpApiKeyId,
        cdpApiKeySecret,
        generateJwtImpl,
        expiresIn,
      }),
      createCdpAuthorizationHeader({
        facilitatorUrl,
        operation: "supported",
        method: "GET",
        cdpApiKeyId,
        cdpApiKeySecret,
        generateJwtImpl,
        expiresIn,
      }),
    ]);

    return {
      verify,
      settle,
      supported,
    };
  };
}

async function createCdpAuthorizationHeader({
  facilitatorUrl,
  operation,
  method,
  cdpApiKeyId,
  cdpApiKeySecret,
  generateJwtImpl,
  expiresIn,
}) {
  const token = await generateJwtImpl({
    apiKeyId: cdpApiKeyId,
    apiKeySecret: cdpApiKeySecret,
    requestMethod: method,
    requestHost: CDP_REQUEST_HOST,
    requestPath: facilitatorPath({ facilitatorUrl, operation }),
    expiresIn,
  });

  return {
    Authorization: `Bearer ${token}`,
  };
}

function facilitatorPath({ facilitatorUrl, operation }) {
  try {
    const parsed = new URL(facilitatorUrl);
    const basePath = parsed.pathname.replace(/\/+$/u, "");
    return `${basePath}/${operation}`;
  } catch {
    return CDP_X402_PATHS[operation];
  }
}

export function resolveLivePaymentConfig({ env = process.env } = {}) {
  const errors = [];
  const storeDriverResult = resolvePaymentStoreDriver({ env });
  const paymentStoreDriver = storeDriverResult.ok ? storeDriverResult.driver : "";

  if (!storeDriverResult.ok) {
    errors.push(storeDriverResult.reason);
  } else if (isProductionLikeRuntime(env) && paymentStoreDriver !== "postgres") {
    errors.push(
      "Production/serverless live x402 requires PAYMENT_STORE_DRIVER=postgres.",
    );
  }

  if (
    storeDriverResult.ok &&
    paymentStoreDriver === "postgres" &&
    !normalizeText(env.PAYMENT_DATABASE_URL)
  ) {
    errors.push("PAYMENT_DATABASE_URL is required when PAYMENT_STORE_DRIVER=postgres.");
  }

  if (normalizeText(env.X402_LIVE_CONFIRM).toLowerCase() !== "true") {
    errors.push("X402_LIVE_CONFIRM must be true.");
  }

  const facilitatorUrl = normalizeText(
    env.X402_FACILITATOR_URL ?? CDP_X402_FACILITATOR_URL,
  );
  if (!isValidHttpsUrl(facilitatorUrl)) {
    errors.push("X402_FACILITATOR_URL must be an https URL.");
  } else if (facilitatorUrl.replace(/\/+$/u, "") !== CDP_X402_FACILITATOR_URL) {
    errors.push(
      "X402_FACILITATOR_URL must be the Coinbase CDP x402 facilitator base URL.",
    );
  }

  const cdpApiKeyId = normalizeText(env.CDP_API_KEY_ID);
  if (!cdpApiKeyId) {
    errors.push("CDP_API_KEY_ID is required.");
  }

  const cdpApiKeySecret = normalizeText(env.CDP_API_KEY_SECRET);
  if (!cdpApiKeySecret) {
    errors.push("CDP_API_KEY_SECRET is required.");
  }

  const network = normalizeText(env.X402_NETWORK ?? "base").toLowerCase();
  if (!["base", "base-mainnet", BASE_MAINNET_CAIP2].includes(network)) {
    errors.push("X402_NETWORK must be base / base-mainnet / eip155:8453.");
  }

  const paymentAsset = normalizeText(env.X402_PAYMENT_ASSET ?? "USDC").toUpperCase();
  if (paymentAsset !== BASE_MAINNET_USDC.symbol) {
    errors.push("X402_PAYMENT_ASSET must be USDC.");
  }

  const paymentRecipient = normalizeAddress(env.X402_PAYMENT_RECIPIENT);
  if (!paymentRecipient) {
    errors.push("X402_PAYMENT_RECIPIENT must be a 20-byte EVM address.");
  }

  let maxLivePaymentAtomicUnits = 0n;
  const maxLivePaymentUsdc = normalizeText(
    env.X402_MAX_LIVE_PAYMENT_USDC ?? DEFAULT_LIVE_CAP_USDC,
  );
  try {
    maxLivePaymentAtomicUnits = parseUsdcAmountToAtomicUnits(maxLivePaymentUsdc);
    if (maxLivePaymentAtomicUnits <= 0n) {
      errors.push("X402_MAX_LIVE_PAYMENT_USDC must be greater than zero.");
    } else if (maxLivePaymentAtomicUnits > HARD_MAX_LIVE_CAP_ATOMIC_UNITS) {
      errors.push("X402_MAX_LIVE_PAYMENT_USDC must be 0.10 USDC or less.");
    }
  } catch {
    errors.push("X402_MAX_LIVE_PAYMENT_USDC must be a USDC decimal string.");
  }

  const maxTimeoutSeconds = Number(
    env.X402_PAYMENT_MAX_TIMEOUT_SECONDS ?? DEFAULT_MAX_TIMEOUT_SECONDS,
  );
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds < 1) {
    errors.push("X402_PAYMENT_MAX_TIMEOUT_SECONDS must be a positive integer.");
  }

  const facilitatorTimeoutMs = Number(
    env.X402_FACILITATOR_TIMEOUT_MS ?? DEFAULT_FACILITATOR_TIMEOUT_MS,
  );
  if (!Number.isInteger(facilitatorTimeoutMs) || facilitatorTimeoutMs < 1000) {
    errors.push("X402_FACILITATOR_TIMEOUT_MS must be at least 1000.");
  }

  const baseMainnetRpcUrl = normalizeText(
    env.BASE_MAINNET_RPC_URL ?? BASE_MAINNET.rpcUrl,
  );
  if (!isValidHttpsUrl(baseMainnetRpcUrl)) {
    errors.push("BASE_MAINNET_RPC_URL must be an https URL.");
  }

  const baseVerificationTimeoutMs = Number(
    env.BASE_SETTLEMENT_VERIFICATION_TIMEOUT_MS ??
      DEFAULT_BASE_VERIFICATION_TIMEOUT_MS,
  );
  if (
    !Number.isInteger(baseVerificationTimeoutMs) ||
    baseVerificationTimeoutMs < 1000
  ) {
    errors.push("BASE_SETTLEMENT_VERIFICATION_TIMEOUT_MS must be at least 1000.");
  }

  if (errors.length > 0) {
    return {
      ok: false,
      code: LIVE_PAYMENT_CODES.CONFIG_INVALID,
      reason: errors.join(" "),
    };
  }

  return {
    ok: true,
    config: {
      baseMainnetRpcUrl,
      baseVerificationTimeoutMs,
      cdpApiKeyId,
      cdpApiKeySecret,
      facilitatorUrl,
      facilitatorTimeoutMs,
      maxLivePaymentAtomicUnits,
      maxLivePaymentUsdc,
      maxTimeoutSeconds,
      network: BASE_MAINNET_CAIP2,
      paymentAsset: BASE_MAINNET_USDC.symbol,
      paymentRecipient,
      paymentStoreDriver,
    },
  };
}

export function createLivePaymentRequirements({
  amountAtomicUnits,
  paymentRecipient,
  maxTimeoutSeconds = DEFAULT_MAX_TIMEOUT_SECONDS,
}) {
  return {
    scheme: "exact",
    network: BASE_MAINNET_CAIP2,
    amount: amountAtomicUnits.toString(),
    asset: BASE_MAINNET_USDC.address,
    payTo: paymentRecipient,
    maxTimeoutSeconds,
    extra: {
      name: BASE_MAINNET_USDC.eip712Name,
      version: BASE_MAINNET_USDC.eip712Version,
      decimals: BASE_MAINNET_USDC.decimals,
      assetTransferMethod: "eip3009",
    },
  };
}

export function createLivePaymentRequired({
  paymentRequirements,
  error,
}) {
  return {
    x402Version: 2,
    error,
    resource: {
      url: TASK_RESOURCE_PATH,
      description: TASK_RESOURCE_DESCRIPTION,
      mimeType: "application/json",
      serviceName: "Base Agent Pay",
      tags: ["base", "ai", "x402"],
    },
    accepts: [paymentRequirements],
    extensions: createTaskBazaarDiscoveryExtensions(),
  };
}

export function parsePaymentSignatureHeader(headerValue) {
  try {
    const paymentPayload = decodePaymentSignatureHeader(String(headerValue));
    if (!paymentPayload || typeof paymentPayload !== "object") {
      return {
        ok: false,
        reason: "PAYMENT-SIGNATURE must decode to a payment payload object.",
      };
    }

    return {
      ok: true,
      paymentPayload,
    };
  } catch {
    return {
      ok: false,
      reason: "PAYMENT-SIGNATURE must be base64-encoded JSON.",
    };
  }
}

export function encodePaymentSignatureForTest(paymentPayload) {
  return encodePaymentSignatureHeader(paymentPayload);
}

function validatePaymentPayloadBinding({
  paymentPayload,
  paymentRequirements,
  paymentRecipient,
  now,
}) {
  if (paymentPayload.x402Version !== 2) {
    return { ok: false, reason: "Payment payload must use x402Version 2." };
  }

  const accepted = paymentPayload.accepted;
  if (!accepted || typeof accepted !== "object") {
    return { ok: false, reason: "Payment payload is missing accepted requirements." };
  }

  for (const key of ["scheme", "network", "amount", "asset", "payTo"]) {
    if (accepted[key] !== paymentRequirements[key]) {
      return {
        ok: false,
        reason: `Payment payload accepted.${key} does not match payment requirements.`,
      };
    }
  }

  for (const key of ["name", "version", "assetTransferMethod"]) {
    if (accepted.extra?.[key] !== paymentRequirements.extra?.[key]) {
      return {
        ok: false,
        reason: `Payment payload accepted.extra.${key} does not match payment requirements.`,
      };
    }
  }

  const authorization = paymentPayload.payload?.authorization;
  if (!authorization || typeof authorization !== "object") {
    return { ok: false, reason: "Payment payload is missing authorization details." };
  }

  if (typeof paymentPayload.payload?.signature !== "string") {
    return { ok: false, reason: "Payment payload is missing a wallet signature." };
  }

  if (!normalizeAddress(authorization.from)) {
    return { ok: false, reason: "Payment authorization payer is invalid." };
  }

  if (normalizeAddress(authorization.to) !== paymentRecipient) {
    return {
      ok: false,
      reason: "Payment authorization recipient does not match live payment target.",
    };
  }

  if (String(authorization.value) !== paymentRequirements.amount) {
    return {
      ok: false,
      reason: "Payment authorization amount does not match live payment amount.",
    };
  }

  return validatePaymentAuthorizationFreshness({ paymentPayload, now });
}

function validateFacilitatorPayerBinding({ paymentPayload, verifyResponse }) {
  const verifiedPayer = normalizeAddress(verifyResponse?.payer);
  if (!verifiedPayer) {
    return { ok: true };
  }

  const authorizedPayer = normalizeAddress(
    paymentPayload?.payload?.authorization?.from,
  );
  if (authorizedPayer !== verifiedPayer) {
    return {
      ok: false,
      reason:
        "Facilitator payer does not match the signed payment authorization.",
    };
  }

  return { ok: true };
}

function validatePaymentAuthorizationFreshness({ paymentPayload, now }) {
  const authorization = paymentPayload?.payload?.authorization;
  const validAfter = parseUnsignedInteger(authorization?.validAfter);
  const validBefore = parseUnsignedInteger(authorization?.validBefore);
  const nonce = normalizeText(authorization?.nonce);

  if (validAfter === null || validBefore === null) {
    return {
      ok: false,
      reason: "Payment authorization validity window is invalid.",
    };
  }

  if (!/^0x[a-fA-F0-9]{64}$/u.test(nonce)) {
    return {
      ok: false,
      reason: "Payment authorization nonce is invalid.",
    };
  }

  const nowSeconds = secondsFromNow(now);
  if (validAfter > nowSeconds) {
    return {
      ok: false,
      reason: "Payment authorization is not valid yet.",
    };
  }

  if (validBefore <= nowSeconds) {
    return {
      ok: false,
      reason: "Payment authorization has expired.",
    };
  }

  return { ok: true };
}

function parseUnsignedInteger(value) {
  const normalized = normalizeText(value);
  if (!/^(0|[1-9]\d*)$/u.test(normalized)) {
    return null;
  }

  return BigInt(normalized);
}

function secondsFromNow(now) {
  if (now instanceof Date) {
    return BigInt(Math.floor(now.getTime() / 1000));
  }

  if (typeof now === "string" && now.length > 0) {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) {
      return BigInt(Math.floor(parsed / 1000));
    }
  }

  return BigInt(Math.floor(Date.now() / 1000));
}

function verifySettlementResponse({ settleResponse, paymentRequirements }) {
  if (!settleResponse || typeof settleResponse !== "object") {
    return {
      ok: false,
      ambiguous: true,
      reason: "Facilitator settlement response was missing or malformed.",
      code: LIVE_PAYMENT_CODES.SETTLEMENT_UNKNOWN,
    };
  }

  if (settleResponse.success !== true) {
    const reason =
      normalizeText(settleResponse.errorReason) ||
      "Facilitator did not report successful settlement.";
    const transaction = normalizeText(settleResponse.transaction);
    const ambiguous =
      reason === "settlement_pending" || (transaction.length > 0 && !TX_HASH_PATTERN.test(transaction));

    return {
      ok: false,
      ambiguous,
      reason,
      code:
        reason === "settlement_pending"
          ? LIVE_PAYMENT_CODES.SETTLEMENT_PENDING
          : LIVE_PAYMENT_CODES.SETTLEMENT_FAILED,
    };
  }

  if (!isExpectedBaseSettlementNetwork(settleResponse.network, paymentRequirements.network)) {
    return {
      ok: false,
      ambiguous: true,
      reason: "Settlement network does not match the required Base Mainnet network.",
      code: LIVE_PAYMENT_CODES.SETTLEMENT_UNKNOWN,
    };
  }

  if (!TX_HASH_PATTERN.test(normalizeText(settleResponse.transaction))) {
    return {
      ok: false,
      ambiguous: true,
      reason: "Settlement response is missing a valid Base transaction hash.",
      code: LIVE_PAYMENT_CODES.SETTLEMENT_UNKNOWN,
    };
  }

  if (
    settleResponse.amount !== undefined &&
    String(settleResponse.amount) !== paymentRequirements.amount
  ) {
    return {
      ok: false,
      ambiguous: true,
      reason: "Settlement amount does not match the required live payment amount.",
      code: LIVE_PAYMENT_CODES.SETTLEMENT_UNKNOWN,
    };
  }

  return { ok: true };
}

function isExpectedBaseSettlementNetwork(network, expectedNetwork) {
  if (network === expectedNetwork) {
    return true;
  }

  return (
    expectedNetwork === BASE_MAINNET_CAIP2 &&
    ["base", "base-mainnet"].includes(normalizeText(network).toLowerCase())
  );
}

function createLiveAuthorizedPaymentRecord({
  prepared,
  paymentPayload,
  paymentId,
  verifyResponse,
}) {
  const authorization = paymentPayload?.payload?.authorization ?? {};
  return {
    mode: "live",
    scheme: "exact",
    status: LIVE_PAYMENT_STATES.AUTHORIZED,
    settlementStatus: LIVE_PAYMENT_STATES.AUTHORIZED,
    paymentId,
    idempotencyKey: prepared.idempotencyKey,
    network: createLiveNetworkRecord(prepared),
    asset: createLiveAssetRecord(),
    amount: prepared.requestedAmount,
    atomicAmount: prepared.requestedAtomicUnits.toString(),
    currency: BASE_MAINNET_USDC.symbol,
    recipient: prepared.config.paymentRecipient,
    payee: prepared.config.paymentRecipient,
    payer: normalizeAddress(authorization.from) || normalizeText(verifyResponse?.payer),
    transactionHash: "",
    reference: paymentId,
    authorizedAt: new Date().toISOString(),
  };
}

function createLivePaymentRecord({
  prepared,
  paymentPayload,
  paymentId,
  settleResponse,
  verifyResponse,
}) {
  const transactionHash = normalizeText(settleResponse.transaction);
  const authorization = paymentPayload?.payload?.authorization ?? {};
  return {
    mode: "live",
    scheme: "exact",
    status: LIVE_PAYMENT_STATES.SETTLED,
    settlementStatus: LIVE_PAYMENT_STATES.SETTLED,
    paymentId,
    idempotencyKey: prepared.idempotencyKey,
    network: createLiveNetworkRecord(prepared),
    asset: createLiveAssetRecord(),
    amount: prepared.requestedAmount,
    atomicAmount: prepared.requestedAtomicUnits.toString(),
    currency: BASE_MAINNET_USDC.symbol,
    recipient: prepared.config.paymentRecipient,
    payee: prepared.config.paymentRecipient,
    payer:
      normalizeAddress(authorization.from) ||
      normalizeText(settleResponse.payer ?? verifyResponse?.payer),
    transactionHash,
    reference: transactionHash,
    settledAt: new Date().toISOString(),
  };
}

function createSafePaymentState(stored) {
  const transactionHash = safeTransactionHash(stored.transactionHash);
  const isSettled = stored.state === LIVE_PAYMENT_STATES.SETTLED;
  const settlementVerified = isSettled && TX_HASH_PATTERN.test(transactionHash);
  const taskPayload = stored.taskResponse?.payload;

  return {
    taskId: stored.taskId,
    paymentId: stored.paymentId || stored.idempotencyKey,
    idempotencyKey: stored.idempotencyKey,
    status: stored.state,
    mode: stored.mode,
    network: stored.network,
    asset: stored.asset,
    amountAtomic: stored.amountAtomic,
    counterparty: stored.counterparty,
    transactionHash,
    updatedAt: stored.updatedAt,
    settledAt: stored.settledAt,
    canRetry: stored.canRetry === true,
    receipt: {
      eligible: settlementVerified,
      settlementVerified,
      transactionHash,
    },
    task: taskPayload
      ? {
          status: taskPayload.status,
          taskId: taskPayload.taskId,
          requestHash: taskPayload.requestHash,
          resultHash: taskPayload.resultHash,
          completedAt: taskPayload.completedAt,
          result: taskPayload.result,
          receipt: taskPayload.receipt
            ? {
                eligible: taskPayload.receipt.eligible === true,
                onchain: taskPayload.receipt.onchain === true,
                registry: taskPayload.receipt.registry,
                message: taskPayload.receipt.message,
              }
            : null,
        }
      : null,
  };
}

function createLiveNetworkRecord(prepared) {
  return {
    name: BASE_MAINNET.name,
    chainId: BASE_MAINNET.chainId,
    caip2: BASE_MAINNET_CAIP2,
    rpcUrl: prepared.config?.baseMainnetRpcUrl ?? BASE_MAINNET.rpcUrl,
  };
}

function createLiveAssetRecord() {
  return {
    symbol: BASE_MAINNET_USDC.symbol,
    address: BASE_MAINNET_USDC.address,
    decimals: BASE_MAINNET_USDC.decimals,
  };
}

function createPaymentStoreRecord({ prepared, state, canRetry }) {
  return {
    idempotencyKey: prepared.idempotencyKey,
    taskId: prepared.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
    paymentFingerprint: prepared.paymentFingerprint,
    paymentId: prepared.idempotencyKey,
    mode: "live",
    network: BASE_MAINNET_CAIP2,
    asset: BASE_MAINNET_USDC.address,
    amountAtomic: prepared.requestedAtomicUnits.toString(),
    counterparty: prepared.config.paymentRecipient,
    state,
    paymentRequirements: prepared.paymentRequirements,
    paymentRequired: prepared.paymentRequired,
    canRetry,
    settlementAttempts: 0,
  };
}

function paymentStateReason(state) {
  if (state === LIVE_PAYMENT_STATES.SETTLED) {
    return "Payment is already settled for this idempotency key.";
  }

  if (state === LIVE_PAYMENT_STATES.UNKNOWN) {
    return "Payment status is unknown; manual reconciliation is required.";
  }

  if (state === LIVE_PAYMENT_STATES.SETTLING) {
    return "Payment settlement is already in progress.";
  }

  if (state === LIVE_PAYMENT_STATES.AUTHORIZED) {
    return "Payment authorization is already verified for this idempotency key.";
  }

  if (state === LIVE_PAYMENT_STATES.RESOURCE_RUNNING) {
    return "Task execution is already in progress for this idempotency key.";
  }

  if (state === LIVE_PAYMENT_STATES.RESOURCE_SUCCEEDED) {
    return "Task execution succeeded and settlement is being finalized.";
  }

  return "Payment is already being processed for this idempotency key.";
}

function createLiveSettlementHeaders(settleResponse) {
  return settleResponse
    ? {
        [X402_PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settleResponse),
      }
    : {};
}

function failClosed(result) {
  return {
    ok: false,
    code: result.code,
    reason: result.reason,
    statusCode: result.statusCode ?? 403,
    state: result.state ?? LIVE_PAYMENT_STATES.BLOCKED,
  };
}

function safelyEvaluateMandate({ evaluator, request, now }) {
  if (typeof evaluator !== "function") {
    return {
      allowed: false,
      code: MANDATE_CODES.INTERNAL_ERROR,
      reason: "Mandate evaluator is unavailable.",
    };
  }

  try {
    const decision = evaluator({
      request,
      mandate: request?.mandate,
      now,
    });
    if (
      !decision ||
      typeof decision.allowed !== "boolean" ||
      typeof decision.code !== "string"
    ) {
      return {
        allowed: false,
        code: MANDATE_CODES.INTERNAL_ERROR,
        reason: "Mandate evaluation returned an unknown policy state.",
      };
    }
    return decision;
  } catch {
    return {
      allowed: false,
      code: MANDATE_CODES.INTERNAL_ERROR,
      reason: "Mandate evaluation failed closed.",
    };
  }
}

function readHeader(headers, name) {
  if (!headers) {
    return undefined;
  }

  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function normalizeAddress(value) {
  const normalized = normalizeText(value);
  return ADDRESS_PATTERN.test(normalized) ? normalized : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function safeTransactionHash(value) {
  const normalized = normalizeText(value);
  return TX_HASH_PATTERN.test(normalized) ? normalized : "";
}

function safeErrorMessage(error, fallback) {
  const message = normalizeText(error?.message);
  if (!message) {
    return fallback;
  }

  if (/authorization|bearer|api[-_ ]?key|token|secret|password/iu.test(message)) {
    return fallback;
  }

  return message;
}
