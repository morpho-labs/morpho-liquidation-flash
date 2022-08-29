/* eslint-disable no-unused-expressions, node/no-missing-import */
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { BigNumber, Contract, Signer } from "ethers";
import { setupAave, setupToken } from "./setup";
import { parseUnits } from "ethers/lib/utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import config from "../config";
import LiquidationBot from "../src/LiquidationBot";
import { Fetcher } from "../src/interfaces/Fetcher";
import NoLogger from "../src/loggers/NoLogger";

describe("Test Liquidation Bot", () => {
  let snapshotId: number;
  let morpho: Contract;
  let flashLiquidator: Contract;
  let oracle: Contract;
  let lens: Contract;

  let owner: Signer;
  let admin: SignerWithAddress; // aave admin
  let liquidator: Signer;
  let borrower: Signer;
  let liquidableUser: Signer;

  let daiToken: Contract;
  let usdcToken: Contract;
  let wEthToken: Contract;

  let aDaiToken: Contract;
  let aUsdcToken: Contract;
  let aEthToken: Contract;

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
    // get Morpho contract
    morpho = await ethers.getContractAt(
      require("../abis/aave/Morpho.json"),
      config.morphoAave,
      owner
    );
    lens = await ethers.getContractAt(
      require("../abis/aave/Lens.json"),
      config.morphoAaveLens,
      owner
    );
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
      .connect(liquidableUser)
      ["borrow(address,uint256)"](aUsdcToken.address, borrowable);

    // do it manually while the lens is nt updated
    const toWithdraw = totalSupply.mul(8500 - 8250).div(10_000); // 80% - 77%

    await morpho
      .connect(liquidableUser)
      .withdraw(aEthToken.address, toWithdraw);

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
});
