import { BigNumber, Contract, Signer, utils } from "ethers";
import hre, { ethers } from "hardhat";
const ERC20Abi = require("../abis/ERC20.json");
export const config = {
  morpho: "0x8888882f8f843896699869179fB6E4f7e3B58888",
  lens: "",
  univ3Router: "0xe592427a0aece92de3edee1f18e0157c05861564", // https://etherscan.io/address/0xe592427a0aece92de3edee1f18e0157c05861564
  lender: "0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853", // https://etherscan.io/address/0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853#code
  tokens: {
    dai: {
      owner: "0xddb108893104de4e1c6d0e47c42237db4e617acc",
      whale: "0x4d9079bb4165aeb4084c526a32695dcfd2f77381",
      address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      cToken: "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643",
    },
    usdc: {
      whale: "0x46340b20830761efd32832A74d7169B29FEB9758",
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      cToken: "0x39aa39c021dfbae8fac545936693ac917d5e7563",
    },
    usdt: {
      whale: "0x11b815efb8f581194ae79006d24e0d814b7697f6",
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      cToken: "0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9",
    },
  },
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
          //@ts-ignore
          .transfer(signer.getAddress(), amount);
      } else {
        //@ts-ignore
        await token.mint(signer.getAddress(), amount, { from: signerAddress });
      }
    })
  );

  return token;
};
