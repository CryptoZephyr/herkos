// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {IERC20} from "../src/interfaces/IHerkosExternal.sol";

/// Only the test needs to know a pool's pair. `_readPools` deliberately reads
/// balances instead, which is what lets one ABI-free path cover V2, V3 and
/// Algebra alike -- so this stays out of the production interfaces.
interface IPoolPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// The two exit venues that are not the redemption queue: DEX depth and the OFT
/// Adapter. Both are governance-registered, which is why a fresh deploy reads
/// zero for them -- that is an unwired oracle, not a measurement.
///
/// The load-bearing distinction here is correlated vs uncorrelated. The deepest
/// FXRP pool on Flare at the pin is FXRP/stXRP, and selling FXRP into stXRP does
/// not get you out of XRP. Counting it as exit depth would inflate capacity,
/// which is the one direction this oracle is not allowed to move.
contract ExitVenuesTest is ForkBase {
    function setUp() public {
        _forkAndDeploy();
    }

    function _addUncorrelatedPools() internal {
        vm.startPrank(GOV);
        oracle.addExitPool(POOL_FXRP_USDT0_A, USDT0, false);
        oracle.addExitPool(POOL_FXRP_USDT0_B, USDT0, false);
        oracle.addExitPool(POOL_FXRP_USDT0_C, USDT0, false);
        vm.stopPrank();
    }

    // ================================================================
    //  Correlation
    // ================================================================

    /// The pair itself, asserted rather than assumed. If this pool ever gets
    /// rebalanced into something uncorrelated the premise below changes, and a
    /// test that only checked the flag would not notice.
    function test_deepestPoolIsBothSidesXRP() public {
        assertEq(IPoolPair(POOL_STXRP_FXRP).token0(), STXRP, "token0 must be stXRP");
        assertEq(IPoolPair(POOL_STXRP_FXRP).token1(), FXRP, "token1 must be FXRP");

        uint256 fxrpSide = IERC20(FXRP).balanceOf(POOL_STXRP_FXRP);
        emit log_named_uint(" stXRP/FXRP fxrp", fxrpSide);
        assertGt(fxrpSide, 2_000_000 * 1e6, "the correlated pool is the deepest at the pin");
    }

    /// THE test for this file. A correlated pool may be registered -- so the
    /// oracle knows the liquidity is there -- and must still contribute nothing
    /// to exit depth. Registering it must not raise capacity by one UBA.
    function test_correlatedPoolDoesNotInflateExitDepth() public {
        oracle.poke();
        uint128 before = oracle.exitCapacityUBA();

        vm.prank(GOV);
        oracle.addExitPool(POOL_STXRP_FXRP, STXRP, true);
        oracle.poke();

        emit log_named_uint("     dexExitUBA", oracle.dexExitUBA());
        emit log_named_uint("  capacity before", before);
        emit log_named_uint("   capacity after", oracle.exitCapacityUBA());

        assertEq(uint256(oracle.exitPoolCount()), 1, "the pool must be registered");
        assertEq(uint256(oracle.dexExitUBA()), 0, "a rotation is not an exit");
        assertEq(oracle.exitCapacityUBA(), before, "a correlated pool must not add capacity");
    }

    /// Mislabelling is the failure this flag exists to prevent, and it is
    /// recoverable: flipping the flag on an already-registered pool moves the
    /// number, so a mistake can be corrected without redeploying.
    function test_correlationFlagIsTheWholeDifference() public {
        vm.prank(GOV);
        oracle.addExitPool(POOL_STXRP_FXRP, STXRP, true);
        oracle.poke();
        assertEq(uint256(oracle.dexExitUBA()), 0, "correlated contributes nothing");

        vm.prank(GOV);
        oracle.setPoolCorrelated(0, false);
        oracle.poke();

        assertGt(uint256(oracle.dexExitUBA()), 0, "the flag must be what excludes it");
    }

    // ================================================================
    //  Uncorrelated depth
    // ================================================================

    /// Uncorrelated depth is real but modest. Registering the three FXRP/USD₮0
    /// pools is what makes dexExitUBA non-zero, and the total has to match the
    /// FXRP those pools actually hold -- not a nominal or notional figure.
    function test_uncorrelatedPoolsContributeMeasuredDepth() public {
        oracle.poke();
        assertEq(uint256(oracle.dexExitUBA()), 0, "unwired means zero, not assumed");

        _addUncorrelatedPools();
        oracle.poke();

        uint256 expected = IERC20(FXRP).balanceOf(POOL_FXRP_USDT0_A) + IERC20(FXRP).balanceOf(POOL_FXRP_USDT0_B)
            + IERC20(FXRP).balanceOf(POOL_FXRP_USDT0_C);

        emit log_named_uint("     dexExitUBA", oracle.dexExitUBA());
        emit log_named_uint("    dexQuoteUBA", oracle.dexQuoteUBA());

        assertEq(uint256(oracle.dexExitUBA()), expected, "depth must be the reserves it read");
        assertGt(uint256(oracle.dexQuoteUBA()), 0, "the stablecoin side must be read too");
    }

    /// The quote side is normalised to FXRP's 6 decimals. USD₮0 is also 6, so
    /// this pins the pass-through case; an 18-decimal quote token would be
    /// divided by 1e12 on the same path.
    function test_quoteSideNormalisedToSixDecimals() public {
        _addUncorrelatedPools();
        oracle.poke();

        uint256 raw = IERC20(USDT0).balanceOf(POOL_FXRP_USDT0_A) + IERC20(USDT0).balanceOf(POOL_FXRP_USDT0_B)
            + IERC20(USDT0).balanceOf(POOL_FXRP_USDT0_C);

        assertEq(uint256(IERC20(USDT0).decimals()), 6, "USDT0 is 6 decimals");
        assertEq(uint256(oracle.dexQuoteUBA()), raw, "equal decimals must pass through unscaled");
    }

    /// DEX depth widens capacity, so it lowers the price of a given exit. Small
    /// in absolute terms against an 8.9M capacity, but it must move the number
    /// in the right direction or the input is decorative.
    function test_dexDepthWidensCapacity() public {
        oracle.poke();
        uint128 without = oracle.exitCapacityUBA();

        _addUncorrelatedPools();
        oracle.poke();

        emit log_named_uint("  cap without dex", without);
        emit log_named_uint("     cap with dex", oracle.exitCapacityUBA());

        assertGt(oracle.exitCapacityUBA(), without, "uncorrelated depth must add capacity");
        assertGe(uint256(oracle.haircutPPM()), oracle.minHaircutPPM(), "haircut floor must hold");
    }

    // ================================================================
    //  The OFT Adapter
    // ================================================================

    /// The adapter's locked balance is the aggregate of every remote claim. It
    /// is recorded, not counted as exit capacity: those tokens are somebody
    /// else's, and per-chain attribution is not FDC-provable on mainnet.
    function test_oftAdapterIsRecordedNotCountedAsCapacity() public {
        oracle.poke();
        assertEq(uint256(oracle.remoteClaimsUBA()), 0, "unset adapter reads zero");
        uint128 before = oracle.exitCapacityUBA();

        vm.prank(GOV);
        oracle.setOftAdapter(OFT_ADAPTER);
        oracle.poke();

        emit log_named_uint("  remoteClaimsUBA", oracle.remoteClaimsUBA());

        assertEq(
            uint256(oracle.remoteClaimsUBA()),
            IERC20(FXRP).balanceOf(OFT_ADAPTER),
            "remote claims must be the adapter's locked balance"
        );
        assertGt(uint256(oracle.remoteClaimsUBA()), 12_000_000 * 1e6, "8.68% of supply at the pin");
        assertEq(oracle.exitCapacityUBA(), before, "remote claims are not exit capacity");
    }

    /// Both venues are governance-only. Anyone may poke, nobody unprivileged may
    /// change what poke reads.
    function test_venueRegistrationIsGovernanceOnly() public {
        vm.startPrank(address(0xBEEF));

        vm.expectRevert();
        oracle.addExitPool(POOL_FXRP_USDT0_A, USDT0, false);

        vm.expectRevert();
        oracle.setOftAdapter(OFT_ADAPTER);

        vm.stopPrank();
    }

    // ================================================================
    //  Routing — the Phase 4 decision
    // ================================================================

    /// The invariant the old unconditional fill violated, and the reason it was
    /// wrong in one line: **an exit venue is optional.** Nobody is forced onto
    /// an AMM, so knowing a pool exists can never make an exit price worse than
    /// it was without it. `_timeToExit` reads the queue and the Core Vault and
    /// not the DEX, so the pre-registration ladder *is* the pure-redemption
    /// price, and registering pools must hold at or above it at every size.
    ///
    /// Against the old code this fails at the first rung: 1M FXRP priced at
    /// 627,540 ppm with pools registered against 999,992 without.
    function test_dexCanOnlyImprove() public {
        uint256[6] memory sizes = [
            uint256(10_000 * 1e6), 100_000 * 1e6, 1_000_000 * 1e6, 10_000_000 * 1e6, 50_000_000 * 1e6, 150_000_000 * 1e6
        ];

        oracle.poke();
        uint256[6] memory redeemOnly;
        for (uint256 i; i < sizes.length; ++i) {
            redeemOnly[i] = oracle.clearingPricePPM(sizes[i]);
        }
        assertEq(uint256(oracle.dexExitUBA()), 0, "the baseline must be redemption alone");

        _addUncorrelatedPools();
        oracle.poke();
        assertGt(uint256(oracle.dexExitUBA()), 0, "pools must actually be registered");

        for (uint256 i; i < sizes.length; ++i) {
            uint256 routed = oracle.clearingPricePPM(sizes[i]);
            emit log_named_uint("        size UBA", sizes[i]);
            emit log_named_uint("   redemption ppm", redeemOnly[i]);
            emit log_named_uint("       routed ppm", routed);
            assertGe(routed, redeemOnly[i], "a venue you may ignore cannot lower the clearing price");
            assertLe(routed, 1_000_000, "clearing price cannot exceed par");
        }
    }

    /// The published number, specifically. `haircutPPM` is `_clearingPPM` at
    /// `referenceSize`, so the invariant above has a direct consequence:
    /// registering real exit depth must widen capacity *without* tightening the
    /// haircut. Both halves moving the same way is what the old fill got wrong.
    function test_registeringPoolsWidensCapacityWithoutTighteningTheHaircut() public {
        oracle.poke();
        uint128 capBefore = oracle.exitCapacityUBA();
        uint32 hcBefore = oracle.haircutPPM();

        _addUncorrelatedPools();
        oracle.poke();

        emit log_named_uint("  capacity before", capBefore);
        emit log_named_uint("   capacity after", oracle.exitCapacityUBA());
        emit log_named_uint("   haircut before", hcBefore);
        emit log_named_uint("    haircut after", oracle.haircutPPM());

        assertGt(oracle.exitCapacityUBA(), capBefore, "uncorrelated depth must add capacity");
        assertGe(uint256(oracle.haircutPPM()), uint256(hcBefore), "depth must not tighten the haircut");
    }

    /// Monotonicity is what makes `referenceSize` a risk control rather than a
    /// number: "what exit size do you want to stay solvent at?" is meaningless
    /// if answering with a bigger size can return a better price. The old fill
    /// broke this exactly once pools were registered — a fixed 1.68M DEX slice
    /// averaged against a growing near-par remainder priced 10M *above* 1M.
    function test_clearingPriceStaysMonotonicWithPoolsRegistered() public {
        _addUncorrelatedPools();
        oracle.poke();

        uint256 prev = 1_000_000 + 1;
        for (uint256 n = 100_000; n <= 200_000_000; n = (n * 3) / 2) {
            uint256 ppm = oracle.clearingPricePPM(n * 1e6);
            assertLe(ppm, prev, "a larger exit cannot clear at a better price");
            prev = ppm;
        }
        emit log_named_uint("  200M FXRP ppm", prev);
    }
}
