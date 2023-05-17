import tokens from "./tokens";
export const AVAILABLE_PROTOCOLS = ["aave", "compound"];

export default {
  liquidator: "",
  oracle: "0x65c816077c29b557bee980ae3cc2dce80204a0c5",
  oracleAave: "0xa50ba011c48153de246e5192c8f9258a2ba79ca9",
  morphoCompound: "0x8888882f8f843896699869179fB6E4f7e3B58888",
  morphoAave: "0x777777c9898d384f785ee44acfe945efdff5f3e0",
  morphoAaveLens: "0x507fa343d0a90786d86c7cd885f5c49263a91ff4",
  addressesProvider: "0xb53c1a33016b2dc2ff3653530bff1848a515c8c5",
  protocolDataProvider: "0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d",
  lens: "0x930f1b46e1d081ec1524efd95752be3ece51ef67",
  univ3Router: "0xe592427a0aece92de3edee1f18e0157c05861564", // https://etherscan.io/address/0xe592427a0aece92de3edee1f18e0157c05861564
  lender: "0x60744434d6339a6b27d73d9eda62b6f66a0a04fa", // https://etherscan.io/address/0x60744434d6339a6b27d73d9eda62b6f66a0a04fa#code
  slippageTolerance: 500, // 5%
  tokens,
  swapFees: {
    exotic: 3000,
    classic: 500,
    stable: 100,
  },
  graphUrl: {
    morphoCompound:
      "https://api.thegraph.com/subgraphs/name/korrigans84/morphocompoundusers",
    morphoAave:
      "https://api.thegraph.com/subgraphs/name/morpho-labs/morpho-aavev2-mainnet",
  },
};
