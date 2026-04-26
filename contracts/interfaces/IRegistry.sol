// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRegistry — external interface for the Immunity 0G Chain registry.
/// @notice Antibody envelope, publisher staking, prepaid-fee subscription,
///         reward settlement, and FIFO sweep of expired stakes.
interface IRegistry {
    // ------------------------------------------------------------------
    //  Enums
    // ------------------------------------------------------------------

    /// @notice Top-level antibody classification.
    enum AntibodyType {
        ADDRESS,        // 0 — blacklisted wallet
        CALL_PATTERN,   // 1 — function selector + args fingerprint
        BYTECODE,       // 2 — runtime bytecode hash for clone detection
        GRAPH,          // 3 — taint topology
        SEMANTIC        // 4 — manipulation embedding / structural markers / poisoned content
    }

    /// @notice Determination produced by the reviewer TEE.
    enum Verdict {
        MALICIOUS,      // 0
        SUSPICIOUS      // 1
    }

    /// @notice Antibody lifecycle status.
    enum Status {
        ACTIVE,         // 0 — published, settling rewards on match
        CHALLENGED,     // 1 — under v2 challenge game (unused in v1)
        SLASHED,        // 2 — admin slashed; stake forfeited to treasury
        EXPIRED         // 3 — past publisher-chosen expiration
    }

    // ------------------------------------------------------------------
    //  Structs
    // ------------------------------------------------------------------

    /// @notice Stored antibody envelope. Off-chain consumers hydrate richer
    ///         data from 0G Storage via `evidenceCid` / `contextHash`.
    /// @dev Field ordering targets ~7 storage slots via packing.
    struct Antibody {
        bytes32 primaryMatcherHash;     // slot 0 — keccak of canonicalized matcher
        bytes32 evidenceCid;            // slot 1 — 0G Storage root of public envelope
        bytes32 contextHash;            // slot 2 — 0G Storage root of encrypted context
        bytes32 embeddingHash;          // slot 3 — SEMANTIC only; zero if unused
        bytes32 attestation;            // slot 4 — TEE quote hash
        address publisher;              // slot 5 — packed with stakeLockUntil + immSeq
        uint64  stakeLockUntil;
        uint32  immSeq;
        address reviewer;               // slot 6 — informational only in v1
        uint64  expiresAt;              //          0 = permanent
        uint8   abType;                 //          AntibodyType
        uint8   flavor;                 //          sub-type for SEMANTIC, ignored otherwise
        uint8   verdict;                //          Verdict
        uint8   confidence;             //          0..100
        uint64  createdAt;              // slot 7 — packed with stakeAmount + small flags
        uint96  stakeAmount;            //          USDC (6 decimals); fits ~7.9e28 wei
        uint8   severity;               //          0..100
        uint8   status;                 //          Status
        uint8   isSeeded;               //          1 if admin-seeded, no stake, no rewards
    }

    /// @notice Calldata shape used by `publish` and `seedAntibody`.
    struct PublishParams {
        uint8   abType;
        uint8   flavor;
        uint8   verdict;
        uint8   confidence;
        uint8   severity;
        bytes32 primaryMatcherHash;
        bytes32 evidenceCid;
        bytes32 contextHash;
        bytes32 embeddingHash;
        bytes32 attestation;
        uint64  expiresAt;
        address reviewer;
        bytes32 auxiliaryKey;           // typed dispatch — see auxiliary events below
    }

    /// @notice Denormalized publisher metrics. Updated on publish, slash, and reward.
    struct PublisherStats {
        uint128 totalStaked;            // cumulative USDC staked across all publishes
        uint128 totalEarned;            // cumulative USDC reward income
        uint64  publishedCount;
        uint64  slashedCount;
    }

    // ------------------------------------------------------------------
    //  Events
    // ------------------------------------------------------------------

    /// @notice Emitted on every successful publish (and seed). Carries the
    ///         entire envelope so the indexer never needs a follow-up RPC.
    event AntibodyPublished(
        bytes32 indexed keccakId,
        uint32  indexed immSeq,
        address indexed publisher,
        uint8   abType,
        uint8   flavor,
        uint8   verdict,
        uint8   severity,
        uint8   confidence,
        address reviewer,
        bytes32 primaryMatcherHash,
        bytes32 evidenceCid,
        bytes32 contextHash,
        bytes32 embeddingHash,
        bytes32 attestation,
        uint256 stake,
        uint64  stakeLockUntil,
        uint64  expiresAt,
        uint64  createdAt,
        bool    isSeeded
    );

    // ---- Auxiliary events: exactly one of these per publish, dispatched on
    //      `abType`. The Mirror contracts on execution chains will emit the
    //      same signatures so indexers see uniform shapes across all chains.

    event AddressBlocked(
        address indexed target,
        bytes32 indexed keccakId,
        address indexed publisher
    );

    event CallPatternBlocked(
        bytes4  indexed selector,
        bytes32 indexed keccakId,
        address indexed publisher
    );

    event BytecodeBlocked(
        bytes32 indexed bytecodeHash,
        bytes32 indexed keccakId,
        address indexed publisher
    );

    event GraphTaintAdded(
        bytes32 indexed taintSetId,
        bytes32 indexed keccakId,
        address indexed publisher
    );

    event SemanticPatternAdded(
        uint8   indexed flavor,
        bytes32 indexed keccakId,
        address indexed publisher
    );

    // ---- Lifecycle, balance, and economic events.

    event CheckSettled(
        address indexed agent,
        bytes32 indexed antibodyId,
        bool    wasMatch,
        uint256 fee,
        uint64  timestamp
    );

    event AntibodyMatched(
        bytes32 indexed keccakId,
        address indexed agent,
        address indexed publisher,
        address reviewer,
        uint256 publisherReward,
        uint256 treasuryReward
    );

    event StakeReleased(
        bytes32 indexed keccakId,
        address indexed publisher,
        uint256 amount,
        uint64  releasedAt
    );

    event StakeSwept(
        address indexed sweeper,
        uint256 numReleased,
        uint256 bountyPaid
    );

    event AntibodySlashed(
        bytes32 indexed keccakId,
        address indexed publisher,
        uint256 stakeAmount
    );

    event Deposited(address indexed operator, uint256 amount);
    event Withdrew(address indexed operator, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event Seeded(bytes32 indexed keccakId, uint32 indexed immSeq);

    // ------------------------------------------------------------------
    //  State-changing functions
    // ------------------------------------------------------------------

    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;

    function publish(PublishParams calldata params)
        external
        returns (bytes32 keccakId, uint32 immSeq);

    function check(bytes32 antibodyId) external returns (bool settled);

    function sweepExpired() external returns (uint256 numReleased);

    function slash(bytes32 antibodyId) external;

    function seedAntibody(PublishParams calldata params)
        external
        returns (bytes32 keccakId, uint32 immSeq);

    function withdrawTreasury(uint256 amount, address to) external;

    // ------------------------------------------------------------------
    //  Views
    // ------------------------------------------------------------------

    function getAntibody(bytes32 keccakId) external view returns (Antibody memory);

    function getAntibodyByImmSeq(uint32 immSeq) external view returns (Antibody memory);

    function getPublisherStats(address publisher) external view returns (PublisherStats memory);

    function getActiveStakeCount() external view returns (uint256);

    function getOldestExpiredStakes(uint256 limit) external view returns (bytes32[] memory);

    function computeKeccakId(
        uint8 abType,
        uint8 flavor,
        bytes32 primaryMatcherHash,
        address publisher
    ) external pure returns (bytes32);
}
