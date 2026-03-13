// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PayCrowEscrow} from "../src/PayCrowEscrow.sol";
import {PayCrowEscrowRouter} from "../src/PayCrowEscrowRouter.sol";
import {PayCrowReputation} from "../src/PayCrowReputation.sol";

/// @notice Deploy ALL PayCrow contracts to Base MAINNET in a single broadcast.
///         This is the production deployment — real USDC, real money.
///
///         1. PayCrowEscrow (with router + reputation support)
///         2. PayCrowReputation (on-chain trust ledger)
///         3. PayCrowEscrowRouter (atomic x402 settlement)
///         4. Wire them together
contract DeployMainnetScript is Script {
    // Base mainnet USDC (Circle official)
    address constant BASE_MAINNET_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 constant DEFAULT_FEE_BPS = 200; // 2%

    function run() external {
        address arbiter = vm.envAddress("ARBITER_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        console.log("=== PayCrow Base MAINNET Deployment ===");
        console.log("USDC:", BASE_MAINNET_USDC);
        console.log("Arbiter:", arbiter);
        console.log("Treasury:", treasury);
        console.log("Fee: 200 bps (2%)");
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy Escrow
        PayCrowEscrow escrow = new PayCrowEscrow(
            BASE_MAINNET_USDC,
            arbiter,
            treasury,
            DEFAULT_FEE_BPS
        );
        console.log("PayCrowEscrow:      ", address(escrow));

        // 2. Deploy Reputation
        PayCrowReputation reputation = new PayCrowReputation();
        console.log("PayCrowReputation:  ", address(reputation));

        // 3. Deploy Router
        PayCrowEscrowRouter router = new PayCrowEscrowRouter(
            BASE_MAINNET_USDC,
            address(escrow)
        );
        console.log("PayCrowEscrowRouter:", address(router));

        // 4. Wire: Escrow ↔ Reputation
        escrow.setReputation(address(reputation));
        reputation.setEscrowContract(address(escrow));

        // 5. Wire: Escrow ← Router (authorize)
        escrow.setRouter(address(router), true);

        console.log("");
        console.log("=== Wiring complete ===");
        console.log("Escrow.reputation:", address(escrow.reputation()));
        console.log("Reputation.escrowContract:", reputation.escrowContract());
        console.log("Router authorized:", escrow.authorizedRouters(address(router)));

        vm.stopBroadcast();
    }
}
