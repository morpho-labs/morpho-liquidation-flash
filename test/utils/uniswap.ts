import { Currency, TradeType } from "@uniswap/sdk-core";

export const getQuoteToken = (
  tokenIn: Currency,
  tokenOut: Currency,
  tradeType: TradeType
): Currency => {
  return tradeType == TradeType.EXACT_INPUT ? tokenOut : tokenIn;
};
