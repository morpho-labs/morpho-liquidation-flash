/* eslint-disable no-unused-expressions, node/no-missing-import */
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import { setupAave, setupToken } from "./setup";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import config from "../config";

describe("Test Flash Mint liquidator on MakerDAO", () => {
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

    let healthFactor = await lens.getUserHealthFactor(borrowerAddress);
    console.log(formatUnits(healthFactor));
    console.log(formatUnits(withdrawable));
    await morpho.connect(borrower).withdraw(aDaiToken.address, withdrawable);

    await oracle.setUnderlyingPrice(daiToken.address, parseUnits("0.95"));
    await oracle.setUnderlyingPrice(usdcToken.address, parseUnits("1.05"));
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

    healthFactor = await lens.getUserHealthFactor(borrowerAddress);
    console.log(formatUnits(healthFactor));
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

  it.only("Should liquidate a user with a flash loan and a dai collateral (no swap)", async () => {
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

    let healthFactor = await lens.getUserHealthFactor(borrowerAddress);
    console.log(formatUnits(healthFactor));
    console.log(formatUnits(withdrawable));
    await morpho.connect(borrower).withdraw(aDaiToken.address, withdrawable);

    await oracle.setUnderlyingPrice(daiToken.address, parseUnits("0.95"));
    await oracle.setUnderlyingPrice(usdcToken.address, parseUnits("1.05"));
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const toLiquidate = borrowable.div(2);

    const collateralBalanceBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );

    healthFactor = await lens.getUserHealthFactor(borrowerAddress);
    console.log(formatUnits(healthFactor));
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
});
