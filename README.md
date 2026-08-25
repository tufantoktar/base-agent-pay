# Base Agent Pay

**CURRENT STATUS: BASE MAINNET RECEIPT REGISTRY / MOCK DEFAULT / LIVE-CAPABLE X402**

Base Agent Pay is a production-quality demo for a Base builder portfolio. It combines a React task UI, an HTTP `402 Payment Required` task API, a clearly marked x402-style mock payment flow, a live-capable x402 v2 adapter behind explicit safety gates, deterministic mock AI execution, and a deployed Base Mainnet receipt registry contract.

Project scripts do not deploy contracts automatically, send blockchain transactions, move real funds, or require paid AI credentials. The only real blockchain action in the app is an interactive wallet-confirmed Base Mainnet receipt write.

## Architecture

```text
User
 ↓
React/Vite
 ↓
Task API
 ↓
Mandate v1 Policy
 ↓
x402 Payment Layer
 ↓
Payment Verification
 ↓
AI Agent
 ↓
Task Result
 ↓
AgentTaskReceipt
 ↓
Base Mainnet
```

## Project Layout

```text
base-agent-pay/
├── src/AgentTaskReceipt.sol
├── test/AgentTaskReceipt.t.sol
├── script/DeployAgentTaskReceipt.s.sol
├── frontend/
│   ├── src/
│   ├── public/
│   └── package.json
├── api/
│   └── task/
├── README.md
├── .env.example
├── .gitignore
├── foundry.toml
└── package.json
```

## x402 Design

The API is designed around the x402 HTTP payment model:

- `POST /api/task` without a valid payment returns `402 Payment Required`.
- The `402` body describes the active payment requirement.
- Retrying with a valid payment header executes the task and returns `taskId`, `requestHash`, and `resultHash`.
- Payment verification and settlement remain server-side in the `api/task/payment-adapter*.js` modules.

### Selected Package Direction

Official x402 docs currently describe maintained v2 packages such as `@x402/core`, `@x402/express`, `@x402/fetch`, and `@x402/evm`. The legacy `x402` package is marked deprecated in favor of v2 package families. See:

- https://docs.x402.org/getting-started/quickstart-for-sellers
- https://docs.x402.org/getting-started/quickstart-for-buyers
- https://www.npmjs.com/package/@x402/core

This repository uses `@x402/core`, `@x402/evm`, and `@x402/fetch` package versions pinned by `package-lock.json`. The API uses official x402 v2 header serialization/parsing and the official HTTP facilitator client. The frontend uses the official EVM exact-scheme helper to create an EIP-712/EIP-3009 `PAYMENT-SIGNATURE` payload from a connected wallet. Tests use mocked wallets, mocked facilitator clients, and mocked Base RPC responses only.

### Payment Modes

`X402_MODE=mock` remains the default. Live mode is never activated implicitly.

Supported modes:

- `X402_MODE=mock`
- `X402_MODE=live`

The mock adapter is intentionally not a real x402 implementation:

- It never signs with a user private key.
- It never verifies a live onchain payment.
- It never settles a payment.
- It never transfers ETH or tokens.
- It marks every response as `mode: "mock"`.

Live mode may move real funds only when both are set:

```text
X402_MODE=live
X402_LIVE_CONFIRM=true
```

If `X402_MODE=live` is set without the confirmation flag, CDP x402 facilitator URL, CDP API key ID/secret placeholders, payment recipient, Base Mainnet RPC, supported network, supported asset, or valid cap, the API fails closed. It does not fall back to mock.

### Live x402

The live adapter lives beside the mock adapter:

```text
api/task/payment-adapter.js
api/task/payment-adapter-mock.js
api/task/payment-adapter-live.js
```

Live x402 uses:

- x402 v2 `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` headers.
- `exact` scheme payment requirements.
- Base Mainnet CAIP-2 network `eip155:8453`.
- Base Mainnet USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals.
- Coinbase CDP x402 facilitator `/verify`, `/settle`, and `/supported` calls using short-lived server-generated JWT auth.
- Independent Base Mainnet RPC verification of the USDC `Transfer` log before durable `SETTLED`.

Live mode requires these server-side values:

```text
X402_FACILITATOR_URL
CDP_API_KEY_ID
CDP_API_KEY_SECRET
X402_PAYMENT_RECIPIENT
X402_MAX_LIVE_PAYMENT_USDC
X402_PAYMENT_ASSET=USDC
X402_NETWORK=base
BASE_MAINNET_RPC_URL=https://mainnet.base.org
```

`X402_MAX_LIVE_PAYMENT_USDC` defaults to `0.10` in examples. The effective spend limit is the lower of `mandate.maxSpendPerTask` and `X402_MAX_LIVE_PAYMENT_USDC`. Requests over either value are denied. The API never silently reduces the amount.

Counterparty binding is exact in live mode:

```text
request.counterparty
==
mandate.allowedCounterparties[0]
==
X402_PAYMENT_RECIPIENT
```

Wildcard counterparties are denied.

Live mode revalidates mandate expiry, scope, spend, currency, and counterparty immediately before settlement. A stale authorization cannot bypass an expired or changed mandate decision.

### Settlement and Idempotency

Live payment states are explicit:

```text
CREATED
CHALLENGED
AUTHORIZED
RESOURCE_RUNNING
RESOURCE_SUCCEEDED
SETTLING
SETTLED
FAILED
UNKNOWN
BLOCKED
```

The live ordering is:

```text
Mandate ALLOW
PAYMENT-REQUIRED
payer signs PAYMENT-SIGNATURE
facilitator verify
AUTHORIZED
RESOURCE_RUNNING
AI task succeeds
RESOURCE_SUCCEEDED
atomic SETTLING claim
facilitator settle
Base RPC USDC Transfer verification
SETTLED
receipt eligibility
```

Only `SETTLED` is treated as paid and receipt-eligible. If the AI task fails after authorization, the API does not settle and does not create a receipt payload. If settlement fails, is pending, or cannot be independently verified on Base, the API does not persist `SETTLED` and does not create a receipt payload.

Retry behavior is deliberately narrow:

- Known verification failures or known settlement failures with no transaction can be retried.
- Pending or unknown settlement blocks retry until manual reconciliation.
- Timeout handling first asks the injected facilitator client for settlement status when such a safe lookup is available.
- If no safe status lookup is available, the state becomes `UNKNOWN` and retry is blocked.

### Durable Payment State

The live adapter requires a stable `idempotencyKey` in the task request. Live payment state is persisted before any facilitator call behind the `PaymentStore` abstraction.

### Payment Store Drivers

Supported drivers:

```text
PAYMENT_STORE_DRIVER=sqlite
PAYMENT_STORE_DRIVER=postgres
```

`sqlite` is the local/dev default. It stores state at `PAYMENT_STORE_PATH`, defaulting to `./runtime/base-agent-pay.sqlite`. Local SQLite is useful for development and tests, but it is not sufficient as a shared durable store for multi-instance/serverless Production deployments such as Vercel.

`postgres` uses a standard `PAYMENT_DATABASE_URL` connection string and the `pg` pool client. It mirrors the SQLite logical schema in shared Postgres tables and uses transaction-safe row locking plus conditional updates so only one instance can claim a payment for settlement. The pool is bounded to avoid unbounded serverless connections, but provider-specific pooling/proxy choices are intentionally left to deployment configuration.

Production/serverless live x402 fails closed unless `PAYMENT_STORE_DRIVER=postgres` or a future explicitly approved shared durable store is configured. There is no silent fallback from Postgres to SQLite.

Payment records include the idempotency key, task id, request fingerprint, payment fingerprint, payment id, mode, network, asset, atomic amount, counterparty, state, transaction hash, facilitator reference, timestamps, safe error fields, settlement attempts, and serialized non-secret payment metadata. Atomic USDC amounts are stored as text so large integer values are not converted through JavaScript floating point.

The database enforces `idempotency_key UNIQUE` and `payment_fingerprint UNIQUE`. Duplicate requests with the same key and same fingerprint return the existing durable state and do not create another settlement attempt. The same key with a different fingerprint fails closed with `IDEMPOTENCY_KEY_REUSE_MISMATCH`.

After AI success and before facilitator settlement, the API atomically claims the durable row by moving `RESOURCE_SUCCEEDED` to `SETTLING`. Only one concurrent request can win that claim; other concurrent or duplicate requests stop when they observe `RESOURCE_RUNNING`, `RESOURCE_SUCCEEDED`, `SETTLING`, `SETTLED`, `UNKNOWN`, `BLOCKED`, or another non-claimable state.

After restart/reconnect, the same idempotency key is loaded from the selected store. `SETTLED` returns the known settlement without settling again. `SETTLING` is never blindly retried; the adapter asks the facilitator status API when available and otherwise marks the payment `UNKNOWN`. `UNKNOWN` always fails closed and requires manual reconciliation before any retry.

AI execution in live mode requires durable `AUTHORIZED -> RESOURCE_RUNNING` ownership. Receipt eligibility requires AI success, successful facilitator settlement, independent Base USDC transfer verification, and a durable `SETTLED` transition. If the payment store cannot be updated or the persisted state is not safe for the next step, the API fails closed and does not create receipt hashes.

Postgres does not by itself make the payment system risk-free. Live facilitator reconciliation, wallet/payment authorization, mandate enforcement, settlement status handling, and operational monitoring still matter before any real payment traffic.

### Receipt Gating

The API creates receipt-eligible hashes only when all are true:

```text
Mandate allowed
AI task completed successfully
payment settled successfully
independent Base USDC Transfer verification succeeded
durable state is SETTLED
```

If authorization fails, the AI task does not run. If AI fails after authorization, no settlement occurs. If settlement fails, is pending, unknown, or lacks Base proof, no receipt payload is produced.

## Mandate v1

Receipts explain what happened. Mandates prevent disallowed execution before payment.

Mandate v1 is an application-level pre-execution policy layer. The API evaluates the mandate before the mock x402 payment adapter, before AI execution, and before any receipt payload can be produced. If mandate evaluation denies the request, the API returns `403` and stops.

Mandate v1 controls:

- `maxSpendPerTask`: maximum requested spend per task.
- `allowedCounterparties`: exact service/counterparty allowlist.
- `expiresAt`: UTC timestamp. If `now >= expiresAt`, the request is denied.
- `allowedScopes`: exact allowed task scopes.

Spend policy uses USDC atomic units with 6 decimals. For example, `0.50 USDC` is evaluated as `500000` atomic units. JavaScript floating-point arithmetic is not used for spend comparisons.

Mandate evaluation is deterministic and fail-closed:

```text
presence
structure
expiry
currency
amount
counterparty
scope
```

Any missing mandate, malformed mandate, expired mandate, unsupported currency, invalid amount, spend over max, disallowed counterparty, disallowed scope, or internal policy error is denied. The equality boundary is explicit: a requested amount equal to `maxSpendPerTask` is allowed if every other check passes.

The frontend includes a small Mandate panel for the demo request. It shows:

- max spend per task
- task counterparty and allowed counterparty
- expiry
- allowed scope
- current decision

Client-side mandate validation is only a usability preflight. Server-side API validation remains authoritative.

Mandate v1 does **not**:

- configure a facilitator
- settle USDC
- sign with a wallet
- provide cryptographic wallet authorization

Mandate v1 is application-level policy. Live x402 may move real funds when explicitly enabled, so Mandate must remain enforced before payment execution.

## AI Provider Design

The API uses an `AiProvider` abstraction in `api/task/ai-provider.js`.

Current implementation:

- `MockAiProvider`
- deterministic local output
- no paid AI API
- no API keys

Supported task types:

- Summarize
- Rewrite
- Classify
- Structured Answer

## Receipt Contract

`AgentTaskReceipt` is an immutable receipt registry for completed paid agent tasks. It is intentionally minimal and non-custodial.

The contract does not:

- custody ETH
- custody tokens
- transfer tokens
- call payment contracts
- have an owner
- have admin privileges
- use upgradeability
- make external calls

### Contract API

```solidity
recordReceipt(bytes32 taskId, bytes32 requestHash, bytes32 resultHash)
getReceipt(bytes32 taskId)
hasReceipt(bytes32 taskId)
getReceiptCount()
getReceiptsByRequester(address requester)
```

Receipts store:

```solidity
struct Receipt {
    address requester;
    bytes32 taskId;
    bytes32 requestHash;
    bytes32 resultHash;
    uint256 timestamp;
}
```

`recordReceipt` is permissionless. The caller is stored as `requester`. Duplicate `taskId` values revert.

## Base Mainnet

Current production target:

- Network: Base Mainnet
- Chain ID: `8453`
- RPC example: `https://mainnet.base.org`
- Deployed `AgentTaskReceipt`: [`0x89365D56D7a8795e141e2e6Cf50Fc6015d988be2`](https://basescan.org/address/0x89365D56D7a8795e141e2e6Cf50Fc6015d988be2)
- Contract verification: `Pass - Verified`

The smart contract is real on Base Mainnet. Receipt writes from the frontend are real Base Mainnet transactions signed interactively by the connected wallet. Production x402 remains `MOCK` unless a separately approved environment update explicitly enables live mode. The AI provider remains `MOCK`.

## Base Sepolia

Retained testnet target:

- Network: Base Sepolia
- Chain ID: `84532`
- RPC example: `https://base-sepolia-rpc.publicnode.com`
- Deployed `AgentTaskReceipt`: [`0x2C1bBa87705eE87465c6da9B00fC941f4557c241`](https://sepolia.basescan.org/address/0x2C1bBa87705eE87465c6da9B00fC941f4557c241)
- Deployment transaction: [`0xf97b7b7291f345689b4167b2d52a075573229020363980485d81956214b4564d`](https://sepolia.basescan.org/tx/0xf97b7b7291f345689b4167b2d52a075573229020363980485d81956214b4564d)
- First successful onchain receipt transaction: [`0x554fdcc6ded1c913bc959a02fff885269724787d4da2fe0353873ec56ec69915`](https://sepolia.basescan.org/tx/0x554fdcc6ded1c913bc959a02fff885269724787d4da2fe0353873ec56ec69915)
- Current receipt count: `1`

The Base Sepolia deployment is retained for reference and local testnet configuration.

## Builder Attribution

Builder Code: `bc_tuybnhw2`

ERC-8021 attribution is enabled for future frontend receipt writes. The frontend wallet client appends the Builder Code attribution suffix to transaction calldata automatically, so no smart contract change is required. Existing historical transactions are not retroactively attributed.

The default x402 payment mode remains `MOCK`, AI remains `MOCK`, and receipt writes remain real, interactively confirmed transactions on the configured Base network.

## Security Model

Secrets must stay server-side or outside the app entirely.

The frontend must never receive:

- private keys
- seed phrases
- wallet passwords
- AI provider secrets
- payment server private credentials
- BaseScan/Etherscan API keys

Ignored local files include:

- `.env`
- `.env.local`
- `frontend/.env`
- `frontend/.env.local`
- `node_modules`
- `frontend/node_modules`
- `frontend/dist`
- `out`
- `cache`
- `broadcast`
- `runtime`

## Environment

Root `.env.example`:

```text
BASE_SEPOLIA_RPC_URL=https://base-sepolia-rpc.publicnode.com
BASE_CHAIN_ID=8453
BASE_MAINNET_RPC_URL=https://mainnet.base.org
X402_MODE=mock
X402_LIVE_CONFIRM=false
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=
X402_PAYMENT_RECIPIENT=
X402_MAX_LIVE_PAYMENT_USDC=0.10
X402_PAYMENT_ASSET=USDC
X402_NETWORK=base
BASE_SETTLEMENT_VERIFICATION_TIMEOUT_MS=10000
PAYMENT_STORE_DRIVER=sqlite
PAYMENT_STORE_PATH=./runtime/base-agent-pay.sqlite
PAYMENT_DATABASE_URL=
MOCK_PAYMENT_RECIPIENT=0x0000000000000000000000000000000000004020
MOCK_PAYMENT_ASSET=mock-USDC
MOCK_PAYMENT_AMOUNT=0.01

VITE_CHAIN_ID=8453
VITE_X402_MODE=mock
VITE_X402_MAX_LIVE_PAYMENT_USDC=0.10
VITE_RPC_URL=https://mainnet.base.org
VITE_BASE_MAINNET_RPC_URL=https://mainnet.base.org
VITE_BASE_MAINNET_CONTRACT_ADDRESS=0x89365D56D7a8795e141e2e6Cf50Fc6015d988be2
VITE_CONTRACT_ADDRESS=0x89365D56D7a8795e141e2e6Cf50Fc6015d988be2
VITE_RECEIPT_CONTRACT_ADDRESS=0x89365D56D7a8795e141e2e6Cf50Fc6015d988be2
VITE_BASE_SEPOLIA_RPC_URL=https://base-sepolia-rpc.publicnode.com
VITE_BASE_SEPOLIA_RECEIPT_CONTRACT_ADDRESS=0x2C1bBa87705eE87465c6da9B00fC941f4557c241
VITE_API_URL=/api/task
```

Frontend-only example values also live in `frontend/.env.example`.

## Local Development

Install dependencies:

```bash
npm install
```

Run API and frontend together:

```bash
npm run dev
```

Local URLs:

- Frontend: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:8787/api/task`

## Tests and Builds

Smart contract:

```bash
forge fmt --check
forge build
forge test
```

Frontend/API:

```bash
npm run lint
npm run build
npm run api:test
```

Postgres payment-store integration tests require a disposable database URL:

```bash
PAYMENT_TEST_DATABASE_URL=postgres://... npm run api:test:postgres
```

## Future Plan

1. Select a production facilitator that supports Base Mainnet USDC and confirm its authentication requirements.
2. Run Postgres integration tests against the selected production-like database environment.
3. Decide whether to keep the direct v2 facilitator client or adopt official `@x402/*` server middleware.
4. Run a separately approved local/Mainnet E2E payment with a real x402 client.
5. Perform a separate Vercel Production environment and deployment review before enabling live production payment work.

No new deployment work is performed by the local app.
