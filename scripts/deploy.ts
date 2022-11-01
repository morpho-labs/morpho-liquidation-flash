import { ethers } from "hardhat";
import config from "../config";
import * as fs from "fs";

async function main() {
  const FlashMintLiquidator = await ethers.getContractFactory(
    "CompoundLiquidator"
  );
  const transaction = await FlashMintLiquidator.getDeployTransaction(
    config.lender,
    config.univ3Router,
    config.morpho,
    config.tokens.dai.cToken,
    config.slippageTolerance
  );
  await fs.writeFileSync(
    `deployments/CompoundLiquidator.json`,
    JSON.stringify(transaction, null, 2)
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
