/* eslint-disable no-unused-expressions, node/no-missing-import */
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import { config, setupCompound } from "./setup";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import { pow10 } from "./helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { cropHexString, getBalanceOfStorageSlot, padHexString } from "./utils";

describe("Test Flash Mint liquidator on MakerDAO", () => {
  let snapshotId: number;
  let morpho: Contract;
  let comptroller: Contract;
  let flashLiquidator: Contract;
  let oracle: Contract;
  let lens: Contract;

  let owner: Signer;
  let admin: SignerWithAddress; // comptroller admin
  let liquidator: Signer;
  let borrower: Signer;

  let daiToken: Contract;
  let usdcToken: Contract;
  let feiToken: Contract;

  let cDaiToken: Contract;
  let cUsdcToken: Contract;
  let cFeiToken: Contract;

  const initialize = async () => {
    [owner, liquidator, borrower] = await ethers.getSigners();

    const FlashMintLiquidator = await ethers.getContractFactory(
      "FlashMintLiquidatorDoubleSwap"
    );
    flashLiquidator = await FlashMintLiquidator.connect(owner).deploy(
      config.lender,
      config.univ3Router,
      config.morpho,
      config.tokens.dai.cToken,
      config.slippageTolerance
    );
    await flashLiquidator.deployed();

    await flashLiquidator
      .connect(owner)
      .addLiquidator(await liquidator.getAddress());

    daiToken = await ethers.getContractAt(
      require("../abis/ERC20.json"),
      config.tokens.dai.address,
      owner
    );
    await Promise.all(
      [owner, liquidator, borrower].map(async (acc) => {
        const balanceOfUserStorageSlot = getBalanceOfStorageSlot(
          await acc.getAddress(),
          config.tokens.dai.balanceOfStorageSlot
        );
        await hre.ethers.provider.send("hardhat_setStorageAt", [
          daiToken.address,
          cropHexString(balanceOfUserStorageSlot),
          padHexString(parseUnits("10000000").toHexString()),
        ]);
      })
    );
    usdcToken = await ethers.getContractAt(
      require("../abis/ERC20.json"),
      config.tokens.usdc.address,
      owner
    );
    await Promise.all(
      [owner, liquidator, borrower].map(async (acc) => {
        const balanceOfUserStorageSlot = getBalanceOfStorageSlot(
          await acc.getAddress(),
          config.tokens.usdc.balanceOfStorageSlot
        );
        await hre.ethers.provider.send("hardhat_setStorageAt", [
          usdcToken.address,
          cropHexString(balanceOfUserStorageSlot),
          padHexString(parseUnits("10000", 6).toHexString()),
        ]);
      })
    );
    feiToken = await ethers.getContractAt(
      require("../abis/ERC20.json"),
      config.tokens.fei.address,
      owner
    );
    await Promise.all(
      [owner, liquidator, borrower].map(async (acc) => {
        const balanceOfUserStorageSlot = getBalanceOfStorageSlot(
          await acc.getAddress(),
          config.tokens.fei.balanceOfStorageSlot
        );
        await hre.ethers.provider.send("hardhat_setStorageAt", [
          feiToken.address,
          cropHexString(balanceOfUserStorageSlot),
          padHexString(parseUnits("10000").toHexString()),
        ]);
      })
    );

    // get Morpho contract
    morpho = await ethers.getContractAt(
      require("../abis/Morpho.json"),
      config.morpho,
      owner
    );
    lens = await ethers.getContractAt(
      require("../abis/Lens.json"),
      config.lens,
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

  it("Should liquidate a user without a flash loan", async () => {
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("10");

    await daiToken.connect(borrower).approve(morpho.address, toSupply);
    const balance = await daiToken.balanceOf(borrowerAddress);
    console.log(balance.toString(), toSupply.toString());
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

    // price is 1:1
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
          true,
          0,
          0
        )
    ).to.emit(flashLiquidator, "Liquidated");

    const collateralBalanceAfter = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });

  it("Should liquidate a user with a flash loan and no swap", async () => {
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
      ["borrow(address,uint256)"](cDaiToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("0.95", 18 * 2 - 18)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);
    await hre.network.provider.send("evm_mine", []);
    await hre.network.provider.send("evm_mine", []);

    const { onPool: debtOnPool, inP2P: debtInP2P } =
      await morpho.borrowBalanceInOf(cDaiToken.address, borrower.getAddress());

    const debtPoolIndex = await cDaiToken.borrowIndex();
    const debtP2PIndex = await morpho.p2pBorrowIndex(cDaiToken.address);
    const toLiquidate = debtOnPool
      .mul(debtPoolIndex)
      .add(debtInP2P.mul(debtP2PIndex))
      .div(2)
      .div(pow10(18));

    console.log("fill liquidator contract");

    console.log(
      "liquidate user",
      formatUnits(toLiquidate, 6),
      formatUnits(toBorrow.div(2), 6)
    );
    const collateralBalanceBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );

    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          cDaiToken.address,
          cDaiToken.address,
          borrowerAddress,
          toLiquidate,
          true,
          0,
          0
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

    const situationBefore = await lens.getUserBalanceStates(borrowerAddress, [
      cUsdcToken.address,
      cDaiToken.address,
    ]);
    console.log(
      formatUnits(
        situationBefore.maxDebtValue
          .mul(parseUnits("1"))
          .div(situationBefore.debtValue)
      )
    );

    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("0.99", 18 * 2 - 18)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const situationAfter = await lens.getUserBalanceStates(borrowerAddress, [
      cUsdcToken.address,
      cDaiToken.address,
    ]);
    console.log(
      formatUnits(
        situationAfter.maxDebtValue
          .mul(parseUnits("1"))
          .div(situationAfter.debtValue)
      )
    );

    const { totalBalance } = await lens.getUpdatedUserBorrowBalance(
      borrowerAddress,
      cUsdcToken.address
    );
    const toLiquidate = totalBalance.div(2);

    console.log(
      "liquidate user",
      formatUnits(toLiquidate),
      formatUnits(totalBalance.div(2))
    );
    const collateralBalanceBefore = await daiToken.balanceOf(
      liquidator.getAddress()
    );
    const collateralBalanceFlashLiquidatorBefore = await daiToken.balanceOf(
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
          true,
          config.swapFees.stable,
          0
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await daiToken.balanceOf(
      liquidator.getAddress()
    );
    const collateralBalanceFlashLiquidatorAfter = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(
      // if over swapped DAI
      collateralBalanceFlashLiquidatorAfter.gte(
        collateralBalanceFlashLiquidatorBefore
      )
    ).to.be.true;
    expect(collateralBalanceAfter.gte(collateralBalanceBefore)).to.be.true;
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
      parseUnits("0.999", 18 * 2 - 6)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const { onPool: debtOnPool, inP2P: debtInP2P } =
      await morpho.borrowBalanceInOf(cDaiToken.address, borrower.getAddress());

    const debtPoolIndex = await cDaiToken.borrowIndex();
    const debtP2PIndex = await morpho.p2pBorrowIndex(cDaiToken.address);
    const toLiquidate = debtOnPool
      .mul(debtPoolIndex)
      .add(debtInP2P.mul(debtP2PIndex))
      .div(2)
      .div(pow10(18));

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
          true,
          0,
          config.swapFees.stable
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await cDaiToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });
  it("Should liquidate a user with a flash loan and stake bonus tokens with two swaps", async () => {
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
      .div(pow10(36 - 12))
      .sub(1000000000000); // rounding errors

    console.log("Start borrow", toBorrow.toString());
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cFeiToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cUsdcToken.address,
      parseUnits("0.98", 18 * 2 - 6)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const { onPool: debtOnPool, inP2P: debtInP2P } =
      await morpho.borrowBalanceInOf(cUsdcToken.address, borrower.getAddress());

    const debtPoolIndex = await cUsdcToken.borrowIndex();
    const debtP2PIndex = await morpho.p2pBorrowIndex(cUsdcToken.address);
    const toLiquidate = debtOnPool
      .mul(debtPoolIndex)
      .add(debtInP2P.mul(debtP2PIndex))
      .div(2)
      .div(pow10(18));
    console.log("liquidate user");
    const collateralBalanceBefore = await usdcToken.balanceOf(
      flashLiquidator.address
    );

    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          cFeiToken.address,
          cUsdcToken.address,
          borrowerAddress,
          toLiquidate,
          true,
          config.swapFees.classic,
          config.swapFees.classic
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await usdcToken.balanceOf(
      flashLiquidator.address
    );
    const rewardsAmount = collateralBalanceAfter.sub(collateralBalanceBefore);
    console.log(
      "Liquidated amount rewarded",
      formatUnits(rewardsAmount, 6),
      "USDC"
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });

  it("Should the admin be able to withdraw funds", async () => {
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

  it("Should the admin be able to withdraw a part of the funds", async () => {
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
        .withdraw(usdcToken.address, owner.getAddress(), usdcAmount.div(2))
    ).to.emit(flashLiquidator, "Withdrawn");
    const balanceAfter = await usdcToken.balanceOf(owner.getAddress());
    expect(balanceAfter.sub(balanceBefore).eq(usdcAmount.div(2))).to.be.true;
  });

  it("Should the admin be able to change the slippage tolerance", async () => {
    const newSlippageTolerance = 150;
    expect(
      await flashLiquidator
        .connect(owner)
        .setSlippageTolerance(newSlippageTolerance)
    ).to.emit(flashLiquidator, "SlippageToleranceSet");
    const slippageTolerance = await flashLiquidator.slippageTolerance();
    expect(slippageTolerance.eq(newSlippageTolerance));
  });
});
