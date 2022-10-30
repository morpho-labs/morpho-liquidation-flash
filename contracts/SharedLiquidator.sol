// SPDX-License-Identifier: GNU AGPLv3
pragma solidity 0.8.13;

import "@rari-capital/solmate/src/utils/SafeTransferLib.sol";

import "@openzeppelin/contracts/access/Ownable.sol";

contract SharedLiquidator is Ownable {
    using SafeTransferLib for ERC20;

    mapping(address => bool) public isLiquidator;

    error OnlyLiquidator();

    event LiquidatorAdded(address indexed _liquidatorAdded);

    event LiquidatorRemoved(address indexed _liquidatorRemoved);

    event Withdrawn(
        address indexed sender,
        address indexed receiver,
        address indexed underlyingAddress,
        uint256 amount
    );

    modifier onlyLiquidator() {
        if (!isLiquidator[msg.sender]) revert OnlyLiquidator();
        _;
    }

    constructor() {
        isLiquidator[msg.sender] = true;
        emit LiquidatorAdded(msg.sender);
    }

    function addLiquidator(address _newLiquidator) external onlyOwner {
        isLiquidator[_newLiquidator] = true;
        emit LiquidatorAdded(_newLiquidator);
    }

    function removeLiquidator(address _liquidatorToRemove) external onlyOwner {
        isLiquidator[_liquidatorToRemove] = false;
        emit LiquidatorRemoved(_liquidatorToRemove);
    }

    function withdraw(
        address _underlyingAddress,
        address _receiver,
        uint256 _amount
    ) external onlyOwner {
        uint256 amountMax = ERC20(_underlyingAddress).balanceOf(address(this));
        uint256 amount = _amount > amountMax ? amountMax : _amount;
        ERC20(_underlyingAddress).safeTransfer(_receiver, amount);
        emit Withdrawn(msg.sender, _receiver, _underlyingAddress, amount);
    }
}
