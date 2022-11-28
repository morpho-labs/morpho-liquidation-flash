// SPDX-License-Identifier: GNU AGPLv3
pragma solidity ^0.8.0;

interface ILiquidator {
    function liquidate(
        address _poolBorrowed,
        address _poolCollateral,
        address _borrower,
        uint256 _toLiquidate,
        bool _stakeTokens,
        bytes memory _path
    ) external;
}