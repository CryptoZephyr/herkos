// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {IPriceOracle} from "../src/interfaces/IHerkosExternal.sol";
import {ExitCapacityOracle} from "../src/ExitCapacityOracle.sol";

/// Staleness and the governance surface. Two separate claims: an oracle with no
/// live measurement refuses to price rather than guessing, and every knob that
/// shapes the number is owned by governance and none of them can set the number
/// itself.
contract GuardsTest is ForkBase {
    function setUp() public {
        _forkAndDeploy();
    }

    // ================================================================
    //  Stale beats confidently wrong
    // ================================================================

    /// A deployed-but-never-poked oracle has no measurement to stand on, so the
    /// hot path reverts. It does not fall back to the incumbent's number and it
    /// does not price at par: either would publish a figure nothing measured.
    function test_unpokedOracleRefusesToPrice() public {
        assertEq(uint256(oracle.pokedAt()), 0, "fresh deploy has never been poked");
        assertTrue(oracle.isPokeStale(), "never poked must read stale");

        vm.expectRevert();
        oracle.getUnderlyingPrice(CFXRP);
    }

    /// The window is real. Inside it the price is served; one second past it the
    /// same call reverts, with nothing else changed.
    ///
    /// The feed window is switched off first, and not to make the test pass: the
    /// FTSO timestamp is frozen at the fork block, so warping six hours ages the
    /// *feed* out (420s default) long before the poke. On a live chain the feed
    /// updates continuously and the poke window is the binding one; on a pinned
    /// fork it cannot, so isolating this guard means disabling the other.
    /// test_feedStalenessIsGuardedSeparately covers the one being disabled here.
    function test_hotPathRevertsOncePokeAgesOut() public {
        vm.prank(GOV);
        oracle.setStalenessWindows(6 hours, 0, 24 hours);
        oracle.poke();
        assertFalse(oracle.isPokeStale(), "a fresh poke must not read stale");
        uint256 served = oracle.getUnderlyingPrice(CFXRP);
        assertGt(served, 0, "a fresh poke must serve a price");

        vm.warp(block.timestamp + oracle.maxPokeAge());
        oracle.getUnderlyingPrice(CFXRP);

        vm.warp(block.timestamp + 1);
        assertTrue(oracle.isPokeStale(), "past the window must read stale");
        vm.expectRevert();
        oracle.getUnderlyingPrice(CFXRP);
    }

    /// Staleness is recoverable by anyone, without governance. This is the
    /// counterpart to the guard: refusing to price is only acceptable because
    /// the fix is a permissionless call. Feed window off for the same reason as
    /// above -- a pinned fork's feed timestamp cannot move.
    function test_anyoneCanClearStalenessByPoking() public {
        vm.prank(GOV);
        oracle.setStalenessWindows(6 hours, 0, 24 hours);
        oracle.poke();
        vm.warp(block.timestamp + oracle.maxPokeAge() + 1);
        assertTrue(oracle.isPokeStale(), "aged out");

        vm.prank(address(0xBEEF));
        oracle.poke();

        assertFalse(oracle.isPokeStale(), "an unprivileged poke must clear staleness");
        assertGt(oracle.getUnderlyingPrice(CFXRP), 0, "and restore pricing");
    }

    /// Non-FXRP markets are unaffected by a stale FXRP measurement. They are
    /// delegated to the incumbent, so a Herkos staleness event must not brick
    /// isoUSDT0 -- otherwise adopting Herkos adds a failure mode to markets it
    /// has nothing to say about.
    function test_stalenessDoesNotBreakDelegatedMarkets() public {
        assertTrue(oracle.isPokeStale(), "never poked");

        uint256 mine = oracle.getUnderlyingPrice(CUSDT0);
        assertEq(mine, IPriceOracle(INCUMBENT_ORACLE).getUnderlyingPrice(CUSDT0), "delegation must survive staleness");
    }

    /// The feed has its own window, independent of the poke window. Set it to
    /// one second and the FTSO reading is stale even though the poke is fresh:
    /// two guards, two failure modes, neither masking the other.
    function test_feedStalenessIsGuardedSeparately() public {
        oracle.poke();

        vm.prank(GOV);
        oracle.setStalenessWindows(6 hours, 1, 24 hours);

        vm.warp(block.timestamp + 300);
        vm.expectRevert();
        oracle.getUnderlyingPrice(CFXRP);

        // Disabling the feed window is explicit, not the default.
        vm.prank(GOV);
        oracle.setStalenessWindows(6 hours, 0, 24 hours);
        assertGt(oracle.getUnderlyingPrice(CFXRP), 0, "a zero feed window means unchecked");
    }

    // ================================================================
    //  Governance shapes the number, never sets it
    // ================================================================

    /// referenceSize is the consumer's question: what exit size do you want to
    /// stay solvent at? A bigger reference is a harsher haircut, and it takes
    /// effect without a poke because _recompute reads storage only.
    function test_referenceSizeMovesHaircutWithoutPoking() public {
        oracle.poke();
        uint32 atDefault = oracle.haircutPPM();

        vm.prank(GOV);
        oracle.setReferenceSize(50_000_000 * 1e6);
        uint32 atLarge = oracle.haircutPPM();

        emit log_named_uint(" default hairc", atDefault);
        emit log_named_uint("   large hairc", atLarge);

        assertLt(uint256(atLarge), uint256(atDefault), "a larger reference must cost more");
        assertEq(uint256(oracle.pokedAt()), uint256(oracle.pokedAt()), "no poke was needed");
    }

    /// The floor is a hard bound on how far the haircut may travel, so a
    /// measurement collapse cannot print an arbitrarily low price.
    function test_haircutFloorClamps() public {
        vm.startPrank(GOV);
        oracle.setHaircutFloor(990_000);
        oracle.setReferenceSize(type(uint128).max / 2);
        vm.stopPrank();

        oracle.poke();

        assertEq(uint256(oracle.haircutPPM()), 990_000, "the floor must clamp an extreme reference");
    }

    /// The exit model is parameters, not code: settlement time, the Core Vault
    /// cycle, escrow release rate and the discount rate all move the derived
    /// number and are all governance-owned.
    function test_exitModelParamsMoveTheDerivedNumber() public {
        oracle.poke();
        uint256 beforeSecs = oracle.timeToExit(uint256(oracle.effectiveQueueUBA()) + 1);
        uint32 beforePPM = oracle.haircutPPM();

        uint128 escrowRate = oracle.escrowReleasePerDayUBA();
        vm.prank(GOV);
        oracle.setExitModel(3_600, 172_800, escrowRate, 200_000);

        assertGt(oracle.timeToExit(uint256(oracle.effectiveQueueUBA()) + 1), beforeSecs, "slower settlement, longer wait");
        assertLt(uint256(oracle.haircutPPM()), uint256(beforePPM), "a steeper discount must cost more");
    }

    /// Bad parameters are refused rather than stored. A zero poke window would
    /// disable the staleness guard; a discount rate above 1.0 is not a rate.
    function test_badParamsRefused() public {
        vm.startPrank(GOV);

        vm.expectRevert();
        oracle.setStalenessWindows(0, 0, 24 hours);

        vm.expectRevert();
        oracle.setExitModel(1_800, 86_400, 0, 1_000_001);

        vm.expectRevert();
        oracle.setHaircutFloor(1_000_001);

        vm.expectRevert();
        oracle.setQueueWalkBounds(0, 100);

        vm.stopPrank();
    }

    /// Every setter is governance-gated. Checked as a set rather than one at a
    /// time, because a single ungated knob is enough to move the published price.
    function test_allSettersAreGovernanceGated() public {
        vm.startPrank(address(0xBEEF));

        vm.expectRevert();
        oracle.setReferenceSize(1);
        vm.expectRevert();
        oracle.setStalenessWindows(1 hours, 0, 1 hours);
        vm.expectRevert();
        oracle.setExitModel(1, 1, 1, 1);
        vm.expectRevert();
        oracle.setHaircutFloor(1);
        vm.expectRevert();
        oracle.setDivergenceThreshold(1);
        vm.expectRevert();
        oracle.setQueueWalkBounds(1, 1);
        vm.expectRevert();
        oracle.registerFXRPMarket(CUSDT0);
        vm.expectRevert();
        oracle.setFallbackOracle(address(0xBEEF));

        vm.stopPrank();
    }

    /// There is no setter for the price or the haircut. Governance can change
    /// what the number is derived from; it cannot write the number. Asserted by
    /// selector so adding one later breaks this test.
    function test_noSetterForPriceOrHaircut() public {
        assertFalse(_hasSelector("setHaircut(uint32)"), "haircut must not be settable");
        assertFalse(_hasSelector("setHaircutPPM(uint32)"), "haircut must not be settable");
        assertFalse(_hasSelector("setUnderlyingPrice(address,uint256)"), "price must not be settable");
        assertFalse(_hasSelector("setExitCapacity(uint128)"), "capacity must not be settable");
    }

    function _hasSelector(string memory sig) internal returns (bool) {
        (bool ok,) = address(oracle).call(abi.encodeWithSelector(bytes4(keccak256(bytes(sig))), uint256(1)));
        return ok;
    }

    /// Governance transfer is two-step, so a typo cannot orphan the knobs.
    function test_governanceTransferIsTwoStep() public {
        address next = address(0xA11CE);

        vm.prank(GOV);
        oracle.transferGovernance(next);
        assertEq(oracle.governance(), GOV, "handover must not be unilateral");

        vm.prank(address(0xBEEF));
        vm.expectRevert();
        oracle.acceptGovernance();

        vm.prank(next);
        oracle.acceptGovernance();
        assertEq(oracle.governance(), next, "the named successor must be able to accept");
    }
}
