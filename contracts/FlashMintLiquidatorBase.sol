// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

import "./interface/IERC3156FlashLender.sol";
import "./interface/IERC3156FlashBorrower.sol";
import "@morphodao/morpho-core-v1/contracts/compound/interfaces/IMorpho.sol";
import "@morphodao/morpho-core-v1/contracts/compound/interfaces/compound/ICompound.sol";

import "@morphodao/morpho-core-v1/contracts/compound/libraries/CompoundMath.sol";
import "./libraries/PercentageMath.sol";

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./SharedLiquidator.sol";

abstract contract FlashMintLiquidatorBase is
    ReentrancyGuard,
    SharedLiquidator,
    IERC3156FlashBorrower
{
    using SafeTransferLib for ERC20;
    using CompoundMath for uint256;
    using PercentageMath for uint256;

    struct FlashLoanParams {
        address collateralUnderlying;
        address borrowedUnderlying;
        address poolTokenCollateral;
        address poolTokenBorrowed;
        address liquidator;
        address borrower;
        uint256 toLiquidate;
        uint24 firstSwapFees;
        uint24 secondSwapFees;
    }

    struct LiquidateParams {
        ERC20 collateralUnderlying;
        ERC20 borrowedUnderlying;
        ICToken poolTokenCollateral;
        ICToken poolTokenBorrowed;
        address liquidator;
        address borrower;
        uint256 toRepay;
    }

    error ValueAboveBasisPoints();

    error UnknownLender();

    error UnknownInitiator();

    event Liquidated(
        address indexed liquidator,
        address borrower,
        address indexed poolTokenBorrowedAddress,
        address indexed poolTokenCollateralAddress,
        uint256 amount,
        uint256 seized,
        bool usingFlashLoan
    );

    event FlashLoan(address indexed initiator, uint256 amount);

    event OverSwappedDai(uint256 amount);

    uint256 public constant BASIS_POINTS = 10_000;
    bytes32 public constant FLASHLOAN_CALLBACK = keccak256("ERC3156FlashBorrower.onFlashLoan");
    uint256 public slippageTolerance; // in BASIS_POINTS units

    IERC3156FlashLender public immutable lender;
    IMorpho public immutable morpho;
    ICToken public immutable cDai;
    ERC20 public immutable dai;
    ICToken public immutable cEth;
    ERC20 public immutable wEth;

    constructor(
        IERC3156FlashLender _lender,
        IMorpho _morpho,
        ICToken _cDai
    ) SharedLiquidator() {
        lender = _lender;
        morpho = _morpho;
        cDai = _cDai;
        dai = ERC20(_cDai.underlying());
        cEth = ICToken(morpho.cEth());
        wEth = ERC20(morpho.wEth());
    }

    function _liquidateInternal(LiquidateParams memory _liquidateParams)
        internal
        returns (uint256 seized_)
    {
        uint256 balanceBefore = _liquidateParams.collateralUnderlying.balanceOf(address(this));
        _liquidateParams.borrowedUnderlying.safeApprove(address(morpho), _liquidateParams.toRepay);
        morpho.liquidate(
            address(_liquidateParams.poolTokenBorrowed),
            address(_liquidateParams.poolTokenCollateral),
            _liquidateParams.borrower,
            _liquidateParams.toRepay
        );
        seized_ = _liquidateParams.collateralUnderlying.balanceOf(address(this)) - balanceBefore;
        emit Liquidated(
            msg.sender,
            _liquidateParams.borrower,
            address(_liquidateParams.poolTokenBorrowed),
            address(_liquidateParams.poolTokenCollateral),
            _liquidateParams.toRepay,
            seized_,
            false
        );
    }

    function _liquidateWithFlashLoan(FlashLoanParams memory _flashLoanParams)
        internal
        returns (uint256 seized_)
    {
        bytes memory data = _encodeData(_flashLoanParams);

        uint256 daiToFlashLoan = _getDaiToFlashloan(
            address(_flashLoanParams.poolTokenBorrowed),
            _flashLoanParams.toLiquidate
        );

        dai.safeApprove(address(lender), daiToFlashLoan + lender.flashFee(address(dai), daiToFlashLoan));

        uint256 balanceBefore = ERC20(_flashLoanParams.collateralUnderlying).balanceOf(
            address(this)
        );

        lender.flashLoan(this, address(dai), daiToFlashLoan, data);

        seized_ =
            ERC20(_flashLoanParams.collateralUnderlying).balanceOf(address(this)) -
            balanceBefore;

        emit FlashLoan(msg.sender, daiToFlashLoan);
    }

    function _getDaiToFlashloan(address _poolTokenToRepay, uint256 _amountToRepay)
        internal
        view
        returns (uint256 amountToFlashLoan_)
    {
        ICompoundOracle oracle = ICompoundOracle(IComptroller(morpho.comptroller()).oracle());
        uint256 daiPrice = oracle.getUnderlyingPrice(address(cDai));
        uint256 borrowedTokenPrice = oracle.getUnderlyingPrice(_poolTokenToRepay);
        amountToFlashLoan_ = _amountToRepay.mul(borrowedTokenPrice).div(daiPrice);
    }

    function _encodeData(FlashLoanParams memory _flashLoanParams)
        internal
        pure
        returns (bytes memory data)
    {
        data = abi.encode(
            _flashLoanParams.collateralUnderlying,
            _flashLoanParams.borrowedUnderlying,
            _flashLoanParams.poolTokenCollateral,
            _flashLoanParams.poolTokenBorrowed,
            _flashLoanParams.liquidator,
            _flashLoanParams.borrower,
            _flashLoanParams.toLiquidate,
            _flashLoanParams.firstSwapFees,
            _flashLoanParams.secondSwapFees
        );
    }

    function _decodeData(bytes calldata data)
        internal
        pure
        returns (FlashLoanParams memory _flashLoanParams)
    {
        _flashLoanParams = abi.decode(data, (FlashLoanParams));
    }

    function _getUnderlying(address _poolToken) internal view returns (ERC20 underlying_) {
        underlying_ = _poolToken == address(cEth) ? wEth : ERC20(ICToken(_poolToken).underlying());
    }
}
