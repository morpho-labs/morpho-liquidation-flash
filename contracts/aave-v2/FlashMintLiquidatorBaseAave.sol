// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

import "../interface/IERC3156FlashLender.sol";
import "../interface/IERC3156FlashBorrower.sol";
import "../interface/IWETH.sol";
import "../interface/aave-v2/aave/ILendingPoolAddressesProvider.sol";
import "../interface/aave-v2/aave/IPriceOracleGetter.sol";
import "../interface/aave-v2/aave/IAToken.sol";
import "../interface/aave-v2/IMorpho.sol";
import "../interface/aave-v2/libraries/aave/ReserveConfiguration.sol";

import "@morphodao/morpho-core-v1/contracts/compound/interfaces/compound/ICompound.sol";

import "@morphodao/morpho-core-v1/contracts/compound/libraries/CompoundMath.sol";
import "../libraries/PercentageMath.sol";

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "../common/SharedLiquidator.sol";

abstract contract FlashMintLiquidatorBaseAave is
    ReentrancyGuard,
    SharedLiquidator,
    IERC3156FlashBorrower
{
    using SafeTransferLib for ERC20;
    using ReserveConfiguration for DataTypes.ReserveConfigurationMap;
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
        bytes path;
    }

    struct LiquidateParams {
        ERC20 collateralUnderlying;
        ERC20 borrowedUnderlying;
        IAToken poolTokenCollateral;
        IAToken poolTokenBorrowed;
        address liquidator;
        address borrower;
        uint256 toRepay;
    }

    error ValueAboveBasisPoints();

    error UnknownLender();

    error UnknownInitiator();

    error NoProfitableLiquidation();

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
    uint256 public constant DAI_DECIMALS = 18;
    uint256 public slippageTolerance; // in BASIS_POINTS units

    IERC3156FlashLender public immutable lender;
    IMorpho public immutable morpho;
    ILendingPoolAddressesProvider public immutable addressesProvider;
    ILendingPool public immutable lendingPool;
    IAToken public immutable aDai;
    ERC20 public immutable dai;

    constructor(
        IERC3156FlashLender _lender,
        IMorpho _morpho,
        ILendingPoolAddressesProvider _addressesProvider,
        IAToken _aDai
    ) SharedLiquidator() {
        lender = _lender;
        morpho = _morpho;
        addressesProvider = _addressesProvider;
        lendingPool = ILendingPool(_addressesProvider.getLendingPool());
        aDai = _aDai;
        dai = ERC20(_aDai.UNDERLYING_ASSET_ADDRESS());
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
            _flashLoanParams.borrowedUnderlying,
            _flashLoanParams.toLiquidate
        );

        dai.safeApprove(
            address(lender),
            daiToFlashLoan + lender.flashFee(address(dai), daiToFlashLoan)
        );

        uint256 balanceBefore = ERC20(_flashLoanParams.collateralUnderlying).balanceOf(
            address(this)
        );

        lender.flashLoan(this, address(dai), daiToFlashLoan, data);

        seized_ =
            ERC20(_flashLoanParams.collateralUnderlying).balanceOf(address(this)) -
            balanceBefore;

        emit FlashLoan(msg.sender, daiToFlashLoan);
    }

    function _getDaiToFlashloan(address _underlyingToRepay, uint256 _amountToRepay)
        internal
        view
        returns (uint256 amountToFlashLoan_)
    {
        if(_underlyingToRepay == address(dai)) {
        amountToFlashLoan_ = _amountToRepay;
        }
        else {
            IPriceOracleGetter oracle = IPriceOracleGetter(addressesProvider.getPriceOracle());

            (uint256 loanToValue, , , , ) = lendingPool
                .getConfiguration(address(dai))
                .getParamsMemory();
            uint256 daiPrice = oracle.getAssetPrice(address(dai));
            uint256 borrowedTokenPrice = oracle.getAssetPrice(_underlyingToRepay);
            uint256 underlyingDecimals = ERC20(_underlyingToRepay).decimals();
            amountToFlashLoan_ =
                _amountToRepay * borrowedTokenPrice * 10**DAI_DECIMALS /
                    daiPrice /
                    10**underlyingDecimals * BASIS_POINTS /
                loanToValue
                + 1e18; // for rounding errors of supply/borrow on aave
        }
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

    function _getUnderlying(address _poolToken) internal view returns (ERC20 underlying_) {
        underlying_ = ERC20(IAToken(_poolToken).UNDERLYING_ASSET_ADDRESS());
    }
}
