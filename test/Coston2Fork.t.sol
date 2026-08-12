// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "./Test.sol";

interface ICoston2Herkos {
    function isFXRPMarket(address market) external view returns (bool);
    function isPokeStale() external view returns (bool);
    function getUnderlyingPrice(address market) external view returns (uint256);
}

interface ICoston2Market {
    function underlying() external view returns (address);
    function oracleFresh() external view returns (bool);
    function lastOraclePrice() external view returns (uint256);
}

/// @notice Read-only checks against the recorded public Coston2 deployment.
/// The fork is pinned so the deployment evidence is deterministic in CI and
/// does not depend on whatever the testnet head happens to be later.
contract Coston2ForkTest is Test {
    uint256 internal constant FORK_BLOCK = 33_973_920;
    address internal constant FTEST_XRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;
    address internal constant SPOT_ORACLE = 0x45A25862a31530197a3a7C1CA7a426959BD3dc8a;
    address internal constant HERKOS = 0xdbE3207e6b6e25417FdC24B99932f554718C0972;
    address internal constant MARKET = 0xb482A2FA8ec63F76B711813e685C4b4568a1c255;

    function setUp() public {
        vm.createSelectFork("coston2", FORK_BLOCK);
    }

    function testRecordedDeploymentHasBytecodeAndRegistration() public {
        assertTrue(SPOT_ORACLE.code.length > 0, "spot oracle has no bytecode");
        assertTrue(HERKOS.code.length > 0, "Herkos has no bytecode");
        assertTrue(MARKET.code.length > 0, "market has no bytecode");
        assertEq(ICoston2Market(MARKET).underlying(), FTEST_XRP, "market underlying changed");
        assertTrue(ICoston2Herkos(HERKOS).isFXRPMarket(MARKET), "market is not registered");
    }

    function testRecordedDeploymentHasFreshOraclePrice() public {
        assertFalse(ICoston2Herkos(HERKOS).isPokeStale(), "Herkos is stale at recorded block");
        assertTrue(ICoston2Market(MARKET).oracleFresh(), "market oracle cache is not fresh");
        assertGt(ICoston2Market(MARKET).lastOraclePrice(), 0, "market has no cached price");
        assertGt(ICoston2Herkos(HERKOS).getUnderlyingPrice(MARKET), 0, "Herkos returned no price");
    }
}
