import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import { setupCompound, setupToken } from "../setup";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import { pow10 } from "../helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import config from "../../config";
import { MorphoCompoundLens } from "@morpho-labs/morpho-ethers-contract/lib/compound/MorphoCompoundLens";
import { FlashMintLiquidatorBorrowRepayCompound } from "../../typechain";
import {
  Comptroller,
  MorphoCompound,
} from "@morpho-labs/morpho-ethers-contract";

describe("Test Flash Mint liquidator on MakerDAO for Morpho Compound", () => {
  let snapshotId: number;
  let morpho: MorphoCompound;
  let comptroller: Comptroller;
  let flashLiquidator: FlashMintLiquidatorBorrowRepayCompound;
  let oracle: Contract;
  let lens: MorphoCompoundLens;

  let owner: Signer;
  let admin: SignerWithAddress; // comptroller admin
  let liquidator: Signer;
  let borrower: Signer;

  let daiToken: Contract;
  let usdcToken: Contract;
  let usdtToken: Contract;
  let wEthToken: Contract;

  let cDaiToken: Contract;
  let cUsdcToken: Contract;
  let cUsdtToken: Contract;
  let cEthToken: Contract;

  const initialize = async () => {
    [owner, liquidator, borrower] = await ethers.getSigners();

    const FlashMintLiquidator = await ethers.getContractFactory(
      "FlashMintLiquidatorBorrowRepayCompound"
    );
    flashLiquidator = await FlashMintLiquidator.connect(owner).deploy(
      config.lender,
      config.univ3Router,
      config.morphoCompound,
      config.tokens.dai.cToken,
      config.slippageTolerance
    );

    await flashLiquidator.deployed();

    await flashLiquidator
      .connect(owner)
      .addLiquidator(await liquidator.getAddress());

    ({ token: usdcToken, cToken: cUsdcToken } = await setupToken(
      config.tokens.usdc,
      owner,
      [owner, liquidator, borrower],
      parseUnits("100000", config.tokens.usdc.decimals)
    ));
    ({ token: daiToken, cToken: cDaiToken } = await setupToken(
      config.tokens.dai,
      owner,
      [owner, liquidator, borrower],
      parseUnits("100000", config.tokens.dai.decimals)
    ));
    ({ token: usdtToken, cToken: cUsdtToken } = await setupToken(
      config.tokens.usdt,
      owner,
      [owner, liquidator, borrower],
      parseUnits("100000", config.tokens.usdt.decimals)
    ));
    ({ cToken: cEthToken, token: wEthToken } = await setupToken(
      config.tokens.wEth,
      owner,
      [owner, liquidator, borrower],
      parseUnits("100000", config.tokens.wEth.decimals)
    ));
    // get Morpho contract
    morpho = (await ethers.getContractAt(
      require("../../abis/Morpho.json"),
      config.morphoCompound,
      owner
    )) as unknown as MorphoCompound;
    lens = (await ethers.getContractAt(
      require("../../abis/Lens.json"),
      config.lens,
      owner
    )) as unknown as MorphoCompoundLens;
    ({ admin, oracle, comptroller } = await setupCompound(morpho, owner));

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
      .div(pow10(18 * 3 - 18));

    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cDaiToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("0.95", 18 * 2 - 18)
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

    const collateralBalanceBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );
    const path = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint24", "address"],
      [daiToken.address, 1000, daiToken.address]
    );

    // transfer to liquidate without flash loans
    await daiToken
      .connect(owner)
      .transfer(flashLiquidator.address, toLiquidate);
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          cDaiToken.address,
          cDaiToken.address,
          borrowerAddress,
          toLiquidate,
          true,
          path
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
      .div(pow10(18 * 3 - 18));

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

    const collateralBalanceBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );
    const path = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint24", "address"],
      [daiToken.address, 1000, daiToken.address]
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
          path
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });

  it("Should liquidate a user with a flash loan and stake bonus tokens with USDC debt & DAI collateral (borrow/repay and swap)", async () => {
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

    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cUsdcToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("0.99", 18 * 2 - 18)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);
    const { totalBalance } = await lens.getCurrentBorrowBalanceInOf(
      cUsdcToken.address,
      borrowerAddress
    );
    const toLiquidate = totalBalance.div(2);

    const collateralBalanceBefore = await daiToken.balanceOf(
      liquidator.getAddress()
    );
    const collateralBalanceFlashLiquidatorBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );
    const path = ethers.utils.solidityPack(
      ["address", "uint24", "address"],
      [usdcToken.address, config.swapFees.stable, daiToken.address]
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
          path
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
  it("Should liquidate a user with a flash loan with DAI debt and USDC collateral (no borrow/repay and swap)", async () => {
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

    const collateralBalanceBefore = await usdcToken.balanceOf(
      flashLiquidator.address
    );

    const path = ethers.utils.solidityPack(
      ["address", "uint24", "address"],
      [daiToken.address, config.swapFees.classic, usdcToken.address]
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
          path
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await usdcToken.balanceOf(
      flashLiquidator.address
    );
    // we swap all the debt
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });
  it.skip("Should liquidate a user with a flash loan with USDT debt and USDC collateral (borrow/repay and swap)", async () => {
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("100", 6);
    await usdcToken.connect(borrower).approve(morpho.address, toSupply);
    console.log("Supplying USDC");
    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cUsdcToken.address,
        borrowerAddress,
        toSupply
      );
    console.log("Supplying USDC done");
    const { totalBalance: totalSupply } =
      await lens.getCurrentSupplyBalanceInOf(
        cUsdcToken.address,
        borrowerAddress
      );
    const { borrowable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      cUsdtToken.address
    );
    console.log(
      "Borrowing USDT",
      formatUnits(totalSupply, 6),
      formatUnits(borrowable, 6)
    );

    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cUsdtToken.address, "85499999");
    console.log("Borrowing USDT done");
    await oracle.setUnderlyingPrice(
      cUsdcToken.address,
      parseUnits("0.96", 18 * 2 - 6)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);
    const { totalBalance: totalBorrow } =
      await lens.getCurrentBorrowBalanceInOf(
        cUsdtToken.address,
        borrowerAddress
      );
    const toLiquidate = totalBorrow.div(2);

    const collateralBalanceBefore = await usdcToken.balanceOf(
      flashLiquidator.address
    );

    const path = ethers.utils.solidityPack(
      ["address", "uint24", "address"],
      [usdtToken.address, config.swapFees.classic, usdcToken.address]
    );
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          cUsdtToken.address,
          cUsdcToken.address,
          borrowerAddress,
          toLiquidate,
          true,
          path
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await usdcToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });
  it("Should liquidate a user with a flash loan, WETH debt and USDC collateral (borrow/repay wrap and swap)", async () => {
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

    // price is 1/1 between usdt & usd
    const { maxDebtValue: toBorrowUSD } = await lens.getUserBalanceStates(
      borrowerAddress,
      [cUsdcToken.address, cEthToken.address]
    );
    const ethPrice = await oracle.getUnderlyingPrice(cEthToken.address);
    const toBorrow = toBorrowUSD.mul(pow10(18)).div(ethPrice);
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cEthToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cUsdcToken.address,
      parseUnits("0.98", 18 * 2 - 6)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const { onPool: debtOnPool, inP2P: debtInP2P } =
      await morpho.borrowBalanceInOf(cEthToken.address, borrower.getAddress());

    const debtPoolIndex = await cEthToken.borrowIndex();
    const debtP2PIndex = await morpho.p2pBorrowIndex(cEthToken.address);
    const toLiquidate = debtOnPool
      .mul(debtPoolIndex)
      .add(debtInP2P.mul(debtP2PIndex))
      .div(2)
      .div(pow10(18));

    const collateralBalanceBefore = await usdcToken.balanceOf(
      flashLiquidator.address
    );

    const path = ethers.utils.solidityPack(
      ["address", "uint24", "address"],
      [wEthToken.address, config.swapFees.classic, usdcToken.address]
    );
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          cEthToken.address,
          cUsdcToken.address,
          borrowerAddress,
          toLiquidate,
          true,
          path
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await usdcToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });
  it("Should liquidate a user with a flash loan, USDC debt and WETH collateral (borrow/repay unwrap and swap)", async () => {
    const borrowerAddress = await borrower.getAddress();

    const toSupply = parseUnits("1", 18);
    await wEthToken.connect(borrower).approve(morpho.address, toSupply);
    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cEthToken.address,
        borrowerAddress,
        toSupply
      );
    const { maxDebtValue: toBorrowUSD } = await lens.getUserBalanceStates(
      borrowerAddress,
      [cUsdcToken.address, cEthToken.address]
    );
    const usdcPrice = await oracle.getUnderlyingPrice(cUsdcToken.address);
    const toBorrow = toBorrowUSD.mul(pow10(18)).div(usdcPrice); // 6 decimals
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cUsdcToken.address, toBorrow);

    const ethPrice = await oracle.getUnderlyingPrice(cEthToken.address);
    await oracle.setUnderlyingPrice(
      cEthToken.address,
      ethPrice.mul(99).div(100)
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

    const collateralBalanceBefore = await wEthToken.balanceOf(
      flashLiquidator.address
    );

    const path = ethers.utils.solidityPack(
      ["address", "uint24", "address"],
      [usdcToken.address, config.swapFees.classic, wEthToken.address]
    );
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          cUsdcToken.address,
          cEthToken.address,
          borrowerAddress,
          toLiquidate,
          true,
          path
        )
    ).to.emit(flashLiquidator, "Liquidated");
    const collateralBalanceAfter = await wEthToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });

  it("Should the admin be able to withdraw funds", async () => {
    const usdcAmount = parseUnits("10", 6);
    // transfer to liquidate without flash loans
    await usdcToken
      .connect(owner)
      .transfer(flashLiquidator.address, usdcAmount);

    const balanceBefore = await usdcToken.balanceOf(owner.getAddress());
    expect(
      await flashLiquidator
        .connect(owner)
        .withdraw(usdcToken.address, await owner.getAddress(), usdcAmount)
    ).to.emit(flashLiquidator, "Withdrawn");
    const balanceAfter = await usdcToken.balanceOf(owner.getAddress());
    expect(balanceAfter.sub(balanceBefore).eq(usdcAmount)).to.be.true;
  });

  it("Should the admin be able to withdraw a part of the funds", async () => {
    const usdcAmount = parseUnits("10", 6);
    await usdcToken
      .connect(owner)
      .transfer(flashLiquidator.address, usdcAmount);
    const ownerAddress = await owner.getAddress();
    const balanceBefore = await usdcToken.balanceOf(ownerAddress);
    expect(
      await flashLiquidator
        .connect(owner)
        .withdraw(usdcToken.address, ownerAddress, usdcAmount.div(2))
    ).to.emit(flashLiquidator, "Withdrawn");
    const balanceAfter = await usdcToken.balanceOf(ownerAddress);
    expect(balanceAfter.sub(balanceBefore).eq(usdcAmount.div(2))).to.be.true;
  });
  it("Should not a non admin be able to withdraw funds", async () => {
    const usdcAmount = parseUnits("10", 6);
    await usdcToken
      .connect(owner)
      .transfer(flashLiquidator.address, usdcAmount);

    expect(
      flashLiquidator
        .connect(owner)
        .withdraw(
          usdcToken.address,
          await liquidator.getAddress(),
          usdcAmount.div(2)
        )
    ).to.revertedWith("");
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
