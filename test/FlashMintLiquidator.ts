import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Contract, Signer, utils } from "ethers";
import { config, getTokens, setupCompound } from "./setup";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import { pow10 } from "./helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

describe("Test Flash Mint liquidator on MakerDAO", () => {
  let snapshotId: number;
  let morpho: Contract;
  let comptroller: Contract;
  let flashLiquidator: Contract;
  let oracle: Contract;

  let owner: Signer;
  let admin: SignerWithAddress; // comptroller admin
  let liquidator: Signer;
  let borrower: Signer;
  let randomLiquidator: Signer;
  let accounts: Signer[];

  let daiToken: Contract;
  let usdcToken: Contract;
  let feiToken: Contract;

  let cDaiToken: Contract;
  let cUsdcToken: Contract;
  let cFeiToken: Contract;

  const initialize = async () => {
    [owner, liquidator, borrower, randomLiquidator, ...accounts] =
      await ethers.getSigners();

    const FlashMintLiquidator = await ethers.getContractFactory(
      "FlashMintLiquidator"
    );
    flashLiquidator = await FlashMintLiquidator.connect(owner).deploy(
      config.lender,
      config.univ3Router,
      config.morpho,
      config.tokens.dai.cToken
    );
    await flashLiquidator.deployed();

    await flashLiquidator
      .connect(owner)
      .addLiquidator(await liquidator.getAddress());

    daiToken = await getTokens(
      config.tokens.dai.whale,
      "whale",
      [owner, borrower],
      config.tokens.dai.address,
      utils.parseUnits("100")
    );
    usdcToken = await getTokens(
      config.tokens.usdc.whale,
      "whale",
      [owner, borrower],
      config.tokens.usdc.address,
      utils.parseUnits("100", 6)
    );
    feiToken = await getTokens(
      config.tokens.fei.whale,
      "whale",
      [owner, accounts[0]],
      config.tokens.fei.address,
      utils.parseUnits("10")
    );

    // get Morpho contract
    morpho = await ethers.getContractAt(
      require("../abis/Morpho.json"),
      config.morpho,
      owner
    );
    const poolSetup = await setupCompound(morpho, owner);
    admin = poolSetup.admin;
    oracle = poolSetup.oracle;
    comptroller = poolSetup.comptroller;

    const CTokenABI = require("../abis/CToken.json");
    cDaiToken = new Contract(config.tokens.dai.cToken, CTokenABI, owner);
    cUsdcToken = new Contract(config.tokens.usdc.cToken, CTokenABI, owner);
    cFeiToken = new Contract(config.tokens.fei.cToken, CTokenABI, owner);

    await comptroller.connect(admin)._setPriceOracle(oracle.address);
  };
  before(initialize);

  beforeEach(async () => {
    snapshotId = await hre.network.provider.send("evm_snapshot", []);
  });

  afterEach(async () => {
    await hre.network.provider.send("evm_revert", [snapshotId]);
  });

  it.skip("Should liquidate a user without a flash loan", async () => {
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
      .div(pow10(18 * 3 - 6));

    console.log("Start borrow", toBorrow.toString());
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cUsdcToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("0.95", 18 * 2 - 18)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = toBorrow.div(2);

    console.log("fill liquidator contract");
    // transfer to liquidate without flash loans
    await usdcToken
      .connect(owner)
      .transfer(flashLiquidator.address, toLiquidate);

    console.log("liquidate user");
    const collateralBalanceBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          cUsdcToken.address,
          cDaiToken.address,
          borrowerAddress,
          toLiquidate,
          true
        )
    ).to.emit(flashLiquidator, "Liquidated");

    const collateralBalanceAfter = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });

  it("Should liquidate a user with a flash loan as random liquidator", async () => {
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
      .div(pow10(18 * 3 - 6));

    console.log("Start borrow", toBorrow.toString());
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cUsdcToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("0.95", 18 * 2 - 18)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = toBorrow.div(2);

    console.log("fill liquidator contract");

    console.log("liquidate user");
    const collateralBalanceBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );

    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          cUsdcToken.address,
          cDaiToken.address,
          borrowerAddress,
          toLiquidate,
          true
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });
  it("Should liquidate a user with a flash loan and stake bonus tokens with debt swap", async () => {
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
      .div(pow10(18 * 3 - 6));

    console.log("Start borrow", toBorrow.toString());
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cUsdcToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("0.95", 18 * 2 - 18)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = toBorrow.div(2);

    console.log("fill liquidator contract");

    console.log("liquidate user");
    const collateralBalanceBefore = await daiToken.balanceOf(
      randomLiquidator.getAddress()
    );
    const collateralBalanceFlashLiquidatorBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(
      await flashLiquidator
        .connect(randomLiquidator)
        .liquidate(
          cUsdcToken.address,
          cDaiToken.address,
          borrowerAddress,
          toLiquidate,
          true
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await daiToken.balanceOf(
      randomLiquidator.getAddress()
    );
    const collateralBalanceFlashLiquidatorAfter = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(
      collateralBalanceFlashLiquidatorAfter.eq(
        collateralBalanceFlashLiquidatorBefore
      )
    ).to.be.true;
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });
  it("Should liquidate a user with a flash loan and stake bonus tokens with collateral swap", async () => {
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("10", 6);
    await usdcToken.connect(borrower).approve(morpho.address, toSupply);

    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cUsdcToken.address,
        borrowerAddress,
        toSupply
      );

    const { collateralFactorMantissa } = await comptroller.markets(
      cUsdcToken.address
    );

    const { onPool, inP2P } = await morpho.supplyBalanceInOf(
      cUsdcToken.address,
      borrowerAddress
    );
    const poolIndex = await cUsdcToken.exchangeRateStored();
    const p2pIndex = await morpho.p2pSupplyIndex(cUsdcToken.address);

    // price is 1/1 an
    const toBorrow = onPool
      .mul(poolIndex)
      .add(inP2P.mul(p2pIndex))
      .mul(collateralFactorMantissa)
      .div(pow10(18 + 6))
      .sub(pow10(15)); // roundings errors

    console.log("Start borrow", formatUnits(toBorrow));
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cDaiToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cUsdcToken.address,
      parseUnits("0.95", 18 * 2 - 6)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = toBorrow.div(2);

    console.log("fill liquidator contract");

    console.log("liquidate user");
    const collateralBalanceBefore = await cDaiToken.balanceOf(
      flashLiquidator.address
    );

    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          cDaiToken.address,
          cUsdcToken.address,
          borrowerAddress,
          toLiquidate,
          true
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await cDaiToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });
  it.skip("Should liquidate a user with a flash loan and stake bonus tokens with two swaps", async () => {
    const { isCreated } = await morpho.marketStatus(cFeiToken.address);
    expect(isCreated).to.be.true;
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("10");
    await feiToken.connect(borrower).approve(morpho.address, toSupply);

    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cFeiToken.address,
        borrowerAddress,
        toSupply
      );

    const { collateralFactorMantissa } = await comptroller.markets(
      cFeiToken.address
    );

    const { onPool, inP2P } = await morpho.supplyBalanceInOf(
      cFeiToken.address,
      borrowerAddress
    );
    const poolIndex = await cFeiToken.exchangeRateStored();
    const p2pIndex = await morpho.p2pSupplyIndex(cFeiToken.address);

    console.log(onPool, inP2P, poolIndex, p2pIndex, collateralFactorMantissa);
    // price is 1/1 an
    const toBorrow = onPool
      .mul(poolIndex)
      .add(inP2P.mul(p2pIndex))
      .mul(collateralFactorMantissa);

    console.log("Start borrow", toBorrow.toString());
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cUsdcToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cFeiToken.address,
      parseUnits("0.95", 18 * 2 - 18)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = toBorrow.div(2);

    console.log("fill liquidator contract");

    console.log("liquidate user");
    const collateralBalanceBefore = await feiToken.balanceOf(
      flashLiquidator.address
    );

    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          cUsdcToken.address,
          cDaiToken.address,
          borrowerAddress,
          toLiquidate,
          true
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await feiToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });

  it("Should be able to withdraw funds", async () => {
    const usdcAmount = parseUnits("10", 6);
    console.log("fill liquidator contract");
    // transfer to liquidate without flash loans
    await usdcToken
      .connect(owner)
      .transfer(flashLiquidator.address, usdcAmount);

    const balanceBefore = await usdcToken.balanceOf(owner.getAddress());
    expect(
      await flashLiquidator
        .connect(owner)
        .withdraw(usdcToken.address, owner.getAddress(), usdcAmount)
    ).to.emit(flashLiquidator, "Withdrawn");
    const balanceAfter = await usdcToken.balanceOf(owner.getAddress());
    expect(balanceAfter.sub(balanceBefore).eq(usdcAmount)).to.be.true;
  });
});
