import { Contract, ethers, providers, Wallet } from "ethers";
import config from "../../config";
import GraphFetcher from "../fetcher/GraphFetcher";
import LiquidationBot from "../LiquidationBot";
import ConsoleLog from "../loggers/ConsoleLog";
import { parseUnits } from "ethers/lib/utils";

export const handler = async () => {
  const provider = new providers.AlchemyProvider(1, process.env.ALCHEMY_KEY);
  const flashLiquidator = new Contract(
    process.env.LIQUIDATOR_ADDRESS ?? config.liquidator,
    require("../../artifacts/contracts/FlashMintLiquidatorBorrowRepay.sol/FlashMintLiquidatorBorrowRepay.json").abi,
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
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw Error("No PRIVATE_KEY provided");
  const signer = new Wallet(pk, provider);
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
