// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PayCrowEscrow} from "./PayCrowEscrow.sol";

/// @title IERC20WithAuthorization
/// @notice Interface for USDC's EIP-3009 transferWithAuthorization
interface IERC20WithAuthorization is IERC20 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title PayCrowEscrowRouter
/// @notice Atomically settles x402 EIP-3009 payments into PayCrowEscrow.
///         Used by the PayCrow x402 facilitator as the settlement layer.
///
/// Flow:
///   1. x402 client signs EIP-3009 transferWithAuthorization(from=client, to=router, value)
///   2. Facilitator calls settleToEscrow() with the signed auth + escrow params
///   3. Router executes transferWithAuthorization → USDC arrives at router
///   4. Router approves escrow contract, calls createAndFundFor(buyer=client, ...)
///   5. Client is the escrow buyer — can release/dispute directly via MCP server
///
/// @dev Zero seller-side changes. Sellers receive USDC on release, same as direct x402.
contract PayCrowEscrowRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20WithAuthorization public immutable usdc;
    PayCrowEscrow public immutable escrow;

    event SettledToEscrow(
        uint256 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        bytes32 serviceHash
    );

    error SettlementFailed();

    constructor(address _usdc, address _escrow) {
        usdc = IERC20WithAuthorization(_usdc);
        escrow = PayCrowEscrow(_escrow);

        // Max-approve the escrow contract once. Router never holds USDC
        // beyond the scope of a single transaction.
        IERC20(_usdc).approve(_escrow, type(uint256).max);
    }

    /// @notice Atomically settle an x402 payment into an PayCrow escrow.
    /// @param from The x402 client (buyer) who signed the EIP-3009 authorization
    /// @param value Amount of USDC authorized (must match escrow amount)
    /// @param validAfter EIP-3009 time constraint
    /// @param validBefore EIP-3009 time constraint
    /// @param nonce EIP-3009 nonce
    /// @param v EIP-3009 signature v
    /// @param r EIP-3009 signature r
    /// @param s EIP-3009 signature s
    /// @param seller Address of the seller/service provider
    /// @param timelockDuration Seconds until the escrow expires
    /// @param serviceHash keccak256 of the service URL being purchased
    /// @return escrowId The ID of the newly created escrow
    function settleToEscrow(
        // EIP-3009 params
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s,
        // Escrow params
        address seller,
        uint256 timelockDuration,
        bytes32 serviceHash
    ) external nonReentrant returns (uint256 escrowId) {
        // Step 1: Execute EIP-3009 transfer (client → router)
        usdc.transferWithAuthorization(
            from,
            address(this),
            value,
            validAfter,
            validBefore,
            nonce,
            v, r, s
        );

        // Step 2: Create escrow with buyer = the original client (from)
        // Approval was given in constructor (max approve)
        escrowId = escrow.createAndFundFor(
            from,       // buyer = the agent who signed the auth
            seller,
            value,
            timelockDuration,
            serviceHash
        );

        emit SettledToEscrow(escrowId, from, seller, value, serviceHash);
    }
}
