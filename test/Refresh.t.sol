// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {IAssetManager, ICoreVaultManager, IERC20} from "../src/interfaces/IHerkosExternal.sol";
import {ExitCapacityOracle} from "../src/ExitCapacityOracle.sol";

/// poke() against the real redemption queue and the real Core Vault at the pin.
/// This is the loop that costs ~600k gas and is permissionless, not free.
contract RefreshTest is ForkBase {
    function setUp() public {
        _forkAndDeploy();
    }

    /// Anyone can refresh. No arguments, no privilege, no submitted values:
    /// poke() reads the chain and writes what it read.
    function test_pokeIsPermissionless() public {
        vm.prank(address(0xBEEF));
        oracle.poke();

        assertGt(oracle.pokedAt(), 0, "poke must stamp a timestamp");
        assertEq(uint256(oracle.pokedAtBlock()), block.number, "poke must stamp a block");
    }

    /// The queue walk must actually reach the real queue. ~80 tickets were live
    /// at the pin; the exact count moves, so assert it read a non-empty queue
    /// and completed within its page budget rather than pinning a number.
    function test_pokeWalksRealQueue() public {
        oracle.poke();

        emit log_named_uint("      tickets", oracle.queueTicketsSeen());
        emit log_named_uint("        pages", oracle.queuePagesWalked());
        emit log_named_uint("effectiveQueue", oracle.effectiveQueueUBA());

        assertGt(oracle.queueTicketsSeen(), 0, "the real queue is not empty at this pin");
        assertFalse(oracle.queueTruncated(), "page budget must cover the live queue");
    }

    /// Truncation is flagged, never silent. A capacity number computed from a
    /// partial walk that claims to be complete is the dangerous failure mode.
    function test_truncationIsFlaggedNotSilent() public {
        vm.prank(GOV);
        oracle.setQueueWalkBounds(1, 1);

        oracle.poke();

        assertTrue(oracle.queueTruncated(), "a one-ticket budget must report truncation");
        assertEq(uint256(oracle.queuePagesWalked()), 1, "budget must be honoured");
    }

    /// The Core Vault contributes real funds. availableFunds + escrowedFunds is
    /// read from the deployed CoreVaultManager, not assumed.
    function test_pokeReadsCoreVault() public {
        oracle.poke();

        uint128 avail = ICoreVaultManager(CORE_VAULT_MANAGER).availableFunds();
        uint128 escrow = ICoreVaultManager(CORE_VAULT_MANAGER).escrowedFunds();

        emit log_named_uint("     available", avail);
        emit log_named_uint("      escrowed", escrow);
        emit log_named_uint("  coreVaultUBA", oracle.coreVaultUBA());

        assertGt(uint256(avail) + uint256(escrow), 0, "core vault holds funds at this pin");
        // No proofs submitted yet, so the stored figure is Flare's own accounting.
        assertEq(oracle.coreVaultUBA(), oracle.lastFlareCoreVaultUBA(), "unreduced without proofs");
    }

    /// The measured capacity has to be a real quantity, not a placeholder, and
    /// the haircut derived from it has to sit inside its own declared bounds.
    function test_pokeProducesSaneAggregate() public {
        oracle.poke();

        emit log_named_uint(" exitCapacity", oracle.exitCapacityUBA());
        emit log_named_uint("  haircut ppm", oracle.haircutPPM());
        emit log_named_uint("  dexExitUBA", oracle.dexExitUBA());

        assertGt(oracle.exitCapacityUBA(), 0, "exit capacity must be measurable at the pin");
        assertGe(uint256(oracle.haircutPPM()), oracle.minHaircutPPM(), "haircut below its floor");
        assertLe(uint256(oracle.haircutPPM()), 1_000_000, "haircut may never exceed 1.0");
    }

    /// The haircut is computed on-chain from stored inputs. Never submitted:
    /// there is no setter for it anywhere on the contract, and poking twice in
    /// the same block from different callers must land on the same number.
    function test_haircutIsDerivedNotSubmitted() public {
        vm.prank(address(0xBEEF));
        oracle.poke();
        uint32 first = oracle.haircutPPM();

        vm.prank(address(0xF00D));
        oracle.poke();

        assertEq(uint256(oracle.haircutPPM()), uint256(first), "haircut must not depend on caller");
    }

    /// A bigger exit costs more than a smaller one. The haircut is a size
    /// question, which is the whole product claim: 766,000 FXRP/day is
    /// demonstrated throughput, not capacity.
    function test_clearingPriceFallsWithSize() public {
        oracle.poke();

        uint256 small = oracle.clearingPricePPM(10_000 * 1e6);
        uint256 mid = oracle.clearingPricePPM(1_000_000 * 1e6);
        uint256 large = oracle.clearingPricePPM(50_000_000 * 1e6);

        emit log_named_uint("      10k FXRP", small);
        emit log_named_uint("       1M FXRP", mid);
        emit log_named_uint("      50M FXRP", large);

        assertGe(small, mid, "a larger exit cannot clear at a better price");
        assertGe(mid, large, "a larger exit cannot clear at a better price");
        assertLe(small, 1_000_000, "clearing price cannot exceed par");
    }

    /// Time to exit is tiered by where the size lands, and no redemption is
    /// instant: even one UBA waits for measured agent settlement. Each tier must
    /// cost strictly more than the one inside it.
    function test_timeToExitIsTieredBySize() public {
        oracle.poke();

        uint256 inQueue = oracle.timeToExit(1);
        uint256 inVault = oracle.timeToExit(uint256(oracle.effectiveQueueUBA()) + 1);
        uint256 beyond = oracle.timeToExit(500_000_000 * 1e6);

        emit log_named_uint("  queue secs", inQueue);
        emit log_named_uint("  vault secs", inVault);
        emit log_named_uint(" beyond secs", beyond);

        assertEq(inQueue, oracle.queueSettleSeconds(), "queue tier is agent settlement");
        assertGt(inVault, inQueue, "reaching the Core Vault must cost its daily cycle");
        assertGt(beyond, inVault, "beyond the vault must cost escrow release time");
    }

    /// The gas budget for the refresh loop. Permissionless, not free: someone
    /// pays this. Measured at the pin it is ~1.84M, not the ~600k Architecture1.md
    /// claims -- that figure covered redemptionQueue(0,100) alone (472k here,
    /// 540,601 on mainnet) and omitted the agent-status filtering, which is the
    /// dominant term at ~282k per unique agent.
    ///
    /// 1.84M is 6.5% of Flare's 28,027,352 block limit and ~1.19 FLR at 650 gwei.
    function test_pokeGasWithinBudget() public {
        uint256 g0 = gasleft();
        oracle.poke();
        uint256 used = g0 - gasleft();

        emit log_named_uint("     poke gas", used);
        emit log_named_uint("      tickets", oracle.queueTicketsSeen());

        assertLt(used, 28_027_352, "poke must fit in a Flare block");
        assertLt(used, 3_000_000, "poke must stay affordable for a volunteer caller");
    }

    /// The scaling term is unique agents, not tickets: the walk caches each
    /// vault and asks the diamond about it once. 80 tickets resolve to 6 agents
    /// at the pin, so the queue can grow a long way before the cost moves.
    ///
    /// It is not unbounded, though. At ~282k per agent a poke reaching ~97
    /// distinct agents would fill a block, and the default page budget admits
    /// 40 x 100 tickets. setQueueWalkBounds is the existing knob for that;
    /// truncation is flagged, so a bounded walk stays honest rather than silent.
    function test_pokeCostScalesWithAgentsNotTickets() public {
        oracle.poke();

        uint256 tickets = oracle.queueTicketsSeen();
        assertGt(tickets, 0, "queue must be non-empty at the pin");

        // Re-poking touches the same agents again: the cost is stable in ticket
        // count, which is what makes an 80-ticket queue affordable at all.
        uint256 g0 = gasleft();
        oracle.poke();
        uint256 second = g0 - gasleft();

        emit log_named_uint("  2nd poke gas", second);
        emit log_named_uint(" per-ticket gas", second / tickets);

        assertLt(second / tickets, 40_000, "per-ticket cost implies the agent cache is not working");
    }
}
