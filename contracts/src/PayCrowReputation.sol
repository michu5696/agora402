// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PayCrowReputation
/// @notice On-chain reputation ledger for the agent economy.
///         Every escrow outcome (release, dispute, refund) writes a permanent,
///         publicly queryable reputation record. No one can fake these scores.
///
/// @dev Only the PayCrowEscrow contract can write reputation (via setEscrowContract).
///      Scores are computed off-chain from on-chain events for flexibility.
///      This contract is the immutable data layer — the source of truth.
contract PayCrowReputation {
    // ─── Types ───────────────────────────────────────────────────────────

    struct Reputation {
        uint64 totalCompleted;   // Escrows successfully released
        uint64 totalDisputed;    // Escrows where this address was disputed
        uint64 totalRefunded;    // Escrows that expired and were refunded
        uint64 totalAsProvider;  // Times this address was the seller/provider
        uint64 totalAsClient;    // Times this address was the buyer/client
        uint256 totalVolume;     // Total USDC volume (in base units, 6 decimals)
        uint256 firstSeen;       // Timestamp of first escrow involvement
        uint256 lastSeen;        // Timestamp of most recent escrow involvement
    }

    enum Outcome {
        Completed,  // 0 — escrow released successfully
        Disputed,   // 1 — escrow disputed (bad delivery)
        Refunded    // 2 — escrow expired and refunded
    }

    // ─── State ───────────────────────────────────────────────────────────

    address public owner;
    address public escrowContract;

    /// @notice Reputation data for each address
    mapping(address => Reputation) public reputations;

    /// @notice Total number of unique addresses with reputation
    uint256 public totalAddresses;

    // ─── Events ──────────────────────────────────────────────────────────

    /// @notice Emitted on every escrow outcome — the core data for off-chain scoring
    event ReputationUpdated(
        address indexed agent,
        Outcome indexed outcome,
        uint256 amount,
        uint256 escrowId,
        bool isProvider  // true if agent was the seller/provider
    );

    event EscrowContractUpdated(address indexed oldContract, address indexed newContract);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    // ─── Errors ──────────────────────────────────────────────────────────

    error NotOwner();
    error NotEscrowContract();
    error ZeroAddress();

    // ─── Modifiers ───────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyEscrow() {
        if (msg.sender != escrowContract) revert NotEscrowContract();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ─── Core: Record Reputation ─────────────────────────────────────────

    /// @notice Record an escrow outcome for both buyer and seller.
    ///         Only callable by the authorized PayCrowEscrow contract.
    /// @param buyer The escrow buyer (client)
    /// @param seller The escrow seller (provider)
    /// @param amount The escrow amount in USDC base units
    /// @param escrowId The escrow ID for traceability
    /// @param outcome The escrow outcome (Completed, Disputed, Refunded)
    function recordOutcome(
        address buyer,
        address seller,
        uint256 amount,
        uint256 escrowId,
        Outcome outcome
    ) external onlyEscrow {
        _updateReputation(buyer, amount, outcome, false);
        _updateReputation(seller, amount, outcome, true);

        emit ReputationUpdated(buyer, outcome, amount, escrowId, false);
        emit ReputationUpdated(seller, outcome, amount, escrowId, true);
    }

    // ─── View: Query Reputation ──────────────────────────────────────────

    /// @notice Get the full reputation record for an address
    function getReputation(address agent)
        external
        view
        returns (
            uint64 totalCompleted,
            uint64 totalDisputed,
            uint64 totalRefunded,
            uint64 totalAsProvider,
            uint64 totalAsClient,
            uint256 totalVolume,
            uint256 firstSeen,
            uint256 lastSeen
        )
    {
        Reputation storage r = reputations[agent];
        return (
            r.totalCompleted,
            r.totalDisputed,
            r.totalRefunded,
            r.totalAsProvider,
            r.totalAsClient,
            r.totalVolume,
            r.firstSeen,
            r.lastSeen
        );
    }

    /// @notice Compute an on-chain trust score (0-100) for convenience.
    ///         More sophisticated scoring should be done off-chain using events.
    function getScore(address agent) external view returns (uint256 score) {
        Reputation storage r = reputations[agent];
        uint256 total = uint256(r.totalCompleted) + uint256(r.totalDisputed) + uint256(r.totalRefunded);

        if (total == 0) return 50; // Default score for unknown agents

        // Simple formula: score = (completed * 100) / total
        // Capped at 100, floor at 0
        score = (uint256(r.totalCompleted) * 100) / total;
    }

    // ─── Admin ───────────────────────────────────────────────────────────

    /// @notice Set the authorized escrow contract that can write reputation
    function setEscrowContract(address _escrowContract) external onlyOwner {
        if (_escrowContract == address(0)) revert ZeroAddress();
        emit EscrowContractUpdated(escrowContract, _escrowContract);
        escrowContract = _escrowContract;
    }

    /// @notice Transfer ownership
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    // ─── Internal ────────────────────────────────────────────────────────

    function _updateReputation(
        address agent,
        uint256 amount,
        Outcome outcome,
        bool isProvider
    ) internal {
        Reputation storage r = reputations[agent];

        // Track first seen
        if (r.firstSeen == 0) {
            r.firstSeen = block.timestamp;
            totalAddresses++;
        }
        r.lastSeen = block.timestamp;

        // Update role counters
        if (isProvider) {
            r.totalAsProvider++;
        } else {
            r.totalAsClient++;
        }

        // Update outcome counters
        if (outcome == Outcome.Completed) {
            r.totalCompleted++;
        } else if (outcome == Outcome.Disputed) {
            r.totalDisputed++;
        } else {
            r.totalRefunded++;
        }

        // Track volume
        r.totalVolume += amount;
    }
}
