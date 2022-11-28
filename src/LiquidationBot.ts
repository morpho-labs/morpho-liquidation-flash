import { BigNumber, getDefaultProvider, providers, Signer } from "ethers";
import { Logger } from "./interfaces/logger";
import { Fetcher } from "./interfaces/Fetcher";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import { pow10 } from "../test/helpers";
import stablecoins from "./constant/stablecoins";
import { ethers } from "hardhat";
import config from "../config";
import underlyings from "./constant/underlyings";
import { getPoolData, UniswapPool } from "./uniswap/pools";
import { IMorphoAdapter } from "./morpho/Morpho.interface";
import { ILiquidator } from "../typechain";

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
    public readonly signer: Signer | undefined,
    public readonly liquidator: ILiquidator,
    public readonly adapter: IMorphoAdapter,
    settings: Partial<LiquidationBotSettings> = {}
  ) {
    this.settings = { ...defaultSettings, ...settings };
  }

  get provider() {
    if (this.signer?.provider) return this.signer.provider;
    if (process.env.ALCHEMY_KEY)
      return new providers.AlchemyProvider("1", process.env.ALCHEMY_KEY);
    return getDefaultProvider();
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
          hf: await this.adapter.getUserHealthFactor(userAddress),
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
    const markets = await this.adapter.getMarkets();

    const balances = await Promise.all(
      markets.map(async (market) => {
        const [
          { totalBalance: totalSupplyBalance },
          { totalBalance: totalBorrowBalance },
        ] = await Promise.all([
          this.adapter.lens.getCurrentSupplyBalanceInOf(market, userAddress),
          this.adapter.lens.getCurrentBorrowBalanceInOf(market, userAddress),
        ]);
        const {
          price,
          balances: [totalSupplyBalanceUSD, totalBorrowBalanceUSD],
        } = await this.adapter.normalize(market, [
          totalSupplyBalance,
          totalBorrowBalance,
        ]);
        const liquidationBonus = await this.adapter.getLiquidationBonus(market);
        return {
          market,
          liquidationBonus,
          totalSupplyBalance,
          totalBorrowBalance,
          price,
          totalSupplyBalanceUSD,
          totalBorrowBalanceUSD,
        };
      })
    );
    console.table(
      balances.map((b) => ({
        balance: b.totalSupplyBalanceUSD.toString(),
        market: b.market,
        liquidationBonus: b.liquidationBonus.toString(),
      }))
    );
    const [debtMarket] = balances.sort((a, b) =>
      a.totalBorrowBalanceUSD.gt(b.totalBorrowBalanceUSD) ? -1 : 1
    );
    const [collateralMarket] = balances
      .filter((b) => b.liquidationBonus.gt(0))
      .sort((a, b) =>
        a.totalSupplyBalanceUSD.gt(b.totalSupplyBalanceUSD) ? -1 : 1
      );
    this.logger.log("Debt Market");
    this.logger.log(debtMarket);
    this.logger.log("Collateral Market");
    this.logger.log(collateralMarket);
    const { toLiquidate, rewardedUSD } =
      await this.adapter.getMaxLiquidationAmount(debtMarket, collateralMarket);
    return {
      collateralMarket,
      debtMarket,
      toLiquidate,
      rewardedUSD,
      userAddress,
    };
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
    if (!this.signer) return;
    const tx = await this.liquidator
      .connect(this.signer)
      // @ts-ignore
      .liquidate(...args, { gasLimit: 8_000_000 })
      .catch(this.logError.bind(this));
    if (!tx) return;
    this.logger.log(tx);
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
