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
        uint256 repayFlashloans;
        uint24 firstSwapFees;
        uint24 secondSwapFees;
    }

    struct LiquidateParams {
        ERC20 collateralUnderlying;
        ERC20 borrowedUnderlying;
        uint256 collateralBalanceBefore;
        uint256 borrowedTokenBalanceBefore;
        uint256 amountSeized;
    }

    error ValueAboveBasisPoints();

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
        if (liquidateParams.borrowedTokenBalanceBefore >= _repayAmount) {
            liquidateParams.borrowedUnderlying.safeApprove(address(morpho), _repayAmount);
            morpho.liquidate(
                _poolTokenBorrowedAddress,
                _poolTokenCollateralAddress,
                _borrower,
                _repayAmount
            );
            liquidateParams.amountSeized =
                liquidateParams.collateralUnderlying.balanceOf(address(this)) -
                liquidateParams.collateralBalanceBefore;
            emit Liquidated(
                msg.sender,
                _borrower,
                _poolTokenBorrowedAddress,
                _poolTokenCollateralAddress,
                _repayAmount,
                liquidateParams.amountSeized,
                false
            );

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

        bytes memory data = abi.encode(
            _poolTokenBorrowedAddress,
            _poolTokenCollateralAddress,
            address(liquidateParams.borrowedUnderlying),
            address(liquidateParams.collateralUnderlying),
            _borrower,
            _repayAmount,
            _firstSwapFees,
            _secondSwapFees
        );
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
        address dai,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        require(msg.sender == address(lender), "FlashBorrower: Untrusted lender");
        require(initiator == address(this), "FlashBorrower: Untrusted loan initiator");
        FlashLoanParams memory flashLoanParams;
        (
            flashLoanParams.poolTokenBorrowedAddress,
            flashLoanParams.poolTokenCollateralAddress,
            flashLoanParams.underlyingTokenBorrowedAddress,
            flashLoanParams.underlyingTokenCollateralAddress,
            flashLoanParams.borrower,
            flashLoanParams.repayAmount,
            flashLoanParams.firstSwapFees,
            flashLoanParams.secondSwapFees
        ) = abi.decode(
            data,
            (address, address, address, address, address, uint256, uint24, uint24)
        );

        flashLoanParams.repayFlashloans = amount + fee; // keep the minimum amount to repay flash loan
        if (dai != flashLoanParams.underlyingTokenBorrowedAddress) {
            // first swap if needed
            ERC20(dai).safeApprove(address(uniswapV3Router), amount);

            uint256 amountOutMinimumWithSlippage = flashLoanParams.repayAmount.percentMul(
                BASIS_POINTS - slippageTolerance
            ); // slippage tolerance
            ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
                tokenIn: dai,
                tokenOut: flashLoanParams.underlyingTokenBorrowedAddress,
                fee: flashLoanParams.firstSwapFees,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: amountOutMinimumWithSlippage,
                sqrtPriceLimitX96: 0
            });
            {
                uint256 swapped = uniswapV3Router.exactInputSingle(params);
                if (swapped > flashLoanParams.repayAmount) {
                    // this is a bonus due to over swapped tokens
                    emit OverSwappedDai(swapped - flashLoanParams.repayAmount);
                } else {
                    flashLoanParams.repayAmount = swapped;
                }
                emit Swapped(
                    dai,
                    flashLoanParams.underlyingTokenBorrowedAddress,
                    amount,
                    swapped,
                    flashLoanParams.firstSwapFees
                );
            }
        }

        uint256 balanceBefore = ERC20(flashLoanParams.underlyingTokenCollateralAddress).balanceOf(
            address(this)
        );

        ERC20(flashLoanParams.underlyingTokenBorrowedAddress).safeApprove(
            address(morpho),
            flashLoanParams.repayAmount
        );
        morpho.liquidate(
            flashLoanParams.poolTokenBorrowedAddress,
            flashLoanParams.poolTokenCollateralAddress,
            flashLoanParams.borrower,
            flashLoanParams.repayAmount
        );

        flashLoanParams.seized =
            ERC20(flashLoanParams.underlyingTokenCollateralAddress).balanceOf(address(this)) -
            balanceBefore;

        if (flashLoanParams.underlyingTokenCollateralAddress != dai) {
            uint256 amountInMaximum;
            {
                ICompoundOracle oracle = ICompoundOracle(
                    IComptroller(morpho.comptroller()).oracle()
                );
                amountInMaximum =
                    (flashLoanParams
                        .repayFlashloans
                        .mul(oracle.getUnderlyingPrice(address(cDai)))
                        .div(
                            oracle.getUnderlyingPrice(
                                address(flashLoanParams.poolTokenCollateralAddress)
                            )
                        ) * (BASIS_POINTS + 100)) /
                    BASIS_POINTS;
                amountInMaximum = amountInMaximum > flashLoanParams.seized
                    ? flashLoanParams.seized
                    : amountInMaximum;
            }

            ERC20(flashLoanParams.underlyingTokenCollateralAddress).safeApprove(
                address(uniswapV3Router),
                amountInMaximum
            );

            ISwapRouter.ExactOutputSingleParams memory outputParams = ISwapRouter
                .ExactOutputSingleParams({
                    tokenIn: flashLoanParams.underlyingTokenCollateralAddress,
                    tokenOut: dai,
                    fee: flashLoanParams.secondSwapFees,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountOut: flashLoanParams.repayFlashloans,
                    amountInMaximum: amountInMaximum,
                    sqrtPriceLimitX96: 0
                });
            uint256 swappedIn = uniswapV3Router.exactOutputSingle(outputParams);

            emit Swapped(
                flashLoanParams.underlyingTokenCollateralAddress,
                dai,
                swappedIn,
                flashLoanParams.repayFlashloans,
                flashLoanParams.secondSwapFees
            );
        }
        emit Liquidated(
            address(this),
            flashLoanParams.borrower,
            flashLoanParams.poolTokenBorrowedAddress,
            flashLoanParams.poolTokenCollateralAddress,
            flashLoanParams.repayAmount,
            flashLoanParams.seized,
            false
        );
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }

    function addLiquidator(address _newLiquidator) external onlyOwner {
        isLiquidator[_newLiquidator] = true;
        emit LiquidatorAdded(_newLiquidator);
    }

    function removeLiquidator(address _liquidatorToRemove) external onlyOwner {
        isLiquidator[_liquidatorToRemove] = false;
        emit LiquidatorRemoved(_liquidatorToRemove);
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

    function setSlippageTolerance(uint256 _newTolerance) external onlyOwner {
        if (_newTolerance > BASIS_POINTS) revert ValueAboveBasisPoints();
        slippageTolerance = _newTolerance;
        emit SlippageToleranceSet(_newTolerance);
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
        amountToFlashLoan_ += lender.flashFee(address(dai), amountToFlashLoan_);
    }
}
