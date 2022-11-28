import { Contract, providers, Wallet } from "ethers";
import config from "../../config";
import CompoundGraphFetcher from "../fetcher/CompoundGraphFetcher";
import LiquidationBot from "../LiquidationBot";
import ConsoleLog from "../loggers/ConsoleLog";
import { parseUnits } from "ethers/lib/utils";
import { getPrivateKey } from "../secrets/privateKey";
import AaveGraphFetcher from "../fetcher/AaveGraphFetcher";

export const handler = async () => {
  const privateKey = await getPrivateKey(!!process.env.FROM_ENV);
  const isCompound = process.env.IS_COMPOUND;
  if (!privateKey) throw Error("No PRIVATE_KEY provided");
  const provider = new providers.AlchemyProvider(1, process.env.ALCHEMY_KEY);
  const liquidatorContractName = isCompound
    ? "FlashMintLiquidatorBorrowRepayCompound"
    : "FlashMintLiquidatorBorrowRepayAave";
  const flashLiquidator = new Contract(
    process.env.LIQUIDATOR_ADDRESS ?? config.liquidator,
    require(`../../artifacts/contracts${
      !isCompound ? "/aave-v2" : ""
    }/${liquidatorContractName}.sol/${liquidatorContractName}.json`).abi,
    provider
  );
  const morpho = new Contract(
    isCompound ? config.morphoCompound : config.morphoAave,
    require("../../artifacts/@morphodao/morpho-core-v1/contracts/compound/interfaces/IMorpho.sol/IMorpho.json").abi,
    provider
  );
  const lens = new Contract(
    isCompound ? config.lens : config.morphoAaveLens,
    require(isCompound ? "../../abis/Lens.json" : "../../abis/aave/Lens.json"),
    provider
  );
  console.log(isCompound, lens);
  const oracle = new Contract(
    isCompound ? config.oracle : config.oracleAave,
    require("../../abis/Oracle.json"),
    provider
  );
  const signer = new Wallet(privateKey, provider);
  const fetcher = isCompound
    ? new CompoundGraphFetcher(config.graphUrl.morphoCompound, 500)
    : new AaveGraphFetcher(config.graphUrl.morphoAave);
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
