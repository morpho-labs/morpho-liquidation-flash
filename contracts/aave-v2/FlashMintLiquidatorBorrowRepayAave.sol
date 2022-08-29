// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "./FlashMintLiquidatorBaseAave.sol";

contract FlashMintLiquidatorBorrowRepayAave is FlashMintLiquidatorBaseAave {
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
        ILendingPoolAddressesProvider _addressesProvider,
        IMorpho _morpho,
        IAToken _aDai,
        uint256 _slippageTolerance
    ) FlashMintLiquidatorBaseAave(_lender, _morpho, _addressesProvider, _aDai) {
        uniswapV3Router = _uniswapV3Router;
        slippageTolerance = _slippageTolerance;
        emit SlippageToleranceSet(_slippageTolerance);
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
            IAToken(_poolTokenCollateralAddress),
            IAToken(_poolTokenBorrowedAddress),
            msg.sender,
            _borrower,
            _repayAmount
        );

        uint256 seized;
        if (liquidateParams.borrowedUnderlying.balanceOf(address(this)) >= _repayAmount)
            // we can liquidate without flash loan by using the contract balance
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
            seized = _liquidateWithFlashLoan(params);
        }

        if (!_stakeTokens) liquidateParams.collateralUnderlying.safeTransfer(msg.sender, seized);
    }

    /// @dev ERC-3156 Flash loan callback
    function onFlashLoan(
        address _initiator,
        address _daiLoanedToken,
        uint256 _amount,
        uint256 _fee,
        bytes calldata data
    ) external override returns (bytes32) {
        if (msg.sender != address(lender)) revert UnknownLender();
        if (_initiator != address(this)) revert UnknownInitiator();
        FlashLoanParams memory flashLoanParams = _decodeData(data);

        _flashLoanInternal(flashLoanParams, _amount);
        return FLASHLOAN_CALLBACK;
    }

    function _flashLoanInternal(FlashLoanParams memory _flashLoanParams, uint256 _amountIn)
        internal
    {
        if (_flashLoanParams.borrowedUnderlying != address(dai)) {
            dai.safeApprove(address(lendingPool), _amountIn);
            lendingPool.deposit(address(dai), _amountIn, address(this), 0);
            lendingPool.borrow(
                _flashLoanParams.borrowedUnderlying,
                _flashLoanParams.toLiquidate,
                2,
                0,
                address(this)
            );
        }

        LiquidateParams memory liquidateParams = LiquidateParams(
            ERC20(_flashLoanParams.collateralUnderlying),
            ERC20(_flashLoanParams.borrowedUnderlying),
            IAToken(_flashLoanParams.poolTokenCollateral),
            IAToken(_flashLoanParams.poolTokenBorrowed),
            _flashLoanParams.liquidator,
            _flashLoanParams.borrower,
            _flashLoanParams.toLiquidate
        );
        uint256 seized = _liquidateInternal(liquidateParams);

        if (_flashLoanParams.borrowedUnderlying != _flashLoanParams.collateralUnderlying) {
            // need a swap
            // we use aave oracle
            IPriceOracleGetter oracle = IPriceOracleGetter(addressesProvider.getPriceOracle());
            uint256 maxIn = (((_flashLoanParams.toLiquidate *
                10**liquidateParams.collateralUnderlying.decimals() *
                oracle.getAssetPrice(_flashLoanParams.borrowedUnderlying)) /
                oracle.getAssetPrice(_flashLoanParams.collateralUnderlying) /
                10**liquidateParams.borrowedUnderlying.decimals()) *
                (BASIS_POINTS + slippageTolerance)) / BASIS_POINTS;

            ERC20(_flashLoanParams.collateralUnderlying).safeApprove(
                address(uniswapV3Router),
                maxIn
            );

            uint256 amountIn = _doSecondSwap(
                _flashLoanParams.path,
                _flashLoanParams.toLiquidate,
                maxIn
            );
        }
        if (_flashLoanParams.borrowedUnderlying != address(dai)) {
            ERC20(_flashLoanParams.borrowedUnderlying).safeApprove(
                address(lendingPool),
                _flashLoanParams.toLiquidate
            );
            lendingPool.repay(
                _flashLoanParams.borrowedUnderlying,
                _flashLoanParams.toLiquidate,
                2,
                address(this)
            );
            // To repay flash loan
            lendingPool.withdraw(address(dai), _amountIn, address(this));
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
}
