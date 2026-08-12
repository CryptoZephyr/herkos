// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {IPriceOracle, IFtsoV2} from "../src/interfaces/IHerkosExternal.sol";

/// The hot path is the whole drop-in claim. `getUnderlyingPrice` runs inside
/// Compound's getHypotheticalAccountLiquidityInternal on every borrow, redeem
/// and liquidation, so these tests are about two things only: does it agree
/// with the incumbent when nothing is wrong, and does it cost about the same.
contract HotPathTest is ForkBase {
    function setUp() public {
        _forkAndDeploy();
    }

    /// The credibility test. Herkos must land on the incumbent's number under
    /// normal conditions, and the only thing allowed to separate them is the
    /// haircut — never a scaling error. Both halves are asserted separately so
    /// a scaling bug cannot hide inside a plausible-looking haircut.
    function test_agreesWithIncumbentUnderNormalConditions() public {
        assertEq(oracle.haircutPPM(), 1_000_000, "fresh deploy should carry no haircut");

        oracle.poke();

        uint256 hc = oracle.haircutPPM();
        uint256 mine = oracle.getUnderlyingPrice(CFXRP);
        uint256 theirs = IPriceOracle(INCUMBENT_ORACLE).getUnderlyingPrice(CFXRP);

        emit log_named_uint("      herkos", mine);
        emit log_named_uint("   incumbent", theirs);
        emit log_named_uint(" haircut ppm", hc);

        // Exact, not approximate: both read the same feed in the same block, so
        // the haircut factor is the entire difference. Any scaling error breaks
        // this line even when the haircut looks reasonable.
        assertEq(mine, (theirs * hc) / 1_000_000, "haircut must be the only difference");

        // And under real mainnet conditions at the pin that haircut is small.
        // FXRP is not broken; the number has to look like the incumbent's until
        // measured exit capacity says otherwise. 8 ppm at this block.
        assertApprox(mine, theirs, 1_000, "normal conditions must not diverge visibly");
    }

    /// Confirms the scaling exponent empirically rather than trusting the
    /// `ftsoPrice * 1e30 / 1e18` shape in Tasks1.md, which is wrong by twelve
    /// orders of magnitude. FXRP is 6 decimals and the feed is 6 decimals, so
    /// the mantissa is value * 10^(36 - 6 - 6) = value * 1e24.
    function test_scalingMatchesFeedDecimals() public {
        oracle.poke();

        (uint256 value, int8 decimals,) = IFtsoV2(FTSO_V2).getFeedById(XRP_USD);
        assertEq(uint256(uint8(decimals)), 6, "XRP/USD feed is 6 decimals");

        uint256 unhaircut = value * 1e24;
        assertEq(
            oracle.getUnderlyingPrice(CFXRP),
            (unhaircut * oracle.haircutPPM()) / 1_000_000,
            "mantissa must be value * 1e24, haircut applied"
        );

        // An 18-decimal assumption would print 1e12 times too small, and the
        // Tasks1.md formula 1e12 too large. Bracket both.
        assertGt(oracle.getUnderlyingPrice(CFXRP), 1e29, "price collapsed, check decimals");
        assertLt(oracle.getUnderlyingPrice(CFXRP), 1e31, "price inflated, check decimals");
    }

    /// The gas ceiling. Measured identically for both oracles in the same
    /// block: one external staticcall each, so the difference is the oracle
    /// and not the harness. Cold is the headline — Compound calls the oracle
    /// once per market in a fresh transaction — and warm is what a multi-market
    /// liquidation actually pays after the first call.
    /// Cold, with Herkos as the first oracle call in the transaction, so it pays
    /// to warm the shared FTSO feed itself. This is the number that has to clear
    /// the 100k target: Compound calls the oracle once per market in a fresh
    /// transaction, so the first call is what the drop-in claim rests on.
    ///
    /// Measured separately from the incumbent because whichever oracle runs
    /// second free-rides on the feed slots the first one warmed. Two tests, two
    /// transactions, two fresh access lists.
    function test_hotPathGasCold_herkosPaysFeedWarming() public {
        oracle.poke();

        uint256 g0 = gasleft();
        IPriceOracle(address(oracle)).getUnderlyingPrice(CFXRP);
        uint256 used = g0 - gasleft();

        emit log_named_uint("  herkos cold", used);

        // The docs' 91,042 is the bare FTSO feed read, not an oracle entrypoint.
        assertLe(used, 100_000, "hot path must stay within the 100k target");
    }

    /// The same measurement for the incumbent, on identical footing: first
    /// oracle call in its own transaction, paying the same feed warming. Recorded
    /// so the comparison in the docs is like-for-like rather than order-biased.
    function test_hotPathGasCold_incumbentPaysFeedWarming() public {
        uint256 g0 = gasleft();
        IPriceOracle(INCUMBENT_ORACLE).getUnderlyingPrice(CFXRP);
        uint256 used = g0 - gasleft();

        emit log_named_uint("  incumb cold", used);
        assertGt(used, 0, "incumbent must be readable at the pin");
    }

    /// Warm steady state, both oracles on the same footing in the same
    /// transaction. This is what a multi-market liquidation pays after the first
    /// call, and here Herkos must not cost more than the oracle it replaces.
    function test_hotPathGasWarmAtOrBelowIncumbent() public {
        oracle.poke();

        IPriceOracle(address(oracle)).getUnderlyingPrice(CFXRP);
        IPriceOracle(INCUMBENT_ORACLE).getUnderlyingPrice(CFXRP);

        uint256 g0 = gasleft();
        IPriceOracle(address(oracle)).getUnderlyingPrice(CFXRP);
        uint256 mine = g0 - gasleft();

        uint256 g1 = gasleft();
        IPriceOracle(INCUMBENT_ORACLE).getUnderlyingPrice(CFXRP);
        uint256 theirs = g1 - gasleft();

        emit log_named_uint("  herkos warm", mine);
        emit log_named_uint("  incumb warm", theirs);

        assertLe(mine, theirs, "herkos must not cost more than the incumbent (warm)");
    }

    /// The queue walk lives in poke(), never here. If a future change reaches
    /// the redemption queue from the hot path this catches it, because a walk
    /// costs 540,601 gas and grows unbounded.
    function test_hotPathDoesNotWalkQueue() public {
        oracle.poke();
        oracle.getUnderlyingPrice(CFXRP);

        uint256 g0 = gasleft();
        oracle.getUnderlyingPrice(CFXRP);
        uint256 used = g0 - gasleft();

        assertLt(used, 200_000, "hot path cost implies a queue walk");
    }

    /// Non-FXRP markets must keep working. `_setPriceOracle` repoints every
    /// market at once, so without delegation adopting Herkos would break
    /// isoUSDT0 and isoSTXRP and the one-governance-call claim would be false.
    function test_delegatesNonFXRPMarketsToIncumbent() public {
        assertFalse(oracle.isFXRPMarket(CUSDT0), "isoUSDT0 is not an FXRP market");

        uint256 mine = oracle.getUnderlyingPrice(CUSDT0);
        uint256 theirs = IPriceOracle(INCUMBENT_ORACLE).getUnderlyingPrice(CUSDT0);

        assertEq(mine, theirs, "non-FXRP markets must pass through unchanged");
    }

    /// The interface flag the governance call itself checks.
    function test_isPriceOracle() public {
        assertTrue(oracle.isPriceOracle(), "comptroller._setPriceOracle requires this");
    }
}
