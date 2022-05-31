pragma solidity 0.8.13;

import "./interface/IERC3156FlashLender.sol";
import "./interface/IERC3156FlashBorrower.sol";
import "./interface/ICompound.sol";
import "./interface/morpho/IMorpho.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@rari-capital/solmate/src/utils/SafeTransferLib.sol";

import '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

contract FlashMintLiquidator is IERC3156FlashBorrower, Ownable {
    using SafeTransferLib for ERC20;
    using CompoundMath for uint256;

    /// EVENTS ///

    event Liquidated(
        address indexed _liquidator,
        address _borrower,
        address indexed _poolTokenBorrowedAddress,
        address indexed _poolTokenCollateralAddress,
        uint256 amount,
        uint256 seized,
        bool usingFlashLoans
    );


    IMorpho public immutable morpho;
    ISwapRouter public immutable uniswapV3Router;



    IERC3156FlashLender lender;

    constructor (
        IERC3156FlashLender lender_,
        IMorpho morpho_
    ) public {
        lender = lender_;
        morpho = morpho_;
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
        (Action action) = abi.decode(data, (Action));
        if (action == Action.NORMAL) {
            require(IERC20(token).balanceOf(address(this)) >= amount);
            // make a profitable trade here
            IERC20(token).transfer(initiator, amount + fee);
        } else if (action == Action.OTHER) {
            // do another
        }
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }


    function liquidate(
        address _poolTokenBorrowedAddress,
        address _poolTokenCollateralAddress,
        address _borrower,
        uint256 _repayAmount,
        bool _stakeTokens
    ) external nonReentrant {
        bool usingFlashLoan;
        uint256 amountSeized;
        if(_stakeTokens) {
            uint256 balanceBefore = ERC20(ICToken(_poolTokenBorrowedAddress).underlying()).balanceOf(address(this));
            if(balanceBefore >= _repayAmount) {
                ERC20 collateralUnderlying = ERC20(ICToken(_poolTokenCollateralAddress).underlying());
                ERC20 borrowedUnderlying = ERC20(ICToken(_poolTokenBorrowedAddress).underlying());
                uint256 collateralBalanceBefore = collateralUnderlying.balanceOf(address(this));
                borrowedUnderlying.safeApprove(address(morpho), _repayAmount);
                morpho.liquidate(_poolTokenBorrowedAddress, _poolTokenCollateralAddress, _borrower, _repayAmount);
                amountSeized = collateralUnderlying.balanceOf(address(this)) - collateralBalanceBefore;
                emit Liquidated(
                    msg.sender,
                    _borrower,
                    _poolTokenBorrowedAddress,
                    _poolTokenCollateralAddress,
                    _repayAmount,
                    amountSeized,
                    false
                );
                return;
            }
        }
    }


    /// @dev Initiate a flash loan
    function flashBorrow(
        address token,
        uint256 amount
    ) public {
        bytes memory data = abi.encode(Action.NORMAL);
        uint256 _allowance = IERC20(token).allowance(address(this), address(lender));
        uint256 _fee = lender.flashFee(token, amount);
        uint256 _repayment = amount + _fee;
        IERC20(token).approve(address(lender), _allowance + _repayment);
        lender.flashLoan(this, token, amount, data);
    }


}
