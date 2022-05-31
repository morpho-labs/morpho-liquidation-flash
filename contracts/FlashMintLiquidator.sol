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




    IMorpho public immutable morpho;
    ISwapRouter public immutable uniswapV3Router;

    address[] liquidators;

    IERC3156FlashLender lender;

    constructor (
        IERC3156FlashLender lender_,
        IMorpho morpho_
    ) public {
        lender = lender_;
        morpho = morpho_;
        liquidators.push(msg.sender);
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
        uint256 amountSeized;

        ERC20 collateralUnderlying = ERC20(ICToken(_poolTokenCollateralAddress).underlying());
        uint256 collateralBalanceBefore = collateralUnderlying.balanceOf(address(this));

        if(_stakeTokens && liquidators[msg.sender] != address(0)) {
            // only for setted liquidators
            uint256 balanceBefore = ERC20(ICToken(_poolTokenBorrowedAddress).underlying()).balanceOf(address(this));
            if(balanceBefore >= _repayAmount) {
                ERC20 borrowedUnderlying = ERC20(ICToken(_poolTokenBorrowedAddress).underlying());
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


    function addLiquidator(address _newLiquidator) external onlyOwner {
        liquidators.push(_newLiquidator);
        emit LiquidatorAdded(_newLiquidator);
    }

    function removeLiquidator(address _liquidatorToRemove) external onlyOwner {
        delete liquidators [_liquidatorToRemove];
        emit LiquidatorRemoved(_newLiquidator);
    }


    function deposit(address _underlyingAddress, uint256 _amount) {
        ERC20(_underlyingAddress).safeTransferFrom(msg.sender, address(this), _amount);
    }

    function withdraw(address _underlyingAddress, address _receiver, uint256 _amount ) onlyOwner {
        ERC20(_underlyingAddress).safeTransfer(_receiver, _amount);
        emit Withdrawn(msg.sender, _receiver, _underlyingAddress, _amount);
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
