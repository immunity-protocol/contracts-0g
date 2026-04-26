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
}
