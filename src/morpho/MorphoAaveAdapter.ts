import { IMorphoAdapter } from "./Morpho.interface";
import {
  AavePriceOracle,
  AToken__factory,
  ERC20__factory,
  MorphoAaveV2Lens,
  ProtocolDataProvider,
  ProtocolDataProvider__factory,
} from "@morpho-labs/morpho-ethers-contract";
import { BigNumber } from "ethers";
import config from "../../config";
import underlyings from "../constant/underlyings";
import { pow10 } from "../../test/helpers";
import { PercentMath, WadRayMath } from "@morpho-labs/ethers-utils/lib/maths";

export default class MorphoAaveAdapter implements IMorphoAdapter {
  private protocolDataProvider: ProtocolDataProvider;
  private ethUsdPrice?: BigNumber;
  constructor(public lens: MorphoAaveV2Lens, public oracle: AavePriceOracle) {
    // this.morpho = MorphoAaveV2__factory.connect(morphoAddress, provider as any);
    // this.lens = MorphoAaveV2Lens__factory.connect(lensAddress, provider as any);
    this.protocolDataProvider = ProtocolDataProvider__factory.connect(
      config.protocolDataProvider,
      lens.provider as any
    );
  }

  public async toUsd(market: string, amount: BigNumber, price: BigNumber) {
    const decimals = await this._getDecimals(await this._getUnderlying(market));
    return amount.mul(price).div(pow10(decimals));
  }

  public async getMaxLiquidationAmount(
    debtMarket: {
      market: string;
      price: BigNumber;
      totalBorrowBalanceUSD: BigNumber;
      totalBorrowBalance: BigNumber;
    },
    collateralMarket: {
      market: string;
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
      const [debtDecimals, collateralDecimals] = await Promise.all([
        this._getDecimals(await this._getUnderlying(debtMarket.market)),
        this._getDecimals(await this._getUnderlying(collateralMarket.market)),
      ]);
      toLiquidate = toLiquidate.mul(pow10(debtDecimals)).div(debtMarket.price); // TODO: verify the formula
      rewardedUSD = toLiquidate
        .mul(debtMarket.price)
        .mul(pow10(collateralDecimals))
        .div(collateralMarket.price)
        .div(pow10(debtDecimals));
    }
    return {
      toLiquidate,
      rewardedUSD,
    };
  }

  public async getUserHealthFactor(user: string): Promise<BigNumber> {
    return this.lens.getUserHealthFactor(user);
  }

  public async normalize(
    market: string,
    balances: BigNumber[]
  ): Promise<{
    price: BigNumber;
    balances: BigNumber[];
  }> {
    // for speed optimisation, we first use the addresses from the config
    const underlying = await this._getUnderlying(market);
    const price = await this.oracle.getAssetPrice(underlying);
    const [ethUsdPrice, decimals] = await Promise.all([
      this._getEthUsdPrice(),
      this._getDecimals(underlying),
    ]);

    return {
      price,
      balances: balances.map((b) =>
        WadRayMath.wadDiv(b.mul(price).div(pow10(decimals)), ethUsdPrice)
      ),
    };
  }

  public async getMarkets(): Promise<string[]> {
    return this.lens.getAllMarkets();
  }

  public async getLiquidationBonus(market: string): Promise<BigNumber> {
    const underlying = underlyings[market.toLowerCase()];

    const { liquidationBonus } =
      await this.protocolDataProvider.getReserveConfigurationData(underlying);

    return liquidationBonus;
  }

  private async _getEthUsdPrice(): Promise<BigNumber> {
    if (!this.ethUsdPrice) {
      this.ethUsdPrice = await this.oracle.getAssetPrice(
        config.tokens.usdc.address
      );
    }
    return this.ethUsdPrice;
  }

  private _decimalsMap: Record<string, number> = {};
  private async _getDecimals(underlying: string): Promise<number> {
    if (!this._decimalsMap[underlying]) {
      const contract = ERC20__factory.connect(
        underlying,
        this.lens.provider as any
      );
      this._decimalsMap[underlying] = await contract.decimals();
    }

    return this._decimalsMap[underlying];
  }

  private async _getUnderlying(market: string): Promise<string> {
    let underlying = underlyings[market.toLowerCase()];
    if (!underlying) {
      const aToken = AToken__factory.connect(market, this.lens.provider as any);
      underlying = (await aToken.UNDERLYING_ASSET_ADDRESS()).toLowerCase();
    }
    return underlying;
  }
}
