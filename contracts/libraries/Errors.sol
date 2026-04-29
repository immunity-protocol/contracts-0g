// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Custom errors emitted by the Immunity Registry. File-scope so that
///         contracts can `revert InsufficientBalance()` directly.

error InsufficientBalance();
error InsufficientStake();
error AntibodyExists();
/// @notice Reverted by `publish` when a different antibody already claims this
///         primary matcher hash. The data field carries the existing keccakId
///         so the SDK can fetch and reuse it instead of publishing a duplicate.
error AntibodyAlreadyExistsForMatcher(bytes32 existingKeccakId);
error AntibodyNotFound();
error AntibodyNotActive();
error StakeStillLocked();
error InvalidConfidence();
error InvalidSeverity();
error InvalidVerdict();
error InvalidAntibodyType();
error InvalidStatusTransition();
error ZeroAddress();
error ZeroAmount();
error SeedNotAllowed();
