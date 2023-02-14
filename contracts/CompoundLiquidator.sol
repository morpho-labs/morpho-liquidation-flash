// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

import "@morphodao/morpho-core-v1/contracts/compound/interfaces/compound/ICompound.sol";
import "@morphodao/morpho-core-v1/contracts/compound/interfaces/IMorpho.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "./interface/IFlashLoanRecipient.sol";
import "./interface/IVault.sol";

import "@rari-capital/solmate/src/utils/SafeTransferLib.sol";
import "./libraries/PercentageMath.sol";
import "./libraries/CompoundMath.sol";

import "@openzeppelin/contracts/access/Ownable.sol";

contract CompoundLiquidator is IFlashLoanRecipient, Ownable {
    using SafeTransferLib for ERC20;
    using PercentageMath for uint256;
    using CompoundMath for uint256;

    /// STRUCTS ///

    struct FlashLoanParams {
        address collateralUnderlying;
        address borrowedUnderlying;
        address poolTokenCollateral;
        address poolTokenBorrowed;
        address borrower;
        uint256 toLiquidate;
        bytes path;
    }

    struct LiquidateParams {
        address collateralUnderlying;
        address borrowedUnderlying;
        address poolTokenCollateral;
        address poolTokenBorrowed;
        address borrower;
        uint256 toRepay;
    }

    /// ERRORS ///

    error ValueAboveBasisPoints();

    error UnknownLender();

    error UnknownInitiator();

    /// EVENTS ///

    event SlippageToleranceSet(uint256 newTolerance);

    event Withdrawn(address indexed token, uint256 amount);

    /// CONSTANTS AND IMMUTABLES ///

    bytes32 public constant FLASHLOAN_CALLBACK = keccak256("ERC3156FlashBorrower.onFlashLoan");
    IMorpho internal constant MORPHO = IMorpho(0x8888882f8f843896699869179fB6E4f7e3B58888);
    IVault internal constant LENDER = IVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    ISwapRouter internal constant ROUTER = ISwapRouter(0xE592427A0AEce92De3Edee1F18E0157C05861564);
    ICompoundOracle internal constant ORACLE =
        ICompoundOracle(0x65c816077C29b557BEE980ae3cC2dCE80204A0C5);

    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant CETH = 0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5;
    address internal constant CDAI = 0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643;
    address internal constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant CCOMP = 0x70e36f6BF80a52b3B46b3aF8e106CC0ed743E8e4;
    address internal constant COMP = 0xc00e94Cb662C3520282E6f5717214004A7f26888;
    address internal constant CUSDC = 0x39AA39c021dfbaE8faC545936693aC917d5E7563;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant CWBTC = 0xccF4429DB6322D5C611ee964527D42E5d685DD6a;
    address internal constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address internal constant CUSDT = 0xf650C3d88D12dB855b8bf7D11Be6C55A4e07dCC9;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant CUNI = 0x35A18000230DA775CAc24873d00Ff85BccdeD550;
    address internal constant UNI = 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984;
    address internal constant CAAVE = 0xe65cdB6479BaC1e22340E4E755fAE7E509EcD06c;
    address internal constant AAVE = 0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9;

    /// STORAGE ///

    uint256 public slippageTolerance; // In basis points.
    mapping(address => address) public cTokenToUnderlying;

    /// CONSTRUCTOR ///

    constructor(uint256 _slippageTolerance) {
        slippageTolerance = _slippageTolerance;

        cTokenToUnderlying[CETH] = WETH;
        cTokenToUnderlying[CDAI] = DAI;
        cTokenToUnderlying[CCOMP] = COMP;
        cTokenToUnderlying[CUSDC] = USDC;
        cTokenToUnderlying[CWBTC] = WBTC;
        cTokenToUnderlying[CUSDT] = USDT;
        cTokenToUnderlying[CUNI] = UNI;
        cTokenToUnderlying[CAAVE] = AAVE;

        /*
		ERC20(WETH).safeApprove(address(ROUTER), type(uint256).max);
		ERC20(WETH).safeApprove(address(MORPHO), type(uint256).max);
		ERC20(WETH).safeApprove(address(LENDER), type(uint256).max);

		ERC20(DAI).safeApprove(address(ROUTER), type(uint256).max);
		ERC20(DAI).safeApprove(address(MORPHO), type(uint256).max);
		ERC20(DAI).safeApprove(address(LENDER), type(uint256).max);

		ERC20(COMP).safeApprove(address(ROUTER), type(uint256).max);
		ERC20(COMP).safeApprove(address(MORPHO), type(uint256).max);
		ERC20(COMP).safeApprove(address(LENDER), type(uint256).max);

		ERC20(USDC).safeApprove(address(ROUTER), type(uint256).max);
		ERC20(USDC).safeApprove(address(MORPHO), type(uint256).max);
		ERC20(USDC).safeApprove(address(LENDER), type(uint256).max);

		ERC20(WBTC).safeApprove(address(ROUTER), type(uint256).max);
		ERC20(WBTC).safeApprove(address(MORPHO), type(uint256).max);
		ERC20(WBTC).safeApprove(address(LENDER), type(uint256).max);

		ERC20(USDT).safeApprove(address(ROUTER), type(uint256).max);
		ERC20(USDT).safeApprove(address(MORPHO), type(uint256).max);
		ERC20(USDT).safeApprove(address(LENDER), type(uint256).max);

		ERC20(UNI).safeApprove(address(ROUTER), type(uint256).max);
		ERC20(UNI).safeApprove(address(MORPHO), type(uint256).max);
		ERC20(UNI).safeApprove(address(LENDER), type(uint256).max);

		ERC20(AAVE).safeApprove(address(ROUTER), type(uint256).max);
		ERC20(AAVE).safeApprove(address(MORPHO), type(uint256).max);
		ERC20(AAVE).safeApprove(address(LENDER), type(uint256).max);
		*/
    }

    function liquidate(
        address _poolTokenBorrowedAddress,
        address _poolTokenCollateralAddress,
        address _borrower,
        uint256 _repayAmount,
        bytes memory _path
    ) external onlyOwner {
        LiquidateParams memory liquidateParams = LiquidateParams(
            cTokenToUnderlying[_poolTokenCollateralAddress],
            cTokenToUnderlying[_poolTokenBorrowedAddress],
            _poolTokenCollateralAddress,
            _poolTokenBorrowedAddress,
            _borrower,
            _repayAmount
        );

        if (ERC20(liquidateParams.borrowedUnderlying).balanceOf(address(this)) >= _repayAmount)
            _liquidateInternal(liquidateParams);
        else {
            FlashLoanParams memory params = FlashLoanParams(
                address(liquidateParams.collateralUnderlying),
                address(liquidateParams.borrowedUnderlying),
                address(liquidateParams.poolTokenCollateral),
                address(liquidateParams.poolTokenBorrowed),
                liquidateParams.borrower,
                liquidateParams.toRepay,
                _path
            );
            _liquidateWithFlashLoan(params);
        }
    }

    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes calldata data
    ) external {
        if (msg.sender != address(LENDER)) revert UnknownLender();
        if (tx.origin != owner()) revert UnknownInitiator(); // TODO: check this

        _flashLoanInternal(_decodeData(data));
    }

    function _flashLoanInternal(FlashLoanParams memory _flashLoanParams) internal {
        LiquidateParams memory liquidateParams = LiquidateParams(
            _flashLoanParams.collateralUnderlying,
            _flashLoanParams.borrowedUnderlying,
            _flashLoanParams.poolTokenCollateral,
            _flashLoanParams.poolTokenBorrowed,
            _flashLoanParams.borrower,
            _flashLoanParams.toLiquidate
        );
        _liquidateInternal(liquidateParams);

        if (_flashLoanParams.borrowedUnderlying != _flashLoanParams.collateralUnderlying) {
            uint256 maxIn = _flashLoanParams
                .toLiquidate
                .mul(ORACLE.getUnderlyingPrice(_flashLoanParams.poolTokenBorrowed))
                .div(ORACLE.getUnderlyingPrice(_flashLoanParams.poolTokenCollateral))
                .percentAdd(slippageTolerance);
            ERC20(_flashLoanParams.collateralUnderlying).safeApprove(address(ROUTER), maxIn);

            _doSecondSwap(_flashLoanParams.path, _flashLoanParams.toLiquidate, maxIn);
        }

        ERC20(_flashLoanParams.borrowedUnderlying).safeTransfer(
            address(LENDER),
            _flashLoanParams.toLiquidate
        );
    }

    function _liquidateInternal(LiquidateParams memory _liquidateParams) internal {
        ERC20(_liquidateParams.borrowedUnderlying).safeApprove(
            address(MORPHO),
            _liquidateParams.toRepay
        );
        MORPHO.liquidate(
            address(_liquidateParams.poolTokenBorrowed),
            address(_liquidateParams.poolTokenCollateral),
            _liquidateParams.borrower,
            _liquidateParams.toRepay
        );
    }

    function _liquidateWithFlashLoan(FlashLoanParams memory _flashLoanParams) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = _flashLoanParams.borrowedUnderlying;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _flashLoanParams.toLiquidate;
        LENDER.flashLoan(address(this), tokens, amounts, _encodeData(_flashLoanParams));
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
            _flashLoanParams.borrower,
            _flashLoanParams.toLiquidate,
            _flashLoanParams.path
        ) = abi.decode(data, (address, address, address, address, address, uint256, bytes));
    }

    /// OWNER ///

    function setSlippageTolerance(uint256 _newTolerance) external onlyOwner {
        if (_newTolerance > PercentageMath.PERCENTAGE_FACTOR) revert ValueAboveBasisPoints();
        slippageTolerance = _newTolerance;
        emit SlippageToleranceSet(_newTolerance);
    }

    function withdraw(address _token, uint256 _amount) external onlyOwner {
        uint256 amountMax = ERC20(_token).balanceOf(address(this));
        uint256 amount = _amount > amountMax ? amountMax : _amount;
        ERC20(_token).safeTransfer(msg.sender, amount);
        emit Withdrawn(_token, amount);
    }

    function setCTokenToUnderlying(address _cToken, address _underlying) external onlyOwner {
        cTokenToUnderlying[_cToken] = _underlying;
    }

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
}
