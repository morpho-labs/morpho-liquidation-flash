import {
  ILiquidationHandler,
  LiquidationParams,
} from "./LiquidationHandler.interface";
import { ILiquidator } from "../../typechain";
import { Overrides, Signer } from "ethers";
import { Logger } from "../interfaces/logger";

export interface LiquidatorHandlerOptions {
  stakeTokens: boolean;
  overrides: Overrides;
}
const defaultOptions: LiquidatorHandlerOptions = {
  stakeTokens: true,
  overrides: { gasLimit: 3_000_000 },
};

export default class LiquidatorHandler implements ILiquidationHandler {
  options: LiquidatorHandlerOptions;
  constructor(
    private liquidator: ILiquidator,
    private signer: Signer,
    private logger: Logger,
    options: Partial<LiquidatorHandlerOptions> = {}
  ) {
    this.options = { ...defaultOptions, ...options };
  }

  async handleLiquidation({
    poolTokenCollateral,
    poolTokenBorrowed,
    user,
    amount,
    swapPath,
  }: LiquidationParams): Promise<void> {
    if (!this.signer) return;
    const tx = await this.liquidator
      .connect(this.signer)
      // @ts-ignore
      .liquidate(
        poolTokenBorrowed,
        poolTokenCollateral,
        user,
        amount,
        this.options.stakeTokens,
        swapPath,
        this.options.overrides
      )
      .catch(this.logger.error(this));
    if (!tx) return;
    this.logger.log(tx);
    const receipt = await tx.wait().catch(this.logger.error.bind(this));
    if (receipt) this.logger.log(`Gas used: ${receipt.gasUsed.toString()}`);
  }
}
