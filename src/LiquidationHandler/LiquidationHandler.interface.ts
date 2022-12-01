import { BigNumberish } from "ethers";

export interface LiquidationParams {
  poolTokenBorrowed: string;
  poolTokenCollateral: string;
  underlyingBorrowed: string;
  user: string;
  amount: BigNumberish;
  swapPath: string;
}

export interface ILiquidationHandler {
  handleLiquidation: (liquidation: LiquidationParams) => Promise<void>;
}
