// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Agora402Escrow} from "../src/Agora402Escrow.sol";

contract DeployScript is Script {
    // Base Sepolia USDC address
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // Default 2% protocol fee
    uint256 constant DEFAULT_FEE_BPS = 200;

    function run() external {
        address arbiter = vm.envAddress("ARBITER_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        Agora402Escrow escrow = new Agora402Escrow(
            BASE_SEPOLIA_USDC,
            arbiter,
            treasury,
            DEFAULT_FEE_BPS
        );

        console.log("Agora402Escrow deployed at:", address(escrow));
        console.log("USDC:", BASE_SEPOLIA_USDC);
        console.log("Arbiter:", arbiter);
        console.log("Treasury:", treasury);
        console.log("Fee:", DEFAULT_FEE_BPS, "bps");
        console.log("Owner:", escrow.owner());

        vm.stopBroadcast();
    }
}
