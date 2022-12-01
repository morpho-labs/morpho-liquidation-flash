/* eslint-disable no-unused-expressions, node/no-missing-import */
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { BigNumber, Contract, Signer } from "ethers";
import { setupAave, setupToken } from "../setup";
import { parseUnits } from "ethers/lib/utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import config from "../../config";
import { FlashMintLiquidatorBorrowRepayAave, IAToken } from "../../typechain";
import {
  ERC20,
  MorphoAaveV2__factory,
  MorphoAaveV2Lens__factory,
} from "@morpho-labs/morpho-ethers-contract";
describe("Test Flash Mint liquidator on MakerDAO for Morpho AAVE", () => {
  let snapshotId: number;
  let morpho: Contract;
  // eslint-disable-next-line no-unused-vars
  let lendingPool: Contract;
  // eslint-disable-next-line no-unused-vars
  let addressesProvider: Contract;
  let flashLiquidator: FlashMintLiquidatorBorrowRepayAave;
  let oracle: Contract;
  let lens: Contract;

  let owner: Signer;
  // eslint-disable-next-line no-unused-vars
  let admin: SignerWithAddress; // comptroller admin
  let liquidator: Signer;
  let borrower: Signer;

  let daiToken: ERC20;
  let usdcToken: ERC20;
  let wEthToken: ERC20;

  let aDaiToken: IAToken;
  let aUsdcToken: IAToken;
  let aEthToken: IAToken;

  const initialize = async () => {
    [owner, liquidator, borrower] = await ethers.getSigners();

    const FlashMintLiquidator = await ethers.getContractFactory(
      "FlashMintLiquidatorBorrowRepayAave"
    );
    flashLiquidator = await FlashMintLiquidator.connect(owner).deploy(
      config.lender,
      config.univ3Router,
      config.addressesProvider,
      config.morphoAave,
      config.tokens.dai.aToken,
      config.slippageTolerance
    );
    await flashLiquidator.deployed();

    await flashLiquidator
      .connect(owner)
      .addLiquidator(await liquidator.getAddress());

    ({ token: usdcToken, aToken: aUsdcToken } = await setupToken(
      config.tokens.usdc,
      owner,
      [owner, liquidator, borrower],
      parseUnits("100000", config.tokens.usdc.decimals)
    ));
    ({ token: daiToken, aToken: aDaiToken } = await setupToken(
      config.tokens.dai,
      owner,
      [owner, liquidator, borrower],
      parseUnits("100000", config.tokens.dai.decimals)
    ));
    ({ aToken: aEthToken, token: wEthToken } = await setupToken(
      config.tokens.wEth,
      owner,
      [owner, liquidator, borrower],
      parseUnits("100000", config.tokens.wEth.decimals)
    ));

    // get Morpho contract
    morpho = MorphoAaveV2__factory.connect(config.morphoAave, owner);
    lens = MorphoAaveV2Lens__factory.connect(config.morphoAaveLens, owner);

    ({ admin, oracle, lendingPool, addressesProvider } = await setupAave(
      morpho,
      owner
    ));
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
        aDaiToken.address,
        borrowerAddress,
        toSupply
      );
    const { borrowable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aUsdcToken.address
    );

    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](aUsdcToken.address, borrowable);

    // go to LiquidationThreshold limit
    const { withdrawable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aDaiToken.address
    );

    await morpho.connect(borrower).withdraw(aDaiToken.address, withdrawable);

    const daiPrice: BigNumber = await oracle.getAssetPrice(daiToken.address);
    const usdcPrice: BigNumber = await oracle.getAssetPrice(usdcToken.address);

    await oracle.setAssetPrice(
      daiToken.address,
      daiPrice.mul(9_850).div(10_000)
    );
    await oracle.setAssetPrice(
      usdcToken.address,
      usdcPrice.mul(10_100).div(10_000)
    );

    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = borrowable.div(2);

    // transfer to liquidate without flash loans
    await usdcToken
      .connect(owner)
      .transfer(flashLiquidator.address, toLiquidate);
    const collateralBalanceBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );

    const healthFactor = await lens.getUserHealthFactor(borrowerAddress);
    expect(healthFactor.lt(BigNumber.from(10).pow(18))).to.be.true;
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          aUsdcToken.address,
          aDaiToken.address,
          borrowerAddress,
          toLiquidate,
          true,
          "0x"
        )
    ).to.emit(flashLiquidator, "Liquidated");

    const collateralBalanceAfter = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });

  it("Should liquidate a user with a flash loan, borrow/repay on aave and a dai/usdc swap", async () => {
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("10");

    await daiToken.connect(borrower).approve(morpho.address, toSupply);
    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        aDaiToken.address,
        borrowerAddress,
        toSupply
      );
    const { borrowable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aUsdcToken.address
    );

    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](aUsdcToken.address, borrowable);

    // go to LiquidationThreshold limit
    const { withdrawable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aDaiToken.address
    );
    await morpho.connect(borrower).withdraw(aDaiToken.address, withdrawable);

    const daiPrice: BigNumber = await oracle.getAssetPrice(daiToken.address);
    const usdcPrice: BigNumber = await oracle.getAssetPrice(usdcToken.address);

    await oracle.setAssetPrice(
      daiToken.address,
      daiPrice.mul(9_850).div(10_000)
    );
    await oracle.setAssetPrice(
      usdcToken.address,
      usdcPrice.mul(10_100).div(10_000)
    );

    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = borrowable.div(2);
    const collateralBalanceBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );

    const path = ethers.utils.solidityPack(
      ["address", "uint24", "address"],
      // borrow to collateral
      [usdcToken.address, config.swapFees.stable, daiToken.address]
    );

    const healthFactor = await lens.getUserHealthFactor(borrowerAddress);
    expect(healthFactor.lt(BigNumber.from(10).pow(18))).to.be.true;
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          aUsdcToken.address,
          aDaiToken.address,
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

  it("Should liquidate a user with a flash loan, borrow/repay on aave and a usdc/eth swap", async () => {
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("10");

    await wEthToken.connect(borrower).approve(morpho.address, toSupply);
    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        aEthToken.address,
        borrowerAddress,
        toSupply
      );
    const { borrowable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aUsdcToken.address
    );

    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](aUsdcToken.address, borrowable);

    // go to LiquidationThreshold limit
    const { withdrawable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aEthToken.address
    );

    await morpho.connect(borrower).withdraw(aEthToken.address, withdrawable);

    const ethPrice: BigNumber = await oracle.getAssetPrice(wEthToken.address);
    const usdcPrice: BigNumber = await oracle.getAssetPrice(usdcToken.address);

    await oracle.setAssetPrice(
      wEthToken.address,
      ethPrice.mul(9_850).div(10_000)
    );
    await oracle.setAssetPrice(
      usdcToken.address,
      usdcPrice.mul(10_100).div(10_000)
    );

    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = borrowable.div(2);
    const collateralBalanceBefore = await wEthToken.balanceOf(
      flashLiquidator.address
    );

    const healthFactor = await lens.getUserHealthFactor(borrowerAddress);
    expect(healthFactor.lt(BigNumber.from(10).pow(18))).to.be.true;
    const path = ethers.utils.solidityPack(
      ["address", "uint24", "address"],
      // borrow to collateral
      [usdcToken.address, config.swapFees.classic, wEthToken.address]
    );
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          aUsdcToken.address,
          aEthToken.address,
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
  it("Should liquidate a user with a flash loan, on aave and a eth/dai swap (no borrow repay)", async () => {
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("10");

    await wEthToken.connect(borrower).approve(morpho.address, toSupply);
    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        aEthToken.address,
        borrowerAddress,
        toSupply
      );
    const { borrowable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aDaiToken.address
    );

    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](aDaiToken.address, borrowable);

    // go to LiquidationThreshold limit
    const { withdrawable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aEthToken.address
    );

    await morpho.connect(borrower).withdraw(aEthToken.address, withdrawable);

    const ethPrice: BigNumber = await oracle.getAssetPrice(wEthToken.address);
    const daiPrice: BigNumber = await oracle.getAssetPrice(daiToken.address);

    await oracle.setAssetPrice(
      wEthToken.address,
      ethPrice.mul(9_850).div(10_000)
    );
    await oracle.setAssetPrice(
      daiToken.address,
      daiPrice.mul(10_100).div(10_000)
    );

    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = borrowable.div(2);
    const collateralBalanceBefore = await wEthToken.balanceOf(
      flashLiquidator.address
    );

    const healthFactor = await lens.getUserHealthFactor(borrowerAddress);
    expect(healthFactor.lt(BigNumber.from(10).pow(18))).to.be.true;
    const path = ethers.utils.solidityPack(
      ["address", "uint24", "address"],
      // borrow to collateral
      [daiToken.address, config.swapFees.classic, wEthToken.address]
    );
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          aDaiToken.address,
          aEthToken.address,
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
    const ownerAddress = await owner.getAddress();
    const usdcAmount = parseUnits("10", 6);
    // transfer to liquidate without flash loans
    await usdcToken
      .connect(owner)
      .transfer(flashLiquidator.address, usdcAmount);

    const balanceBefore = await usdcToken.balanceOf(ownerAddress);
    expect(
      await flashLiquidator
        .connect(owner)
        .withdraw(usdcToken.address, ownerAddress, usdcAmount)
    ).to.emit(flashLiquidator, "Withdrawn");
    const balanceAfter = await usdcToken.balanceOf(ownerAddress);
    expect(balanceAfter.sub(balanceBefore).eq(usdcAmount)).to.be.true;
  });

  it("Should the admin be able to withdraw a part of the funds", async () => {
    const ownerAddress = await owner.getAddress();

    const usdcAmount = parseUnits("10", 6);
    await usdcToken
      .connect(owner)
      .transfer(flashLiquidator.address, usdcAmount);

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
