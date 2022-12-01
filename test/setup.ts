import { BigNumber, Contract, Signer } from "ethers";
import hre, { ethers } from "hardhat";
import { parseUnits } from "ethers/lib/utils";
import { cropHexString, getBalanceOfStorageSlot, padHexString } from "./utils";
import config from "../config";
import { IAToken__factory, ICToken__factory } from "../typechain";
import {
  AavePriceOracle__factory,
  AToken__factory,
  CompoundOracle__factory,
  Comptroller,
  Comptroller__factory,
  ERC20__factory,
  LendingPool__factory,
  LendingPoolAddressesProvider__factory,
  MorphoAaveV2,
} from "@morpho-labs/morpho-ethers-contract";
export const setupCompound = async (morpho: Contract, signer: Signer) => {
  const markets: string[] = await morpho.getAllMarkets();

  const comptrollerAddress = await morpho.comptroller();
  const comptroller = await Comptroller__factory.connect(
    comptrollerAddress,
    signer
  );

  const Oracle = await ethers.getContractFactory("SimplePriceOracle");
  const oracle = await Oracle.deploy();
  await oracle.deployed();

  const realOracle = CompoundOracle__factory.connect(
    await comptroller.oracle(),
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
  // @ts-ignore
  const adminAddress = await comptroller.admin();
  await hre.network.provider.send("hardhat_impersonateAccount", [adminAddress]);
  await hre.network.provider.send("hardhat_setBalance", [
    adminAddress,
    ethers.utils.parseEther("10").toHexString(),
  ]);
  const admin = await ethers.getSigner(adminAddress);
  return { comptroller: comptroller as unknown as Comptroller, oracle, admin };
};

export const setupAave = async (morpho: Contract, signer: Signer) => {
  const markets: string[] = await (morpho as MorphoAaveV2).getMarketsCreated();

  const addressesProvider = LendingPoolAddressesProvider__factory.connect(
    config.addressesProvider,
    signer
  );
  const lendingPool = LendingPool__factory.connect(
    await addressesProvider.getLendingPool(),
    signer
  );

  const Oracle = await ethers.getContractFactory("SimplePriceOracle");
  const oracle = await Oracle.deploy();
  await oracle.deployed();

  const realOracle = AavePriceOracle__factory.connect(
    await addressesProvider.getPriceOracle(),
    signer
  );
  await Promise.all(
    markets.map(async (marketAddress) => {
      const aToken = AToken__factory.connect(marketAddress, signer);

      const underlying = await aToken.UNDERLYING_ASSET_ADDRESS();
      await oracle.setAssetPrice(
        underlying,
        await realOracle.getAssetPrice(underlying)
      );
    })
  );

  const adminAddress = await addressesProvider.owner();
  await hre.network.provider.send("hardhat_impersonateAccount", [adminAddress]);
  await hre.network.provider.send("hardhat_setBalance", [
    adminAddress,
    ethers.utils.parseEther("10").toHexString(),
  ]);
  const admin = await ethers.getSigner(adminAddress);
  await addressesProvider.connect(admin).setPriceOracle(oracle.address);
  return {
    lendingPool,
    addressesProvider,
    oracle,
    admin,
  };
};

export interface TokenConfig {
  balanceOfStorageSlot: number;
  address: string;
  cToken: string;
  aToken: string;
  decimals: number;
}
export const setupToken = async (
  config: TokenConfig,
  owner: Signer,
  accounts: Signer[],
  amountToFill: BigNumber
) => {
  const token = ERC20__factory.connect(config.address, owner);
  await Promise.all(
    accounts.map(async (acc) => {
      const balanceOfUserStorageSlot = getBalanceOfStorageSlot(
        await acc.getAddress(),
        config.balanceOfStorageSlot
      );
      await hre.ethers.provider.send("hardhat_setStorageAt", [
        token.address,
        cropHexString(balanceOfUserStorageSlot),
        padHexString(amountToFill.toHexString()),
      ]);
    })
  );
  return {
    token,
    cToken: ICToken__factory.connect(config.cToken, owner),
    aToken: IAToken__factory.connect(config.aToken, owner),
  };
};
