// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

import "@morphodao/morpho-core-v1/contracts/compound/libraries/CompoundMath.sol";

import "./interface/IERC3156FlashLender.sol";
import "./interface/IERC3156FlashBorrower.sol";
import "@morphodao/morpho-core-v1/contracts/compound/interfaces/IMorpho.sol";
import "@morphodao/morpho-core-v1/contracts/compound/interfaces/compound/ICompound.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@rari-capital/solmate/src/utils/SafeTransferLib.sol";

import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

contract FlashMintLiquidator is IERC3156FlashBorrower, Ownable, ReentrancyGuard {
    //using SafeTransferLib for IERC20;
    using SafeERC20 for IERC20;
    using CompoundMath for uint256;


    struct FlashLoansParams {
        address _liquidator;
        address _poolTokenBorrowedAddress;
        address _poolTokenCollateralAddress;
        address _underlyingTokenBorrowedAddress;
        address _underlyingTokenCollateralAddress;
        address _borrower;
        uint256 _repayAmount;
        uint256 seized;
        uint256 repayFlashloans;
    }
    struct LiquidateParams {
        IERC20 collateralUnderlying;
        IERC20 borrowedUnderlying;
        uint256 collateralBalanceBefore;
        uint256 borrowedTokenBalanceBefore;
        uint256 amountSeized;
    }
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

    event LiquidatorAdded(
        address indexed _liquidatorAdded
    );

    event LiquidatorRemoved(
        address indexed _liquidatorRemoved
    );

    event Withdrawn(
        address indexed sender,
        address indexed receiver,
        address indexed underlyingAddress,
        uint256 amount
    );

    event OverSwappedDai(
        uint256 amount
    );


    IMorpho public immutable morpho;
    ICToken public immutable cDai;
    ISwapRouter public immutable uniswapV3Router;
    uint256 public constant BASIS_POINTS = 10000;
    mapping(address => bool) isLiquidator;

    IERC3156FlashLender lender;

    constructor (
        IERC3156FlashLender lender_,
        ISwapRouter uniswapV3Router_,
        IMorpho morpho_,
        ICToken cDai_
    ) {
        lender = lender_;
        morpho = morpho_;
        cDai = cDai_;
        uniswapV3Router = uniswapV3Router_;
        isLiquidator[msg.sender] = true;
    }


    function liquidate(
        address _poolTokenBorrowedAddress,
        address _poolTokenCollateralAddress,
        address _borrower,
        uint256 _repayAmount,
        bool _stakeTokens
    ) external nonReentrant {
        LiquidateParams memory liquidateParams;
        liquidateParams.collateralUnderlying = IERC20(ICToken(_poolTokenCollateralAddress).underlying());
        liquidateParams.collateralBalanceBefore = liquidateParams.collateralUnderlying.balanceOf(address(this));

        liquidateParams.borrowedUnderlying = IERC20(ICToken(_poolTokenBorrowedAddress).underlying());
        if(_stakeTokens && isLiquidator[msg.sender] ) {
            // only for setted liquidators
            liquidateParams.borrowedTokenBalanceBefore = IERC20(ICToken(_poolTokenBorrowedAddress).underlying()).balanceOf(address(this));
            if(liquidateParams.borrowedTokenBalanceBefore >= _repayAmount) {
                liquidateParams.borrowedUnderlying.safeApprove(address(morpho), _repayAmount);
                morpho.liquidate(_poolTokenBorrowedAddress, _poolTokenCollateralAddress, _borrower, _repayAmount);
                liquidateParams.amountSeized = liquidateParams.collateralUnderlying.balanceOf(address(this)) - liquidateParams.collateralBalanceBefore;
                emit Liquidated(
                    msg.sender,
                    _borrower,
                    _poolTokenBorrowedAddress,
                    _poolTokenCollateralAddress,
                    _repayAmount,
                    liquidateParams.amountSeized,
                    false
                );
                return;
            }
        }
        IERC20 dai;
        uint256 daiToFlashLoans;
        {
            ICompoundOracle oracle = ICompoundOracle(IComptroller(morpho.comptroller()).oracle());
            uint256 daiPrice = oracle.getUnderlyingPrice(address(cDai));
            uint256 borrowedTokenPrice = oracle.getUnderlyingPrice(_poolTokenBorrowedAddress);
            daiToFlashLoans = _repayAmount.mul(borrowedTokenPrice).div(daiPrice);
            dai = IERC20(cDai.underlying());
            uint256 fee = lender.flashFee(address(dai), daiToFlashLoans);
            dai.safeApprove(address(lender), daiToFlashLoans + fee);
        }

        bytes memory data = abi.encode(
            _poolTokenBorrowedAddress,
            _poolTokenCollateralAddress,
            address(liquidateParams.borrowedUnderlying),
            address(liquidateParams.collateralUnderlying),
            _borrower,
            _repayAmount
        );
        uint256 balanceBefore = liquidateParams.borrowedUnderlying.balanceOf(address(this));
        lender.flashLoan(this, address(dai), daiToFlashLoans, data);
        liquidateParams.amountSeized = liquidateParams.borrowedUnderlying.balanceOf(address(this)) - balanceBefore;
        emit Liquidated(
            msg.sender,
            _borrower,
            _poolTokenBorrowedAddress,
            _poolTokenCollateralAddress,
            _repayAmount,
            liquidateParams.amountSeized,
            true
        );

        if(!_stakeTokens)
            liquidateParams.borrowedUnderlying.safeTransfer(msg.sender, liquidateParams.amountSeized);

    }

    /// @dev ERC-3156 Flash loan callback
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        require(
            msg.sender == address(lender),
            "FlashBorrower: Untrusted lender"
        );
        require(
            initiator == address(this),
            "FlashBorrower: Untrusted loan initiator"
        );
        FlashLoansParams memory flashLoansParams;
        (
            flashLoansParams._poolTokenBorrowedAddress,
            flashLoansParams._poolTokenCollateralAddress,
            flashLoansParams._underlyingTokenBorrowedAddress,
            flashLoansParams._underlyingTokenCollateralAddress,
            flashLoansParams._borrower,
            flashLoansParams._repayAmount
        ) = abi.decode(data, (address,address,address,address,address,uint256));
        uint24 poolFee = 3000; // 0.3% 1e6 BASIS POINTS

        flashLoansParams.repayFlashloans = amount + fee; // keep the minimum amount to repay flash loan
        if(token != flashLoansParams._underlyingTokenBorrowedAddress) {
            // first swap if needed
            IERC20(token).safeApprove(address(uniswapV3Router), amount);

            uint amountOutMinimumWithSlippage = flashLoansParams._repayAmount * (BASIS_POINTS - 100) / BASIS_POINTS;
            ISwapRouter.ExactInputSingleParams memory params =
            ISwapRouter.ExactInputSingleParams({
            tokenIn: token,
            tokenOut: flashLoansParams._underlyingTokenBorrowedAddress,
            fee: poolFee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amount,
            amountOutMinimum: amountOutMinimumWithSlippage,
            // We also set the sqrtPriceLimitx96 to be 0 to ensure we swap our exact input amount.
            sqrtPriceLimitX96: 0
            });
            {
                uint256 swapped = uniswapV3Router.exactInputSingle(params);
                if(swapped > flashLoansParams._repayAmount) {
                    // this is a bonus due to over swapped tokens
                    emit OverSwappedDai(swapped - flashLoansParams._repayAmount);
                } else {
                    flashLoansParams._repayAmount = swapped;
                }
            }
        }

        uint256 balanceBefore = IERC20(flashLoansParams._underlyingTokenCollateralAddress).balanceOf(address(this));

        IERC20(flashLoansParams._underlyingTokenBorrowedAddress).approve(address(morpho), flashLoansParams._repayAmount);
        morpho.liquidate(flashLoansParams._poolTokenBorrowedAddress, flashLoansParams._poolTokenCollateralAddress, flashLoansParams._borrower, flashLoansParams._repayAmount);

        flashLoansParams.seized = IERC20(flashLoansParams._underlyingTokenCollateralAddress).balanceOf(address(this)) - balanceBefore;

        if(flashLoansParams._underlyingTokenCollateralAddress != token) {
            uint256 amountInMaximum;
            {
                ICompoundOracle oracle = ICompoundOracle(IComptroller(morpho.comptroller()).oracle());
                amountInMaximum = flashLoansParams.repayFlashloans.mul(oracle.getUnderlyingPrice(address(cDai))).div(oracle.getUnderlyingPrice(address(flashLoansParams._poolTokenCollateralAddress))) * (BASIS_POINTS + 100) / BASIS_POINTS;
            }
            require(amountInMaximum >= flashLoansParams.seized, "FlashBorrower: Cannot assume slippage");

            IERC20(flashLoansParams._underlyingTokenCollateralAddress).safeApprove(address(uniswapV3Router), flashLoansParams.seized);
            ISwapRouter.ExactOutputSingleParams memory outputParams =
                ISwapRouter.ExactOutputSingleParams({
                    tokenIn: flashLoansParams._underlyingTokenCollateralAddress,
                    tokenOut: token,
                    fee: poolFee,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountOut: flashLoansParams.repayFlashloans,
                    amountInMaximum: flashLoansParams.seized,
                    // We also set the sqrtPriceLimitx96 to be 0 to ensure we swap our exact output amount.
                    sqrtPriceLimitX96: 0
                });
            flashLoansParams.repayFlashloans = uniswapV3Router.exactOutputSingle(outputParams);
        }
        // IERC20(_underlyingTokenCollateralAddress).safeTransfer(initiator, bonus);
        emit Liquidated(
            flashLoansParams._liquidator,
            flashLoansParams._borrower,
            flashLoansParams._poolTokenBorrowedAddress,
            flashLoansParams._poolTokenCollateralAddress,
            flashLoansParams._repayAmount,
            flashLoansParams.seized,
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


    function deposit(address _underlyingAddress, uint256 _amount) external {
        IERC20(_underlyingAddress).safeTransferFrom(msg.sender, address(this), _amount);
    }

    function withdraw(address _underlyingAddress, address _receiver, uint256 _amount ) external onlyOwner {
        IERC20(_underlyingAddress).safeTransfer(_receiver, _amount);
        emit Withdrawn(msg.sender, _receiver, _underlyingAddress, _amount);
    }

}
