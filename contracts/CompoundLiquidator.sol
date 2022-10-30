// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

import "@morphodao/MORPHO-core-v1/contracts/compound/interfaces/compound/ICompound.sol";
import "@morphodao/MORPHO-core-v1/contracts/compound/interfaces/IMORPHO.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "./interface/IERC3156FlashBorrower.sol";
import "./interface/IERC3156FlashLender.sol";
import "./interface/IWETH.sol";

import "@rari-capital/solmate/src/utils/SafeTransferLib.sol";
import "./libraries/PercentageMath.sol";
import "./libraries/CompoundMath.sol";

import "@openzeppelin/contracts/access/Ownable.sol";

contract CompoundLiquidator is IERC3156FlashBorrower, Ownable {
	using SafeTransferLib for ERC20;
    using CompoundMath for uint256;
    using PercentageMath for uint256;

	event Withdrawn(address indexed token, uint256 amount);

	/// CONSTANTS AND IMMUTABLES ///

    bytes32 public constant FLASHLOAN_CALLBACK = keccak256("ERC3156FlashBorrower.onFlashLoan");
    IWETH internal constant WETH = IWETH(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    ICToken internal constant CETH = ICToken(0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5);
    IMorpho internal constant MORPHO = IMorpho(0x8888882f8f843896699869179fB6E4f7e3B58888);
	IERC3156FlashLender internal constant LENDER = IERC3156FlashLender(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
	ISwapRouter internal constant ROUTER = ISwapRouter(0xE592427A0AEce92De3Edee1F18E0157C05861564);

	struct FlashLoanParams {
        address collateralUnderlying;
        address borrowedUnderlying;
        address poolTokenCollateral;
        address poolTokenBorrowed;
        address liquidator;
        address borrower;
        uint256 toLiquidate;
        bytes path;
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

    error NoProfitableLiquidation();


	event SlippageToleranceSet(uint256 newTolerance);

    event Swapped(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

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

	  function liquidate(
        address _poolTokenBorrowedAddress,
        address _poolTokenCollateralAddress,
        address _borrower,
        uint256 _repayAmount,
        bool _stakeTokens,
        bytes memory _path
    ) external onlyOwner {
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
            IComptroller comptroller = MORPHO.comptroller();
            seized = _liquidateWithFlashLoan(params);
        }

        if (!_stakeTokens) liquidateParams.collateralUnderlying.safeTransfer(msg.sender, seized);
    }

    /// @dev ERC-3156 Flash loan callback
    function onFlashLoan(
        address _initiator,
        address _token,
        uint256 _amount,
        uint256 _fee,
        bytes calldata data
    ) external override returns (bytes32) {
        if (msg.sender != address(LENDER)) revert UnknownLender();
        if (_initiator != address(this)) revert UnknownInitiator();
        FlashLoanParams memory flashLoanParams = _decodeData(data);

        _flashLoanInternal(flashLoanParams, _amount, _amount + _fee);
        return FLASHLOAN_CALLBACK;
    }

    function _flashLoanInternal(
        FlashLoanParams memory _flashLoanParams,
        uint256 _amountIn,
        uint256 _toRepayFlashLoan
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
            ICompoundOracle oracle = ICompoundOracle(IComptroller(MORPHO.comptroller()).oracle());

            uint256 maxIn = (_flashLoanParams
                .toLiquidate
                .mul(oracle.getUnderlyingPrice(_flashLoanParams.poolTokenBorrowed))
                .div(oracle.getUnderlyingPrice(_flashLoanParams.poolTokenCollateral)) *
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


    function _liquidateInternal(LiquidateParams memory _liquidateParams)
        internal
        returns (uint256 seized_)
    {
        uint256 balanceBefore = _liquidateParams.collateralUnderlying.balanceOf(address(this));
        _liquidateParams.borrowedUnderlying.safeApprove(address(MORPHO), _liquidateParams.toRepay);
        MORPHO.liquidate(
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

    function _liquidateWithFlashLoan(FlashLoanParams memory _flashLoanParams) internal returns (uint256 seized_) {
        bytes memory data = _encodeData(_flashLoanParams);

		// TODO: approve everything.
        ERC20(_flashLoanParams.borrowedUnderlying).safeApprove(
            address(LENDER),
            _flashLoanParams.toLiquidate + LENDER.flashFee(address(_flashLoanParams.poolTokenBorrowed), _flashLoanParams.toLiquidate)
        );

        uint256 balanceBefore = ERC20(_flashLoanParams.collateralUnderlying).balanceOf(
            address(this)
        );

        LENDER.flashLoan(this, address(_flashLoanParams.poolTokenBorrowed), _flashLoanParams.toLiquidate, data);

        seized_ =
            ERC20(_flashLoanParams.collateralUnderlying).balanceOf(address(this)) -
            balanceBefore;

        emit FlashLoan(msg.sender, _flashLoanParams.toLiquidate);
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
            _flashLoanParams.path
        );
    }

    function _decodeData(bytes calldata data)
        internal
        pure
        returns (FlashLoanParams memory _flashLoanParams)
    {
        (
            _flashLoanParams.collateralUnderlying,
            _flashLoanParams.borrowedUnderlying,
            _flashLoanParams.poolTokenCollateral,
            _flashLoanParams.poolTokenBorrowed,
            _flashLoanParams.liquidator,
            _flashLoanParams.borrower,
            _flashLoanParams.toLiquidate,
            _flashLoanParams.path
        ) = abi.decode(
            data,
            (address, address, address, address, address, address, uint256, bytes)
        );
    }


	/// OWNER ///

	function setSlippageTolerance(uint256 _newTolerance) external onlyOwner {
        if (_newTolerance > PercentageMath.PERCENTAGE_FACTOR) revert ValueAboveBasisPoints();
        slippageTolerance = _newTolerance;
        emit SlippageToleranceSet(_newTolerance);
    }

	function withdraw(
        address _token,
        uint256 _amount
    ) external onlyOwner {
        uint256 amountMax = ERC20(_token).balanceOf(address(this));
        uint256 amount = _amount > amountMax ? amountMax : _amount;
        ERC20(_token).safeTransfer(msg.sender, amount);
        emit Withdrawn(_token, amount);
    }

	// TODO: withdraw ETH

	/// INTERNAL ///


	function _doSecondSwap(
        bytes memory _path,
        uint256 _amount,
        uint256 _maxIn
    ) internal returns (uint256 amountIn) {
        amountIn = ROUTER.exactOutput(
            ISwapRouter.ExactOutputParams(_path, address(this), block.timestamp, _amount, _maxIn)
        );
    }

	function _getUnderlying(address _poolToken) internal view returns (ERC20 underlying_) {
	underlying_ = _poolToken == address(CETH)
		? ERC20(address(WETH))
		: ERC20(ICToken(_poolToken).underlying());
	}
}