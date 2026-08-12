// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceOracle} from "./interfaces/IHerkosExternal.sol";

interface IERC20Coston2 {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IExitCapacityOracleCoston2 is IPriceOracle {
    function isPokeStale() external view returns (bool);
}

/// @title Coston2LendingMarket
/// @notice A small, no-interest lending market for the Herkos Coston2 demo.
///
/// FTestXRP is collateral and faucet USDT0 is the debt asset. The market holds
/// real testnet tokens and uses Herkos for every risk-increasing price read.
/// It has no owner withdrawal, upgrade path, or production claim.
contract Coston2LendingMarket {
    error ZeroAddress();
    error BadDecimals();
    error AmountZero();
    error AmountTooLarge();
    error InsufficientLiquidity(uint256 available, uint256 requested);
    error InsufficientLiquiditySupply(uint256 available, uint256 requested);
    error BorrowLimitExceeded(uint256 limit, uint256 requestedDebt);
    error CollateralLimitExceeded(uint256 limit, uint256 requestedDebt);
    error HealthyPosition();
    error NoDebt();
    error RepayExceedsDebt(uint256 debt, uint256 requested);
    error OracleStale();
    error OracleUnavailable();
    error OracleNotReady();
    error TokenCallFailed();
    error ReentrantCall();

    uint256 public constant PRICE_SCALE = 1e30;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_LTV_BPS = 7_000;
    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 7_500;
    uint256 public constant LIQUIDATION_BONUS_BPS = 500;

    IERC20Coston2 public immutable collateralToken;
    IERC20Coston2 public immutable debtToken;
    IExitCapacityOracleCoston2 public immutable oracle;

    struct Position {
        uint128 collateral;
        uint128 debt;
    }

    mapping(address => Position) public positions;
    mapping(address => uint256) public suppliedLiquidity;
    uint256 public totalLiquidity;
    uint256 public totalDebt;
    uint256 public lastOraclePrice;
    uint64 public lastOracleAt;
    uint64 public lastOracleBlock;
    uint256 private _lock = 1;

    event LiquiditySupplied(address indexed supplier, uint256 amount);
    event LiquidityWithdrawn(address indexed supplier, uint256 amount);
    event CollateralDeposited(address indexed borrower, uint256 amount);
    event CollateralWithdrawn(address indexed borrower, uint256 amount);
    event Borrowed(address indexed borrower, uint256 amount);
    event Repaid(address indexed borrower, address indexed payer, uint256 amount);
    event Liquidated(address indexed borrower, address indexed liquidator, uint256 repaid, uint256 seized);
    event OraclePriceRefreshed(uint256 price, uint64 atBlock, uint64 atTimestamp);

    constructor(address _collateralToken, address _debtToken, address _oracle) {
        if (_collateralToken == address(0) || _debtToken == address(0) || _oracle == address(0)) {
            revert ZeroAddress();
        }
        if (IERC20Coston2(_collateralToken).decimals() != 6) revert BadDecimals();
        if (IERC20Coston2(_debtToken).decimals() != 6) revert BadDecimals();
        collateralToken = IERC20Coston2(_collateralToken);
        debtToken = IERC20Coston2(_debtToken);
        oracle = IExitCapacityOracleCoston2(_oracle);
    }

    function underlying() external view returns (address) {
        return address(collateralToken);
    }

    function debtAsset() external view returns (address) {
        return address(debtToken);
    }

    function availableLiquidity() public view returns (uint256) {
        return totalLiquidity > totalDebt ? totalLiquidity - totalDebt : 0;
    }

    function position(address account) external view returns (uint256 collateral, uint256 debt) {
        Position memory p = positions[account];
        return (p.collateral, p.debt);
    }

    function collateralValue(address account) public view returns (uint256) {
        Position memory p = positions[account];
        return _value(p.collateral, lastOraclePrice);
    }

    function borrowingLimit(address account) public view returns (uint256) {
        return collateralValue(account) * MAX_LTV_BPS / BPS;
    }

    function liquidationLimit(address account) public view returns (uint256) {
        return collateralValue(account) * LIQUIDATION_THRESHOLD_BPS / BPS;
    }

    function healthFactorBps(address account) public view returns (uint256) {
        uint256 debt = positions[account].debt;
        if (debt == 0) return type(uint256).max;
        return collateralValue(account) * BPS / debt;
    }

    function oracleFresh() external view returns (bool) {
        try oracle.isPokeStale() returns (bool stale) {
            return !stale && lastOraclePrice != 0;
        } catch {
            return false;
        }
    }

    function supplyLiquidity(uint256 amount) external nonReentrant {
        _requireAmount(amount);
        _safeTransferFrom(address(debtToken), msg.sender, address(this), amount);
        suppliedLiquidity[msg.sender] += amount;
        totalLiquidity += amount;
        emit LiquiditySupplied(msg.sender, amount);
    }

    function withdrawLiquidity(uint256 amount) external nonReentrant {
        _requireAmount(amount);
        uint256 supplied = suppliedLiquidity[msg.sender];
        if (supplied < amount) revert InsufficientLiquiditySupply(supplied, amount);
        uint256 available = availableLiquidity();
        if (available < amount) revert InsufficientLiquidity(available, amount);
        suppliedLiquidity[msg.sender] = supplied - amount;
        totalLiquidity -= amount;
        _safeTransfer(address(debtToken), msg.sender, amount);
        emit LiquidityWithdrawn(msg.sender, amount);
    }

    function depositCollateral(uint256 amount) external nonReentrant {
        _requireAmount(amount);
        if (amount > type(uint128).max) revert AmountTooLarge();
        _safeTransferFrom(address(collateralToken), msg.sender, address(this), amount);
        uint256 updated = uint256(positions[msg.sender].collateral) + amount;
        if (updated > type(uint128).max) revert AmountTooLarge();
        positions[msg.sender].collateral = uint128(updated);
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external nonReentrant {
        _requireAmount(amount);
        uint256 price = _freshPrice();
        Position memory p = positions[msg.sender];
        if (p.collateral < amount) revert CollateralLimitExceeded(p.collateral, amount);
        uint256 remaining = p.collateral - amount;
        uint256 limit = _value(remaining, price) * MAX_LTV_BPS / BPS;
        if (p.debt > limit) revert CollateralLimitExceeded(limit, p.debt);
        positions[msg.sender].collateral = uint128(remaining);
        _safeTransfer(address(collateralToken), msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external nonReentrant {
        _requireAmount(amount);
        uint256 price = _freshPrice();
        Position memory p = positions[msg.sender];
        uint256 requestedDebt = uint256(p.debt) + amount;
        if (requestedDebt > type(uint128).max) revert AmountTooLarge();
        uint256 limit = _value(p.collateral, price) * MAX_LTV_BPS / BPS;
        if (requestedDebt > limit) revert BorrowLimitExceeded(limit, requestedDebt);
        uint256 available = availableLiquidity();
        if (available < amount) revert InsufficientLiquidity(available, amount);
        positions[msg.sender].debt = uint128(requestedDebt);
        totalDebt += amount;
        _safeTransfer(address(debtToken), msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external nonReentrant {
        _requireAmount(amount);
        uint256 debt = positions[msg.sender].debt;
        if (debt == 0) revert NoDebt();
        uint256 actual = amount > debt ? debt : amount;
        _safeTransferFrom(address(debtToken), msg.sender, address(this), actual);
        positions[msg.sender].debt = uint128(debt - actual);
        totalDebt -= actual;
        emit Repaid(msg.sender, msg.sender, actual);
    }

    function liquidate(address borrower, uint256 repayAmount) external nonReentrant {
        _requireAmount(repayAmount);
        Position memory p = positions[borrower];
        if (p.debt == 0) revert NoDebt();
        uint256 price = _freshPrice();
        uint256 limit = _value(p.collateral, price) * LIQUIDATION_THRESHOLD_BPS / BPS;
        if (p.debt <= limit) revert HealthyPosition();
        if (repayAmount > p.debt) revert RepayExceedsDebt(p.debt, repayAmount);

        uint256 seize = _ceilDiv(repayAmount * (BPS + LIQUIDATION_BONUS_BPS) * PRICE_SCALE, price * BPS);
        if (seize > p.collateral) seize = p.collateral;
        _safeTransferFrom(address(debtToken), msg.sender, address(this), repayAmount);
        positions[borrower].debt = uint128(uint256(p.debt) - repayAmount);
        positions[borrower].collateral = uint128(uint256(p.collateral) - seize);
        totalDebt -= repayAmount;
        _safeTransfer(address(collateralToken), msg.sender, seize);
        emit Liquidated(borrower, msg.sender, repayAmount, seize);
    }

    function refreshOraclePrice() external nonReentrant returns (uint256 price) {
        return _freshPrice();
    }

    function _freshPrice() internal returns (uint256 price) {
        bool stale;
        try oracle.isPokeStale() returns (bool value) {
            stale = value;
        } catch {
            revert OracleUnavailable();
        }
        if (stale) revert OracleStale();
        try oracle.getUnderlyingPrice(address(this)) returns (uint256 value) {
            price = value;
        } catch {
            revert OracleUnavailable();
        }
        if (price == 0) revert OracleUnavailable();
        lastOraclePrice = price;
        lastOracleAt = uint64(block.timestamp);
        lastOracleBlock = uint64(block.number);
        emit OraclePriceRefreshed(price, lastOracleBlock, lastOracleAt);
    }

    function _value(uint256 amount, uint256 price) internal pure returns (uint256) {
        return amount * price / PRICE_SCALE;
    }

    function _requireAmount(uint256 amount) internal pure {
        if (amount == 0) revert AmountZero();
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Coston2.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Coston2.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    modifier nonReentrant() {
        if (_lock != 1) revert ReentrantCall();
        _lock = 2;
        _;
        _lock = 1;
    }
}
