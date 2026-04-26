// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IRegistry} from "./interfaces/IRegistry.sol";
import {
    ZeroAddress,
    ZeroAmount,
    InsufficientBalance,
    AntibodyExists,
    InvalidAntibodyType,
    InvalidVerdict,
    InvalidConfidence,
    InvalidSeverity
} from "./libraries/Errors.sol";

/// @title Immunity Registry — 0G Chain antibody registry, staking, and rewards.
/// @notice Source of truth for the trust layer of the Immunity protocol.
///         Operators prepay USDC into a balance, publishers stake 1 USDC per
///         antibody (auto-released after 72h via FIFO sweep), and every check
///         atomically settles fees and rewards.
abstract contract Registry is IRegistry, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    //  Constants — tokenomics (USDC, 6 decimals)
    // ------------------------------------------------------------------

    uint256 public constant CHECK_FEE             = 2_000;        // 0.002 USDC
    uint256 public constant PUBLISH_STAKE         = 1_000_000;    // 1.0 USDC
    uint64  public constant STAKE_LOCK_DURATION   = 72 hours;
    uint256 public constant SWEEP_BATCH_SIZE      = 5;
    uint256 public constant SWEEP_BOUNTY          = 100;          // 0.0001 USDC
    uint16  public constant PUBLISHER_REWARD_BPS  = 8000;         // 80%
    uint16  public constant TREASURY_REWARD_BPS   = 2000;         // 20%
    uint16  public constant BPS_DENOMINATOR       = 10_000;

    // ------------------------------------------------------------------
    //  Immutables
    // ------------------------------------------------------------------

    IERC20 public immutable usdc;

    // ------------------------------------------------------------------
    //  State
    // ------------------------------------------------------------------

    /// @dev keccakId → Antibody. Read via `getAntibody`.
    mapping(bytes32 => Antibody) internal _antibodies;

    /// @notice Sequence number → keccakId. Sequence renders as IMM-YYYY-NNNN client-side.
    mapping(uint32 => bytes32) public immSeqToKeccakId;

    /// @notice Prepaid USDC balance per operator/publisher.
    mapping(address => uint256) public balances;

    /// @dev Publisher denormalized stats. Read via `getPublisherStats`.
    mapping(address => PublisherStats) internal _publishers;

    /// @dev FIFO queue of antibody keccakIds whose stake is still locked.
    ///      Indices are append-only; head advances as stakes are released.
    mapping(uint256 => bytes32) internal _stakeQueue;
    uint256 public stakeHead;
    uint256 public stakeTail;

    /// @notice Accumulated treasury balance (20% of matched fees, 100% of unmatched).
    uint256 public treasuryBalance;

    /// @notice Next antibody sequence number; incremented on every publish/seed.
    uint32 public nextImmSeq;

    // ------------------------------------------------------------------
    //  Constructor
    // ------------------------------------------------------------------

    /// @param _usdc Address of the USDC token (or MockUSDC on testnet).
    constructor(address _usdc) Ownable(msg.sender) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    // ------------------------------------------------------------------
    //  Operator balance — deposit / withdraw
    // ------------------------------------------------------------------

    /// @inheritdoc IRegistry
    /// @dev Caller must approve `amount` USDC to this contract first.
    function deposit(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        balances[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @inheritdoc IRegistry
    function withdraw(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balances[msg.sender];
        if (bal < amount) revert InsufficientBalance();
        unchecked { balances[msg.sender] = bal - amount; }
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrew(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    //  Publish
    // ------------------------------------------------------------------

    /// @dev Internal worker shared by `publish` and (later) `seedAntibody`.
    ///      `stake` is debited from `balances[publisher]`; pass 0 for seeded.
    function _publish(
        PublishParams calldata p,
        address publisher,
        uint256 stake,
        bool isSeeded
    )
        internal
        returns (bytes32 keccakId, uint32 immSeq)
    {
        // Validate enum bounds.
        if (p.abType > uint8(AntibodyType.SEMANTIC)) revert InvalidAntibodyType();
        if (p.verdict > uint8(Verdict.SUSPICIOUS)) revert InvalidVerdict();
        if (p.confidence > 100) revert InvalidConfidence();
        if (p.severity > 100) revert InvalidSeverity();

        // Content-addressed identity. Same publisher republishing the same
        // (type, flavor, matcher) collides — that's the duplicate guard.
        keccakId = _hash(p.abType, p.flavor, p.primaryMatcherHash, publisher);
        if (_antibodies[keccakId].publisher != address(0)) revert AntibodyExists();

        // Debit stake from publisher's prepaid balance.
        if (stake != 0) {
            uint256 bal = balances[publisher];
            if (bal < stake) revert InsufficientBalance();
            unchecked { balances[publisher] = bal - stake; }
            _stakeQueue[stakeTail++] = keccakId;
        }

        // Allocate sequence (starts at 1; 0 reserved as "unset" sentinel).
        immSeq = ++nextImmSeq;

        // Reviewer defaults to publisher when caller passes address(0).
        address reviewer = p.reviewer == address(0) ? publisher : p.reviewer;

        uint64 createdAt = uint64(block.timestamp);
        uint64 stakeLockUntil = stake == 0 ? 0 : createdAt + STAKE_LOCK_DURATION;

        _antibodies[keccakId] = Antibody({
            primaryMatcherHash: p.primaryMatcherHash,
            evidenceCid:        p.evidenceCid,
            contextHash:        p.contextHash,
            embeddingHash:      p.embeddingHash,
            attestation:        p.attestation,
            publisher:          publisher,
            stakeLockUntil:     stakeLockUntil,
            immSeq:             immSeq,
            reviewer:           reviewer,
            expiresAt:          p.expiresAt,
            abType:             p.abType,
            flavor:             p.flavor,
            verdict:            p.verdict,
            confidence:         p.confidence,
            createdAt:          createdAt,
            stakeAmount:        uint96(stake),
            severity:           p.severity,
            status:             uint8(Status.ACTIVE),
            isSeeded:           isSeeded ? 1 : 0
        });
        immSeqToKeccakId[immSeq] = keccakId;

        PublisherStats storage stats = _publishers[publisher];
        unchecked {
            stats.totalStaked  += uint128(stake);
            stats.publishedCount += 1;
        }

        emit AntibodyPublished(
            keccakId,
            immSeq,
            publisher,
            p.abType,
            p.flavor,
            p.verdict,
            p.severity,
            p.confidence,
            reviewer,
            p.primaryMatcherHash,
            p.evidenceCid,
            p.contextHash,
            p.embeddingHash,
            p.attestation,
            stake,
            stakeLockUntil,
            p.expiresAt,
            createdAt,
            isSeeded
        );

        _emitAuxiliary(p.abType, p.flavor, keccakId, p.auxiliaryKey, publisher);
    }

    /// @dev Dispatches the type-specific auxiliary event so consumers (relayer,
    ///      explorer, per-type indexers) can filter by an indexed primitive
    ///      instead of scanning every `AntibodyPublished`.
    function _emitAuxiliary(
        uint8   abType,
        uint8   flavor,
        bytes32 keccakId,
        bytes32 auxKey,
        address publisher
    ) internal {
        if (abType == uint8(AntibodyType.ADDRESS)) {
            emit AddressBlocked(address(uint160(uint256(auxKey))), keccakId, publisher);
        } else if (abType == uint8(AntibodyType.CALL_PATTERN)) {
            emit CallPatternBlocked(bytes4(auxKey), keccakId, publisher);
        } else if (abType == uint8(AntibodyType.BYTECODE)) {
            emit BytecodeBlocked(auxKey, keccakId, publisher);
        } else if (abType == uint8(AntibodyType.GRAPH)) {
            emit GraphTaintAdded(auxKey, keccakId, publisher);
        } else {
            // SEMANTIC — the indexed key is the flavor, not auxKey.
            emit SemanticPatternAdded(flavor, keccakId, publisher);
        }
    }

    /// @dev Canonical content-addressed antibody identifier.
    function _hash(
        uint8 abType,
        uint8 flavor,
        bytes32 primaryMatcherHash,
        address publisher
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(abType, flavor, primaryMatcherHash, publisher));
    }

    /// @inheritdoc IRegistry
    function publish(PublishParams calldata params)
        external
        override
        nonReentrant
        returns (bytes32 keccakId, uint32 immSeq)
    {
        return _publish(params, msg.sender, PUBLISH_STAKE, false);
    }

    // ------------------------------------------------------------------
    //  Check (hot path)
    // ------------------------------------------------------------------

    /// @inheritdoc IRegistry
    /// @dev Pass `bytes32(0)` for a no-match check (caller still pays fee → treasury).
    ///      Sweep of expired stakes is wired in alongside the sweep implementation.
    function check(bytes32 antibodyId)
        external
        override
        nonReentrant
        returns (bool settled)
    {
        // Debit fee from caller's prepaid balance.
        uint256 bal = balances[msg.sender];
        if (bal < CHECK_FEE) revert InsufficientBalance();
        unchecked { balances[msg.sender] = bal - CHECK_FEE; }

        bool wasMatch;
        if (antibodyId != bytes32(0)) {
            Antibody storage ab = _antibodies[antibodyId];
            // Eligible iff exists, ACTIVE, and not past expiry.
            if (
                ab.publisher != address(0) &&
                ab.status == uint8(Status.ACTIVE) &&
                (ab.expiresAt == 0 || ab.expiresAt > block.timestamp)
            ) {
                uint256 publisherReward = (CHECK_FEE * PUBLISHER_REWARD_BPS) / BPS_DENOMINATOR;
                // Subtract from full fee so the split sums exactly even with rounding.
                uint256 treasuryReward = CHECK_FEE - publisherReward;

                balances[ab.publisher] += publisherReward;
                treasuryBalance += treasuryReward;
                unchecked {
                    _publishers[ab.publisher].totalEarned += uint128(publisherReward);
                }

                wasMatch = true;
                settled = true;

                emit AntibodyMatched(
                    antibodyId,
                    msg.sender,
                    ab.publisher,
                    ab.reviewer,
                    publisherReward,
                    treasuryReward
                );
            }
        }

        if (!wasMatch) {
            treasuryBalance += CHECK_FEE;
        }

        emit CheckSettled(msg.sender, antibodyId, wasMatch, CHECK_FEE, uint64(block.timestamp));

        // Opportunistic sweep — replaces a Chainlink/Gelato keeper. Caller earns
        // a small bounty per released stake, paid from treasury.
        _sweep(SWEEP_BATCH_SIZE);
    }

    // ------------------------------------------------------------------
    //  FIFO sweep of expired stakes
    // ------------------------------------------------------------------

    /// @inheritdoc IRegistry
    /// @dev Public unguarded backup — anyone can call to release expired stakes
    ///      without paying a check fee. Caller still earns the per-stake bounty.
    function sweepExpired() external override nonReentrant returns (uint256) {
        return _sweep(SWEEP_BATCH_SIZE);
    }

    /// @dev Walks the FIFO queue from `stakeHead` for at most `batchSize` entries.
    ///      Releases each entry whose `stakeLockUntil <= block.timestamp` and is
    ///      still ACTIVE; skips (advances over) entries whose status is no longer
    ///      ACTIVE (e.g. slashed). Stops as soon as it sees a still-locked entry,
    ///      since the queue is monotonic in `stakeLockUntil`.
    function _sweep(uint256 batchSize) internal returns (uint256 numReleased) {
        uint256 head = stakeHead;
        uint256 tail = stakeTail;
        uint256 walked;

        while (walked < batchSize && head < tail) {
            bytes32 id = _stakeQueue[head];
            Antibody storage ab = _antibodies[id];

            if (ab.status != uint8(Status.ACTIVE)) {
                // Stake already routed elsewhere (slash etc.) — skip.
                unchecked { head++; walked++; }
                continue;
            }
            if (ab.stakeLockUntil > block.timestamp) {
                // FIFO: nothing past this point can be ready either.
                break;
            }

            uint256 amount = ab.stakeAmount;
            address publisher = ab.publisher;
            balances[publisher] += amount;
            emit StakeReleased(id, publisher, amount, uint64(block.timestamp));

            unchecked { head++; walked++; numReleased++; }
        }

        stakeHead = head;

        if (numReleased > 0) {
            uint256 desired = numReleased * SWEEP_BOUNTY;
            uint256 paid = desired > treasuryBalance ? treasuryBalance : desired;
            if (paid > 0) {
                unchecked { treasuryBalance -= paid; }
                balances[msg.sender] += paid;
            }
            emit StakeSwept(msg.sender, numReleased, paid);
        }
    }
}
