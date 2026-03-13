// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PayCrowEscrow} from "../src/PayCrowEscrow.sol";
import {PayCrowReputation} from "../src/PayCrowReputation.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock USDC for reputation tests
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// ─── Standalone Reputation Contract Tests ───────────────────────────────────

contract PayCrowReputationTest is Test {
    PayCrowReputation public rep;

    address public owner = address(this);
    address public escrowContract = makeAddr("escrow");
    address public agent1 = makeAddr("agent1");
    address public agent2 = makeAddr("agent2");
    address public attacker = makeAddr("attacker");

    function setUp() public {
        rep = new PayCrowReputation();
        rep.setEscrowContract(escrowContract);
    }

    // ─── Constructor / Admin ────────────────────────────────────────────

    function test_constructor_setsOwner() public view {
        assertEq(rep.owner(), owner);
    }

    function test_constructor_escrowContractInitiallyZero() public {
        PayCrowReputation fresh = new PayCrowReputation();
        assertEq(fresh.escrowContract(), address(0));
    }

    function test_setEscrowContract_works() public view {
        assertEq(rep.escrowContract(), escrowContract);
    }

    function test_setEscrowContract_emitsEvent() public {
        address newEscrow = makeAddr("newEscrow");
        vm.expectEmit(true, true, false, false);
        emit PayCrowReputation.EscrowContractUpdated(escrowContract, newEscrow);
        rep.setEscrowContract(newEscrow);
    }

    function test_setEscrowContract_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowReputation.NotOwner.selector);
        rep.setEscrowContract(makeAddr("new"));
    }

    function test_setEscrowContract_revertsOnZeroAddress() public {
        vm.expectRevert(PayCrowReputation.ZeroAddress.selector);
        rep.setEscrowContract(address(0));
    }

    function test_transferOwnership_works() public {
        address newOwner = makeAddr("newOwner");
        rep.transferOwnership(newOwner);
        assertEq(rep.owner(), newOwner);
    }

    function test_transferOwnership_emitsEvent() public {
        address newOwner = makeAddr("newOwner");
        vm.expectEmit(true, true, false, false);
        emit PayCrowReputation.OwnerUpdated(owner, newOwner);
        rep.transferOwnership(newOwner);
    }

    function test_transferOwnership_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowReputation.NotOwner.selector);
        rep.transferOwnership(attacker);
    }

    function test_transferOwnership_revertsOnZeroAddress() public {
        vm.expectRevert(PayCrowReputation.ZeroAddress.selector);
        rep.transferOwnership(address(0));
    }

    // ─── recordOutcome: access control ──────────────────────────────────

    function test_recordOutcome_revertsIfNotEscrow() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowReputation.NotEscrowContract.selector);
        rep.recordOutcome(agent1, agent2, 1_000_000, 0, PayCrowReputation.Outcome.Completed);
    }

    // ─── recordOutcome: Completed ───────────────────────────────────────

    function test_recordOutcome_completed_updatesBothParties() public {
        vm.prank(escrowContract);
        rep.recordOutcome(agent1, agent2, 10_000_000, 0, PayCrowReputation.Outcome.Completed);

        // Agent1 (buyer/client)
        (uint64 c1, uint64 d1, uint64 r1, uint64 p1, uint64 cl1, uint256 v1,,) = rep.getReputation(agent1);
        assertEq(c1, 1);  // 1 completed
        assertEq(d1, 0);
        assertEq(r1, 0);
        assertEq(p1, 0);  // not provider
        assertEq(cl1, 1); // is client
        assertEq(v1, 10_000_000);

        // Agent2 (seller/provider)
        (uint64 c2, uint64 d2, uint64 r2, uint64 p2, uint64 cl2, uint256 v2,,) = rep.getReputation(agent2);
        assertEq(c2, 1);
        assertEq(d2, 0);
        assertEq(r2, 0);
        assertEq(p2, 1);  // is provider
        assertEq(cl2, 0); // not client
        assertEq(v2, 10_000_000);
    }

    function test_recordOutcome_completed_emitsEvents() public {
        vm.prank(escrowContract);
        vm.expectEmit(true, true, false, true);
        emit PayCrowReputation.ReputationUpdated(agent1, PayCrowReputation.Outcome.Completed, 10_000_000, 0, false);
        vm.expectEmit(true, true, false, true);
        emit PayCrowReputation.ReputationUpdated(agent2, PayCrowReputation.Outcome.Completed, 10_000_000, 0, true);
        rep.recordOutcome(agent1, agent2, 10_000_000, 0, PayCrowReputation.Outcome.Completed);
    }

    // ─── recordOutcome: Disputed ────────────────────────────────────────

    function test_recordOutcome_disputed_updatesCounters() public {
        vm.prank(escrowContract);
        rep.recordOutcome(agent1, agent2, 5_000_000, 1, PayCrowReputation.Outcome.Disputed);

        (uint64 c1, uint64 d1, uint64 r1,,,,,) = rep.getReputation(agent1);
        assertEq(c1, 0);
        assertEq(d1, 1);
        assertEq(r1, 0);

        (uint64 c2, uint64 d2, uint64 r2,,,,,) = rep.getReputation(agent2);
        assertEq(c2, 0);
        assertEq(d2, 1);
        assertEq(r2, 0);
    }

    // ─── recordOutcome: Refunded ────────────────────────────────────────

    function test_recordOutcome_refunded_updatesCounters() public {
        vm.prank(escrowContract);
        rep.recordOutcome(agent1, agent2, 5_000_000, 2, PayCrowReputation.Outcome.Refunded);

        (uint64 c1, uint64 d1, uint64 r1,,,,,) = rep.getReputation(agent1);
        assertEq(c1, 0);
        assertEq(d1, 0);
        assertEq(r1, 1);

        (uint64 c2, uint64 d2, uint64 r2,,,,,) = rep.getReputation(agent2);
        assertEq(c2, 0);
        assertEq(d2, 0);
        assertEq(r2, 1);
    }

    // ─── Multiple outcomes accumulation ─────────────────────────────────

    function test_multipleOutcomes_accumulate() public {
        vm.startPrank(escrowContract);
        rep.recordOutcome(agent1, agent2, 10_000_000, 0, PayCrowReputation.Outcome.Completed);
        rep.recordOutcome(agent1, agent2, 5_000_000, 1, PayCrowReputation.Outcome.Completed);
        rep.recordOutcome(agent1, agent2, 3_000_000, 2, PayCrowReputation.Outcome.Disputed);
        rep.recordOutcome(agent1, agent2, 2_000_000, 3, PayCrowReputation.Outcome.Refunded);
        vm.stopPrank();

        (uint64 c, uint64 d, uint64 r, uint64 p, uint64 cl, uint256 v,,) = rep.getReputation(agent1);
        assertEq(c, 2);  // 2 completed
        assertEq(d, 1);  // 1 disputed
        assertEq(r, 1);  // 1 refunded
        assertEq(cl, 4); // 4 times as client
        assertEq(p, 0);
        assertEq(v, 20_000_000); // 10 + 5 + 3 + 2

        // Agent2 was provider in all 4
        (,,, uint64 p2, uint64 cl2, uint256 v2,,) = rep.getReputation(agent2);
        assertEq(p2, 4);  // 4 times as provider
        assertEq(cl2, 0);
        assertEq(v2, 20_000_000);
    }

    // ─── Timestamps ─────────────────────────────────────────────────────

    function test_firstSeen_setsOnFirstOutcome() public {
        vm.warp(1000);
        vm.prank(escrowContract);
        rep.recordOutcome(agent1, agent2, 1_000_000, 0, PayCrowReputation.Outcome.Completed);

        (,,,,,, uint256 firstSeen, uint256 lastSeen) = rep.getReputation(agent1);
        assertEq(firstSeen, 1000);
        assertEq(lastSeen, 1000);
    }

    function test_firstSeen_doesNotChangeOnSubsequent() public {
        vm.warp(1000);
        vm.prank(escrowContract);
        rep.recordOutcome(agent1, agent2, 1_000_000, 0, PayCrowReputation.Outcome.Completed);

        vm.warp(2000);
        vm.prank(escrowContract);
        rep.recordOutcome(agent1, agent2, 1_000_000, 1, PayCrowReputation.Outcome.Completed);

        (,,,,,, uint256 firstSeen, uint256 lastSeen) = rep.getReputation(agent1);
        assertEq(firstSeen, 1000); // Unchanged
        assertEq(lastSeen, 2000);  // Updated
    }

    // ─── totalAddresses counter ─────────────────────────────────────────

    function test_totalAddresses_incrementsForNewAddresses() public {
        assertEq(rep.totalAddresses(), 0);

        vm.prank(escrowContract);
        rep.recordOutcome(agent1, agent2, 1_000_000, 0, PayCrowReputation.Outcome.Completed);
        assertEq(rep.totalAddresses(), 2); // Both buyer + seller are new

        // Same agents again — counter shouldn't increment
        vm.prank(escrowContract);
        rep.recordOutcome(agent1, agent2, 1_000_000, 1, PayCrowReputation.Outcome.Completed);
        assertEq(rep.totalAddresses(), 2); // Still 2

        // New agent
        address agent3 = makeAddr("agent3");
        vm.prank(escrowContract);
        rep.recordOutcome(agent1, agent3, 1_000_000, 2, PayCrowReputation.Outcome.Completed);
        assertEq(rep.totalAddresses(), 3); // agent1 + agent2 + agent3
    }

    // ─── getScore ───────────────────────────────────────────────────────

    function test_getScore_returns50ForUnknownAgent() public view {
        assertEq(rep.getScore(address(0xdead)), 50);
    }

    function test_getScore_returns100ForPerfectRecord() public {
        vm.startPrank(escrowContract);
        rep.recordOutcome(agent1, agent2, 1_000_000, 0, PayCrowReputation.Outcome.Completed);
        rep.recordOutcome(agent1, agent2, 1_000_000, 1, PayCrowReputation.Outcome.Completed);
        rep.recordOutcome(agent1, agent2, 1_000_000, 2, PayCrowReputation.Outcome.Completed);
        vm.stopPrank();

        assertEq(rep.getScore(agent1), 100);
        assertEq(rep.getScore(agent2), 100);
    }

    function test_getScore_returns0ForAllDisputed() public {
        vm.startPrank(escrowContract);
        rep.recordOutcome(agent1, agent2, 1_000_000, 0, PayCrowReputation.Outcome.Disputed);
        rep.recordOutcome(agent1, agent2, 1_000_000, 1, PayCrowReputation.Outcome.Disputed);
        vm.stopPrank();

        assertEq(rep.getScore(agent1), 0);
    }

    function test_getScore_returns0ForAllRefunded() public {
        vm.startPrank(escrowContract);
        rep.recordOutcome(agent1, agent2, 1_000_000, 0, PayCrowReputation.Outcome.Refunded);
        vm.stopPrank();

        assertEq(rep.getScore(agent1), 0);
    }

    function test_getScore_mixedRecord() public {
        vm.startPrank(escrowContract);
        // 3 completed, 1 disputed, 1 refunded = 3/5 = 60
        rep.recordOutcome(agent1, agent2, 1_000_000, 0, PayCrowReputation.Outcome.Completed);
        rep.recordOutcome(agent1, agent2, 1_000_000, 1, PayCrowReputation.Outcome.Completed);
        rep.recordOutcome(agent1, agent2, 1_000_000, 2, PayCrowReputation.Outcome.Completed);
        rep.recordOutcome(agent1, agent2, 1_000_000, 3, PayCrowReputation.Outcome.Disputed);
        rep.recordOutcome(agent1, agent2, 1_000_000, 4, PayCrowReputation.Outcome.Refunded);
        vm.stopPrank();

        assertEq(rep.getScore(agent1), 60); // 3/5 * 100
    }

    // ─── getReputation: returns zeros for unknown agent ─────────────────

    function test_getReputation_returnsZerosForUnknown() public view {
        (uint64 c, uint64 d, uint64 r, uint64 p, uint64 cl, uint256 v, uint256 fs, uint256 ls) =
            rep.getReputation(address(0xdead));

        assertEq(c, 0);
        assertEq(d, 0);
        assertEq(r, 0);
        assertEq(p, 0);
        assertEq(cl, 0);
        assertEq(v, 0);
        assertEq(fs, 0);
        assertEq(ls, 0);
    }

    // ─── Agent can be both provider and client ──────────────────────────

    function test_agentAsBothProviderAndClient() public {
        vm.startPrank(escrowContract);
        // agent1 is buyer (client) of agent2
        rep.recordOutcome(agent1, agent2, 5_000_000, 0, PayCrowReputation.Outcome.Completed);
        // agent1 is seller (provider) to agent2
        rep.recordOutcome(agent2, agent1, 3_000_000, 1, PayCrowReputation.Outcome.Completed);
        vm.stopPrank();

        (uint64 c, uint64 d, uint64 r, uint64 p, uint64 cl, uint256 v,,) = rep.getReputation(agent1);
        assertEq(c, 2);
        assertEq(d, 0);
        assertEq(r, 0);
        assertEq(p, 1);  // provider once
        assertEq(cl, 1); // client once
        assertEq(v, 8_000_000); // 5M + 3M
    }

    // ─── Fuzz: recordOutcome amount ─────────────────────────────────────

    function testFuzz_recordOutcome_amount(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max); // reasonable range

        vm.prank(escrowContract);
        rep.recordOutcome(agent1, agent2, amount, 0, PayCrowReputation.Outcome.Completed);

        (,,,,,uint256 v,,) = rep.getReputation(agent1);
        assertEq(v, amount);
    }

    function testFuzz_recordOutcome_volumeAccumulates(uint256 a1, uint256 a2) public {
        a1 = bound(a1, 1, type(uint128).max);
        a2 = bound(a2, 1, type(uint128).max);

        vm.startPrank(escrowContract);
        rep.recordOutcome(agent1, agent2, a1, 0, PayCrowReputation.Outcome.Completed);
        rep.recordOutcome(agent1, agent2, a2, 1, PayCrowReputation.Outcome.Completed);
        vm.stopPrank();

        (,,,,,uint256 v,,) = rep.getReputation(agent1);
        assertEq(v, a1 + a2);
    }

    function testFuzz_getScore_alwaysLte100(uint8 completed, uint8 disputed, uint8 refunded) public {
        vm.assume(uint256(completed) + uint256(disputed) + uint256(refunded) > 0);
        vm.assume(uint256(completed) + uint256(disputed) + uint256(refunded) < 200);

        vm.startPrank(escrowContract);
        for (uint8 i = 0; i < completed; i++) {
            rep.recordOutcome(agent1, agent2, 1_000_000, i, PayCrowReputation.Outcome.Completed);
        }
        for (uint8 i = 0; i < disputed; i++) {
            rep.recordOutcome(agent1, agent2, 1_000_000, uint256(completed) + i, PayCrowReputation.Outcome.Disputed);
        }
        for (uint8 i = 0; i < refunded; i++) {
            rep.recordOutcome(agent1, agent2, 1_000_000, uint256(completed) + uint256(disputed) + i, PayCrowReputation.Outcome.Refunded);
        }
        vm.stopPrank();

        uint256 score = rep.getScore(agent1);
        assertLe(score, 100);
    }
}

// ─── Integration: Escrow + Reputation wired together ────────────────────────

contract EscrowReputationIntegrationTest is Test {
    PayCrowEscrow public escrow;
    PayCrowReputation public rep;
    MockUSDC public usdc;

    address public owner = address(this);
    address public arbiter = makeAddr("arbiter");
    address public treasury = makeAddr("treasury");
    address public buyer = makeAddr("buyer");
    address public seller = makeAddr("seller");

    uint256 public constant ONE_USDC = 1_000_000;
    uint256 public constant TEN_USDC = 10_000_000;
    uint256 public constant DEFAULT_TIMELOCK = 30 minutes;
    uint256 public constant DEFAULT_FEE_BPS = 200;
    bytes32 public constant SERVICE_HASH = keccak256("https://api.example.com/data");

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new PayCrowEscrow(address(usdc), arbiter, treasury, DEFAULT_FEE_BPS);
        rep = new PayCrowReputation();

        // Wire reputation to escrow (bidirectional)
        rep.setEscrowContract(address(escrow));
        escrow.setReputation(address(rep));

        // Fund buyer
        usdc.mint(buyer, 1000 * ONE_USDC);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _createAndFund(uint256 amount) internal returns (uint256 escrowId) {
        vm.prank(buyer);
        escrowId = escrow.createAndFund(seller, amount, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    // ─── release → Completed reputation ─────────────────────────────────

    function test_release_recordsCompletedReputation() public {
        uint256 escrowId = _createAndFund(TEN_USDC);

        vm.prank(buyer);
        escrow.release(escrowId);

        // Both buyer and seller get Completed reputation
        (uint64 cb,,, uint64 pb, uint64 clb, uint256 vb,,) = rep.getReputation(buyer);
        assertEq(cb, 1);
        assertEq(pb, 0);
        assertEq(clb, 1);
        assertEq(vb, TEN_USDC);

        (uint64 cs,,, uint64 ps, uint64 cls, uint256 vs,,) = rep.getReputation(seller);
        assertEq(cs, 1);
        assertEq(ps, 1);
        assertEq(cls, 0);
        assertEq(vs, TEN_USDC);
    }

    function test_release_emitsReputationEvents() public {
        uint256 escrowId = _createAndFund(TEN_USDC);

        vm.prank(buyer);
        vm.expectEmit(true, true, false, true, address(rep));
        emit PayCrowReputation.ReputationUpdated(buyer, PayCrowReputation.Outcome.Completed, TEN_USDC, escrowId, false);
        vm.expectEmit(true, true, false, true, address(rep));
        emit PayCrowReputation.ReputationUpdated(seller, PayCrowReputation.Outcome.Completed, TEN_USDC, escrowId, true);
        escrow.release(escrowId);
    }

    // ─── resolve (dispute) → Disputed reputation ────────────────────────

    function test_resolve_recordsDisputedReputation() public {
        uint256 escrowId = _createAndFund(TEN_USDC);

        vm.prank(buyer);
        escrow.dispute(escrowId);

        uint256 fee = (TEN_USDC * DEFAULT_FEE_BPS) / 10_000;
        uint256 distributable = TEN_USDC - fee;

        vm.prank(arbiter);
        escrow.resolve(escrowId, distributable, 0); // Full refund to buyer

        (uint64 cb, uint64 db,,,,,, ) = rep.getReputation(buyer);
        assertEq(cb, 0);
        assertEq(db, 1);

        (uint64 cs, uint64 ds,,,,,, ) = rep.getReputation(seller);
        assertEq(cs, 0);
        assertEq(ds, 1);
    }

    // ─── refund (expired) → Refunded reputation ─────────────────────────

    function test_refund_recordsRefundedReputation() public {
        uint256 escrowId = _createAndFund(TEN_USDC);

        // Fast-forward past timelock
        vm.warp(block.timestamp + DEFAULT_TIMELOCK + 1);
        escrow.markExpired(escrowId);
        escrow.refund(escrowId);

        (uint64 cb,, uint64 rb,,,,, ) = rep.getReputation(buyer);
        assertEq(cb, 0);
        assertEq(rb, 1);

        (uint64 cs,, uint64 rs,,,,, ) = rep.getReputation(seller);
        assertEq(cs, 0);
        assertEq(rs, 1);
    }

    // ─── Scores update correctly through escrow lifecycle ───────────────

    function test_scores_updateThroughLifecycle() public {
        // 3 successful escrows
        for (uint256 i = 0; i < 3; i++) {
            uint256 id = _createAndFund(ONE_USDC);
            vm.prank(buyer);
            escrow.release(id);
        }
        assertEq(rep.getScore(seller), 100);

        // 1 disputed escrow → score drops to 75 (3/4)
        uint256 disputeId = _createAndFund(ONE_USDC);
        vm.prank(buyer);
        escrow.dispute(disputeId);
        uint256 fee = (ONE_USDC * DEFAULT_FEE_BPS) / 10_000;
        vm.prank(arbiter);
        escrow.resolve(disputeId, ONE_USDC - fee, 0);

        assertEq(rep.getScore(seller), 75); // 3/4 * 100

        // 1 refunded escrow → score drops to 60 (3/5)
        uint256 refundId = _createAndFund(ONE_USDC);
        vm.warp(block.timestamp + DEFAULT_TIMELOCK + 1);
        escrow.markExpired(refundId);
        escrow.refund(refundId);

        assertEq(rep.getScore(seller), 60); // 3/5 * 100
    }

    // ─── Volume accumulates across escrows ──────────────────────────────

    function test_volume_accumulatesAcrossEscrows() public {
        uint256 id1 = _createAndFund(TEN_USDC);
        vm.prank(buyer);
        escrow.release(id1);

        uint256 id2 = _createAndFund(5 * ONE_USDC);
        vm.prank(buyer);
        escrow.release(id2);

        (,,,,,uint256 v,,) = rep.getReputation(seller);
        assertEq(v, TEN_USDC + 5 * ONE_USDC); // 15 USDC
    }

    // ─── Reputation disabled (address(0)) → no revert ───────────────────

    function test_reputationDisabled_noRevert() public {
        // Disable reputation
        escrow.setReputation(address(0));

        uint256 escrowId = _createAndFund(TEN_USDC);

        // Release still works — no revert
        vm.prank(buyer);
        escrow.release(escrowId);

        (,,,,, PayCrowEscrow.EscrowState state,) = escrow.getEscrow(escrowId);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Released));
    }

    // ─── setReputation admin function ───────────────────────────────────

    function test_setReputation_emitsEvent() public {
        address newRep = makeAddr("newRep");
        vm.expectEmit(true, false, false, false);
        emit PayCrowEscrow.ReputationUpdated(newRep);
        escrow.setReputation(newRep);
    }

    function test_setReputation_revertsIfNotOwner() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(PayCrowEscrow.NotOwner.selector);
        escrow.setReputation(makeAddr("malicious"));
    }

    // ─── E2E: full lifecycle with reputation ────────────────────────────

    function test_e2e_fullLifecycleWithReputation() public {
        address seller2 = makeAddr("seller2");

        // Buyer does 2 successful trades with seller
        for (uint256 i = 0; i < 2; i++) {
            uint256 id = _createAndFund(5 * ONE_USDC);
            vm.prank(buyer);
            escrow.release(id);
        }

        // Buyer does 1 disputed trade with seller2
        usdc.mint(buyer, TEN_USDC);
        vm.prank(buyer);
        uint256 disputeId = escrow.createAndFund(seller2, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
        vm.prank(buyer);
        escrow.dispute(disputeId);
        uint256 fee = (TEN_USDC * DEFAULT_FEE_BPS) / 10_000;
        vm.prank(arbiter);
        escrow.resolve(disputeId, TEN_USDC - fee, 0);

        // Buyer: 2 completed + 1 disputed = score 66 (2/3)
        assertEq(rep.getScore(buyer), 66); // 2/3 * 100 = 66 (integer division)

        // Seller: 2 completed = score 100
        assertEq(rep.getScore(seller), 100);

        // Seller2: 1 disputed = score 0
        assertEq(rep.getScore(seller2), 0);

        // Total unique addresses
        assertEq(rep.totalAddresses(), 3); // buyer + seller + seller2

        // Buyer volume: $5 + $5 + $10 = $20
        (,,,,,uint256 bv,,) = rep.getReputation(buyer);
        assertEq(bv, 20_000_000);
    }

    // ─── Fuzz: multiple releases maintain 100 score ─────────────────────

    function testFuzz_multipleReleases_perfectScore(uint8 count) public {
        count = uint8(bound(count, 1, 20));

        for (uint8 i = 0; i < count; i++) {
            usdc.mint(buyer, ONE_USDC);
            uint256 id = _createAndFund(ONE_USDC);
            vm.prank(buyer);
            escrow.release(id);
        }

        assertEq(rep.getScore(seller), 100);
        assertEq(rep.getScore(buyer), 100);

        (uint64 c,,,,,,, ) = rep.getReputation(seller);
        assertEq(c, count);
    }
}
