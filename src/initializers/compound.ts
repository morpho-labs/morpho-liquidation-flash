import { providers } from "ethers";
import CompoundGraphFetcher from "../fetcher/CompoundGraphFetcher";
import config from "../../config";
import {
  CompoundOracle__factory,
  Comptroller__factory,
  MorphoCompound__factory,
  MorphoCompoundLens__factory,
} from "@morpho-labs/morpho-ethers-contract";
import MorphoCompoundAdapter from "../morpho/MorphoCompoundAdapter";

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
  return { adapter, fetcher, morpho };
};

export default initCompound;
