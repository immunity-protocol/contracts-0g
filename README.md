# immunity-contracts-0g

The 0G Chain side of [Immunity](https://immunity.xyz) — a decentralized threat-intelligence network for AI agents. This repo holds the **trust layer**: an on-chain antibody registry, publisher staking, prepaid-fee subscription, atomic reward settlement, and FIFO sweep of expired stakes.

> Mirror contracts and the Uniswap v4 hook live in a separate `contracts-hook` repo. The SDK is forthcoming at [`immunity-sdk`](https://github.com/immunity-protocol/sdk). This repo's deployed ABI is the authoritative source for both.

## Architecture in one paragraph

Operators prepay USDC into a balance via `deposit`. Publishers `publish` antibodies (signed, staked declarations that a specific pattern is malicious — wallet, call pattern, bytecode, taint graph, or semantic embedding) by locking 1 USDC for 72h. Every agent action calls `check(antibodyId)` which atomically (a) debits a 0.002 USDC fee, (b) settles 80% to the publisher and 20% to the treasury on a match (100% to treasury otherwise), and (c) opportunistically releases up to 5 oldest expired stakes from a FIFO queue, paying the caller a small bounty per release. The sweep mechanism removes any need for an external keeper.

## The Registry as Tier-2 cache

Immunity's SDK runs a three-tier lookup on every `check()`:

```
Tier 1 — Local cache    ~1 ms     hit: settle on chain
Tier 2 — Registry RPC   ~200 ms   hit: settle + populate cache
Tier 3 — TEE detection  ~3 s      only for genuinely novel threats
```

This contract is the canonical Tier-2. The SDK queries `getAntibodyByMatcherHash(bytes32)` whenever the local cache misses, and only falls through to TEE detection when the chain has no record either. This makes the Registry the source of truth and the cache a pure performance optimization on top of it.

Two pieces back this:

- A `matcherIndex` mapping (`bytes32 primaryMatcherHash → bytes32 keccakId`) populated on every publish. The SDK's per-type matcher-hash format (see `immunity-sdk/src/keccak/matchers/`) is the same bytes the contract stores, so the lookup is a single SLOAD chain plus the existing antibody read.
- A revert (`AntibodyAlreadyExistsForMatcher(bytes32 existingKeccakId)`) when a different publisher tries to claim a matcher hash already in use. The error data carries the existing keccakId so the SDK can fetch and reuse the original antibody instead of minting a duplicate. This kills "ensemble" publishing of the same matcher and gives the first publisher a clean economic claim on subsequent matches.

### TTL is reserved for v2

`Antibody.expiresAt` and the per-call expiry filter in `check()` are wired but unused in v1: every SDK publish sets `expiresAt = 0` (permanent), and the explorer hides the field. Keeping the storage and event signatures in place lets v2 flip a single SDK flag to honor expiries without a contract redeploy.

## Setup

Requires Node 22.10+ (Hardhat warns about newer majors but works).

```bash
npm install
```

## Build

```bash
npx hardhat compile
```

Solidity is pinned to `0.8.24` with `evmVersion: "shanghai"` because 0G Galileo does not support Cancun opcodes (no MCOPY / TLOAD / TSTORE / BLOBHASH).

## Test

```bash
npx hardhat test
```

110 tests covering deposit/withdraw, publish (with all 5 typed auxiliary events + matcher dedup), check (match + no-match + expiry), FIFO sweep (bounty + slashed-skip), slash, seedAntibody, withdrawTreasury, view functions (including the Tier-2 `getAntibodyByMatcherHash` lookup), fuzz invariants on accounting & queue order, reentrancy guards, and a hot-path gas budget.

## Deploy to 0G Galileo

The 0G Galileo testnet specifics are pinned in `hardhat.config.ts`:

| | |
|---|---|
| Network name | `ogGalileo` |
| Chain ID | **16602** (NOT 16601 — that's a deprecated ThirdWeb listing) |
| RPC | `https://evmrpc-testnet.0g.ai` (rate-limited dev endpoint) |
| Explorer | `https://chainscan-galileo.0g.ai` |
| Faucet | [Google Cloud Web3 faucet](https://cloud.google.com/application/web3/faucet/0g/galileo) (the official `faucet.0g.ai` is flaky) |
| Gas token | `0G` (digit zero, not letter O) |

### 1. Configure keystore secrets

Hardhat 3 stores secrets in an encrypted keystore — no `.env` file needed.

```bash
npx hardhat keystore set IMMUNITY_GALILEO_RPC      # paste https://evmrpc-testnet.0g.ai
npx hardhat keystore set IMMUNITY_DEPLOYER_PK      # paste 0x-prefixed funded private key
```

### 2. Run the deploy script

```bash
# Testnet (default): deploys MockUSDC, then Registry pointing at it.
./scripts/deploy.sh

# Mainnet (future): use the canonical USDC address.
./scripts/deploy.sh --usdc 0xCANONICAL_USDC_ADDRESS
```

The script writes `.deploy.json` with the deployed addresses, chain ID, and timestamp. The SDK, indexer, and relayer should read this file (or be configured with the addresses out-of-band).

### 3. Optional: fund demo wallets

```bash
MOCK_USDC_RECIPIENTS="0xWalletA,0xWalletB" \
  MOCK_USDC_AMOUNT=100000000 \
  ./scripts/deploy.sh
```

Mints 100 USDC to each listed wallet. Skipped silently if `MOCK_USDC_RECIPIENTS` is unset, or if the configured token isn't a `MockUSDC`.

### 4. Verify on the explorer

There's no Etherscan-style verification API for Galileo — contracts appear immediately on Chainscan but source-code verification is manual via the UI. The deployed bytecode is reproducible from this repo at the committed hash given the pinned Solidity version + optimizer settings.

## Tokenomics constants

All amounts in USDC (6 decimals).

| Constant | Value | Notes |
|---|---|---|
| `CHECK_FEE` | 0.002 USDC | Per `check()` call |
| `PUBLISH_STAKE` | 1.0 USDC | Locked at `publish` time |
| `STAKE_LOCK_DURATION` | 72 hours | Auto-released via FIFO sweep |
| `PUBLISHER_REWARD_BPS` | 8000 (80%) | Of `CHECK_FEE` on a match |
| `TREASURY_REWARD_BPS` | 2000 (20%) | Of `CHECK_FEE` on a match (100% on no-match) |
| `SWEEP_BATCH_SIZE` | 5 | Max stakes released per `check()` |
| `SWEEP_BOUNTY` | 0.0001 USDC | Per stake released, paid from treasury |

> **No reviewer reward share in v1.** The TEE that produced the verdict is already paid per-inference by 0G Compute. The `reviewer` field on the antibody is informational only — used by the explorer and the v2 challenge game for re-verification, but no economic path reads it.

## Antibody types

The contract treats the antibody type as opaque from a logic perspective — it stores it, emits it, and lets off-chain consumers (SDK, indexer, explorer, mirrors) interpret it. `publish()` dispatches a typed auxiliary event so consumers can filter by an indexed primitive instead of scanning every `AntibodyPublished`:

| `abType` | Value | Auxiliary event | Indexed key |
|---|---|---|---|
| ADDRESS | 0 | `AddressBlocked(address indexed target, ...)` | the wallet address |
| CALL_PATTERN | 1 | `CallPatternBlocked(bytes4 indexed selector, ...)` | the function selector |
| BYTECODE | 2 | `BytecodeBlocked(bytes32 indexed bytecodeHash, ...)` | the runtime bytecode hash |
| GRAPH | 3 | `GraphTaintAdded(bytes32 indexed taintSetId, ...)` | the taint set id |
| SEMANTIC | 4 | `SemanticPatternAdded(uint8 indexed flavor, ...)` | the semantic flavor |

The `auxiliaryKey` field on `PublishParams` carries the typed value; its interpretation is dictated by `abType`. The Mirror contracts on execution chains will emit the same signatures so indexers see uniform event shapes across all chains.

> **Adding a new antibody type in v2 requires a contract upgrade** (new auxiliary event + new dispatch branch). The v1 contract is intentionally non-upgradeable for hackathon simplicity.

## Design decisions worth knowing

- **Content-addressed antibody IDs.** `keccakId = keccak256(abi.encode(abType, flavor, primaryMatcherHash, publisher))`. The same publisher republishing reverts with `AntibodyExists`. A different publisher claiming a matcher hash already in use reverts with `AntibodyAlreadyExistsForMatcher(existingKeccakId)` so the SDK can reuse the original antibody. The first publisher to flag a pattern keeps the economic claim; the chain enforces uniqueness regardless of SDK behavior.
- **Tier-2 lookup index.** `matcherIndex` (`primaryMatcherHash → keccakId`) lets `getAntibodyByMatcherHash` return the antibody in a single SLOAD chain. This is what the SDK calls on cache miss before falling through to TEE detection.
- **FIFO stake queue.** Implemented as `mapping(uint256 => bytes32)` with `head`/`tail` pointers (no array pop). Sweep walks from `head`, releases ACTIVE+unlocked stakes, skips slashed entries, and stops at the first not-yet-expired entry (queue is monotonic in `stakeLockUntil`).
- **Sweep wired into `check`.** Replaces a Chainlink/Gelato keeper. Caller earns `SWEEP_BOUNTY` per stake released, capped at `treasuryBalance`.
- **Slash is admin-only in v1.** Sets status to `SLASHED`, moves the locked stake to treasury. The challenge game (community-driven slashing) is v2.
- **`seedAntibody` for genesis imports.** Owner-only path for importing known threats from external sources without staking. Seeded antibodies are matchable in `check()` (and pay the publisher) but bypass the FIFO queue.
- **Non-upgradeable.** Immutable by design for hackathon credibility. v2 will be a redeploy + migration if needed.

## File layout

```
contracts/
  Registry.sol            # the main contract
  interfaces/IRegistry.sol  # external interface — import this in the SDK
  libraries/Errors.sol    # custom errors
  mocks/MockUSDC.sol      # 6-decimal ERC20 with public mint, used on testnet
  mocks/MaliciousUSDC.sol # reentrancy-attacking ERC20, test-only
ignition/modules/
  MockUSDC.ts             # standalone deploy
  Registry.ts             # takes a `usdc` parameter
ignition/parameters/
  galileo.json            # populated by deploy.sh with the resolved USDC address
scripts/
  deploy.sh               # orchestrates MockUSDC + Registry deploy, writes .deploy.json
  post-deploy-bootstrap.ts  # optional demo USDC funding
test/
  Registry.deposit.test.ts
  Registry.publish.test.ts
  Registry.check.test.ts
  Registry.sweep.test.ts
  Registry.admin.test.ts
  Registry.views.test.ts
  Registry.invariants.test.ts
  Registry.reentrancy.test.ts
  Registry.gas.test.ts
  MockUSDC.test.ts
  utils.ts                # shared fixtures
```

## License

MIT
