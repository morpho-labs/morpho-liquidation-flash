import { IMorphoAdapter } from "./Morpho.interface";
import { CompoundOracle } from "@morpho-labs/morpho-ethers-contract";
import { BigNumber } from "ethers";
import { MorphoCompoundLens } from "@morpho-labs/morpho-ethers-contract/lib/compound/MorphoCompoundLens";
import { SimplePriceOracle } from "../../typechain";
import { PercentMath, WadRayMath } from "@morpho-labs/ethers-utils/lib/maths";
import { pow10 } from "../../test/helpers";

export default class MorphoCompoundAdapter implements IMorphoAdapter {
  static LIQUIDATION_BONUS = BigNumber.from(10_700);
  // eslint-disable-next-line no-useless-constructor
  constructor(
    public lens: MorphoCompoundLens,
    private oracle: SimplePriceOracle | CompoundOracle
  ) {}

  public async toUsd(
    market: string,
    amount: BigNumber,
    price: BigNumber
  ): Promise<BigNumber> {
    return WadRayMath.wadMul(amount, price);
  }

  public async getMaxLiquidationAmount(
    debtMarket: {
      price: BigNumber;
      totalBorrowBalanceUSD: BigNumber;
      totalBorrowBalance: BigNumber;
    },
    collateralMarket: {
      price: BigNumber;
      totalSupplyBalanceUSD: BigNumber;
      liquidationBonus: BigNumber;
    }
  ): Promise<{ toLiquidate: BigNumber; rewardedUSD: BigNumber }> {
    let toLiquidate = debtMarket.totalBorrowBalance.div(2);
    let rewardedUSD = collateralMarket.liquidationBonus.eq(0)
      ? BigNumber.from(0)
      : PercentMath.percentDiv(
          collateralMarket.totalSupplyBalanceUSD,
          collateralMarket.liquidationBonus
        );
    if (
      PercentMath.percentMul(
        toLiquidate, // close factor is the same for aave & compound
        collateralMarket.liquidationBonus
      ).gt(collateralMarket.totalSupplyBalanceUSD)
    ) {
      console.log("the collateral cannot cover the debt");
      toLiquidate = toLiquidate.mul(pow10(18)).div(debtMarket.price);
      rewardedUSD = toLiquidate
        .mul(debtMarket.price)
        .mul(pow10(18))
        .div(collateralMarket.price);
    }
    return {
      toLiquidate,
      rewardedUSD,
    };
  }

  public async getUserHealthFactor(user: string): Promise<BigNumber> {
    return this.lens.getUserHealthFactor(user, []);
  }

  public async normalize(
    market: string,
    balances: BigNumber[]
  ): Promise<{
    price: BigNumber;
    balances: BigNumber[];
  }> {
    const price = await this.oracle.getUnderlyingPrice(market);
    return {
      price,
      balances: balances.map((b) => WadRayMath.wadMul(b, price)),
    };
  }

  public async getMarkets(): Promise<string[]> {
    return this.lens.getAllMarkets();
  }

  public async getLiquidationBonus(): Promise<BigNumber> {
    return MorphoCompoundAdapter.LIQUIDATION_BONUS;
  }
}
