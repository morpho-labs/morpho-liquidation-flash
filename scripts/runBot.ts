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

dotenv.config();

const AVAILABLE_PROTOCOLS = ["aave", "compound"];
const initializers: Record<
  string,
  (
    provider: providers.Provider
  ) => Promise<{ fetcher: IFetcher; adapter: IMorphoAdapter }>
> = {
  aave: initAave,
  compound: initCompound,
};
const main = async (): Promise<any> => {
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
  if (!liquidatorAddresses) throw new Error("No liquidator addresses found");
  liquidatorAddresses.forEach((liquidatorAddress) => {
    if (!isAddress(liquidatorAddress))
      throw new Error(`Invalid liquidator address ${liquidatorAddress}`);
  });

  // Check protocols
  const protocols = process.env.PROTOCOLS?.split(",");
  if (!protocols) throw new Error("No protocols found");
  protocols.forEach((protocol) => {
    if (!AVAILABLE_PROTOCOLS.includes(protocol))
      throw new Error(`Invalid protocol ${protocol}`);
  });
  if (protocols.length !== liquidatorAddresses.length)
    throw new Error(
      "Number of protocols and liquidator addresses must be the same"
    );

  for (let i = 0; i < protocols.length; i++) {
    const protocol = protocols[i];
    const liquidatorAddress = liquidatorAddresses[i];
    console.time(protocol);
    console.timeLog(protocol, `Starting bot initialization`);
    const { adapter, fetcher } = await initializers[protocol](provider);
    const bot = new LiquidationBot(
      new ConsoleLog(),
      fetcher,
      wallet,
      ILiquidator__factory.connect(liquidatorAddress, provider as any),
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
