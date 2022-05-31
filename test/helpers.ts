import { BigNumber, BigNumberish } from "ethers";

export const pow10 = (pow: BigNumberish) => BigNumber.from(10).pow(pow);
