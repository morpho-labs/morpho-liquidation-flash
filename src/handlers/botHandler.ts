import { providers, Wallet } from "ethers";
import LiquidationBot from "../LiquidationBot";
import ConsoleLog from "../loggers/ConsoleLog";
import { parseUnits } from "ethers/lib/utils";
import { getPrivateKey } from "../secrets/privateKey";
import { ILiquidator__factory } from "../../typechain";
import initCompound from "../initializers/compound";
import initAave from "../initializers/aave";

export const handler = async () => {
  const privateKey = await getPrivateKey(!!process.env.FROM_ENV);
  const provider = new providers.AlchemyProvider(1, process.env.ALCHEMY_KEY);

  const isCompound = process.env.IS_COMPOUND;

  const signer = privateKey ? new Wallet(privateKey, provider) : undefined;
  const flashLiquidator = ILiquidator__factory.connect(
    process.env.LIQUIDATOR_ADDRESS!,
    provider as any
  );
  const { adapter, fetcher } = await (isCompound
    ? initCompound(provider)
    : initAave(provider));
  const bot = new LiquidationBot(
    new ConsoleLog(),
    fetcher,
    signer,
    flashLiquidator,
    adapter,
    {
      profitableThresholdUSD: parseUnits(
        process.env.PROFITABLE_THRESHOLD ?? "1"
      ),
    }
  );
  await bot.run();
};
