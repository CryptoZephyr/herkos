// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IFlareContractRegistry, IFtsoV2, IERC20, IPriceOracle, ICToken} from "./interfaces/IHerkosExternal.sol";

/// @title Coston2SpotOracle
/// @notice A small fallback oracle for the public Coston2 test market.
///
/// The XRP price comes from the registry-resolved FTSO feed. Test USDT0 is a
/// faucet token intended to track one dollar, so its testnet price is fixed at
/// one dollar. There is no owner price setter and unknown markets revert.
contract Coston2SpotOracle is IPriceOracle {
    error ZeroAddress();
    error BadDecimals(uint8 decimals);
    error NoPrice(address market);
    error ZeroFeedValue();
    error StaleFeed(uint64 feedTimestamp, uint64 maxAge);
    error BadFeedDecimals(int8 decimals);

    address public immutable registry;
    address public immutable fTestXrp;
    address public immutable testUsdt0;
    bytes21 public immutable xrpUsdFeedId;
    uint8 public immutable fTestXrpDecimals;
    uint8 public immutable testUsdt0Decimals;
    uint64 public immutable maxFeedAge;

    constructor(address _registry, address _fTestXrp, address _testUsdt0, bytes21 _xrpUsdFeedId, uint64 _maxFeedAge) {
        if (_registry == address(0) || _fTestXrp == address(0) || _testUsdt0 == address(0)) {
            revert ZeroAddress();
        }

        uint8 fxrpDecimals = IERC20(_fTestXrp).decimals();
        uint8 usdtDecimals = IERC20(_testUsdt0).decimals();
        if (fxrpDecimals > 18) revert BadDecimals(fxrpDecimals);
        if (usdtDecimals > 18) revert BadDecimals(usdtDecimals);

        registry = _registry;
        fTestXrp = _fTestXrp;
        testUsdt0 = _testUsdt0;
        xrpUsdFeedId = _xrpUsdFeedId;
        fTestXrpDecimals = fxrpDecimals;
        testUsdt0Decimals = usdtDecimals;
        maxFeedAge = _maxFeedAge;
    }

    function isPriceOracle() external pure returns (bool) {
        return true;
    }

    function ftsoV2() public view returns (address) {
        return IFlareContractRegistry(registry).getContractAddressByName("FtsoV2");
    }

    function getUnderlyingPrice(address market) external view returns (uint256) {
        address asset = _underlyingOrSelf(market);
        if (asset == fTestXrp) return _xrpPrice();
        if (asset == testUsdt0) return _oneDollar(testUsdt0Decimals);
        revert NoPrice(market);
    }

    function xrpUsdPrice() external view returns (uint256 value, int8 decimals, uint64 timestamp) {
        (value, decimals, timestamp) = IFtsoV2(ftsoV2()).getFeedById(xrpUsdFeedId);
        _checkFresh(timestamp);
    }

    function _xrpPrice() internal view returns (uint256) {
        (uint256 value, int8 decimals, uint64 timestamp) = IFtsoV2(ftsoV2()).getFeedById(xrpUsdFeedId);
        _checkFresh(timestamp);
        uint256 scaled = _scale(value, decimals, fTestXrpDecimals);
        if (scaled == 0) revert ZeroFeedValue();
        return scaled;
    }

    function _underlyingOrSelf(address market) internal view returns (address asset) {
        asset = market;
        (bool ok, bytes memory data) = market.staticcall(abi.encodeCall(ICToken.underlying, ()));
        if (ok && data.length >= 32) asset = abi.decode(data, (address));
    }

    function _oneDollar(uint8 decimals) internal pure returns (uint256) {
        return 1e6 * (10 ** (30 - decimals));
    }

    function _scale(uint256 value, int8 feedDecimals, uint8 assetDecimals) internal pure returns (uint256) {
        int256 exp = int256(36) - int256(uint256(assetDecimals)) - int256(feedDecimals);
        if (exp > 60 || exp < -18) revert BadFeedDecimals(feedDecimals);
        if (exp >= 0) return value * (10 ** uint256(exp));
        return value / (10 ** uint256(-exp));
    }

    function _checkFresh(uint64 timestamp) internal view {
        if (maxFeedAge != 0 && (timestamp > block.timestamp || block.timestamp - timestamp > maxFeedAge)) {
            revert StaleFeed(timestamp, maxFeedAge);
        }
    }
}
