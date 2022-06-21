import { ethers } from "hardhat";

export const abiCoder = new ethers.utils.AbiCoder();

export const getBalanceOfStorageSlot = (
  accountAddress: string,
  mappingStorageSlot: number
) =>
  ethers.utils.keccak256(
    abiCoder.encode(
      ["address", "uint256"],
      [accountAddress, mappingStorageSlot]
    )
  );

export const padHexString = (hexString: string, nbBytes: number = 32) =>
  "0x" + hexString.slice(2).padStart(nbBytes * 2, "0");

export const cropHexString = (hexString: string, nbBytes: number = 32) =>
  "0x" + hexString.slice(2).replace(/^0+/, "");
