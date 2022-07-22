export default {
  morpho: "0x8888882f8f843896699869179fB6E4f7e3B58888",
  lens: "0x930f1b46e1d081ec1524efd95752be3ece51ef67",
  univ3Router: "0xe592427a0aece92de3edee1f18e0157c05861564", // https://etherscan.io/address/0xe592427a0aece92de3edee1f18e0157c05861564
  lender: "0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853", // https://etherscan.io/address/0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853#code
  slippageTolerance: 100, // 1%
  tokens: {
    dai: {
      address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      cToken: "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643",
      balanceOfStorageSlot: 2,
      decimals: 18,
    },
    usdc: {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      cToken: "0x39aa39c021dfbae8fac545936693ac917d5e7563",
      balanceOfStorageSlot: 9,
      decimals: 6,
    },
    usdt: {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      cToken: "0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9",
      balanceOfStorageSlot: 2,
      decimals: 6,
    },
    fei: {
      address: "0x956f47f50a910163d8bf957cf5846d573e7f87ca",
      cToken: "0x7713DD9Ca933848F6819F38B8352D9A15EA73F67",
      balanceOfStorageSlot: 0,
      decimals: 18,
    },
    wEth: {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      cToken: "0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5",
      decimals: 18,
      balanceOfStorageSlot: 3,
    },
    wBtc: {
      address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
      cToken: "0xccf4429db6322d5c611ee964527d42e5d685dd6a",
      decimals: 8,
      balanceOfStorageSlot: 0,
    },
    comp: {
      address: "0xc00e94cb662c3520282e6f5717214004a7f26888",
      cToken: "0x70e36f6bf80a52b3b46b3af8e106cc0ed743e8e4",
      decimals: 18,
      balanceOfStorageSlot: 1,
    },
    uni: {
      address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
      cToken: "0x35a18000230da775cac24873d00ff85bccded550",
      decimals: 18,
      balanceOfStorageSlot: 4,
    },
  },
  swapFees: {
    exotic: 3000,
    classic: 500,
    stable: 100,
  },
};
