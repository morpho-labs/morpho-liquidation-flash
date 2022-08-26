/* eslint-disable no-unused-expressions, node/no-missing-import */
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { BigNumber, Contract, Signer } from "ethers";
import { setupAave, setupToken } from "./setup";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import config from "../config";

describe("Test Flash Mint liquidator on MakerDAO for Morpho AAVE", () => {
  let snapshotId: number;
  let morpho: Contract;
  let lendingPool: Contract;
  let addressesProvider: Contract;
  let flashLiquidator: Contract;
  let oracle: Contract;
  let lens: Contract;

  let owner: Signer;
  let admin: SignerWithAddress; // comptroller admin
  let liquidator: Signer;
  let borrower: Signer;

  let daiToken: Contract;
  let usdcToken: Contract;
  let wEthToken: Contract;

  let aDaiToken: Contract;
  let aUsdcToken: Contract;
  let aEthToken: Contract;

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
    morpho = new ethers.Contract(
      config.morphoAave,
      require("../abis/aave/Morpho.json"),
      owner
    );
    lens = new ethers.Contract(
      config.morphoAaveLens,
      require("../abis/aave/Lens.json"),
      owner
    );

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

    const toWithdraw = toSupply.mul(8500 - 7700).div(10_000); // 85% - 77%

    await morpho.connect(borrower).withdraw(aDaiToken.address, toWithdraw);

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
    const { totalBalance: totalSupply } =
      await lens.getCurrentSupplyBalanceInOf(
        aDaiToken.address,
        borrowerAddress
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
    // do it manually while the lens is nt updated
    const toWithdraw = totalSupply.mul(8500 - 7700).div(10_000); // 80% - 77%

    await morpho.connect(borrower).withdraw(aDaiToken.address, toWithdraw);

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
    const { totalBalance: totalSupply } =
      await lens.getCurrentSupplyBalanceInOf(
        aEthToken.address,
        borrowerAddress
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
    // do it manually while the lens is nt updated
    const toWithdraw = totalSupply.mul(8500 - 8250).div(10_000); // 80% - 77%

    await morpho.connect(borrower).withdraw(aEthToken.address, toWithdraw);

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
    const { totalBalance: totalSupply } =
      await lens.getCurrentSupplyBalanceInOf(
        aEthToken.address,
        borrowerAddress
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
    // do it manually while the lens is nt updated
    const toWithdraw = totalSupply.mul(8500 - 8250).div(10_000); // 80% - 77%

    await morpho.connect(borrower).withdraw(aEthToken.address, toWithdraw);

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
});
