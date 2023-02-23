import { providers } from "ethers";
import AaveGraphFetcher from "../fetcher/AaveGraphFetcher";
import config from "../../config";
import {
  AavePriceOracle__factory,
  LendingPool__factory,
  MorphoAaveV2__factory,
  MorphoAaveV2Lens__factory,
} from "@morpho-labs/morpho-ethers-contract";
import { ILendingPoolAddressesProvider__factory } from "../../typechain";
import MorphoAaveAdapter from "../morpho/MorphoAaveAdapter";

const initAave = async (provider: providers.Provider) => {
  const fetcher = new AaveGraphFetcher(config.graphUrl.morphoAave, +(process.env.BATCH_SIZE ?? "500"));

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
  return { adapter, fetcher, morpho };
};

export default initAave;
