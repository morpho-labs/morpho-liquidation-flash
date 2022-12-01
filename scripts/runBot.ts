import * as dotenv from "dotenv";
import { providers, Wallet } from "ethers";
import { isAddress, parseUnits } from "ethers/lib/utils";
import initAave from "../src/initializers/aave";
import initCompound from "../src/initializers/compound";
import { IFetcher } from "../src/interfaces/IFetcher";
import { IMorphoAdapter } from "../src/morpho/Morpho.interface";
import LiquidationBot from "../src/LiquidationBot";
import ConsoleLog from "../src/loggers/ConsoleLog";
import { ILiquidator__factory } from "../typechain";
import { AVAILABLE_PROTOCOLS } from "../config";
import { ILiquidationHandler } from "../src/LiquidationHandler/LiquidationHandler.interface";
import LiquidatorHandler from "../src/LiquidationHandler/LiquidatorHandler";
import {
  MorphoAaveV2,
  MorphoCompound,
} from "@morpho-labs/morpho-ethers-contract";
import ReadOnlyHandler from "../src/LiquidationHandler/ReadOnlyHandler";
import EOAHandler from "../src/LiquidationHandler/EOAHandler";

dotenv.config();

const initializers: Record<
  string,
  (provider: providers.Provider) => Promise<{
    fetcher: IFetcher;
    adapter: IMorphoAdapter;
    morpho: MorphoCompound | MorphoAaveV2;
  }>
> = {
  aave: initAave,
  compound: initCompound,
};
const main = async (): Promise<any> => {
  const useFlashLiquidator = process.argv.includes("--flash");
  const pk = process.env.PRIVATE_KEY;
  const provider = new providers.AlchemyProvider(1, process.env.ALCHEMY_KEY);

  let wallet: Wallet | undefined;
  if (!pk) {
    console.log("No private key found, read only mode");
  } else {
    wallet = new Wallet(pk, provider);
  }

  // Check liquidator addresses

  const liquidatorAddresses = process.env.LIQUIDATOR_ADDRESSES?.split(",");
  if (useFlashLiquidator) {
    if (!liquidatorAddresses) throw new Error("No liquidator addresses found");
    liquidatorAddresses.forEach((liquidatorAddress) => {
      if (!isAddress(liquidatorAddress))
        throw new Error(`Invalid liquidator address ${liquidatorAddress}`);
    });
  }

  // Check protocols
  const protocols = process.env.PROTOCOLS?.split(",");
  if (!protocols) throw new Error("No protocols found");
  protocols.forEach((protocol) => {
    if (!AVAILABLE_PROTOCOLS.includes(protocol))
      throw new Error(`Invalid protocol ${protocol}`);
  });
  if (useFlashLiquidator && protocols.length !== liquidatorAddresses!.length)
    throw new Error(
      "Number of protocols and liquidator addresses must be the same"
    );
  const logger = new ConsoleLog();

  for (let i = 0; i < protocols.length; i++) {
    const protocol = protocols[i];
    const { adapter, fetcher, morpho } = await initializers[protocol](provider);

    let liquidationHandler: ILiquidationHandler;
    if (useFlashLiquidator) {
      liquidationHandler = new LiquidatorHandler(
        ILiquidator__factory.connect(liquidatorAddresses![i], provider as any),
        wallet!,
        logger
      );
      console.log("Using flash liquidator");
    } else if (!wallet) {
      liquidationHandler = new ReadOnlyHandler(logger);
      console.log("Using read only handler");
    } else {
      liquidationHandler = new EOAHandler(morpho, wallet, logger);
      console.log("Using EOA handler");
    }
    console.time(protocol);
    console.timeLog(protocol, `Starting bot initialization`);
    const bot = new LiquidationBot(
      logger,
      fetcher,
      provider,
      liquidationHandler,
      adapter,
      {
        profitableThresholdUSD: parseUnits(
          process.env.PROFITABLE_THRESHOLD ?? "100"
        ),
      }
    );
    console.timeLog(protocol, `Running bot`);
    await bot.run();
    console.timeLog(protocol, `Finished bot`);
    console.timeEnd(protocol);
  }

  const delay = process.env.DELAY;
  if (!delay) return;
  console.log(`Waiting ${delay} seconds before restarting`);
  await new Promise((resolve) => setTimeout(resolve, parseInt(delay) * 1000));
  return main();
};

main()
  .then(console.log)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
