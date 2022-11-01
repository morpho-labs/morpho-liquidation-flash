// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

interface IVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}
