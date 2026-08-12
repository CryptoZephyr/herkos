// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// A ~50-line stand-in for forge-std. No submodules, no node_modules — being
/// dependency-free is part of the $0 story, not an accident. `forge test` needs
/// only the cheatcode address and an interface to talk to it.
interface Vm {
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function roll(uint256) external;
    function deal(address, uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function label(address, string calldata) external;
    function mockCall(address, bytes calldata, bytes calldata) external;
    function clearMockedCalls() external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
    function envOr(string calldata, string calldata) external view returns (string memory);
    function readFile(string calldata) external view returns (string memory);
    function parseJsonUint(string calldata, string calldata) external pure returns (uint256);
    function toString(uint256) external pure returns (string memory);
}

abstract contract Test {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    uint256 private _failures;

    event log(string);
    event log_named_uint(string key, uint256 val);
    event log_named_int(string key, int256 val);
    event log_named_address(string key, address val);
    event log_named_string(string key, string val);

    function assertTrue(bool c, string memory reason) internal {
        if (!c) {
            emit log_named_string("assertion failed", reason);
            revert(reason);
        }
    }

    function assertFalse(bool c, string memory reason) internal {
        assertTrue(!c, reason);
    }

    function assertEq(uint256 a, uint256 b, string memory reason) internal {
        if (a != b) {
            emit log_named_uint("      left", a);
            emit log_named_uint("     right", b);
            revert(reason);
        }
    }

    function assertEq(address a, address b, string memory reason) internal {
        if (a != b) {
            emit log_named_address("      left", a);
            emit log_named_address("     right", b);
            revert(reason);
        }
    }

    function assertLe(uint256 a, uint256 b, string memory reason) internal {
        if (a > b) {
            emit log_named_uint("      left", a);
            emit log_named_uint("  right max", b);
            revert(reason);
        }
    }

    function assertGe(uint256 a, uint256 b, string memory reason) internal {
        if (a < b) {
            emit log_named_uint("      left", a);
            emit log_named_uint("  right min", b);
            revert(reason);
        }
    }

    function assertLt(uint256 a, uint256 b, string memory reason) internal {
        if (a >= b) {
            emit log_named_uint("      left", a);
            emit log_named_uint("     right", b);
            revert(reason);
        }
    }

    function assertGt(uint256 a, uint256 b, string memory reason) internal {
        if (a <= b) {
            emit log_named_uint("      left", a);
            emit log_named_uint("     right", b);
            revert(reason);
        }
    }

    /// Within `tolPPM` parts per million of each other.
    function assertApprox(uint256 a, uint256 b, uint256 tolPPM, string memory reason) internal {
        uint256 d = a > b ? a - b : b - a;
        uint256 base = b == 0 ? 1 : b;
        if ((d * 1_000_000) / base > tolPPM) {
            emit log_named_uint("      left", a);
            emit log_named_uint("     right", b);
            revert(reason);
        }
    }
}
