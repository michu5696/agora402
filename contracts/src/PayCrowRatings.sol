// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PayCrowEscrow} from "./PayCrowEscrow.sol";

/// @title PayCrowRatings
/// @notice On-chain quality ratings for completed escrows.
///         After an escrow is released, the buyer can rate the service 1-5 stars.
///         These ratings feed into trust scoring — a provider with 100 completions
///         but 1.5 average stars is worse than one with 10 completions and 4.8 stars.
///
/// @dev Ratings are bilateral: buyers rate sellers, and sellers can rate buyers.
///      This prevents gaming — a buyer who always rates 1 star to get disputes
///      will themselves get low ratings from sellers.
contract PayCrowRatings {

    // ─── Types ───────────────────────────────────────────────────────────

    struct Rating {
        uint8 stars;        // 1-5
        uint256 timestamp;
    }

    struct AgentRatings {
        uint64 totalRatingsReceived;
        uint64 totalStarsReceived;     // Sum of all stars received
        uint64 totalRatingsGiven;
        uint64 totalStarsGiven;        // Sum of all stars given
        // Breakdown
        uint64 fiveStarCount;
        uint64 oneStarCount;
    }

    // ─── State ───────────────────────────────────────────────────────────

    address public owner;
    PayCrowEscrow public escrowContract;

    /// @notice Buyer's rating of the seller for a specific escrow
    mapping(uint256 => Rating) public buyerRatings;

    /// @notice Seller's rating of the buyer for a specific escrow
    mapping(uint256 => Rating) public sellerRatings;

    /// @notice Aggregate ratings per address
    mapping(address => AgentRatings) public agentRatings;

    /// @notice Total ratings submitted
    uint256 public totalRatings;

    // ─── Events ──────────────────────────────────────────────────────────

    event ServiceRated(
        uint256 indexed escrowId,
        address indexed rater,
        address indexed rated,
        uint8 stars,
        bool raterIsBuyer
    );

    // ─── Errors ──────────────────────────────────────────────────────────

    error NotOwner();
    error ZeroAddress();
    error InvalidRating();           // stars must be 1-5
    error EscrowNotReleased();       // can only rate released escrows
    error AlreadyRated();            // one rating per side per escrow
    error NotParticipant();          // must be buyer or seller of escrow

    // ─── Modifiers ───────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────

    constructor(address _escrowContract) {
        if (_escrowContract == address(0)) revert ZeroAddress();
        owner = msg.sender;
        escrowContract = PayCrowEscrow(_escrowContract);
    }

    // ─── Core: Submit Rating ─────────────────────────────────────────────

    /// @notice Rate a completed escrow. Buyer rates the seller's service quality.
    ///         Seller rates the buyer's conduct (fair dealing, no false disputes).
    /// @param escrowId The escrow to rate
    /// @param stars Rating 1-5 (1=terrible, 5=excellent)
    function rate(uint256 escrowId, uint8 stars) external {
        if (stars < 1 || stars > 5) revert InvalidRating();

        // Verify escrow is released (completed successfully)
        (
            address buyer,
            address seller,
            ,  // amount
            ,  // createdAt
            ,  // expiresAt
            PayCrowEscrow.EscrowState state,
               // serviceHash
        ) = escrowContract.getEscrow(escrowId);

        if (state != PayCrowEscrow.EscrowState.Released) revert EscrowNotReleased();

        bool isBuyer = msg.sender == buyer;
        bool isSeller = msg.sender == seller;
        if (!isBuyer && !isSeller) revert NotParticipant();

        if (isBuyer) {
            // Buyer rates the seller's service
            if (buyerRatings[escrowId].stars != 0) revert AlreadyRated();
            buyerRatings[escrowId] = Rating(stars, block.timestamp);
            _recordRating(seller, stars, true);
            _recordGiven(buyer, stars);
            emit ServiceRated(escrowId, buyer, seller, stars, true);
        } else {
            // Seller rates the buyer's conduct
            if (sellerRatings[escrowId].stars != 0) revert AlreadyRated();
            sellerRatings[escrowId] = Rating(stars, block.timestamp);
            _recordRating(buyer, stars, true);
            _recordGiven(seller, stars);
            emit ServiceRated(escrowId, seller, buyer, stars, false);
        }

        totalRatings++;
    }

    // ─── View Functions ──────────────────────────────────────────────────

    /// @notice Get average rating for an address (0-500, divide by 100 for decimal)
    ///         Returns 0 if no ratings yet.
    function getAverageRating(address agent) external view returns (uint256) {
        AgentRatings storage r = agentRatings[agent];
        if (r.totalRatingsReceived == 0) return 0;
        // Return as integer * 100 for precision (e.g., 450 = 4.50 stars)
        return (uint256(r.totalStarsReceived) * 100) / uint256(r.totalRatingsReceived);
    }

    /// @notice Get average rating the agent gives others (are they harsh or fair?)
    function getAverageRatingGiven(address agent) external view returns (uint256) {
        AgentRatings storage r = agentRatings[agent];
        if (r.totalRatingsGiven == 0) return 0;
        return (uint256(r.totalStarsGiven) * 100) / uint256(r.totalRatingsGiven);
    }

    /// @notice Get full rating stats for an address
    function getRatingStats(address agent)
        external
        view
        returns (
            uint64 ratingsReceived,
            uint64 starsReceived,
            uint64 ratingsGiven,
            uint64 starsGiven,
            uint64 fiveStarCount,
            uint64 oneStarCount
        )
    {
        AgentRatings storage r = agentRatings[agent];
        return (
            r.totalRatingsReceived,
            r.totalStarsReceived,
            r.totalRatingsGiven,
            r.totalStarsGiven,
            r.fiveStarCount,
            r.oneStarCount
        );
    }

    /// @notice Check if a specific escrow has been rated by buyer/seller
    function isRated(uint256 escrowId) external view returns (bool buyerRated, bool sellerRated) {
        buyerRated = buyerRatings[escrowId].stars != 0;
        sellerRated = sellerRatings[escrowId].stars != 0;
    }

    // ─── Admin ───────────────────────────────────────────────────────────

    function setEscrowContract(address _escrowContract) external onlyOwner {
        if (_escrowContract == address(0)) revert ZeroAddress();
        escrowContract = PayCrowEscrow(_escrowContract);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ─── Internal ────────────────────────────────────────────────────────

    function _recordRating(address agent, uint8 stars, bool received) internal {
        AgentRatings storage r = agentRatings[agent];
        if (received) {
            r.totalRatingsReceived++;
            r.totalStarsReceived += uint64(stars);
            if (stars == 5) r.fiveStarCount++;
            if (stars == 1) r.oneStarCount++;
        }
    }

    function _recordGiven(address agent, uint8 stars) internal {
        AgentRatings storage r = agentRatings[agent];
        r.totalRatingsGiven++;
        r.totalStarsGiven += uint64(stars);
    }
}
