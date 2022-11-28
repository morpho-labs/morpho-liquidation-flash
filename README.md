# Morpho Liquidator contract

This project is an advanced Liquidator contract, built on top of Morpho Compound Mainnet

## Flash Mint liquidator

The first version of the Liquidator contract uses a MakerDAO Flash loan of DAI, a supply/borrow on Compound, and a swap on Uniswap V3.

## Development

Building contracts:

```shell
yarn compile
```

Running tests:

```shell
yarn test
```

## Liquidation bot

### Locally

To run a liquidation check, you just have to set the right environement variables: `PRIVATE_KEY` and `ALCHEMY_KEY`
and the `LIQUIDATOR_ADDRESS` which is the address of the deployed liquidator contract.  
Then, you can just run:

```shell
FROM_ENV=true ts-node scripts/runBot.ts
```

### Remotely

To deploy the liquidation bot on AWS Lambda, you have to use the AWS SAM cli, and running

```shell
sam build && sam deploy --guided
```
