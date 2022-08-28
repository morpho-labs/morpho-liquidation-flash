import { BigNumber, Contract, providers, Signer } from "ethers";
import { Logger } from "./interfaces/logger";
import { Fetcher } from "./interfaces/Fetcher";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import { pow10 } from "../test/helpers";
import stablecoins from "./constant/stablecoins";
import { ethers } from "hardhat";
import config from "../config";
import underlyings from "./constant/underlyings";
import { getPoolData, UniswapPool } from "./uniswap/pools";

export interface LiquidationBotSettings {
  profitableThresholdUSD: BigNumber;
}
const defaultSettings: LiquidationBotSettings = {
  profitableThresholdUSD: parseUnits("1"),
};

export default class LiquidationBot {
  static W_ETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
  markets: string[] = [];
  static readonly HF_THRESHOLD = parseUnits("1");
  settings: LiquidationBotSettings = defaultSettings;
  constructor(
    public readonly logger: Logger,
    public readonly fetcher: Fetcher,
    public readonly signer: Signer,
    public readonly morpho: Contract,
    public readonly lens: Contract,
    public readonly oracle: Contract,
    public readonly liquidator: Contract,
    settings: Partial<LiquidationBotSettings> = {}
  ) {
    this.settings = { ...defaultSettings, ...settings };
  }

  async computeLiquidableUsers() {
    let lastId = "";
    let hasMore = true;
    let liquidableUsers: { address: string; hf: BigNumber }[] = [];
    while (hasMore) {
      let users: string[];
      ({ hasMore, lastId, users } = await this.fetcher.fetchUsers(lastId));
      this.logger.log(`${users.length} users fetched`);
      const newLiquidatableUsers = await Promise.all(
        users.map(async (userAddress) => ({
          address: userAddress,
          hf: (await this.lens.getUserHealthFactor(
            userAddress,
            []
          )) as BigNumber,
        }))
      ).then((healthFactors) =>
        healthFactors.filter((userHf) => {
          if (userHf.hf.lt(parseUnits("1.0001")))
            this.logger.log(
              `User ${userHf.address} has a low HF (${formatUnits(userHf.hf)})`
            );
          return userHf.hf.lt(LiquidationBot.HF_THRESHOLD);
        })
      );
      liquidableUsers = [...liquidableUsers, ...newLiquidatableUsers];
    }
    return liquidableUsers;
  }

  async getUserLiquidationParams(userAddress: string) {
    // first fetch all user balances
    const markets = await this.getMarkets();
    const balances = await Promise.all(
      markets.map(async (market) => {
        const { totalBalance: totalSupplyBalance } =
          (await this.lens.getCurrentSupplyBalanceInOf(
            market,
            userAddress
          )) as { totalBalance: BigNumber };
        const { totalBalance: totalBorrowBalance } =
          (await this.lens.getCurrentBorrowBalanceInOf(
            market,
            userAddress
          )) as { totalBalance: BigNumber };
        const price: BigNumber = await this.oracle.getUnderlyingPrice(market);
        return {
          market,
          totalSupplyBalance,
          totalBorrowBalance,
          price,
          totalSupplyBalanceUSD: totalSupplyBalance.mul(price).div(pow10(18)),
          totalBorrowBalanceUSD: totalBorrowBalance.mul(price).div(pow10(18)),
        };
      })
    );
    const [debtMarket] = balances.sort((a, b) =>
      a.totalBorrowBalanceUSD.gt(b.totalBorrowBalanceUSD) ? -1 : 1
    );
    const [collateralMarket] = balances.sort((a, b) =>
      a.totalSupplyBalanceUSD.gt(b.totalSupplyBalanceUSD) ? -1 : 1
    );
    this.logger.log("Debt Market");
    this.logger.log(debtMarket);
    this.logger.log("Collateral Market");
    this.logger.log(collateralMarket);
    let toLiquidate = debtMarket.totalBorrowBalance.div(2);
    if (
      debtMarket.totalBorrowBalanceUSD
        .div(2)
        .mul(107) // Compound rewards
        .div(100)
        .gt(collateralMarket.totalSupplyBalanceUSD)
    ) {
      console.log("the collateral cannot cover the debt");

      toLiquidate = collateralMarket.totalSupplyBalanceUSD
        .mul(pow10(20))
        .div(107) // Compound rewards
        .div(debtMarket.price);
    }
    const rewardedUSD = toLiquidate
      .mul(debtMarket.price)
      .mul(107)
      .div(pow10(20));
    return {
      collateralMarket,
      debtMarket,
      toLiquidate,
      rewardedUSD,
      userAddress,
    };
  }

  async getMarkets() {
    if (this.markets.length === 0)
      this.markets = await this.morpho.getAllMarkets();
    return this.markets;
  }

  getPath(borrowMarket: string, collateralMarket: string) {
    borrowMarket = borrowMarket.toLowerCase();
    collateralMarket = collateralMarket.toLowerCase();
    if (borrowMarket === collateralMarket) return "0x";
    if (
      [underlyings[borrowMarket], underlyings[collateralMarket]].includes(
        LiquidationBot.W_ETH
      )
    ) {
      // a simple swap with wEth
      return ethers.utils.solidityPack(
        ["address", "uint24", "address"],
        [
          underlyings[borrowMarket],
          config.swapFees.classic,
          underlyings[collateralMarket],
        ]
      );
    }
    if (
      stablecoins.includes(borrowMarket) &&
      stablecoins.includes(collateralMarket)
    )
      return ethers.utils.solidityPack(
        ["address", "uint24", "address"],
        [
          underlyings[borrowMarket],
          config.swapFees.stable,
          underlyings[collateralMarket],
        ]
      );
    return ethers.utils.solidityPack(
      ["address", "uint24", "address", "uint24", "address"],
      [
        underlyings[borrowMarket],
        config.swapFees.exotic,
        LiquidationBot.W_ETH,
        config.swapFees.exotic,
        underlyings[collateralMarket],
      ]
    );
  }

  isProfitable(toLiquidate: BigNumber, price: BigNumber) {
    return toLiquidate
      .mul(price)
      .div(pow10(18))
      .mul(7)
      .div(100)
      .gt(this.settings.profitableThresholdUSD);
  }

  async liquidate(...args: any) {
    const tx: providers.TransactionResponse = await this.liquidator
      .connect(this.signer)
      .liquidate(...args, { gasLimit: 8_000_000 })
      .catch(this.logError.bind(this));
    this.logger.log(tx.hash);
    const receipt = await tx.wait().catch(this.logError.bind(this));
    if (receipt) this.logger.log(`Gas used: ${receipt.gasUsed.toString()}`);
  }

  async checkPoolLiquidity(borrowMarket: string, collateralMarket: string) {
    borrowMarket = borrowMarket.toLowerCase();
    collateralMarket = collateralMarket.toLowerCase();
    let pools: UniswapPool[][] = [];
    if (
      stablecoins.includes(borrowMarket) &&
      stablecoins.includes(collateralMarket)
    ) {
      const data = await getPoolData(
        underlyings[borrowMarket],
        underlyings[collateralMarket]
      );
      pools.push(data);
    } else if (
      [underlyings[borrowMarket], underlyings[collateralMarket]].includes(
        LiquidationBot.W_ETH
      )
    ) {
      const data = await getPoolData(
        underlyings[borrowMarket],
        underlyings[collateralMarket]
      );
      pools.push(data);
    } else {
      const newPools = await Promise.all([
        getPoolData(underlyings[borrowMarket], LiquidationBot.W_ETH),
        getPoolData(underlyings[collateralMarket], LiquidationBot.W_ETH),
      ]);
      pools = [...pools, ...newPools];
    }
    console.log(JSON.stringify(pools, null, 4));
    return pools;
  }

  // async amountAndPathsForMultipleLiquidations(
  //   borrowMarket: string,
  //   collateralMarket: string
  // ) {
  //   const borrowUnderlying = underlyings[borrowMarket.toLowerCase()];
  //   const collateralUnderlying = underlyings[collateralMarket.toLowerCase()];
  //   const pools = await this.checkPoolLiquidity(borrowMarket, collateralMarket);
  //   console.log(pools);
  //   if (pools.length === 1) {
  //     // stable/stable or stable/eth swap
  //     const [oneSwapPools] = pools;
  //   }
  // }

  async run() {
    const users = await this.computeLiquidableUsers();
    const liquidationsParams = await Promise.all(
      users.map((u) => this.getUserLiquidationParams(u.address))
    );
    const toLiquidate = liquidationsParams.filter((user) =>
      this.isProfitable(user.toLiquidate, user.debtMarket.price)
    );
    if (toLiquidate.length > 0) {
      this.logger.log(`${toLiquidate.length} users to liquidate`);
      for (const userToLiquidate of toLiquidate) {
        const swapPath = this.getPath(
          userToLiquidate.debtMarket.market,
          userToLiquidate.collateralMarket.market
        );
        await this.liquidate(
          userToLiquidate.debtMarket.market,
          userToLiquidate.collateralMarket.market,
          userToLiquidate.userAddress,
          userToLiquidate.toLiquidate,
          true,
          swapPath
        );
      }
    }
  }

  logError(error: object) {
    console.error(error);
    this.logger.log(error);
  }
}
