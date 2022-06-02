const axios = require("axios");
const ethers = require("ethers");
const BigNumber = ethers.BigNumber;
const SlackNotify = require("slack-notify");
const { formatUnits } = require("ethers/lib/utils");

let SLACK_WEBHOOK_URL;
let RPC_URL;
let slack;
let GRAPH_URL;
const morphoAddress = "0x8888882f8f843896699869179fB6E4f7e3B58888";
const lensAddress = "";

const init = () => {
  SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
  RPC_URL = process.env.RPC_URL;
  GRAPH_URL = process.env.GRAPH_URL;
  if (!(SLACK_WEBHOOK_URL && RPC_URL && GRAPH_URL))
    throw Error("Invalid configuration");
  slack = SlackNotify(SLACK_WEBHOOK_URL);
};

exports.lambdaHandler = async (event, context) => {
  init();
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL, 1);

  const morphoContract = new ethers.Contract(
    morphoAddress,
    require("./abis/Morpho.json"),
    provider
  );

  const users = await getUsers(GRAPH_URL);

  const markets = await morphoContract.getAllMarkets();
  const comptroller = new ethers.Contract(
    await morphoContract.comptroller(),
    require("./abis/Comptroller.json"),
    provider
  );
  const oracle = new ethers.Contract(
    await comptroller.oracle(),
    require("./abis/Oracle.json"),
    provider
  );

  let totalSupply = BigNumber.from(0);
  let totalCollateral = BigNumber.from(0);
  let totalBorrow = BigNumber.from(0);
  await Promise.all(
    markets.map(async (market) => {
      const cToken = new ethers.Contract(
        market,
        require("./abis/CToken.json"),
        provider
      );

      const { collateralFactorMantissa } = await comptroller.markets(market);
      const cTokenBalance = await cToken.balanceOf(morphoAddress);
      const borrowBalanceStored = await cToken.borrowBalanceStored(
        morphoAddress
      );

      const supplyIndex = await cToken.exchangeRateStored();
      const borrowIndex = await cToken.borrowIndex();
      const price = await oracle.getUnderlyingPrice(market);
      const usdSupply = cTokenBalance
        .mul(supplyIndex)
        .mul(price)
        .div(BigNumber.from(10).pow(18 * 2));
      const usdCollateral = usdSupply
        .mul(collateralFactorMantissa)
        .div(BigNumber.from(10).pow(18));
      const usdDebt = borrowBalanceStored
        .mul(borrowIndex)
        .mul(price)
        .div(BigNumber.from(10).pow(18 * 2));
      totalSupply = totalSupply.add(usdSupply);
      totalBorrow = totalBorrow.add(usdDebt);
      totalCollateral = totalCollateral.add(usdCollateral);
    })
  );
  const healthFactor = totalBorrow.eq(0)
    ? "Infinite"
    : totalCollateral.mul(BigNumber.from(10).pow(18)).div(totalBorrow);
  const bcu = totalCollateral.eq(0)
    ? BigNumber.from(0)
    : totalBorrow.mul(10000).div(totalCollateral);
  const supplyFactor = totalBorrow.eq(0)
    ? "Infinite"
    : totalSupply.mul(BigNumber.from(10).pow(18)).div(totalBorrow);
  const txt = `
                                Morpho status at ${Date.now().toLocaleString()}
Total users: ${users.length} Suppliers, ${
    users.filter((u) => u.isBorrower).length
  } Borrowers
Total Collateral: ${formatUnits(totalCollateral)}$
Total Debt: ${formatUnits(totalBorrow)}$
Total Supply: ${formatUnits(totalSupply)}$
                Morpho Health Factor: ${
                  healthFactor === "Infinite"
                    ? "Infinite"
                    : formatUnits(healthFactor)
                } (Borrow Capacity used: ${formatUnits(bcu, 2)}%)
                Supply/Borrow Factor: ${formatUnits(supplyFactor)}
  `;
  await notify(txt);
};

const notify = async (text) =>
  slack.send({
    channel: "#mainnet-bots",
    // icon_url: "http://example.com/my-icon.png",
    text,
    unfurl_links: 1,
    username: "Tracking Bot",
  });

const query = `{
  users(first: 1000) {
    id
    address
    isBorrower
  }
}`;
const getUsers = async (graphUrl) =>
  axios.post(graphUrl, { query }).then((r) => r.data.data.users);
