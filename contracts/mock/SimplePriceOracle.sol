// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

contract SimplePriceOracle {
    bool public constant isPriceOracle = true;

    event PriceUpdated(address indexed _cToken, uint256 _newPrice);

    constructor() {}

    mapping(address => uint256) prices;

    function getUnderlyingPrice(address _cTokenAddress) external view returns (uint256 price) {
        price = prices[_cTokenAddress];
    }

    function getAssetPrice(address _underlying) external view returns (uint256 price) {
        price = prices[_underlying];
    }

    function setUnderlyingPrice(address _cTokenAddress, uint256 _price) external {
        prices[_cTokenAddress] = _price;
        emit PriceUpdated(_cTokenAddress, _price);
    }

    function setAssetPrice(address _underlying, uint256 _price) external {
        prices[_underlying] = _price;
        emit PriceUpdated(_underlying, _price);
    }
}
