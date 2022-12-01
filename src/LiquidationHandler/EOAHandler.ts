import {
  ILiquidationHandler,
  LiquidationParams,
} from "./LiquidationHandler.interface";
import {
  ERC20__factory,
  MorphoAaveV2,
  MorphoCompound,
} from "@morpho-labs/morpho-ethers-contract";
import { BigNumberish, constants, Overrides, Signer } from "ethers";
import { Logger } from "../interfaces/logger";

export interface EOAHandlerOptions {
  overrides: Overrides;
  checkAllowance: boolean;
  checkBalance: boolean;
  approveMax: boolean;
}
export const defaultOptions: EOAHandlerOptions = {
  overrides: { gasLimit: 3_000_000 },
  checkAllowance: true,
  checkBalance: true,
  approveMax: true,
};

// A list of tokens that need to approve zero before to increase the allowance
const APPROVE_ZERO_TOKENS = ["0x0000000000000000000000000000000000000000"];

export default class EOAHandler implements ILiquidationHandler {
  options: EOAHandlerOptions;
  constructor(
    private readonly morpho: MorphoCompound | MorphoAaveV2,
    private readonly signer: Signer,
    private readonly logger: Logger,
    options: Partial<EOAHandlerOptions> = {}
  ) {
    this.options = { ...defaultOptions, ...options };
  }

  public async handleLiquidation({
    user,
    poolTokenBorrowed,
    poolTokenCollateral,
    amount,
    underlyingBorrowed,
  }: LiquidationParams): Promise<void> {
    if (this.options.checkBalance) {
      await this._checkBalance(underlyingBorrowed, amount);
    }
    await this._checkAllowance(underlyingBorrowed, amount);
    const tx = await this.morpho
      .connect(this.signer)
      .liquidate(
        poolTokenBorrowed,
        poolTokenCollateral,
        user,
        amount,
        this.options.overrides
      )
      .catch(this.logger.error.bind(this));
    if (!tx) return;
    this.logger.log(tx);
    const receipt = await tx.wait().catch(this.logger.error.bind(this));
    if (receipt) this.logger.log(`Gas used: ${receipt.gasUsed.toString()}`);
  }

  private async _approve(token: string, amount: BigNumberish): Promise<void> {
    const erc20 = ERC20__factory.connect(token, this.signer);
    const tx = await erc20
      .approve(this.morpho.address, amount, this.options.overrides)
      .catch(this.logger.error.bind(this));
    if (!tx) return;
    this.logger.log(tx);
    const receipt = await tx.wait().catch(this.logger.error.bind(this));
    if (receipt) this.logger.log(`Gas used: ${receipt.gasUsed.toString()}`);
  }

  private async _checkAllowance(
    token: string,
    amount: BigNumberish
  ): Promise<void> {
    token = token.toLowerCase();
    const erc20 = ERC20__factory.connect(token, this.signer);
    const allowance = await erc20.allowance(
      await this.signer.getAddress(),
      this.morpho.address
    );
    if (allowance.lt(amount)) {
      this.logger.log(`Allowance is not enough for ${token}`);
      if (APPROVE_ZERO_TOKENS.includes(token)) {
        await this._approve(token, 0);
      }
      await this._approve(
        token,
        this.options.approveMax ? constants.MaxUint256 : amount
      );
      this.logger.log(`Allowance updated for ${token}`);
    }
  }

  private async _checkBalance(
    underlyingBorrowed: string,
    amount: BigNumberish
  ): Promise<void> {
    const erc20 = ERC20__factory.connect(underlyingBorrowed, this.signer);
    const balance = await erc20.balanceOf(await this.signer.getAddress());
    if (balance.lt(amount)) throw new Error("Insufficient balance");
  }
}
