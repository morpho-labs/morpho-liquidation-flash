/* eslint-disable no-unused-expressions, node/no-missing-import */
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { BigNumber, Contract, Signer } from "ethers";
import { setupCompound, setupToken } from "../setup";
import { parseUnits } from "ethers/lib/utils";
import { pow10 } from "../helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import config from "../../config";
import LiquidationBot from "../../src/LiquidationBot";
import { IFetcher } from "../../src/interfaces/IFetcher";
import NoLogger from "../../src/loggers/NoLogger";
import {
  FlashMintLiquidatorBorrowRepayCompound,
  SimplePriceOracle,
  ICToken,
} from "../../typechain";
import { MorphoCompoundLens } from "@morpho-labs/morpho-ethers-contract/lib/compound/MorphoCompoundLens";
import {
  ERC20,
  MorphoCompound__factory,
  MorphoCompoundLens__factory,
} from "@morpho-labs/morpho-ethers-contract";
import MorphoCompoundAdapter from "../../src/morpho/MorphoCompoundAdapter";
import LiquidatorHandler from "../../src/LiquidationHandler/LiquidatorHandler";

describe("Test Liquidation Bot for Morpho-Compound", () => {
  let snapshotId: number;
  let morpho: Contract;
  let comptroller: Contract;
  let flashLiquidator: FlashMintLiquidatorBorrowRepayCompound;
  let oracle: SimplePriceOracle;
  let lens: MorphoCompoundLens;

  let owner: Signer;
  let admin: SignerWithAddress; // comptroller admin
  let liquidator: Signer;
  let borrower: Signer;
  let liquidableUser: Signer;

  let daiToken: ERC20;
  let usdcToken: ERC20;
  let usdtToken: ERC20;
  let wEthToken: ERC20;
  let compToken: ERC20;

  let cDaiToken: ICToken;
  let cUsdcToken: ICToken;
  let cUsdtToken: ICToken;
  let cEthToken: ICToken;
  let cCompToken: ICToken;

  let bot: LiquidationBot;
  let fetcher: IFetcher;
  const initialize = async () => {
    [owner, liquidator, borrower, liquidableUser] = await ethers.getSigners();

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
      [owner, liquidator, borrower, liquidableUser],
      parseUnits("100000", config.tokens.usdc.decimals)
    ));
    ({ token: daiToken, cToken: cDaiToken } = await setupToken(
      config.tokens.dai,
      owner,
      [owner, liquidator, borrower, liquidableUser],
      parseUnits("1000000000", config.tokens.dai.decimals)
    ));
    ({ token: usdtToken, cToken: cUsdtToken } = await setupToken(
      config.tokens.usdt,
      owner,
      [owner, liquidator, borrower, liquidableUser],
      parseUnits("100000", config.tokens.usdt.decimals)
    ));
    ({ cToken: cEthToken, token: wEthToken } = await setupToken(
      config.tokens.wEth,
      owner,
      [owner, liquidator, borrower, liquidableUser],
      parseUnits("100000", config.tokens.wEth.decimals)
    ));
    ({ cToken: cCompToken, token: compToken } = await setupToken(
      config.tokens.comp,
      owner,
      [owner, liquidator, borrower, liquidableUser],
      parseUnits("10000000", config.tokens.comp.decimals)
    ));

    // get Morpho contract
    morpho = MorphoCompound__factory.connect(config.morphoCompound, owner);
    lens = MorphoCompoundLens__factory.connect(config.lens, owner);
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
    ({ admin, oracle, comptroller } = await setupCompound(morpho, owner));
    const adapter = new MorphoCompoundAdapter(lens, oracle);

    const handler = new LiquidatorHandler(
      flashLiquidator,
      liquidator,
      new NoLogger()
    );

    bot = new LiquidationBot(
      new NoLogger(),
      fetcher,
      liquidator.provider!,
      handler,
      adapter,
      {
        profitableThresholdUSD: parseUnits("0.01"),
      }
    );
    await comptroller.connect(admin)._setPriceOracle(oracle.address);

    const borrowerAddress = await liquidableUser.getAddress();
    const toSupply = parseUnits("10");

    await daiToken.connect(liquidableUser).approve(morpho.address, toSupply);
    await morpho
      .connect(liquidableUser)
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

    await morpho
      .connect(liquidableUser)
      ["borrow(address,uint256)"](cUsdcToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("0.95", 18 * 2 - 18)
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
  it("Should return correct params for a liquidable user with a non collateral token supplied (USDT)", async () => {
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("10");

    await daiToken.connect(borrower).approve(morpho.address, toSupply);

    const usdtToSupply = parseUnits("1000", config.tokens.usdt.decimals);
    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cDaiToken.address,
        borrowerAddress,
        toSupply
      );

    await usdtToken.connect(borrower).approve(morpho.address, usdtToSupply);
    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cUsdtToken.address,
        borrowerAddress,
        usdtToSupply
      );

    // price is 1:1, just have to take care of decimals
    const { maxDebtValue: toBorrowInUSD } = await lens.getUserBalanceStates(
      borrowerAddress,
      [cUsdcToken.address]
    );
    const toBorrow = toBorrowInUSD.div(pow10(12)); // to 6 decimals
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cUsdcToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("0.92", 18 * 2 - 18)
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
      cDaiToken.address.toLowerCase()
    );
    const path = bot.getPath(
      params.debtMarket.market,
      params.collateralMarket.market
    );
    const expectedPath = ethers.utils.solidityPack(
      ["address", "uint24", "address"],
      [usdcToken.address, config.swapFees.stable, daiToken.address]
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
  it("Should return correct params for a liquidable user with multiple supplied tokens", async () => {
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("1500");

    await daiToken.connect(borrower).approve(morpho.address, toSupply);

    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cDaiToken.address,
        borrowerAddress,
        toSupply
      );

    const usdcToSupply = parseUnits("25000", 6);
    await usdcToken.connect(borrower).approve(morpho.address, usdcToSupply);

    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cUsdcToken.address,
        borrowerAddress,
        usdcToSupply
      );

    const wEthToSupply = parseUnits("1.5");

    await wEthToken.connect(borrower).approve(morpho.address, wEthToSupply);

    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cEthToken.address,
        borrowerAddress,
        wEthToSupply
      );

    const { maxDebtValue: toBorrow } = await lens.getUserBalanceStates(
      borrowerAddress,
      [cUsdcToken.address]
    );
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cUsdcToken.address, toBorrow.div(pow10(12)));

    await oracle.setUnderlyingPrice(
      cDaiToken.address,
      parseUnits("0.90", 18 * 2 - 18)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);
    const usersToLiquidate = await bot.computeLiquidableUsers();
    expect(usersToLiquidate).to.have.lengthOf(2);
    expect(
      usersToLiquidate
        .map((u) => u.address.toLowerCase())
        .includes(borrowerAddress.toLowerCase())
    ).to.be.true;
    const params = await bot.getUserLiquidationParams(borrowerAddress);

    expect(params.collateralMarket.market.toLowerCase()).eq(
      cUsdcToken.address.toLowerCase()
    );

    const path = bot.getPath(
      params.debtMarket.market,
      params.collateralMarket.market
    );
    expect(path).eq("0x", "Wrong default path");
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
  });
  it("Should detect a non profitable liquidation", async () => {
    const [userToLiquidate] = await bot.computeLiquidableUsers();
    const params = await bot.getUserLiquidationParams(userToLiquidate.address);

    expect(bot.isProfitable(params.toLiquidate, params.debtMarket.price)).to.be
      .false;
  });
  it("Should return correct params for a liquidable user with a WETH debt", async () => {
    const borrowerAddress = await borrower.getAddress();
    const toSupply = parseUnits("1500");

    await daiToken.connect(borrower).approve(morpho.address, toSupply);

    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cDaiToken.address,
        borrowerAddress,
        toSupply
      );

    const usdcToSupply = parseUnits("1500", 6);
    await usdcToken.connect(borrower).approve(morpho.address, usdcToSupply);

    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cUsdcToken.address,
        borrowerAddress,
        usdcToSupply
      );

    const { maxDebtValue: toBorrowUSD } = await lens.getUserBalanceStates(
      borrowerAddress,
      [cEthToken.address]
    );
    const ethPrice: BigNumber = await oracle.getUnderlyingPrice(
      cEthToken.address
    );
    const toBorrow = toBorrowUSD.mul(pow10(18)).div(ethPrice);
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cEthToken.address, toBorrow);

    await oracle.setUnderlyingPrice(
      cEthToken.address,
      ethPrice.mul(101).div(100)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const usersToLiquidate = await bot.computeLiquidableUsers();
    expect(usersToLiquidate).to.have.lengthOf(2);
    const userToLiquidate = usersToLiquidate.find(
      (u) => u.address.toLowerCase() === borrowerAddress.toLowerCase()
    );
    expect(userToLiquidate).to.not.be.undefined;
    const params = await bot.getUserLiquidationParams(borrowerAddress);

    const toRepay = await lens.computeLiquidationRepayAmount(
      borrowerAddress,
      params.debtMarket.market,
      params.collateralMarket.market,
      [params.collateralMarket.market, params.debtMarket.market]
    );
    expect(params.debtMarket.market.toLowerCase()).eq(
      cEthToken.address.toLowerCase()
    );

    const path = bot.getPath(
      params.debtMarket.market,
      params.collateralMarket.market
    );
    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          params.debtMarket.market,
          params.collateralMarket.market,
          params.userAddress,
          toRepay,
          true,
          path
        )
    ).to.emit(flashLiquidator, "Liquidated");
  });
  it("Should liquidate a debt of COMP", async () => {
    const borrowerAddress = await borrower.getAddress();
    const amount = 15_000;
    const toSupply = parseUnits(amount.toString());

    await daiToken.connect(borrower).approve(morpho.address, toSupply);

    await morpho
      .connect(borrower)
      ["supply(address,address,uint256)"](
        cDaiToken.address,
        borrowerAddress,
        toSupply
      );
    const { maxDebtValue: toBorrowUSD } = await lens.getUserBalanceStates(
      borrowerAddress,
      [cCompToken.address]
    );
    const compPrice: BigNumber = await oracle.getUnderlyingPrice(
      cCompToken.address
    );
    const toBorrow = toBorrowUSD.mul(pow10(18)).div(compPrice);
    await morpho
      .connect(borrower)
      ["borrow(address,uint256)"](cCompToken.address, toBorrow);
    await oracle.setUnderlyingPrice(
      cCompToken.address,
      compPrice.mul(101).div(100)
    );
    // Mine block

    await hre.network.provider.send("evm_mine", []);

    const usersToLiquidate = await bot.computeLiquidableUsers();
    expect(usersToLiquidate).to.have.lengthOf(2);
    const userToLiquidate = usersToLiquidate.find(
      (u) => u.address.toLowerCase() === borrowerAddress.toLowerCase()
    );
    expect(userToLiquidate).to.not.be.undefined;
    const params = await bot.getUserLiquidationParams(borrowerAddress);

    const toRepay = await lens.computeLiquidationRepayAmount(
      borrowerAddress,
      params.debtMarket.market,
      params.collateralMarket.market,
      [params.collateralMarket.market, params.debtMarket.market]
    );

    expect(params.debtMarket.market.toLowerCase()).eq(
      cCompToken.address.toLowerCase()
    );

    const path = bot.getPath(
      params.debtMarket.market,
      params.collateralMarket.market
    );

    expect(
      await flashLiquidator
        .connect(liquidator)
        .liquidate(
          params.debtMarket.market,
          params.collateralMarket.market,
          params.userAddress,
          toRepay,
          true,
          path
        )
    ).to.emit(flashLiquidator, "Liquidated");
  });
  it("Should detect a non profitable liquidation", async () => {
    const [userToLiquidate] = await bot.computeLiquidableUsers();
    const params = await bot.getUserLiquidationParams(userToLiquidate.address);

    expect(bot.isProfitable(params.toLiquidate, params.debtMarket.price)).to.be
      .false;
  });
  it("Should liquidate from the bot function", async () => {
    const [userToLiquidate] = await bot.computeLiquidableUsers();
    const params = await bot.getUserLiquidationParams(userToLiquidate.address);
    const path = bot.getPath(
      params.debtMarket.market,
      params.collateralMarket.market
    );
    expect(
      await bot.liquidate(
        params.debtMarket.market,
        params.collateralMarket.market,
        params.userAddress,
        params.toLiquidate,
        path
      )
    ).to.emit(flashLiquidator, "Liquidated");
  });
  it("Should liquidate from from the run function", async () => {
    expect(await bot.run()).to.emit(flashLiquidator, "Liquidated");
  });
});
