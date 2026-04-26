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

    function sweepExpired() external pure override returns (uint256) { revert TestStub(); }

    function slash(bytes32) external pure override { revert TestStub(); }

    function seedAntibody(IRegistry.PublishParams calldata)
        external
        pure
        override
        returns (bytes32, uint32)
    { revert TestStub(); }

    function withdrawTreasury(uint256, address) external pure override { revert TestStub(); }

    // View functions are wired up early so other in-progress test files can
    // assert against state. These will move to `Registry.sol` in the view
    // functions commit and then be removed from this mock.

    function getAntibody(bytes32 id) external view override returns (IRegistry.Antibody memory) {
        return _antibodies[id];
    }

    function getAntibodyByImmSeq(uint32 seq) external view override returns (IRegistry.Antibody memory) {
        return _antibodies[immSeqToKeccakId[seq]];
    }

    function getPublisherStats(address publisher) external view override returns (IRegistry.PublisherStats memory) {
        return _publishers[publisher];
    }

    function getActiveStakeCount() external view override returns (uint256) {
        return stakeTail - stakeHead;
    }

    function getOldestExpiredStakes(uint256 limit) external view override returns (bytes32[] memory) {
        uint256 active = stakeTail - stakeHead;
        if (limit > active) limit = active;
        bytes32[] memory out = new bytes32[](limit);
        for (uint256 i = 0; i < limit; i++) {
            out[i] = _stakeQueue[stakeHead + i];
        }
        return out;
    }

    function computeKeccakId(
        uint8 abType,
        uint8 flavor,
        bytes32 primaryMatcherHash,
        address publisher
    ) external pure override returns (bytes32) {
        return keccak256(abi.encode(abType, flavor, primaryMatcherHash, publisher));
    }
}
