import { BigNumber, Contract, Signer, utils } from "ethers";
import hre, { ethers } from "hardhat";
import { parseUnits } from "ethers/lib/utils";
const ERC20Abi = require("../abis/ERC20.json");
export const config = {
  morpho: "0x8888882f8f843896699869179fB6E4f7e3B58888",
  lens: "0xe8cfa2edbdc110689120724c4828232e473be1b2",
  univ3Router: "0xe592427a0aece92de3edee1f18e0157c05861564", // https://etherscan.io/address/0xe592427a0aece92de3edee1f18e0157c05861564
  lender: "0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853", // https://etherscan.io/address/0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853#code
  slippageTolerance: 500, // 1%
  tokens: {
    dai: {
      address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      cToken: "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643",
      balanceOfStorageSlot: 2,
    },
    usdc: {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      cToken: "0x39aa39c021dfbae8fac545936693ac917d5e7563",
      balanceOfStorageSlot: 9,
    },
    usdt: {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      cToken: "0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9",
      balanceOfStorageSlot: 2,
    },
    fei: {
      address: "0x956f47f50a910163d8bf957cf5846d573e7f87ca",
      cToken: "0x7713DD9Ca933848F6819F38B8352D9A15EA73F67",
      balanceOfStorageSlot: 0,
    },
  },
  swapFees: {
    exotic: 3000,
    classic: 500,
    stable: 100,
  },
};
export const setupCompound = async (morpho: Contract, signer: Signer) => {
  const markets: string[] = await morpho.getAllMarkets();

  const comptrollerAddress = await morpho.comptroller();
  const comptroller = await ethers.getContractAt(
    require("../abis/Comptroller.json"),
    comptrollerAddress,
    signer
  );

  const Oracle = await ethers.getContractFactory("SimplePriceOracle");
  const oracle = await Oracle.deploy();
  await oracle.deployed();

  const realOracle = new Contract(
    // @ts-ignore
    await comptroller.oracle(),
    require("../abis/Oracle.json"),
    signer
  );
  await Promise.all(
    markets.map(async (marketAddress) => {
      await oracle.setUnderlyingPrice(
        marketAddress,
        await realOracle.getUnderlyingPrice(marketAddress)
      );
    })
  );

  await oracle.setUnderlyingPrice(
    config.tokens.dai.cToken,
    parseUnits("1", 18 * 2 - 18)
  );
  await oracle.setUnderlyingPrice(
    config.tokens.usdt.cToken,
    parseUnits("1", 18 * 2 - 18)
  );
  await oracle.setUnderlyingPrice(
    config.tokens.usdc.cToken,
    parseUnits("1", 18 * 2 - 6)
  );
  await oracle.setUnderlyingPrice(
    config.tokens.fei.cToken,
    parseUnits("1", 18 * 2 - 18)
  );
  // @ts-ignore
  const adminAddress = await comptroller.admin();
  await hre.network.provider.send("hardhat_impersonateAccount", [adminAddress]);
  await hre.network.provider.send("hardhat_setBalance", [
    adminAddress,
    ethers.utils.parseEther("10").toHexString(),
  ]);
  const admin = await ethers.getSigner(adminAddress);
  return { comptroller, oracle: oracle as Contract, admin };
};
export const getTokens = async (
  signerAddress: string,
  signerType: string,
  signers: Signer[],
  tokenAddress: string,
  amount: BigNumber,
  ownerAddress?: string
): Promise<Contract> => {
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [signerAddress],
  });
  const signerAccount = await ethers.getSigner(signerAddress);
  await hre.network.provider.send("hardhat_setBalance", [
    signerAddress,
    utils.hexValue(utils.parseUnits("1000")),
  ]);

  // Transfer token
  const token = await ethers.getContractAt(
    ERC20Abi,
    tokenAddress,
    signerAccount
  );
  if (ownerAddress) {
    await hre.network.provider.send("hardhat_impersonateAccount", [
      ownerAddress,
    ]);
    await hre.network.provider.send("hardhat_setBalance", [
      ownerAddress,
      ethers.utils.parseEther("10").toHexString(),
    ]);
    const owner = await ethers.getSigner(ownerAddress);
    await Promise.all(
      signers.map(async (signer) => {
        await token
          .connect(owner)
          // @ts-ignore
          .mint(signer.getAddress(), amount);
      })
    );
  }
  await Promise.all(
    signers.map(async (signer) => {
      if (signerType === "whale") {
        await token
          .connect(signerAccount)
          // @ts-ignore
          .transfer(signer.getAddress(), amount);
      }
    })
  );

  return token;
};
