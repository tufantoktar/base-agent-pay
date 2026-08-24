# Base Agent Pay

**CURRENT STATUS: BASE MAINNET RECEIPT REGISTRY / MOCK X402**

Base Agent Pay is a production-quality demo for a Base builder portfolio. It combines a React task UI, an HTTP `402 Payment Required` task API, a clearly marked x402-style mock payment flow, deterministic mock AI execution, and a deployed Base Mainnet receipt registry contract.

Project scripts do not deploy contracts automatically, send blockchain transactions, move real funds, or require paid AI credentials. The only real blockchain action in the app is an interactive wallet-confirmed Base Mainnet receipt write.

## Architecture

```text
User
 ↓
React/Vite
 ↓
Task API
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
- The `402` body describes the active Base network, the mock asset, amount, recipient, facilitator, and payment requirements.
- Retrying with a valid development `X-PAYMENT` header executes the task and returns `taskId`, `requestHash`, and `resultHash`.
- Payment verification remains server-side in `api/task/payment-adapter.js`.

### Selected Package Direction

Official x402 docs currently describe maintained v2 packages such as `@x402/core`, `@x402/express`, `@x402/fetch`, and `@x402/evm`. The legacy `x402` package is marked deprecated in favor of v2 package families. See:

- https://docs.x402.org/getting-started/quickstart-for-sellers
- https://docs.x402.org/getting-started/quickstart-for-buyers
- https://www.npmjs.com/package/@x402/core

This local demo does **not** integrate those packages yet because a real facilitator, seller recipient configuration, and payment settlement path would make the app capable of real payment activity. Instead, the code provides a `PaymentAdapter` interface and a `MockPaymentAdapter`.

### Mock vs Real Payment

`X402_MODE=mock` is the only implemented mode.

The mock adapter is intentionally not a real x402 implementation:

- It never signs with a user private key.
- It never verifies a live onchain payment.
- It never settles a payment.
- It never transfers ETH or tokens.
- It marks every response as `mode: "mock"`.

A future real adapter should be added beside `MockPaymentAdapter` after the official package APIs, facilitator configuration, and Base payment asset are selected for a deployment environment.

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

The smart contract is real on Base Mainnet. Receipt writes from the frontend are real Base Mainnet transactions signed interactively by the connected wallet. The x402 payment layer remains `MOCK`, and the AI provider remains `MOCK`.

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

The x402 payment remains `MOCK`, AI remains `MOCK`, and receipt writes remain real, interactively confirmed transactions on the configured Base network.

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

## Environment

Root `.env.example`:

```text
BASE_SEPOLIA_RPC_URL=https://base-sepolia-rpc.publicnode.com
BASE_CHAIN_ID=8453
BASE_MAINNET_RPC_URL=https://mainnet.base.org
X402_MODE=mock
MOCK_PAYMENT_RECIPIENT=0x0000000000000000000000000000000000004020
MOCK_PAYMENT_ASSET=mock-USDC
MOCK_PAYMENT_AMOUNT=0.01

VITE_CHAIN_ID=8453
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

## Future Plan

1. Select the official `@x402/*` server and client packages for the target runtime.
2. Configure a real Base payment asset, recipient, and facilitator.
3. Add a non-mock `PaymentAdapter` that verifies payments server-side.
4. Keep x402 in mock mode until a separate live-payment review is completed.
5. Re-run tests and perform a separate deployment review before any production payment work.

No new deployment work is performed by the local app.
