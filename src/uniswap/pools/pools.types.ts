export interface UniswapToken {
  name: string;
  id: string;
}

export interface UniswapPool {
  id: string;
  token0: UniswapToken;
  token1: UniswapToken;
  feeTier: string;
  totalValueLockedToken0: string;
  totalValueLockedToken1: string;
}
