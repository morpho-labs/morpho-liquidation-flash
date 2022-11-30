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

To run a liquidation check, you just have to set the right environment variables, extracted from the `.env.example` file:
- `PRIVATE_KEY`: the private key of the account that will be used to send the transactions. If not provided, you'll run the bot in read only mode.
- `ALCHEMY_KEY`: the Alchemy key to connect to the Ethereum network.
- `LIQUIDATOR_ADDRESSES`: a comma separated list of the liquidator contract addresses to use.
- `PROFITABLE_THRESHOLD`: the liquidation threshold to use (in USD).
- `BATCH_SIZE`: The number of parallel queries sent to the Ethereum network.
- `PROTOCOLS`: The underlying protocols to use (comma separated list).
- `DELAY`: The delay between two liquidations check. If not provided, the bot will run only once.
Then, you can just run:

```shell
ts-node scripts/runBot.ts
```

### Remotely

To deploy the liquidation bot on AWS Lambda, you have to use the AWS SAM cli, and running

```shell
sam build && sam deploy --guided
```
