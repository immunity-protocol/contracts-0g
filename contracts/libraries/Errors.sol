// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Custom errors emitted by the Immunity Registry. File-scope so that
///         contracts can `revert InsufficientBalance()` directly.

error InsufficientBalance();
error InsufficientStake();
error AntibodyExists();
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
