import { ethers } from "hardhat";
import config, { AVAILABLE_PROTOCOLS } from "../config";
import { formatUnits } from "ethers/lib/utils";

const contractsNames: Record<string, string> = {
  aave: "FlashMintLiquidatorBorrowRepayAave",
  compound: "FlashMintLiquidatorBorrowRepayCompound",
};
const params: Record<string, any[]> = {
  aave: [
    config.lender,
    config.univ3Router,
    config.addressesProvider,
    config.morphoAave,
    config.tokens.dai.aToken,
    config.slippageTolerance,
  ],
  compound: [
    config.lender,
    config.univ3Router,
    config.morphoCompound,
    config.tokens.dai.cToken,
    config.slippageTolerance,
  ],
};

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer", signer.address);

  // Check protocols
  const protocols = process.env.PROTOCOLS?.split(",");
  if (!protocols) throw new Error("No protocols found");
  protocols.forEach((protocol) => {
    if (!AVAILABLE_PROTOCOLS.includes(protocol))
      throw new Error(`Invalid protocol ${protocol}`);
  });

  for (const protocol of protocols) {
    console.log(`Deploying ${protocol} liquidator`);

    const FlashMintLiquidator = await ethers.getContractFactory(
      contractsNames[protocol]
    );

    const balance = await signer.getBalance();
    console.log("ETH balance", formatUnits(balance));
    const transaction = await FlashMintLiquidator.deploy(...params[protocol]);
    const deploymentAddress = transaction.address;
    console.log(
      `Deploying liquidator for Morpho ${protocol} at address`,
      deploymentAddress
    );
    await transaction.deployed();

    console.log("Successfully deployed to", deploymentAddress);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
