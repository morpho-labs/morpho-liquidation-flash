import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Contract, Signer, utils } from "ethers";
import { config, getTokens } from "./setup";
import { parseUnits } from "ethers/lib/utils";
import { pow10 } from "./helpers";

describe("Test Flash Mint liquidator on MakerDAO", () => {
  let snapshotId: number;
  let morpho: Contract;
  let comptroller: Contract;
  let flashLiquidator: Contract;
  let oracle: Contract;

  let owner: Signer;
  let admin: Signer; // comptroller admin
  let liquidator: Signer;
  let accounts: Signer[];

  let daiToken: Contract;
  let usdcToken: Contract;
  let usdtToken: Contract;

  let cDaiToken: Contract;
  let cUsdcToken: Contract;
  let cUsdtToken: Contract;
  const initialize = async () => {
    [owner, liquidator, ...accounts] = await ethers.getSigners();

    const FlashMintLiquidator = await ethers.getContractFactory(
      "FlashMintLiquidator"
    );
    flashLiquidator = await FlashMintLiquidator.deploy(
      config.lender,
      config.univ3Router,
      config.morpho,
      config.tokens.dai.cToken
    );
    await flashLiquidator.deployed();
    daiToken = await getTokens(
      config.tokens.dai.whale,
      "whale",
      [owner, accounts[0]],
      config.tokens.dai.address,
      utils.parseUnits("100")
    );
    usdcToken = await getTokens(
      config.tokens.usdc.whale,
      "whale",
      [owner, accounts[0]],
      config.tokens.usdc.address,
      utils.parseUnits("100", 6)
    );
    // usdtToken = await getTokens(
    //   config.tokens.usdt.whale,
    //   "whale",
    //   [owner, ...accounts],
    //   config.tokens.usdt.address,
    //   utils.parseUnits("10000")
    // );

    const CTokenABI = require("../abis/CToken.json");
    cDaiToken = new Contract(config.tokens.dai.cToken, CTokenABI, owner);
    cUsdcToken = new Contract(config.tokens.usdc.cToken, CTokenABI, owner);
    // cUsdtToken = new Contract(config.tokens.usdt.cToken, CTokenABI, owner);

    // get Morpho contract
    morpho = await ethers.getContractAt(
      require("../abis/Morpho.json"),
      config.morpho,
      owner
    );
    const comptrollerAddress = await morpho.comptroller();
    comptroller = await ethers.getContractAt(
      require("../abis/Comptroller.json"),
      comptrollerAddress,
      owner
    );
    const Oracle = await ethers.getContractFactory("SimplePriceOracle");
    oracle = await Oracle.deploy();
    await oracle.deployed();
    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("1", 18 * 2 - 18)
    );
    await oracle.setUnderlyingPrice(
      cUsdcToken.address,
      parseUnits("1", 18 * 2 - 6)
    );
    const adminAddress = await comptroller.admin();
    await hre.network.provider.send("hardhat_impersonateAccount", [
      adminAddress,
    ]);
    await hre.network.provider.send("hardhat_setBalance", [
      adminAddress,
      ethers.utils.parseEther("10").toHexString(),
    ]);
    admin = await ethers.getSigner(adminAddress);

    await comptroller.connect(admin)._setPriceOracle(oracle.address);
  };
  before(initialize);

  beforeEach(async () => {
    snapshotId = await hre.network.provider.send("evm_snapshot", []);
  });

  afterEach(async () => {
    await hre.network.provider.send("evm_revert", [snapshotId]);
  });

  it("Should liquidate a user without a flash loan", async () => {
    const [borrower] = accounts;
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("10");
    await daiToken.connect(borrower).approve(morpho.address, toSupply);

    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cDaiToken.address,
        borrowerAddress,
        toSupply
      );

    const { collateralFactorMantissa } = await comptroller.markets(
      cDaiToken.address
    );

    const { onPool, inP2P } = await morpho.supplyBalanceInOf(
      cDaiToken.address,
      borrowerAddress
    );
    const poolIndex = await cDaiToken.exchangeRateStored();
    const p2pIndex = await morpho.p2pSupplyIndex(cDaiToken.address);

    // price is 1/1 an
    const toBorrow = onPool
      .mul(poolIndex)
      .add(inP2P.mul(p2pIndex))
      .mul(collateralFactorMantissa)
      .div(pow10(18 * 3 - 6))
      .sub(pow10(6));

    const daiDecimals = await daiToken.decimals();
    const usdcDecimals = await usdcToken.decimals();
    console.log("Start borrow", daiDecimals, usdcDecimals, toBorrow.toString());
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cUsdcToken.address, 100000);

    await oracle.setDirectPrice(parseUnits("0.95", 18 * 2 - 6));
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = toBorrow.div(2);

    console.log("fill liquidator contract");
    // transfer to liquidate without flash loans
    await usdcToken
      .connect(owner)
      .transfer(flashLiquidator.address, toLiquidate);

    console.log("liquidate user");
    const liquidatorAddress = await liquidator.getAddress();
    const collateralBalanceBefore = await daiToken.balanceOf(liquidatorAddress);
    await flashLiquidator
      .connect(liquidator)
      .liquidate(cUsdcToken, daiToken, borrowerAddress, toLiquidate);

    const collateralBalanceAfter = await daiToken.balanceOf(liquidatorAddress);
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });
});
