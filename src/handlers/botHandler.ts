import { providers, Wallet } from "ethers";
import config from "../../config";
import CompoundGraphFetcher from "../fetcher/CompoundGraphFetcher";
import LiquidationBot from "../LiquidationBot";
import ConsoleLog from "../loggers/ConsoleLog";
import { parseUnits } from "ethers/lib/utils";
import { getPrivateKey } from "../secrets/privateKey";
import AaveGraphFetcher from "../fetcher/AaveGraphFetcher";
import {
  ILendingPoolAddressesProvider__factory,
  ILiquidator__factory,
} from "../../typechain";
import MorphoCompoundAdapter from "../morpho/MorphoCompoundAdapter";
import {
  AavePriceOracle__factory,
  CompoundOracle__factory,
  Comptroller__factory,
  LendingPool__factory,
  MorphoAaveV2__factory,
  MorphoAaveV2Lens__factory,
  MorphoCompound__factory,
  MorphoCompoundLens__factory,
} from "@morpho-labs/morpho-ethers-contract";
import MorphoAaveAdapter from "../morpho/MorphoAaveAdapter";

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

const initCompound = async (provider: providers.Provider) => {
  const fetcher = new CompoundGraphFetcher(config.graphUrl.morphoCompound, 500);

  const lens = MorphoCompoundLens__factory.connect(
    config.lens,
    provider as any
  );
  // fetch compound oracle
  const morpho = MorphoCompound__factory.connect(
    config.morphoCompound,
    provider as any
  );
  const comptroller = Comptroller__factory.connect(
    await morpho.comptroller(),
    provider as any
  );
  const oracle = CompoundOracle__factory.connect(
    await comptroller.oracle(),
    provider as any
  );
  const adapter = new MorphoCompoundAdapter(lens, oracle);
  return { adapter, fetcher };
};

const initAave = async (provider: providers.Provider) => {
  const fetcher = new AaveGraphFetcher(config.graphUrl.morphoAave, 500);

  const lens = MorphoAaveV2Lens__factory.connect(
    config.morphoAaveLens,
    provider as any
  );
  // fetch aave V2 oracle
  const morpho = MorphoAaveV2__factory.connect(
    config.morphoAave,
    provider as any
  );
  const lendingPool = LendingPool__factory.connect(
    await morpho.pool(),
    provider as any
  );
  const addressesProvider = ILendingPoolAddressesProvider__factory.connect(
    await lendingPool.getAddressesProvider(),
    provider as any
  );
  const oracle = AavePriceOracle__factory.connect(
    await addressesProvider.getPriceOracle(),
    provider as any
  );
  const adapter = new MorphoAaveAdapter(lens, oracle);
  return { adapter, fetcher };
};
