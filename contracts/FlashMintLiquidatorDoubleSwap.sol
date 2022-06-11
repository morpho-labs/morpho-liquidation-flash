// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

import "./FlashMintLiquidatorBase.sol";

contract FlashMintLiquidatorDoubleSwap is FlashMintLiquidatorBase {
    using SafeTransferLib for ERC20;
    using CompoundMath for uint256;
    using PercentageMath for uint256;

    event SlippageToleranceSet(uint256 newTolerance);

    event Swapped(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint24 fees
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
    }

    function liquidate(
        address _poolTokenBorrowedAddress,
        address _poolTokenCollateralAddress,
        address _borrower,
        uint256 _repayAmount,
        bool _stakeTokens,
        uint24 _firstSwapFees,
        uint24 _secondSwapFees
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

        if (liquidateParams.borrowedUnderlying.balanceOf(address(this)) >= _repayAmount) {
            uint256 seized = _liquidateInternal(liquidateParams);
            if (!_stakeTokens) {
                liquidateParams.collateralUnderlying.safeTransfer(msg.sender, seized);
            }
            return;
        }
        FlashLoanParams memory params = FlashLoanParams(
            address(liquidateParams.collateralUnderlying),
            address(liquidateParams.borrowedUnderlying),
            address(liquidateParams.poolTokenCollateral),
            address(liquidateParams.poolTokenBorrowed),
            liquidateParams.liquidator,
            liquidateParams.borrower,
            liquidateParams.toRepay,
            _firstSwapFees,
            _secondSwapFees
        );

        uint256 seized = _liquidateWithFlashLoan(params);

        if (!_stakeTokens) {
            liquidateParams.collateralUnderlying.safeTransfer(msg.sender, seized);
        }
    }

    /// @dev ERC-3156 Flash loan callback
    function onFlashLoan(
        address initiator,
        address daiLoanedToken,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        if (msg.sender != address(lender)) revert UnknownLender();
        if (initiator != address(this)) revert UnknownInitiator();
        FlashLoanParams memory flashLoanParams = _decodeData(data);

        _flashLoanInternal(flashLoanParams, amount, amount + fee);
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }

    function _flashLoanInternal(
        FlashLoanParams memory _flashLoanParams,
        uint256 _amountIn,
        uint256 _toRepayFlashLoan
    ) internal {
        if (address(dai) != _flashLoanParams.borrowedUnderlying) {
            _flashLoanParams.toLiquidate = _doFirstSwap(
                _flashLoanParams.borrowedUnderlying,
                _amountIn,
                _flashLoanParams.toLiquidate,
                _flashLoanParams.firstSwapFees
            );
        } else {
            _flashLoanParams.toLiquidate = _amountIn < _flashLoanParams.toLiquidate
                ? _amountIn
                : _flashLoanParams.toLiquidate; // resolve rounding errors
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

        if (_flashLoanParams.collateralUnderlying != address(dai)) {
            // tokenIn, seized, amountOut,
            _doSecondSwap(
                _flashLoanParams.collateralUnderlying,
                _flashLoanParams.poolTokenCollateral,
                seized,
                _toRepayFlashLoan,
                _flashLoanParams.secondSwapFees
            );
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

    function _doFirstSwap(
        address _tokenOut,
        uint256 _amountIn,
        uint256 _amountOutMaximum,
        uint24 _fee
    ) internal returns (uint256 amountOut_) {
        // first swap if needed
        dai.safeApprove(address(uniswapV3Router), _amountIn);

        uint256 amountOutMinimumWithSlippage = _amountOutMaximum.percentMul(
            BASIS_POINTS - slippageTolerance
        ); // slippage tolerance
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(dai),
            tokenOut: _tokenOut,
            fee: _fee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: _amountIn,
            amountOutMinimum: amountOutMinimumWithSlippage,
            sqrtPriceLimitX96: 0
        });
        {
            uint256 swapped = uniswapV3Router.exactInputSingle(params);
            if (swapped > _amountOutMaximum) {
                // this is a bonus due to over swapped tokens
                emit OverSwappedDai(swapped - _amountOutMaximum);
                amountOut_ = _amountOutMaximum;
            } else {
                amountOut_ = swapped;
            }
            emit Swapped(address(dai), _tokenOut, _amountIn, swapped, _fee);
        }
    }

    function _doSecondSwap(
        address _tokenIn,
        address _poolTokenIn,
        uint256 _seized,
        uint256 _amountOut,
        uint24 _fee
    ) internal returns (uint256 swappedIn_) {
        uint256 amountInMaximum;
        {
            ICompoundOracle oracle = ICompoundOracle(IComptroller(morpho.comptroller()).oracle());
            amountInMaximum = _amountOut
                .mul(oracle.getUnderlyingPrice(address(cDai)))
                .div(oracle.getUnderlyingPrice(address(_poolTokenIn)))
                .percentMul(BASIS_POINTS + slippageTolerance);

            amountInMaximum = amountInMaximum > _seized ? _seized : amountInMaximum;
        }

        ERC20(_tokenIn).safeApprove(address(uniswapV3Router), amountInMaximum);

        ISwapRouter.ExactOutputSingleParams memory outputParams = ISwapRouter
            .ExactOutputSingleParams({
                tokenIn: _tokenIn,
                tokenOut: address(dai),
                fee: _fee,
                recipient: address(this),
                deadline: block.timestamp,
                amountOut: _amountOut,
                amountInMaximum: amountInMaximum,
                sqrtPriceLimitX96: 0
            });
        uint256 swappedIn_ = uniswapV3Router.exactOutputSingle(outputParams);
        emit Swapped(_tokenIn, address(dai), swappedIn_, _amountOut, _fee);
    }

    function setSlippageTolerance(uint256 _newTolerance) external onlyOwner {
        if (_newTolerance > BASIS_POINTS) revert ValueAboveBasisPoints();
        slippageTolerance = _newTolerance;
        emit SlippageToleranceSet(_newTolerance);
    }
}
