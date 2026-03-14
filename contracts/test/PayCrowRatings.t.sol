// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {PayCrowRatings} from "../src/PayCrowRatings.sol";
import {PayCrowEscrow} from "../src/PayCrowEscrow.sol";
import {PayCrowReputation} from "../src/PayCrowReputation.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock USDC token for testing (6 decimals like real USDC)
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PayCrowRatingsTest is Test {
    PayCrowRatings public ratings;
    PayCrowEscrow public escrow;
    PayCrowReputation public reputation;
    MockUSDC public usdc;

    address public owner = address(this);
    address public arbiter = makeAddr("arbiter");
    address public treasuryAddr = makeAddr("treasury");
    address public buyer = makeAddr("buyer");
    address public seller = makeAddr("seller");
    address public stranger = makeAddr("stranger");

    uint256 public constant ONE_USDC = 1_000_000;
    uint256 public constant TEN_USDC = 10_000_000;
    uint256 public constant DEFAULT_TIMELOCK = 30 minutes;
    uint256 public constant DEFAULT_FEE_BPS = 200; // 2%
    bytes32 public constant SERVICE_HASH = keccak256("https://api.example.com/service");

    function setUp() public {
        // 1. Deploy mock USDC
        usdc = new MockUSDC();

        // 2. Deploy PayCrowReputation
        reputation = new PayCrowReputation();

        // 3. Deploy PayCrowEscrow
        escrow = new PayCrowEscrow(address(usdc), arbiter, treasuryAddr, DEFAULT_FEE_BPS);

        // 4. Set reputation on escrow
        escrow.setReputation(address(reputation));
        reputation.setEscrowContract(address(escrow));

        // 5. Deploy PayCrowRatings
        ratings = new PayCrowRatings(address(escrow));

        // Fund buyer with USDC and approve
        usdc.mint(buyer, 1000 * ONE_USDC);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _createAndReleaseEscrow(address _buyer, address _seller) internal returns (uint256) {
        vm.startPrank(_buyer);
        usdc.approve(address(escrow), ONE_USDC);
        uint256 id = escrow.createAndFund(_seller, ONE_USDC, 30 minutes, SERVICE_HASH);
        escrow.release(id);
        vm.stopPrank();
        return id;
    }

    function _createFundedEscrow(address _buyer, address _seller) internal returns (uint256) {
        vm.startPrank(_buyer);
        usdc.approve(address(escrow), ONE_USDC);
        uint256 id = escrow.createAndFund(_seller, ONE_USDC, 30 minutes, SERVICE_HASH);
        vm.stopPrank();
        return id;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Constructor Tests
    // ═══════════════════════════════════════════════════════════════════════

    function test_constructor_setsOwnerAndEscrow() public view {
        assertEq(ratings.owner(), owner);
        assertEq(address(ratings.escrowContract()), address(escrow));
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(PayCrowRatings.ZeroAddress.selector);
        new PayCrowRatings(address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // rate() - Buyer rates seller
    // ═══════════════════════════════════════════════════════════════════════

    function test_rate_buyerRatesReleasedEscrow() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(buyer);
        ratings.rate(id, 4);

        (uint8 stars, uint256 timestamp) = ratings.buyerRatings(id);
        assertEq(stars, 4);
        assertEq(timestamp, block.timestamp);
    }

    function test_rate_ratingStoredCorrectly() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(buyer);
        ratings.rate(id, 5);

        (uint8 stars, uint256 timestamp) = ratings.buyerRatings(id);
        assertEq(stars, 5);
        assertEq(timestamp, block.timestamp);
    }

    function test_rate_agentRatingsUpdated() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(buyer);
        ratings.rate(id, 4);

        (
            uint64 ratingsReceived,
            uint64 starsReceived,
            uint64 ratingsGiven,
            uint64 starsGiven,
            uint64 fiveStarCount,
            uint64 oneStarCount
        ) = ratings.getRatingStats(seller);

        assertEq(ratingsReceived, 1);
        assertEq(starsReceived, 4);
        assertEq(fiveStarCount, 0);
        assertEq(oneStarCount, 0);

        // Buyer's "given" stats
        (,, uint64 buyerGiven, uint64 buyerStarsGiven,,) = ratings.getRatingStats(buyer);
        assertEq(buyerGiven, 1);
        assertEq(buyerStarsGiven, 4);
    }

    function test_rate_emitsServiceRated_buyerRates() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.expectEmit(true, true, true, true);
        emit PayCrowRatings.ServiceRated(id, buyer, seller, 4, true);

        vm.prank(buyer);
        ratings.rate(id, 4);
    }

    function test_rate_revertsIfEscrowNotReleased() public {
        uint256 id = _createFundedEscrow(buyer, seller);

        vm.prank(buyer);
        vm.expectRevert(PayCrowRatings.EscrowNotReleased.selector);
        ratings.rate(id, 4);
    }

    function test_rate_revertsIfStarsTooLow() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(buyer);
        vm.expectRevert(PayCrowRatings.InvalidRating.selector);
        ratings.rate(id, 0);
    }

    function test_rate_revertsIfStarsTooHigh() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(buyer);
        vm.expectRevert(PayCrowRatings.InvalidRating.selector);
        ratings.rate(id, 6);
    }

    function test_rate_revertsIfAlreadyRated() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(buyer);
        ratings.rate(id, 4);

        vm.prank(buyer);
        vm.expectRevert(PayCrowRatings.AlreadyRated.selector);
        ratings.rate(id, 5);
    }

    function test_rate_revertsIfNotParticipant() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(stranger);
        vm.expectRevert(PayCrowRatings.NotParticipant.selector);
        ratings.rate(id, 3);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // rate() - Seller rates buyer
    // ═══════════════════════════════════════════════════════════════════════

    function test_rate_sellerRatesBuyer() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(seller);
        ratings.rate(id, 5);

        (uint8 stars, uint256 timestamp) = ratings.sellerRatings(id);
        assertEq(stars, 5);
        assertEq(timestamp, block.timestamp);
    }

    function test_rate_sellerRatingStoredInSellerRatings() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(seller);
        ratings.rate(id, 3);

        // sellerRatings populated
        (uint8 sellerStars,) = ratings.sellerRatings(id);
        assertEq(sellerStars, 3);

        // buyerRatings untouched
        (uint8 buyerStars,) = ratings.buyerRatings(id);
        assertEq(buyerStars, 0);
    }

    function test_rate_emitsServiceRated_sellerRates() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        // When seller rates: event is ServiceRated(escrowId, seller, buyer, stars, false)
        vm.expectEmit(true, true, true, true);
        emit PayCrowRatings.ServiceRated(id, seller, buyer, 3, false);

        vm.prank(seller);
        ratings.rate(id, 3);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Bilateral ratings
    // ═══════════════════════════════════════════════════════════════════════

    function test_rate_bothBuyerAndSellerCanRate() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(buyer);
        ratings.rate(id, 4);

        vm.prank(seller);
        ratings.rate(id, 5);

        (uint8 buyerStars,) = ratings.buyerRatings(id);
        (uint8 sellerStars,) = ratings.sellerRatings(id);
        assertEq(buyerStars, 4);
        assertEq(sellerStars, 5);
        assertEq(ratings.totalRatings(), 2);
    }

    function test_rate_bilateralRatingsDontInterfere() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        // Buyer rates seller 2 stars
        vm.prank(buyer);
        ratings.rate(id, 2);

        // Seller rates buyer 5 stars
        vm.prank(seller);
        ratings.rate(id, 5);

        // Seller received 2 stars (from buyer)
        (uint64 sellerReceived, uint64 sellerStarsReceived,,,,) = ratings.getRatingStats(seller);
        assertEq(sellerReceived, 1);
        assertEq(sellerStarsReceived, 2);

        // Buyer received 5 stars (from seller)
        (uint64 buyerReceived, uint64 buyerStarsReceived,,,,) = ratings.getRatingStats(buyer);
        assertEq(buyerReceived, 1);
        assertEq(buyerStarsReceived, 5);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // getAverageRating
    // ═══════════════════════════════════════════════════════════════════════

    function test_getAverageRating_returnsZeroForUnrated() public view {
        assertEq(ratings.getAverageRating(seller), 0);
    }

    function test_getAverageRating_returnsCorrectAverage() public {
        // Create two escrows, rate seller 4 and 5 => avg = 4.5 => 450
        address buyer2 = makeAddr("buyer2");
        usdc.mint(buyer2, 100 * ONE_USDC);
        vm.prank(buyer2);
        usdc.approve(address(escrow), type(uint256).max);

        uint256 id1 = _createAndReleaseEscrow(buyer, seller);
        uint256 id2 = _createAndReleaseEscrow(buyer2, seller);

        vm.prank(buyer);
        ratings.rate(id1, 4);

        vm.prank(buyer2);
        ratings.rate(id2, 5);

        assertEq(ratings.getAverageRating(seller), 450); // 4.50 * 100
    }

    function test_getAverageRating_updatesAcrossMultipleEscrows() public {
        // Rate seller across 3 escrows: 3, 4, 5 => avg = 4.0 => 400
        address buyer2 = makeAddr("buyer2");
        address buyer3 = makeAddr("buyer3");
        usdc.mint(buyer2, 100 * ONE_USDC);
        usdc.mint(buyer3, 100 * ONE_USDC);
        vm.prank(buyer2);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(buyer3);
        usdc.approve(address(escrow), type(uint256).max);

        uint256 id1 = _createAndReleaseEscrow(buyer, seller);
        uint256 id2 = _createAndReleaseEscrow(buyer2, seller);
        uint256 id3 = _createAndReleaseEscrow(buyer3, seller);

        vm.prank(buyer);
        ratings.rate(id1, 3);
        vm.prank(buyer2);
        ratings.rate(id2, 4);
        vm.prank(buyer3);
        ratings.rate(id3, 5);

        assertEq(ratings.getAverageRating(seller), 400); // (3+4+5)/3 = 4.0 * 100
    }

    // ═══════════════════════════════════════════════════════════════════════
    // getAverageRatingGiven
    // ═══════════════════════════════════════════════════════════════════════

    function test_getAverageRatingGiven_tracksRaterBehavior() public {
        // Buyer rates two sellers: 1 and 3 => avg given = 2.0 => 200
        address seller2 = makeAddr("seller2");
        usdc.mint(buyer, 100 * ONE_USDC);

        uint256 id1 = _createAndReleaseEscrow(buyer, seller);
        uint256 id2 = _createAndReleaseEscrow(buyer, seller2);

        vm.prank(buyer);
        ratings.rate(id1, 1);
        vm.prank(buyer);
        ratings.rate(id2, 3);

        assertEq(ratings.getAverageRatingGiven(buyer), 200); // (1+3)/2 = 2.0 * 100
    }

    function test_getAverageRatingGiven_returnsZeroForNoRatingsGiven() public view {
        assertEq(ratings.getAverageRatingGiven(buyer), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // getRatingStats
    // ═══════════════════════════════════════════════════════════════════════

    function test_getRatingStats_fullBreakdown() public {
        // Give seller one 5-star and one 1-star rating
        address buyer2 = makeAddr("buyer2");
        usdc.mint(buyer2, 100 * ONE_USDC);
        vm.prank(buyer2);
        usdc.approve(address(escrow), type(uint256).max);

        uint256 id1 = _createAndReleaseEscrow(buyer, seller);
        uint256 id2 = _createAndReleaseEscrow(buyer2, seller);

        vm.prank(buyer);
        ratings.rate(id1, 5);
        vm.prank(buyer2);
        ratings.rate(id2, 1);

        (
            uint64 ratingsReceived,
            uint64 starsReceived,
            uint64 ratingsGiven,
            uint64 starsGiven,
            uint64 fiveStarCount,
            uint64 oneStarCount
        ) = ratings.getRatingStats(seller);

        assertEq(ratingsReceived, 2);
        assertEq(starsReceived, 6); // 5 + 1
        assertEq(ratingsGiven, 0); // seller hasn't rated anyone
        assertEq(starsGiven, 0);
        assertEq(fiveStarCount, 1);
        assertEq(oneStarCount, 1);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // isRated
    // ═══════════════════════════════════════════════════════════════════════

    function test_isRated_returnsFalseFalseBeforeRating() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        (bool buyerRated, bool sellerRated) = ratings.isRated(id);
        assertFalse(buyerRated);
        assertFalse(sellerRated);
    }

    function test_isRated_returnsTrueFalseAfterBuyerRates() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(buyer);
        ratings.rate(id, 4);

        (bool buyerRated, bool sellerRated) = ratings.isRated(id);
        assertTrue(buyerRated);
        assertFalse(sellerRated);
    }

    function test_isRated_returnsTrueTrueAfterBothRate() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        vm.prank(buyer);
        ratings.rate(id, 4);
        vm.prank(seller);
        ratings.rate(id, 5);

        (bool buyerRated, bool sellerRated) = ratings.isRated(id);
        assertTrue(buyerRated);
        assertTrue(sellerRated);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Admin
    // ═══════════════════════════════════════════════════════════════════════

    function test_setEscrowContract_ownerCanUpdate() public {
        address newEscrow = makeAddr("newEscrow");
        ratings.setEscrowContract(newEscrow);
        assertEq(address(ratings.escrowContract()), newEscrow);
    }

    function test_setEscrowContract_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(PayCrowRatings.NotOwner.selector);
        ratings.setEscrowContract(makeAddr("newEscrow"));
    }

    function test_setEscrowContract_revertsOnZeroAddress() public {
        vm.expectRevert(PayCrowRatings.ZeroAddress.selector);
        ratings.setEscrowContract(address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // totalRatings counter
    // ═══════════════════════════════════════════════════════════════════════

    function test_totalRatings_incrementsOnEachRating() public {
        uint256 id = _createAndReleaseEscrow(buyer, seller);

        assertEq(ratings.totalRatings(), 0);

        vm.prank(buyer);
        ratings.rate(id, 4);
        assertEq(ratings.totalRatings(), 1);

        vm.prank(seller);
        ratings.rate(id, 5);
        assertEq(ratings.totalRatings(), 2);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Edge cases: all star values 1-5
    // ═══════════════════════════════════════════════════════════════════════

    function test_rate_allValidStarValues() public {
        for (uint8 stars = 1; stars <= 5; stars++) {
            address b = makeAddr(string(abi.encodePacked("buyer", stars)));
            usdc.mint(b, 10 * ONE_USDC);
            vm.prank(b);
            usdc.approve(address(escrow), type(uint256).max);

            uint256 id = _createAndReleaseEscrow(b, seller);
            vm.prank(b);
            ratings.rate(id, stars);

            (uint8 storedStars,) = ratings.buyerRatings(id);
            assertEq(storedStars, stars);
        }
    }

    function test_rate_fiveStarAndOneStarCountsTracked() public {
        // Five 5-star ratings and two 1-star ratings
        address buyer2 = makeAddr("buyer2");
        usdc.mint(buyer2, 100 * ONE_USDC);
        vm.prank(buyer2);
        usdc.approve(address(escrow), type(uint256).max);

        uint256 id1 = _createAndReleaseEscrow(buyer, seller);
        uint256 id2 = _createAndReleaseEscrow(buyer2, seller);

        vm.prank(buyer);
        ratings.rate(id1, 5);
        vm.prank(buyer2);
        ratings.rate(id2, 1);

        (,,,, uint64 fiveCount, uint64 oneCount) = ratings.getRatingStats(seller);
        assertEq(fiveCount, 1);
        assertEq(oneCount, 1);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // transferOwnership
    // ═══════════════════════════════════════════════════════════════════════

    function test_transferOwnership_works() public {
        address newOwner = makeAddr("newOwner");
        ratings.transferOwnership(newOwner);
        assertEq(ratings.owner(), newOwner);
    }

    function test_transferOwnership_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(PayCrowRatings.NotOwner.selector);
        ratings.transferOwnership(makeAddr("newOwner"));
    }

    function test_transferOwnership_revertsOnZeroAddress() public {
        vm.expectRevert(PayCrowRatings.ZeroAddress.selector);
        ratings.transferOwnership(address(0));
    }
}
