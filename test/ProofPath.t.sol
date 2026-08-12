// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {IXRPPayment, IFdcVerification} from "../src/interfaces/IFdcVerification.sol";
import {ICoreVaultManager} from "../src/interfaces/IHerkosExternal.sol";
import {ExitCapacityOracle} from "../src/ExitCapacityOracle.sol";

/// The trust model. Attested state is one-directional: a submitted proof may
/// only make the number more conservative, never less. That is what makes lying
/// by omission harmless rather than merely unlikely.
///
/// These tests mock FdcVerification.verifyXRPPayment. The real-proof replay
/// against a finalized mainnet Merkle root is a separate exercise (Phase 3, and
/// npm run replay in the research toolkit) -- what is under test here is what
/// Herkos does with a proof once FDC has accepted it, including refusing one.
contract ProofPathTest is ForkBase {
    string internal cvAddress;

    function setUp() public {
        _forkAndDeploy();
        cvAddress = ICoreVaultManager(CORE_VAULT_MANAGER).coreVaultAddress();
        oracle.poke();
    }

    function _proof(bytes32 txId, string memory source, int256 spent, uint8 status)
        internal
        pure
        returns (IXRPPayment.Proof memory p)
    {
        p.data.requestBody.transactionId = txId;
        p.data.responseBody.sourceAddress = source;
        p.data.responseBody.spentAmount = spent;
        p.data.responseBody.status = status;
    }

    function _fdcAccepts(bool ok) internal {
        vm.mockCall(
            FDC_VERIFICATION, abi.encodeWithSelector(IFdcVerification.verifyXRPPayment.selector), abi.encode(ok)
        );
    }

    // ================================================================
    //  The invariant
    // ================================================================

    /// THE test. An outflow the publisher never reports cannot inflate capacity,
    /// because omission leaves the oracle on Flare's own accounting -- exactly
    /// where every consumer stands today. Reporting it can only lower the number.
    function test_omittedOutflowCannotInflateCapacity() public {
        uint128 silent = oracle.exitCapacityUBA();
        uint32 silentHaircut = oracle.haircutPPM();

        _fdcAccepts(true);
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(1)), cvAddress, 500_000 * 1e6, 0));

        uint128 reported = oracle.exitCapacityUBA();

        emit log_named_uint("  silent cap", silent);
        emit log_named_uint("reported cap", reported);
        emit log_named_uint("silent hairc", silentHaircut);
        emit log_named_uint("report hairc", oracle.haircutPPM());

        assertLt(reported, silent, "a reported outflow must lower capacity");
        assertLe(uint256(oracle.haircutPPM()), uint256(silentHaircut), "reporting must not raise the price");
    }

    /// The same property stated from the other side: there is no input, from any
    /// caller, that raises capacity above Flare's own accounting. Proofs only
    /// subtract.
    function test_proofsOnlySubtract() public {
        uint128 flare = oracle.lastFlareCoreVaultUBA();
        assertEq(oracle.coreVaultUBA(), flare, "unproven state is Flare's accounting");

        _fdcAccepts(true);
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(2)), cvAddress, 1_000_000 * 1e6, 0));

        assertLt(oracle.coreVaultUBA(), flare, "a proof must subtract");
        assertLe(oracle.coreVaultUBA(), flare, "a proof may never add");
    }

    /// Proofs accumulate, and the total never turns back upward.
    function test_multipleProofsAccumulateDownward() public {
        _fdcAccepts(true);

        uint128 prev = oracle.coreVaultUBA();
        for (uint256 i = 10; i < 14; i++) {
            oracle.submitCoreVaultOutflow(_proof(bytes32(i), cvAddress, 100_000 * 1e6, 0));
            uint128 now_ = oracle.coreVaultUBA();
            assertLt(now_, prev, "each proof must reduce further");
            prev = now_;
        }

        assertEq(uint256(oracle.pendingProvenOutflowsUBA()), 400_000 * 1e6, "pending must be the sum");
    }

    /// An outflow larger than the vault floors at zero rather than underflowing.
    function test_oversizedOutflowFloorsAtZero() public {
        _fdcAccepts(true);
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(3)), cvAddress, 900_000_000 * 1e6, 0));

        assertEq(uint256(oracle.coreVaultUBA()), 0, "core vault must floor at zero");
        assertGe(uint256(oracle.haircutPPM()), oracle.minHaircutPPM(), "haircut floor must still hold");
    }

    // ================================================================
    //  What gets refused
    // ================================================================

    /// Subject binding. A real proof of a real payment from somebody else's XRPL
    /// account is still not evidence about the Core Vault.
    function test_rejectsWrongSubject() public {
        _fdcAccepts(true);
        vm.expectRevert();
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(4)), "rSomeoneElsesAccount1234567890", 1_000 * 1e6, 0));
    }

    /// The subject is read from the deployed CoreVaultManager at call time, not
    /// stored at construction, so it cannot drift from the live vault.
    function test_subjectIsTheLiveCoreVaultAddress() public {
        assertGt(bytes(cvAddress).length, 0, "core vault address must be readable");

        _fdcAccepts(true);
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(5)), cvAddress, 1_000 * 1e6, 0));
        assertGt(uint256(oracle.pendingProvenOutflowsUBA()), 0, "the live address must be accepted");
    }

    /// Replay. The same transaction cannot be counted twice, or a single real
    /// outflow could be used to drive capacity to zero.
    function test_rejectsReplay() public {
        _fdcAccepts(true);
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(6)), cvAddress, 1_000 * 1e6, 0));

        vm.expectRevert();
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(6)), cvAddress, 1_000 * 1e6, 0));
    }

    /// FDC is the gate. Herkos verifies rather than trusting the relayer.
    function test_rejectsProofFdcDoesNotAccept() public {
        _fdcAccepts(false);
        vm.expectRevert();
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(7)), cvAddress, 1_000 * 1e6, 0));
    }

    /// A failed XRPL payment moved nothing, so it is not an outflow.
    function test_rejectsUnsuccessfulPayment() public {
        _fdcAccepts(true);
        vm.expectRevert();
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(8)), cvAddress, 1_000 * 1e6, 1));
    }

    /// A non-positive or unbounded amount is refused rather than truncated:
    /// wrapping would shrink the reduction, the one unsafe direction.
    function test_rejectsNonPositiveAndUnboundedAmounts() public {
        _fdcAccepts(true);

        vm.expectRevert();
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(9)), cvAddress, 0, 0));

        vm.expectRevert();
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(10)), cvAddress, -1_000, 0));

        vm.expectRevert();
        oracle.submitCoreVaultOutflow(
            _proof(bytes32(uint256(11)), cvAddress, int256(uint256(type(uint128).max)) + 1, 0)
        );
    }

    // ================================================================
    //  Staleness and settlement
    // ================================================================

    /// Anyone may relay. A proof is a proof regardless of who carries it, which
    /// is what keeps the publisher a relayer rather than an authority.
    function test_anyoneMayRelay() public {
        _fdcAccepts(true);
        vm.prank(address(0xCAFE));
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(12)), cvAddress, 1_000 * 1e6, 0));

        assertGt(uint256(oracle.pendingProvenOutflowsUBA()), 0, "an unprivileged relay must land");
    }

    /// An aged attestation is flagged, never cleared. Expiring a proof would
    /// raise capacity, which is the one forbidden direction -- so staleness here
    /// is information for a consumer, not a reset.
    function test_staleAttestationIsFlaggedNotCleared() public {
        _fdcAccepts(true);
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(13)), cvAddress, 250_000 * 1e6, 0));

        uint128 reduced = oracle.coreVaultUBA();
        assertFalse(oracle.isAttestationStale(), "fresh proof must not read stale");

        vm.warp(block.timestamp + oracle.maxAttestationAge() + 1);

        assertTrue(oracle.isAttestationStale(), "an aged proof must be flagged");
        assertEq(oracle.coreVaultUBA(), reduced, "ageing must not restore capacity");
        assertEq(uint256(oracle.pendingProvenOutflowsUBA()), 250_000 * 1e6, "the reduction must persist");
    }

    /// The reduction clears only when Flare's own accounting catches up, which is
    /// the sound reason for it to go away: the outflow is now visible on-chain
    /// and double-counting it would understate capacity.
    function test_reductionClearsWhenFlareAccountingCatchesUp() public {
        _fdcAccepts(true);
        oracle.submitCoreVaultOutflow(_proof(bytes32(uint256(14)), cvAddress, 300_000 * 1e6, 0));
        assertEq(uint256(oracle.pendingProvenOutflowsUBA()), 300_000 * 1e6, "proof must be pending");

        // Flare now reports a vault lower by the same amount.
        uint128 caughtUp = oracle.lastFlareCoreVaultUBA() - 300_000 * 1e6;
        vm.mockCall(
            CORE_VAULT_MANAGER, abi.encodeWithSelector(ICoreVaultManager.availableFunds.selector), abi.encode(caughtUp)
        );
        vm.mockCall(
            CORE_VAULT_MANAGER, abi.encodeWithSelector(ICoreVaultManager.escrowedFunds.selector), abi.encode(uint128(0))
        );
        oracle.poke();

        assertEq(uint256(oracle.pendingProvenOutflowsUBA()), 0, "Flare catching up must absorb the proof");
    }
}
