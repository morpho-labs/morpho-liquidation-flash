import tokens from "./tokens";

export default {
  liquidator: "",
  oracle: "0x65c816077c29b557bee980ae3cc2dce80204a0c5",
  morphoCompound: "0x8888882f8f843896699869179fB6E4f7e3B58888",
  morphoAave: "0x777777c9898d384f785ee44acfe945efdff5f3e0",
  morphoAaveLens: "0x8706256509684e9cd93b7f19254775ce9324c226",
  addressesProvider: "0xb53c1a33016b2dc2ff3653530bff1848a515c8c5",
  protocolDataProvider: "0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d",
  lens: "0x930f1b46e1d081ec1524efd95752be3ece51ef67",
  univ3Router: "0xe592427a0aece92de3edee1f18e0157c05861564", // https://etherscan.io/address/0xe592427a0aece92de3edee1f18e0157c05861564
  lender: "0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853", // https://etherscan.io/address/0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853#code
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
    morphoAave: "",
  },
};
