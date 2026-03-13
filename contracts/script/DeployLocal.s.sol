// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PayCrowEscrow} from "../src/PayCrowEscrow.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock USDC for local testing (6 decimals, mintable)
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Deploy everything to local Anvil for E2E testing
contract DeployLocalScript is Script {
    uint256 constant DEFAULT_FEE_BPS = 200; // 2%
    uint256 constant MINT_AMOUNT = 10_000_000_000; // $10,000 USDC

    function run() external {
        // Anvil's default private key (account 0)
        uint256 deployerKey = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // Deploy mock USDC
        MockUSDC usdc = new MockUSDC();
        console.log("MockUSDC deployed at:", address(usdc));

        // Deploy escrow (deployer is arbiter + treasury for testing)
        PayCrowEscrow escrow = new PayCrowEscrow(
            address(usdc),
            deployer,  // arbiter
            deployer,  // treasury
            DEFAULT_FEE_BPS
        );
        console.log("PayCrowEscrow deployed at:", address(escrow));

        // Mint USDC to deployer
        usdc.mint(deployer, MINT_AMOUNT);
        console.log("Minted", MINT_AMOUNT, "USDC to deployer");

        // Mint USDC to a second test account (Anvil account 1)
        address buyer = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        usdc.mint(buyer, MINT_AMOUNT);
        console.log("Minted", MINT_AMOUNT, "USDC to buyer:", buyer);

        console.log("");
        console.log("=== Local Deployment Complete ===");
        console.log("USDC:    ", address(usdc));
        console.log("Escrow:  ", address(escrow));
        console.log("Owner:   ", deployer);
        console.log("Arbiter: ", deployer);
        console.log("Treasury:", deployer);
        console.log("Fee:      200 bps (2%)");

        vm.stopBroadcast();
    }
}
