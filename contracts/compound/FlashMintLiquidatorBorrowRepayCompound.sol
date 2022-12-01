// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "./FlashMintLiquidatorBase.sol";
import "../common/ILiquidator.sol";

contract FlashMintLiquidatorBorrowRepayCompound is FlashMintLiquidatorBase, ILiquidator {
    using SafeTransferLib for ERC20;
    using CompoundMath for uint256;
    using PercentageMath for uint256;

    event SlippageToleranceSet(uint256 newTolerance);

    event Swapped(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    ISwapRouter public immutable uniswapV3Router;

    constructor(
        IERC3156FlashLender _lender,
        ISwapRouter _uniswapV3Router,
        IMorpho _morpho,
        ICToken _cDai,
        uint256 _slippageTolerance
    ) FlashMintLiquidatorBase(_lender, _morpho, _cDai) {
        uniswapV3Router = _uniswapV3Router;
        slippageTolerance = _slippageTolerance;
        emit SlippageToleranceSet(_slippageTolerance);
        morpho.comptroller().enterMarkets(morpho.getAllMarkets());
    }

    function setSlippageTolerance(uint256 _newTolerance) external onlyOwner {
        if (_newTolerance > BASIS_POINTS) revert ValueAboveBasisPoints();
        slippageTolerance = _newTolerance;
        emit SlippageToleranceSet(_newTolerance);
    }

    function liquidate(
        address _poolTokenBorrowedAddress,
        address _poolTokenCollateralAddress,
        address _borrower,
        uint256 _repayAmount,
        bool _stakeTokens,
        bytes memory _path
    ) external nonReentrant onlyLiquidator {
        LiquidateParams memory liquidateParams = LiquidateParams(
            _getUnderlying(_poolTokenCollateralAddress),
            _getUnderlying(_poolTokenBorrowedAddress),
            ICToken(_poolTokenCollateralAddress),
            ICToken(_poolTokenBorrowedAddress),
            msg.sender,
            _borrower,
            _repayAmount
        );

        uint256 seized;
        if (liquidateParams.borrowedUnderlying.balanceOf(address(this)) >= _repayAmount)
            seized = _liquidateInternal(liquidateParams);
        else {
            FlashLoanParams memory params = FlashLoanParams(
                address(liquidateParams.collateralUnderlying),
                address(liquidateParams.borrowedUnderlying),
                address(liquidateParams.poolTokenCollateral),
                address(liquidateParams.poolTokenBorrowed),
                liquidateParams.liquidator,
                liquidateParams.borrower,
                liquidateParams.toRepay,
                _path
            );
            IComptroller comptroller = morpho.comptroller();
            (, uint256 collateralFactorMantissa, ) = comptroller.markets(address(cDai));
            seized = _liquidateWithFlashLoan(params, collateralFactorMantissa);
        }

        if (!_stakeTokens) liquidateParams.collateralUnderlying.safeTransfer(msg.sender, seized);
    }

    /// @dev ERC-3156 Flash loan callback
    function onFlashLoan(
        address _initiator,
        address ,
        uint256 _amount,
        uint256 ,
        bytes calldata data
    ) external override returns (bytes32) {
        if (msg.sender != address(lender)) revert UnknownLender();
        if (_initiator != address(this)) revert UnknownInitiator();
        FlashLoanParams memory flashLoanParams = _decodeData(data);

        _flashLoanInternal(flashLoanParams, _amount);
        return FLASHLOAN_CALLBACK;
    }

    function _flashLoanInternal(
        FlashLoanParams memory _flashLoanParams,
        uint256 _amountIn
    ) internal {
        if (_flashLoanParams.borrowedUnderlying != address(dai)) {
            dai.safeApprove(address(cDai), _amountIn);

            require(cDai.mint(_amountIn) == 0, "FlashLoan: supply on Compound failed");
            uint256 err = ICToken(_flashLoanParams.poolTokenBorrowed).borrow(
                _flashLoanParams.toLiquidate
            );
            require(err == 0, "FlashLoan: borrow on Compound failed");
            if (_flashLoanParams.borrowedUnderlying == address(wEth)) {
                wEth.deposit{value: _flashLoanParams.toLiquidate}();
            }
        }

        LiquidateParams memory liquidateParams = LiquidateParams(
            ERC20(_flashLoanParams.collateralUnderlying),
            ERC20(_flashLoanParams.borrowedUnderlying),
            ICToken(_flashLoanParams.poolTokenCollateral),
            ICToken(_flashLoanParams.poolTokenBorrowed),
            _flashLoanParams.liquidator,
            _flashLoanParams.borrower,
            _flashLoanParams.toLiquidate
        );
        uint256 seized = _liquidateInternal(liquidateParams);

        if (_flashLoanParams.borrowedUnderlying != _flashLoanParams.collateralUnderlying) {
            // need a swap
            ICompoundOracle oracle = ICompoundOracle(IComptroller(morpho.comptroller()).oracle());

            uint256 maxIn = ((_flashLoanParams.toLiquidate *
                oracle.getUnderlyingPrice(_flashLoanParams.poolTokenBorrowed)) * 10) ^
                (ERC20(_flashLoanParams.collateralUnderlying).decimals() /
                    oracle.getUnderlyingPrice(_flashLoanParams.poolTokenCollateral) /
                    10) ^
                ((ERC20(_flashLoanParams.borrowedUnderlying).decimals() *
                    (BASIS_POINTS + slippageTolerance)) / BASIS_POINTS);
            ERC20(_flashLoanParams.collateralUnderlying).safeApprove(
                address(uniswapV3Router),
                maxIn
            );
            _doSecondSwap(
                _flashLoanParams.path,
                _flashLoanParams.toLiquidate,
                maxIn
            );
        }
        if (_flashLoanParams.borrowedUnderlying != address(dai)) {
            if (_flashLoanParams.borrowedUnderlying == address(wEth)) {
                wEth.withdraw(_flashLoanParams.toLiquidate);
                ICEth(address(cEth)).repayBorrow{value: _flashLoanParams.toLiquidate}();
            } else {
                ERC20(_flashLoanParams.borrowedUnderlying).safeApprove(
                    _flashLoanParams.poolTokenBorrowed,
                    _flashLoanParams.toLiquidate
                );
                ICToken(_flashLoanParams.poolTokenBorrowed).repayBorrow(
                    _flashLoanParams.toLiquidate
                );
            }
            // To repay flash loan
            cDai.redeemUnderlying(_amountIn);
        }
        emit Liquidated(
            _flashLoanParams.liquidator,
            _flashLoanParams.borrower,
            _flashLoanParams.poolTokenBorrowed,
            _flashLoanParams.poolTokenCollateral,
            _flashLoanParams.toLiquidate,
            seized,
            true
        );
    }

    function _doSecondSwap(
        bytes memory _path,
        uint256 _amount,
        uint256 _maxIn
    ) internal returns (uint256 amountIn) {
        amountIn = uniswapV3Router.exactOutput(
            ISwapRouter.ExactOutputParams(_path, address(this), block.timestamp, _amount, _maxIn)
        );
    }

    /// @dev Allows to receive ETH.
    receive() external payable {}

    function enterMarkets(address[] calldata markets) external onlyOwner {
        morpho.comptroller().enterMarkets(markets);
    }
}
