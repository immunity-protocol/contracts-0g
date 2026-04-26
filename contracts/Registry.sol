// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IRegistry} from "./interfaces/IRegistry.sol";
import {ZeroAddress} from "./libraries/Errors.sol";

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
}
