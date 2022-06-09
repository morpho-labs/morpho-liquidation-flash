// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "./interface/IERC3156FlashLender.sol";
import "./interface/IERC3156FlashBorrower.sol";
import "@morphodao/morpho-core-v1/contracts/compound/interfaces/IMorpho.sol";
import "@morphodao/morpho-core-v1/contracts/compound/interfaces/compound/ICompound.sol";

import "@rari-capital/solmate/src/utils/SafeTransferLib.sol";
import "@morphodao/morpho-core-v1/contracts/compound/libraries/CompoundMath.sol";
import "@morphodao/morpho-core-v1/contracts/compound/libraries/CompoundMath.sol";
import "./libraries/PercentageMath.sol";

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract FlashMintLiquidator is IERC3156FlashBorrower, Ownable, ReentrancyGuard {
    using SafeTransferLib for ERC20;
    using CompoundMath for uint256;
    using PercentageMath for uint256;

    struct FlashLoanParams {
        address poolTokenBorrowedAddress;
        address poolTokenCollateralAddress;
        address underlyingTokenBorrowedAddress;
        address underlyingTokenCollateralAddress;
        address borrower;
        uint256 repayAmount;
        uint256 seized;
        uint256 flashLoaned;
        uint256 repayFlashloans;
        uint24 firstSwapFees;
        uint24 secondSwapFees;
    }

    struct LiquidateParams {
        ERC20 collateralUnderlying;
        ERC20 borrowedUnderlying;
        ICToken poolTokenCollateral;
        ICToken poolTokenBorrowed;
        address borrower;
        uint256 toRepay;
        uint256 collateralBalanceBefore;
        uint256 borrowedTokenBalanceBefore;
        uint256 amountSeized;
    }

    error ValueAboveBasisPoints();

    error UnknownLender();

    error UnknownInitiator();

    error OnlyLiquidator();

    /// EVENTS ///

    event Liquidated(
        address indexed liquidator,
        address borrower,
        address indexed poolTokenBorrowedAddress,
        address indexed poolTokenCollateralAddress,
        uint256 amount,
        uint256 seized,
        bool usingFlashLoans
    );

    event FlashLoan(address indexed _initiator, uint256 amount);

    event LiquidatorAdded(address indexed _liquidatorAdded);

    event LiquidatorRemoved(address indexed _liquidatorRemoved);

    event Withdrawn(
        address indexed sender,
        address indexed receiver,
        address indexed underlyingAddress,
        uint256 amount
    );

    event OverSwappedDai(uint256 amount);

    event Swapped(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint24 fees
    );

    event SlippageToleranceSet(uint256 newTolerance);

    modifier onlyLiquidator() {
        if (!isLiquidator[msg.sender]) revert OnlyLiquidator();
        _;
    }

    uint256 public constant BASIS_POINTS = 10000;
    uint256 public slippageTolerance; // in BASIS_POINTS units

    IERC3156FlashLender public immutable lender;
    IMorpho public immutable morpho;
    ISwapRouter public immutable uniswapV3Router;
    ICToken public immutable cDai;
    ERC20 public immutable dai;
    ICToken public immutable cEth;
    ERC20 public immutable wEth;

    mapping(address => bool) public isLiquidator;

    constructor(
        IERC3156FlashLender _lender,
        ISwapRouter _uniswapV3Router,
        IMorpho _morpho,
        ICToken _cDai,
        uint256 _slippageTolerance
    ) {
        lender = _lender;
        morpho = _morpho;
        uniswapV3Router = _uniswapV3Router;
        cDai = _cDai;
        dai = ERC20(_cDai.underlying());
        cEth = ICToken(morpho.cEth());
        wEth = ERC20(morpho.wEth());
        isLiquidator[msg.sender] = true;
        emit LiquidatorAdded(msg.sender);
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
        LiquidateParams memory liquidateParams;
        liquidateParams.poolTokenBorrowed = ICToken(_poolTokenBorrowedAddress);
        liquidateParams.poolTokenCollateral = ICToken(_poolTokenCollateralAddress);
        liquidateParams.collateralUnderlying = _poolTokenCollateralAddress == address(cEth)
            ? wEth
            : ERC20(ICToken(_poolTokenCollateralAddress).underlying());
        liquidateParams.collateralBalanceBefore = liquidateParams.collateralUnderlying.balanceOf(
            address(this)
        );

        liquidateParams.borrowedUnderlying = _poolTokenBorrowedAddress == address(cEth)
            ? wEth
            : ERC20(ICToken(_poolTokenBorrowedAddress).underlying());

        liquidateParams.borrowedTokenBalanceBefore = ERC20(
            ICToken(_poolTokenBorrowedAddress).underlying()
        ).balanceOf(address(this));
        liquidateParams.borrower = _borrower;
        liquidateParams.toRepay = _repayAmount;

        if (liquidateParams.borrowedTokenBalanceBefore >= _repayAmount) {
            _liquidateInternal(liquidateParams);
            if (!_stakeTokens) {
                liquidateParams.collateralUnderlying.safeTransfer(
                    msg.sender,
                    liquidateParams.amountSeized
                );
            }
            return;
        }

        uint256 daiToFlashLoan = _getDaiToFlashloan(_poolTokenBorrowedAddress, _repayAmount);

        dai.safeApprove(address(lender), daiToFlashLoan);

        FlashLoanParams memory params = FlashLoanParams(
            address(liquidateParams.poolTokenBorrowed),
            address(liquidateParams.poolTokenCollateral),
            address(liquidateParams.borrowedUnderlying),
            address(liquidateParams.collateralUnderlying),
            _borrower,
            _repayAmount,
            0,
            0,
            0,
            _firstSwapFees,
            _secondSwapFees
        );
        bytes memory data = _encodeData(params);
        uint256 balanceBefore = liquidateParams.collateralUnderlying.balanceOf(address(this));

        lender.flashLoan(this, address(dai), daiToFlashLoan, data);

        emit FlashLoan(msg.sender, daiToFlashLoan);

        liquidateParams.amountSeized =
            liquidateParams.collateralUnderlying.balanceOf(address(this)) -
            balanceBefore;

        if (!_stakeTokens) {
            liquidateParams.collateralUnderlying.safeTransfer(
                msg.sender,
                liquidateParams.amountSeized
            );
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

        flashLoanParams.repayFlashloans = amount + fee; // keep the minimum amount to repay flash loan
        flashLoanParams.flashLoaned = amount;
        _flashLoanInternal(flashLoanParams);
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }

    function _flashLoanInternal(FlashLoanParams memory _flashLoanParams) internal {
        if (address(dai) != _flashLoanParams.underlyingTokenBorrowedAddress) {
            _flashLoanParams.repayAmount = _doFirstSwap(
                _flashLoanParams.underlyingTokenBorrowedAddress,
                _flashLoanParams.flashLoaned,
                _flashLoanParams.repayAmount,
                _flashLoanParams.firstSwapFees
            );
        }

        uint256 balanceBefore = ERC20(_flashLoanParams.underlyingTokenCollateralAddress).balanceOf(
            address(this)
        );

        ERC20(_flashLoanParams.underlyingTokenBorrowedAddress).safeApprove(
            address(morpho),
            _flashLoanParams.repayAmount
        );
        morpho.liquidate(
            _flashLoanParams.poolTokenBorrowedAddress,
            _flashLoanParams.poolTokenCollateralAddress,
            _flashLoanParams.borrower,
            _flashLoanParams.repayAmount
        );

        _flashLoanParams.seized =
            ERC20(_flashLoanParams.underlyingTokenCollateralAddress).balanceOf(address(this)) -
            balanceBefore;

        if (_flashLoanParams.underlyingTokenCollateralAddress != address(dai)) {
            // tokenIn, seized, amountOut,
            _doSecondSwap(
                _flashLoanParams.underlyingTokenCollateralAddress,
                _flashLoanParams.seized,
                _flashLoanParams.repayFlashloans,
                _flashLoanParams.secondSwapFees
            );
        }
        emit Liquidated(
            address(this),
            _flashLoanParams.borrower,
            _flashLoanParams.poolTokenBorrowedAddress,
            _flashLoanParams.poolTokenCollateralAddress,
            _flashLoanParams.repayAmount,
            _flashLoanParams.seized,
            false
        );
    }

    function _doFirstSwap(
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMaximum,
        uint24 fee
    ) internal returns (uint256 amountOut_) {
        // first swap if needed
        dai.safeApprove(address(uniswapV3Router), amountIn);

        uint256 amountOutMinimumWithSlippage = amountOutMaximum.percentMul(
            BASIS_POINTS - slippageTolerance
        ); // slippage tolerance
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(dai),
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: amountOutMinimumWithSlippage,
            sqrtPriceLimitX96: 0
        });
        {
            uint256 swapped = uniswapV3Router.exactInputSingle(params);
            if (swapped > amountOutMaximum) {
                // this is a bonus due to over swapped tokens
                emit OverSwappedDai(swapped - amountOutMaximum);
                amountOut_ = amountOutMaximum;
            } else {
                amountOut_ = swapped;
            }
            emit Swapped(address(dai), tokenOut, amountIn, swapped, fee);
        }
    }

    function _doSecondSwap(
        address _tokenIn,
        uint256 _seized,
        uint256 _amountOut,
        uint24 _fee
    ) internal returns (uint256 swappedIn_) {
        uint256 amountInMaximum;
        {
            ICompoundOracle oracle = ICompoundOracle(IComptroller(morpho.comptroller()).oracle());
            amountInMaximum = _amountOut
                .mul(oracle.getUnderlyingPrice(address(cDai)))
                .div(oracle.getUnderlyingPrice(address(_tokenIn)))
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

    function _liquidateInternal(LiquidateParams memory _liquidateParams) internal {
        _liquidateParams.borrowedUnderlying.safeApprove(address(morpho), _liquidateParams.toRepay);
        morpho.liquidate(
            address(_liquidateParams.poolTokenBorrowed),
            address(_liquidateParams.poolTokenCollateral),
            _liquidateParams.borrower,
            _liquidateParams.toRepay
        );
        _liquidateParams.amountSeized =
            _liquidateParams.collateralUnderlying.balanceOf(address(this)) -
            _liquidateParams.collateralBalanceBefore;
        emit Liquidated(
            msg.sender,
            _liquidateParams.borrower,
            address(_liquidateParams.poolTokenBorrowed),
            address(_liquidateParams.poolTokenCollateral),
            _liquidateParams.toRepay,
            _liquidateParams.amountSeized,
            false
        );
    }

    /// OWNER SETTERS ///

    function addLiquidator(address _newLiquidator) external onlyOwner {
        isLiquidator[_newLiquidator] = true;
        emit LiquidatorAdded(_newLiquidator);
    }

    function removeLiquidator(address _liquidatorToRemove) external onlyOwner {
        isLiquidator[_liquidatorToRemove] = false;
        emit LiquidatorRemoved(_liquidatorToRemove);
    }

    function setSlippageTolerance(uint256 _newTolerance) external onlyOwner {
        if (_newTolerance > BASIS_POINTS) revert ValueAboveBasisPoints();
        slippageTolerance = _newTolerance;
        emit SlippageToleranceSet(_newTolerance);
    }

    function withdraw(
        address _underlyingAddress,
        address _receiver,
        uint256 _amount
    ) external onlyOwner {
        uint256 amountMax = ERC20(_underlyingAddress).balanceOf(address(this));
        uint256 amount = _amount > amountMax ? amountMax : _amount;
        ERC20(_underlyingAddress).safeTransfer(_receiver, amount);
        emit Withdrawn(msg.sender, _receiver, _underlyingAddress, amount);
    }

    /// HELPERS ///

    function _getDaiToFlashloan(address _poolTokenToRepay, uint256 _amountToRepay)
        internal
        view
        returns (uint256 amountToFlashLoan_)
    {
        ICompoundOracle oracle = ICompoundOracle(IComptroller(morpho.comptroller()).oracle());
        uint256 daiPrice = oracle.getUnderlyingPrice(address(cDai));
        uint256 borrowedTokenPrice = oracle.getUnderlyingPrice(_poolTokenToRepay);
        amountToFlashLoan_ = _amountToRepay.mul(borrowedTokenPrice).div(daiPrice);
        amountToFlashLoan_ += lender.flashFee(address(dai), amountToFlashLoan_);
    }

    function _encodeData(FlashLoanParams memory _flashLoanParams)
        internal
        pure
        returns (bytes memory data)
    {
        data = abi.encode(
            _flashLoanParams.poolTokenBorrowedAddress,
            _flashLoanParams.poolTokenCollateralAddress,
            _flashLoanParams.underlyingTokenBorrowedAddress,
            _flashLoanParams.underlyingTokenCollateralAddress,
            _flashLoanParams.borrower,
            _flashLoanParams.repayAmount,
            _flashLoanParams.firstSwapFees,
            _flashLoanParams.secondSwapFees
        );
    }

    function _decodeData(bytes calldata data)
        internal
        pure
        returns (FlashLoanParams memory _flashLoanParams)
    {
        (
            _flashLoanParams.poolTokenBorrowedAddress,
            _flashLoanParams.poolTokenCollateralAddress,
            _flashLoanParams.underlyingTokenBorrowedAddress,
            _flashLoanParams.underlyingTokenCollateralAddress,
            _flashLoanParams.borrower,
            _flashLoanParams.repayAmount,
            _flashLoanParams.firstSwapFees,
            _flashLoanParams.secondSwapFees
        ) = abi.decode(
            data,
            (address, address, address, address, address, uint256, uint24, uint24)
        );
    }
}
