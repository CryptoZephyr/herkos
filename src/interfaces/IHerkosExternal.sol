// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Every shape here was taken from a deployed contract on Flare mainnet, not
/// from documentation. See Memory1.md: the docs have been wrong five times and
/// the explorer is not the deployed contract either.

/// FlareContractsRegistry 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019
interface IFlareContractRegistry {
    function getContractAddressByName(string calldata _name) external view returns (address);
}

/// FtsoV2 0x7bde3df0624114edb3a67dfe6753e62f4e7c1d20.
/// Verified live: getFeedById(0x015852502f55534400...) -> (1039350, 6, 1786285014)
interface IFtsoV2 {
    function getFeedById(bytes21 _feedId)
        external
        view
        returns (uint256 _value, int8 _decimals, uint64 _timestamp);
}

/// AssetManager FXRP 0x2a3fe068cd92178554cabcf7c95adf49b4b0b6a8 — an EIP-2535
/// diamond. Selectors confirmed against the on-chain loupe, not the explorer
/// shell ABI (which carries zero functions).
interface IAssetManager {
    struct RedemptionTicketInfo {
        uint256 redemptionTicketId;
        address agentVault;
        uint256 ticketValueUBA;
    }

    function redemptionQueue(uint256 _firstRedemptionTicketId, uint256 _pageSize)
        external
        view
        returns (RedemptionTicketInfo[] memory _queue, uint256 _nextRedemptionTicketId);

    function fAsset() external view returns (address);

    function getCoreVaultManager() external view returns (address);

    function lotSize() external view returns (uint256 _lotSizeUBA);
}

/// CoreVaultManager 0x6c8d96defe4cbee05fa969fc0ac436d94fc21784.
/// coreVaultAddress() returns the XRPL account as a *string*, which is what
/// lets FDC subject binding compare against XRPPayment.sourceAddress directly
/// with no hash convention to guess.
interface ICoreVaultManager {
    function availableFunds() external view returns (uint128);

    function escrowedFunds() external view returns (uint128);

    function coreVaultAddress() external view returns (string memory);
}

/// AssetManagerController 0x097b93eebe9b76f2611e1e7d9665a9d7ff5280b3, resolved
/// from the registry. Used to prove the AssetManager handed to the constructor
/// is genuinely registered rather than taken on faith.
interface IAssetManagerController {
    function getAssetManagers() external view returns (address[] memory);
}

interface IERC20 {
    function balanceOf(address _owner) external view returns (uint256);

    function decimals() external view returns (uint8);

    function totalSupply() external view returns (uint256);
}

/// The interface a Compound-fork comptroller consumes. Replacing the incumbent
/// is one governance call, `comptroller._setPriceOracle(herkos)`, and that call
/// requires isPriceOracle() == true.
interface IPriceOracle {
    function isPriceOracle() external view returns (bool);

    function getUnderlyingPrice(address cToken) external view returns (uint256);
}

interface ICToken {
    function underlying() external view returns (address);
}
