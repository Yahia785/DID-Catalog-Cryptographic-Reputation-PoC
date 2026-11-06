// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal fingerprint registry for the E2 baseline: record a 32-byte hash once, read back when.
contract CredentialRegistry {
    mapping(bytes32 => uint256) private _recordedAt;

    event Recorded(bytes32 h, uint256 timestamp);
    error AlreadyRecorded(bytes32 h);

    /// Stores block.timestamp for h; reverts if h was already recorded.
    function record(bytes32 h) external {
        if (_recordedAt[h] != 0) revert AlreadyRecorded(h);
        _recordedAt[h] = block.timestamp;
        emit Recorded(h, block.timestamp);
    }

    /// The timestamp h was recorded at, or 0 if it never was.
    function recordedAt(bytes32 h) external view returns (uint256) {
        return _recordedAt[h];
    }
}
