# Morpho Liquidator contract

This project is an advanced Liquidator contract, built on top of Morpho Compound Mainnet

## Flash Mint liquidator with double swap

The first version of the Liquidator contract uses a MakerDAO Flash loan and Uniswap v3 swaps to
retrieve the right asset during the flash loan to perform the liquidation.

This contract is deployed on mainnet (see release v0.1.0)

## Development

Building contracts:

```shell
npx hardhat compile
```

Running tests:

```shell
REPORT_GAS=true npx hardhat test
```
