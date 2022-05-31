import { ethers } from "hardhat";

async function main() {
  const FlashMintLiquidator = await ethers.getContractFactory("FlashMintLiquidator");
  const flashMintLiquidator = await FlashMintLiquidator.deploy();

  await flashMintLiquidator.deployed();

  console.log("FlashMintLiquidator deployed to:", flashMintLiquidator.address);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
