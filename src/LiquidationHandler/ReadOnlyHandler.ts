import { ILiquidationHandler } from "./LiquidationHandler.interface";
import { Logger } from "../interfaces/logger";

export default class ReadOnlyHandler implements ILiquidationHandler {
  constructor(private logger: Logger) {}
  async handleLiquidation(): Promise<void> {
    this.logger.log("Read only mode, no liquidation will be performed");
  }
}
