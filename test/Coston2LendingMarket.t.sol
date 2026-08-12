// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "./Test.sol";
import {Coston2LendingMarket} from "../src/Coston2LendingMarket.sol";
import {Coston2SpotOracle} from "../src/Coston2SpotOracle.sol";

contract MockToken {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 _decimals) {
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[from][msg.sender];
        require(permitted >= amount, "allowance");
        allowance[from][msg.sender] = permitted - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract MockOracle {
    uint256 public price;
    bool public stale;

    constructor(uint256 _price) {
        price = _price;
    }

    function isPriceOracle() external pure returns (bool) {
        return true;
    }

    function isPokeStale() external view returns (bool) {
        return stale;
    }

    function getUnderlyingPrice(address) external view returns (uint256) {
        require(!stale, "stale");
        return price;
    }

    function setPrice(uint256 _price) external {
        price = _price;
    }

    function setStale(bool _stale) external {
        stale = _stale;
    }
}

contract MockRegistry {
    address public ftso;

    constructor(address _ftso) {
        ftso = _ftso;
    }

    function getContractAddressByName(string calldata) external view returns (address) {
        return ftso;
    }
}

contract MockFtso {
    uint256 public value;
    int8 public feedDecimals;
    uint64 public timestamp;

    constructor(uint256 _value, int8 _decimals) {
        value = _value;
        feedDecimals = _decimals;
        timestamp = uint64(block.timestamp);
    }

    function getFeedById(bytes21) external view returns (uint256, int8, uint64) {
        return (value, feedDecimals, timestamp);
    }
}

contract Coston2LendingMarketTest is Test {
    address internal constant LP = address(0x1001);
    address internal constant ALICE = address(0x1002);
    address internal constant BOB = address(0x1003);

    MockToken internal collateral;
    MockToken internal debt;
    MockOracle internal oracle;
    Coston2LendingMarket internal market;

    function setUp() public {
        collateral = new MockToken(6);
        debt = new MockToken(6);
        oracle = new MockOracle(1e30);
        market = new Coston2LendingMarket(address(collateral), address(debt), address(oracle));

        collateral.mint(ALICE, 10e6);
        debt.mint(LP, 1_000e6);
        debt.mint(BOB, 100e6);

        vm.startPrank(LP);
        debt.approve(address(market), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(ALICE);
        collateral.approve(address(market), type(uint256).max);
        debt.approve(address(market), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(BOB);
        debt.approve(address(market), type(uint256).max);
        vm.stopPrank();
    }

    function testSupplyDepositBorrowAndRepay() public {
        vm.prank(LP);
        market.supplyLiquidity(1_000e6);
        market.refreshOraclePrice();

        vm.startPrank(ALICE);
        market.depositCollateral(10e6);
        market.borrow(7e6);
        assertEq(debt.balanceOf(ALICE), 7e6, "borrowed amount transferred");
        market.repay(2e6);
        vm.stopPrank();

        (, uint256 debtOwed) = market.position(ALICE);
        assertEq(debtOwed, 5e6, "repayment reduces debt");
        assertEq(market.availableLiquidity(), 995e6, "available liquidity tracks debt");
    }

    function testBorrowCannotExceedLtv() public {
        vm.prank(LP);
        market.supplyLiquidity(1_000e6);
        vm.prank(ALICE);
        market.depositCollateral(10e6);
        market.refreshOraclePrice();

        vm.prank(ALICE);
        vm.expectRevert();
        market.borrow(7_000_001);
    }

    function testRiskIncreasingActionsRequireFreshOracle() public {
        vm.prank(LP);
        market.supplyLiquidity(1_000e6);
        vm.prank(ALICE);
        market.depositCollateral(10e6);
        oracle.setStale(true);

        vm.prank(ALICE);
        vm.expectRevert(Coston2LendingMarket.OracleStale.selector);
        market.borrow(1e6);
    }

    function testLiquidationRefreshesPriceAndSeizesCollateral() public {
        vm.prank(LP);
        market.supplyLiquidity(1_000e6);
        vm.startPrank(ALICE);
        market.depositCollateral(10e6);
        market.borrow(7e6);
        vm.stopPrank();

        oracle.setPrice(8e29);
        vm.prank(BOB);
        market.liquidate(ALICE, 1e6);

        (, uint256 debtOwed) = market.position(ALICE);
        (uint256 collateralLeft,) = market.position(ALICE);
        assertEq(debtOwed, 6e6, "liquidation reduces debt");
        assertLt(collateralLeft, 10e6, "liquidation seizes collateral");
        assertGt(collateral.balanceOf(BOB), 0, "liquidator receives collateral");
    }

    function testSpotOracleScalesFtsoAndSupportsMarketUnderlying() public {
        MockFtso ftso = new MockFtso(1_250_000, 6);
        MockRegistry registry = new MockRegistry(address(ftso));
        Coston2SpotOracle spot = new Coston2SpotOracle(
            address(registry),
            address(collateral),
            address(debt),
            bytes21(0x015852502f55534400000000000000000000000000),
            1 days
        );
        uint256 price = spot.getUnderlyingPrice(address(collateral));
        assertEq(price, 1_250_000 * 1e24, "six-decimal feed scales to 1e30");
        assertEq(spot.getUnderlyingPrice(address(debt)), 1e30, "USDT0 uses one dollar");
    }
}
