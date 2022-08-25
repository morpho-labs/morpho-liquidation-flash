import { ethers, tenderly } from "hardhat";
import config from "../config";
import { formatUnits } from "ethers/lib/utils";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer", signer.address);
  await tenderly.verify(["0xe7FFcce05c17F414150Bb864945a82899C013C4b"]);
  process.exit();
  const FlashMintLiquidator = await ethers.getContractFactory(
    "FlashMintLiquidatorBorrowRepay"
  );
  const balance = await signer.getBalance();
  console.log("ETH balance", formatUnits(balance));
  const transaction = await FlashMintLiquidator.deploy(
    config.lender,
    config.univ3Router,
    config.morphoCompound,
    config.tokens.dai.cToken,
    config.slippageTolerance
  );
  const deploymentAddress = transaction.address;
  console.log("Deploying to", deploymentAddress);
  await transaction.deployed();

  console.log("Successfully deployed to", deploymentAddress);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
