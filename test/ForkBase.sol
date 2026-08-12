// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "./Test.sol";
import {ExitCapacityOracle} from "../src/ExitCapacityOracle.sol";
import {IPriceOracle, IERC20, ICoreVaultManager} from "../src/interfaces/IHerkosExternal.sol";

/// Shared fork fixture. Every test runs against Flare mainnet state at the
/// block pinned in fork.json — real addresses, real storage, real gas.
abstract contract ForkBase is Test {
    // Pinned in fork.json. A pin that follows the head is not a pin.
    uint256 internal constant FORK_BLOCK = 67_013_823;
    string internal constant RPC = "https://flare-api.flare.network/ext/C/rpc";

    address internal constant REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;
    address internal constant ASSET_MANAGER = 0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8;
    address internal constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address internal constant CORE_VAULT_MANAGER = 0x6c8d96dEfE4cbEE05FA969Fc0Ac436d94Fc21784;
    address internal constant FDC_VERIFICATION = 0x5C14FE9D73Ab763F4d4a76f334bf7029DDD20Ecc;
    address internal constant FTSO_V2 = 0x7BDE3Df0624114eDB3A67dFe6753e62f4e7c1d20;

    // The live Compound fork Herkos would drop into. `oracle()` on the
    // comptroller returns INCUMBENT_ORACLE at the pinned block, and `admin()`
    // returns GOV — both read from chain, not from the docs.
    address internal constant INCUMBENT_ORACLE = 0x61f77Ef0064736Ffa68c31D960E55BAf67F79A4b;
    address internal constant COMPTROLLER = 0x15F69897E6aEBE0463401345543C26d1Fd994abB;
    address internal constant GOV = 0x37C6C7c719DB93085678cE72981CDd96219C9B72;

    // Resolved from COMPTROLLER.getAllMarkets() by matching underlying(), not
    // from a live on-chain market lookup. Three markets are live;
    // isoUSDT0 is the non-FXRP market the fallback-delegation test needs.
    address internal constant CFXRP = 0xD1b7A5eFa9bd88F291F7A4563a8f6185c0249CB3;
    address internal constant CUSDT0 = 0xad7e7989796414c9572da9854DEb1B920724fd09;

    // XRP/USD, the same feed the incumbent reads.
    bytes21 internal constant XRP_USD = bytes21(0x015852502f55534400000000000000000000000000);

    // The DEX venue, resolved by calling token0()/token1() on every contract in
    // fxrp-holders.json rather than from any doc -- no pool address is recorded
    // in the markdown, and the largest FXRP pool is not an exit venue.
    //
    // FXRP/stXRP: the deepest pool at the pin (2.32M FXRP) and correlated. Both
    // sides are XRP, so swapping is a rotation, not an exit.
    address internal constant POOL_STXRP_FXRP = 0x2a91D9296ee2fe4139b49c7071b2f29f59a9f9aE;
    address internal constant STXRP = 0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3;

    // FXRP/USD₮0: the real uncorrelated exit depth. Three pools, 1.685M FXRP
    // between them -- smaller than the correlated pool, which is the point.
    address internal constant POOL_FXRP_USDT0_A = 0x927485d88a66253c63Af9163dca5f21c25A57393;
    address internal constant POOL_FXRP_USDT0_B = 0x686f53F0950Ef193C887527eC027E6A574A4DbE1;
    address internal constant POOL_FXRP_USDT0_C = 0x88D46717b16619B37fa2DfD2F038DEFB4459F1F7;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;

    // Every remote FXRP claim, held on Flare. 12.92M FXRP, 8.68% of supply.
    address internal constant OFT_ADAPTER = 0xd70659a6396285BF7214d7Ea9673184e7C72E07E;

    ExitCapacityOracle internal oracle;

    /// Fork from a local anvil when HERKOS_RPC points at one, otherwise straight
    /// from mainnet. Anvil is the venue the architecture prescribes for anything
    /// that writes, and the public RPC rate-limits a queue walk into failure.
    ///
    /// Either way the pin is asserted rather than assumed: a local anvil booted
    /// at the wrong block would otherwise silently move the ground under every
    /// measured number in the docs.
    function _fork() internal {
        string memory url = vm.envOr("HERKOS_RPC", RPC);
        if (keccak256(bytes(url)) == keccak256(bytes(RPC))) {
            vm.createSelectFork(url, FORK_BLOCK);
        } else {
            // anvil --fork-block-number already holds the pin at its head.
            vm.createSelectFork(url);
        }
        assertEq(block.number, FORK_BLOCK, "fork is not at the pinned block");
    }

    function _deploy() internal {
        oracle = new ExitCapacityOracle(REGISTRY, ASSET_MANAGER, INCUMBENT_ORACLE, XRP_USD, GOV);
        oracle.registerFXRPMarket(CFXRP);
    }

    function _forkAndDeploy() internal {
        _fork();
        _deploy();
    }
}
