import { Contract, providers, Wallet } from "ethers";
import config from "../../config";
import GraphFetcher from "../fetcher/GraphFetcher";
import LiquidationBot from "../LiquidationBot";
import ConsoleLog from "../loggers/ConsoleLog";
import { parseUnits } from "ethers/lib/utils";
import { getPrivateKey } from "../secrets/privateKey";

export const handler = async () => {
  const privateKey = await getPrivateKey(!!process.env.FROM_ENV);

  if (!privateKey) throw Error("No PRIVATE_KEY provided");
  const provider = new providers.AlchemyProvider(1, process.env.ALCHEMY_KEY);

  const flashLiquidator = new Contract(
    process.env.LIQUIDATOR_ADDRESS ?? config.liquidator,
    require("../../artifacts/contracts/CompoundLiquidator.sol/CompoundLiquidator.json").abi,
    provider
  );
  const morpho = new Contract(
    config.morpho,
    require("../../artifacts/@morphodao/morpho-core-v1/contracts/compound/interfaces/IMorpho.sol/IMorpho.json").abi,
    provider
  );
  const lens = new Contract(
    config.lens,
    require("../../abis/Lens.json"),
    provider
  );
  const oracle = new Contract(
    config.oracle,
    require("../../abis/Oracle.json"),
    provider
  );
  const signer = new Wallet(privateKey, provider);
  const fetcher = new GraphFetcher(config.graphUrl, 500);
  const bot = new LiquidationBot(
    new ConsoleLog(),
    fetcher,
    signer,
    morpho,
    lens,
    oracle,
    flashLiquidator,
    {
      profitableThresholdUSD: parseUnits(
        process.env.PROFITABLE_THRESHOLD ?? "1"
      ),
    }
  );
  await bot.run();
};
