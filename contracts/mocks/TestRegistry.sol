// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Registry} from "../Registry.sol";
import {IRegistry} from "../interfaces/IRegistry.sol";

/// @title TestRegistry
/// @notice Concrete subclass of `Registry` used to deploy the contract in tests
///         while `Registry` is still abstract (interface functions added
///         incrementally per commit). Each stub is removed as the parent
///         contract implements the corresponding function.
///         Not for production deployment.
contract TestRegistry is Registry {
    error TestStub();

    constructor(address _usdc) Registry(_usdc) {}

    function check(bytes32) external pure override returns (bool) { revert TestStub(); }

    function sweepExpired() external pure override returns (uint256) { revert TestStub(); }

    function slash(bytes32) external pure override { revert TestStub(); }

    function seedAntibody(IRegistry.PublishParams calldata)
        external
        pure
        override
        returns (bytes32, uint32)
    { revert TestStub(); }

    function withdrawTreasury(uint256, address) external pure override { revert TestStub(); }

    function getAntibody(bytes32) external pure override returns (IRegistry.Antibody memory) {
        revert TestStub();
    }

    function getAntibodyByImmSeq(uint32) external pure override returns (IRegistry.Antibody memory) {
        revert TestStub();
    }

    function getPublisherStats(address) external pure override returns (IRegistry.PublisherStats memory) {
        revert TestStub();
    }

    function getActiveStakeCount() external pure override returns (uint256) { revert TestStub(); }

    function getOldestExpiredStakes(uint256) external pure override returns (bytes32[] memory) {
        revert TestStub();
    }

    function computeKeccakId(uint8, uint8, bytes32, address)
        external
        pure
        override
        returns (bytes32)
    { revert TestStub(); }
}
