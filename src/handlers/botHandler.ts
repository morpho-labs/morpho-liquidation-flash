import { providers, Wallet } from "ethers";
import LiquidationBot from "../LiquidationBot";
import ConsoleLog from "../loggers/ConsoleLog";
import { parseUnits } from "ethers/lib/utils";
import { getPrivateKey } from "../secrets/privateKey";
import { ILiquidator__factory } from "../../typechain";
import initCompound from "../initializers/compound";
import initAave from "../initializers/aave";
import LiquidatorHandler from "../LiquidationHandler/LiquidatorHandler";

export const handler = async () => {
  const privateKey = await getPrivateKey(!!process.env.FROM_ENV);
  if (!privateKey) throw new Error("No private key found");
  const provider = new providers.AlchemyProvider(1, process.env.ALCHEMY_KEY);

  const isCompound = process.env.IS_COMPOUND;
  const logger = new ConsoleLog();
  const signer = new Wallet(privateKey, provider);
  const flashLiquidator = ILiquidator__factory.connect(
    process.env.LIQUIDATOR_ADDRESS!,
    provider as any
  );
  const { adapter, fetcher } = await (isCompound
    ? initCompound(provider)
    : initAave(provider));
  const liquidationHandler = new LiquidatorHandler(
    flashLiquidator,
    signer,
    logger
  );
  const bot = new LiquidationBot(
    logger,
    fetcher,
    signer.provider,
    liquidationHandler,
    adapter,
    {
      profitableThresholdUSD: parseUnits(
        process.env.PROFITABLE_THRESHOLD ?? "1"
      ),
    }
  );
  await bot.run();
};
