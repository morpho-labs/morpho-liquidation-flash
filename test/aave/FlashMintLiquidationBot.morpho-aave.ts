/* eslint-disable no-unused-expressions, node/no-missing-import */
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { BigNumber, Contract, Signer } from "ethers";
import { setupAave, setupToken } from "../setup";
import { parseUnits } from "ethers/lib/utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import config from "../../config";
import LiquidationBot from "../../src/LiquidationBot";
import { Fetcher } from "../../src/interfaces/Fetcher";
import NoLogger from "../../src/loggers/NoLogger";
import tokens from "../../config/tokens";
import { ERC20, IAToken } from "../../typechain";
import {
  MorphoAaveV2Lens,
  MorphoAaveV2Lens__factory,
} from "@morpho-labs/morpho-ethers-contract";

describe("Test Liquidation Bot for Morpho-Aave", () => {
  let snapshotId: number;
  let morpho: Contract;
  let flashLiquidator: Contract;
  let oracle: Contract;
  let lens: MorphoAaveV2Lens;

  let owner: Signer;
  // eslint-disable-next-line no-unused-vars
  let admin: SignerWithAddress; // aave admin
  let liquidator: Signer;
  let borrower: Signer;
  let liquidableUser: Signer;

  let daiToken: ERC20;
  let usdcToken: ERC20;
  let wEthToken: ERC20;
  let usdtToken: ERC20;

  let aDaiToken: IAToken;
  let aUsdcToken: IAToken;
  let aEthToken: IAToken;
  let aUsdtToken: IAToken;

  let bot: LiquidationBot;
  let fetcher: Fetcher;
  const initialize = async () => {
    [owner, liquidator, borrower, liquidableUser] = await ethers.getSigners();

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
      [owner, liquidator, borrower, liquidableUser],
      parseUnits("100000", config.tokens.usdc.decimals)
    ));
    ({ token: daiToken, aToken: aDaiToken } = await setupToken(
      config.tokens.dai,
      owner,
      [owner, liquidator, borrower, liquidableUser],
      parseUnits("1000000000", config.tokens.dai.decimals)
    ));
    ({ aToken: aEthToken, token: wEthToken } = await setupToken(
      config.tokens.wEth,
      owner,
      [owner, liquidator, borrower, liquidableUser],
      parseUnits("100000", config.tokens.wEth.decimals)
    ));
    ({ aToken: aUsdtToken, token: usdtToken } = await setupToken(
      config.tokens.usdt,
      owner,
      [owner, liquidator, borrower, liquidableUser],
      parseUnits("100000", config.tokens.usdt.decimals)
    ));
    // get Morpho contract
    morpho = await ethers.getContractAt(
      require("../../abis/aave/Morpho.json"),
      config.morphoAave,
      owner
    );
    lens = MorphoAaveV2Lens__factory.connect(config.morphoAaveLens, owner);
    fetcher = {
      fetchUsers: async () => {
        const borrowerAddress = await borrower.getAddress();
        const liquidableUserAddress = await liquidableUser.getAddress();
        return {
          hasMore: false,
          users: [borrowerAddress, liquidableUserAddress],
          lastId: liquidableUserAddress.toLowerCase(),
        };
      },
    };
    ({ admin, oracle } = await setupAave(morpho, owner));
    bot = new LiquidationBot(
      new NoLogger(),
      fetcher,
      liquidator,
      morpho,
      lens,
      oracle,
      flashLiquidator,
      {
        profitableThresholdUSD: parseUnits("0.01"), // in ETH for aave
        protocol: "aave",
      }
    );

    const borrowerAddress = await liquidableUser.getAddress();
    const toSupply = parseUnits("1000");

    await wEthToken.connect(liquidableUser).approve(morpho.address, toSupply);
    await morpho
      .connect(liquidableUser)
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
      .connect(liquidableUser)
      ["borrow(address,uint256)"](aUsdcToken.address, borrowable);

    const { withdrawable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aEthToken.address
    );

    await morpho
      .connect(liquidableUser)
      .withdraw(aEthToken.address, withdrawable);

    const usdcPrice: BigNumber = await oracle.getAssetPrice(usdcToken.address);

    await oracle.setAssetPrice(
      usdcToken.address,
      usdcPrice.mul(10_500).div(10_000)
    );

    // Mine block
    await hre.network.provider.send("evm_mine", []);
  };
  before(initialize);

  beforeEach(async () => {
    snapshotId = await hre.network.provider.send("evm_snapshot", []);
  });

  afterEach(async () => {
    await hre.network.provider.send("evm_revert", [snapshotId]);
  });

  it("Should return a liquidatable user", async () => {
    const usersToLiquidate = await bot.computeLiquidableUsers();
    expect(usersToLiquidate).to.have.lengthOf(1, "Users length");
  });

  it("Should return correct params for a liquidable user", async () => {
    const [userToLiquidate] = await bot.computeLiquidableUsers();

    const params = await bot.getUserLiquidationParams(userToLiquidate.address);
    const path = bot.getPath(
      params.debtMarket.market,
      params.collateralMarket.market
    );

    const collateralBalanceBefore = await wEthToken.balanceOf(
      flashLiquidator.address
    );
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          params.debtMarket.market,
          params.collateralMarket.market,
          params.userAddress,
          params.toLiquidate,
          true,
          path
        )
    ).to.emit(flashLiquidator, "Liquidated");

    const collateralBalanceAfter = await wEthToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });

  it("Should return correct params for a liquidable user with a non collateral token supplied (USDT)", async () => {
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("100");

    await daiToken.connect(borrower).approve(morpho.address, toSupply);

    const usdtToSupply = parseUnits("1000", tokens.usdt.decimals);
    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        aDaiToken.address,
        borrowerAddress,
        toSupply
      );

    await usdtToken.connect(borrower).approve(morpho.address, usdtToSupply);
    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        aUsdtToken.address,
        borrowerAddress,
        usdtToSupply
      );

    // price is 1:1, just have to take care of decimals

    const { borrowable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aUsdcToken.address
    );
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](aUsdtToken.address, borrowable);

    const { withdrawable } = await lens.getUserMaxCapacitiesForAsset(
      borrowerAddress,
      aDaiToken.address
    );
    await morpho.connect(borrower).withdraw(aDaiToken.address, withdrawable);
    const daiPrice = await oracle.getAssetPrice(daiToken.address);
    await oracle.setAssetPrice(
      daiToken.address,
      daiPrice.mul(9_500).div(10_000)
    );
    // Mine block
    await hre.network.provider.send("evm_mine", []);

    const usersToLiquidate = await bot.computeLiquidableUsers();
    expect(usersToLiquidate).to.have.lengthOf(2, "Users length");
    const userToLiquidate = usersToLiquidate.find(
      (u) => u.address.toLowerCase() === borrowerAddress.toLowerCase()
    );
    expect(usersToLiquidate).to.not.be.undefined;
    const params = await bot.getUserLiquidationParams(userToLiquidate!.address);

    expect(params.collateralMarket.market.toLowerCase()).eq(
      aDaiToken.address.toLowerCase(),
      "USDT has not rewards for liquidation"
    );
    const path = bot.getPath(
      params.debtMarket.market,
      params.collateralMarket.market
    );
    const expectedPath = ethers.utils.solidityPack(
      ["address", "uint24", "address"],
      [usdtToken.address, config.swapFees.stable, daiToken.address]
    );
    expect(path).to.be.eq(expectedPath);
    const collateralBalanceBefore = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          params.debtMarket.market,
          params.collateralMarket.market,
          params.userAddress,
          params.toLiquidate,
          true,
          path
        )
    ).to.emit(flashLiquidator, "Liquidated");

    const collateralBalanceAfter = await daiToken.balanceOf(
      flashLiquidator.address
    );
    expect(collateralBalanceAfter.gt(collateralBalanceBefore)).to.be.true;
  });

  it("Should liquidate from the run function", async () => {
    expect(await bot.run()).to.emit(flashLiquidator, "Liquidated");
  });
});
