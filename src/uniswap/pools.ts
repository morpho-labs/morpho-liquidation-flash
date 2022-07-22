import axios from "axios";

export const graphUrl =
  "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";
const query = `
  query GetPool($token1: ID!, $token2: ID!) {
    pools(
      first: 10
      where: { token0_in: [$token1, $token2], token1_in: [$token1, $token2] }
    ) {
      id
      token0 {
        name
        id
      }
      feeTier
      token1 {
        name
        id
      }
      totalValueLockedToken0
      totalValueLockedToken1
    }
  }
`;

export const getPoolData = (token1: string, token2: string) => {
  return axios
    .post(graphUrl, {
      query,
      variables: {
        token1,
        token2,
      },
    })
    .then((result) => {
      console.log(result.data);
      return result.data.data;
    });
};
