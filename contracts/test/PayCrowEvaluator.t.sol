// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {PayCrowEvaluator, IAgenticCommerce} from "../src/PayCrowEvaluator.sol";
import {PayCrowReputation} from "../src/PayCrowReputation.sol";

/// @dev Mock AgenticCommerce that just tracks complete/reject calls
contract MockAgenticCommerce {
    struct Call {
        uint256 jobId;
        bytes32 reason;
    }

    Call[] public completeCalls;
    Call[] public rejectCalls;

    function complete(uint256 jobId, bytes32 reason, bytes calldata) external {
        completeCalls.push(Call(jobId, reason));
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata) external {
        rejectCalls.push(Call(jobId, reason));
    }

    function getCompleteCallCount() external view returns (uint256) {
        return completeCalls.length;
    }

    function getRejectCallCount() external view returns (uint256) {
        return rejectCalls.length;
    }
}

/// @dev Mock escrow contract used to call recordOutcome on reputation
contract MockPayCrowEscrow {
    PayCrowReputation public reputation;

    constructor(address _reputation) {
        reputation = PayCrowReputation(_reputation);
    }

    function recordOutcome(
        address buyer,
        address seller,
        uint256 amount,
        uint256 escrowId,
        PayCrowReputation.Outcome outcome
    ) external {
        reputation.recordOutcome(buyer, seller, amount, escrowId, outcome);
    }
}

contract PayCrowEvaluatorTest is Test {
    PayCrowEvaluator public evaluator;
    PayCrowReputation public reputation;
    MockAgenticCommerce public commerce;
    MockPayCrowEscrow public mockEscrow;

    address public owner = address(this);
    address public arbiter = makeAddr("arbiter");
    address public provider = makeAddr("provider");
    address public client = makeAddr("client");
    address public attacker = makeAddr("attacker");
    address public randomCaller = makeAddr("randomCaller");

    uint256 public constant JOB_ID = 42;
    bytes32 public constant EXPECTED_HASH = keccak256("deliverable_v1");
    bytes32 public constant CHALLENGE_REASON = keccak256("BAD_QUALITY");

    function setUp() public {
        // Deploy reputation
        reputation = new PayCrowReputation();

        // Deploy mock escrow and authorize it on reputation
        mockEscrow = new MockPayCrowEscrow(address(reputation));
        reputation.setEscrowContract(address(mockEscrow));

        // Deploy mock commerce
        commerce = new MockAgenticCommerce();

        // Deploy evaluator
        evaluator = new PayCrowEvaluator(address(reputation), arbiter);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    /// @dev Build reputation for provider: `completed` completions out of `total` outcomes
    function _buildReputation(address who, uint64 completed, uint64 disputed) internal {
        address dummyBuyer = makeAddr("dummyBuyer");
        for (uint64 i = 0; i < completed; i++) {
            mockEscrow.recordOutcome(dummyBuyer, who, 1e6, i, PayCrowReputation.Outcome.Completed);
        }
        for (uint64 i = 0; i < disputed; i++) {
            mockEscrow.recordOutcome(dummyBuyer, who, 1e6, completed + i, PayCrowReputation.Outcome.Disputed);
        }
    }

    function _registerDefault() internal {
        evaluator.registerForEvaluation(
            address(commerce), JOB_ID, provider, client, bytes32(0)
        );
    }

    function _registerWithHash() internal {
        evaluator.registerForEvaluation(
            address(commerce), JOB_ID, provider, client, EXPECTED_HASH
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Constructor Tests
    // ═══════════════════════════════════════════════════════════════════════

    function test_constructor_setsState() public view {
        assertEq(evaluator.owner(), owner);
        assertEq(evaluator.arbiter(), arbiter);
        assertEq(address(evaluator.reputation()), address(reputation));
        assertEq(evaluator.autoCompleteThreshold(), 70);
        assertEq(evaluator.minTrustScore(), 0);
        assertEq(evaluator.highTrustGracePeriod(), 15 minutes);
        assertEq(evaluator.normalGracePeriod(), 1 hours);
        assertEq(evaluator.lowTrustGracePeriod(), 4 hours);
    }

    function test_constructor_revertsOnZeroReputation() public {
        vm.expectRevert(PayCrowEvaluator.ZeroAddress.selector);
        new PayCrowEvaluator(address(0), arbiter);
    }

    function test_constructor_revertsOnZeroArbiter() public {
        vm.expectRevert(PayCrowEvaluator.ZeroAddress.selector);
        new PayCrowEvaluator(address(reputation), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // registerForEvaluation Tests
    // ═══════════════════════════════════════════════════════════════════════

    function test_register_highTrustProvider_shortGracePeriod() public {
        // Score = 80/100 = 80 >= 70 threshold → highTrustGracePeriod (15 min)
        _buildReputation(provider, 80, 20);
        assertEq(reputation.getScore(provider), 80);

        uint256 ts = block.timestamp;
        evaluator.registerForEvaluation(
            address(commerce), JOB_ID, provider, client, bytes32(0)
        );

        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(eval_.gracePeriodEnd, ts + 15 minutes);
        assertEq(uint8(eval_.status), uint8(PayCrowEvaluator.EvalStatus.Pending));
        assertEq(eval_.provider, provider);
        assertEq(eval_.client, client);
    }

    function test_register_moderateTrustProvider_normalGracePeriod() public {
        // Score = 60/100 = 60, which is >= 45 but < 70 → normalGracePeriod (1 hour)
        _buildReputation(provider, 60, 40);
        assertEq(reputation.getScore(provider), 60);

        uint256 ts = block.timestamp;
        _registerDefault();

        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(eval_.gracePeriodEnd, ts + 1 hours);
    }

    function test_register_lowTrustProvider_longGracePeriod() public {
        // Score = 20/100 = 20 < 45 → lowTrustGracePeriod (4 hours)
        _buildReputation(provider, 20, 80);
        assertEq(reputation.getScore(provider), 20);

        uint256 ts = block.timestamp;
        _registerDefault();

        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(eval_.gracePeriodEnd, ts + 4 hours);
    }

    function test_register_unknownProvider_defaultScoreGetsNormalGracePeriod() public {
        // Unknown provider → getScore returns 50 (default), 50 >= 45 → normalGracePeriod
        assertEq(reputation.getScore(provider), 50);

        uint256 ts = block.timestamp;
        _registerDefault();

        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(eval_.gracePeriodEnd, ts + 1 hours);
    }

    function test_register_revertsOnDuplicate() public {
        _registerDefault();

        vm.expectRevert(PayCrowEvaluator.AlreadyRegistered.selector);
        _registerDefault();
    }

    function test_register_emitsEvent() public {
        uint256 ts = block.timestamp;
        uint256 expectedScore = reputation.getScore(provider); // 50 (default)

        vm.expectEmit(true, true, true, true);
        emit PayCrowEvaluator.EvaluationRegistered(
            address(commerce), JOB_ID, provider, expectedScore, ts + 1 hours
        );

        _registerDefault();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // verifyDeliverable Tests
    // ═══════════════════════════════════════════════════════════════════════

    function test_verify_skipsCheckWhenExpectedHashIsZero() public {
        _registerDefault(); // expectedHash = bytes32(0)

        // Should not revert, should not reject — hash check skipped
        evaluator.verifyDeliverable(address(commerce), JOB_ID, keccak256("anything"));

        // Status should remain Pending
        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(uint8(eval_.status), uint8(PayCrowEvaluator.EvalStatus.Pending));
        assertEq(commerce.getRejectCallCount(), 0);
    }

    function test_verify_autoRejectsOnHashMismatch() public {
        _registerWithHash();

        evaluator.verifyDeliverable(address(commerce), JOB_ID, keccak256("wrong_deliverable"));

        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(uint8(eval_.status), uint8(PayCrowEvaluator.EvalStatus.Rejected));
        assertEq(commerce.getRejectCallCount(), 1);
        (uint256 rejectedJobId, bytes32 reason) = commerce.rejectCalls(0);
        assertEq(rejectedJobId, JOB_ID);
        assertEq(reason, keccak256("HASH_MISMATCH"));
    }

    function test_verify_noRejectWhenHashMatches() public {
        _registerWithHash();

        evaluator.verifyDeliverable(address(commerce), JOB_ID, EXPECTED_HASH);

        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(uint8(eval_.status), uint8(PayCrowEvaluator.EvalStatus.Pending));
        assertEq(commerce.getRejectCallCount(), 0);
    }

    function test_verify_revertsOnUnregisteredJob() public {
        vm.expectRevert(PayCrowEvaluator.NotRegistered.selector);
        evaluator.verifyDeliverable(address(commerce), 999, keccak256("data"));
    }

    function test_verify_revertsIfAlreadyEvaluated() public {
        _registerWithHash();
        // Auto-reject via hash mismatch first
        evaluator.verifyDeliverable(address(commerce), JOB_ID, keccak256("wrong"));
        // Now status is Rejected — should revert
        vm.expectRevert(PayCrowEvaluator.AlreadyEvaluated.selector);
        evaluator.verifyDeliverable(address(commerce), JOB_ID, EXPECTED_HASH);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // challenge Tests
    // ═══════════════════════════════════════════════════════════════════════

    function test_challenge_clientCanChallengeDuringGracePeriod() public {
        _registerDefault();

        vm.prank(client);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);

        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(uint8(eval_.status), uint8(PayCrowEvaluator.EvalStatus.Challenged));
        assertEq(eval_.challengeReason, CHALLENGE_REASON);
        assertEq(evaluator.totalChallenged(), 1);
    }

    function test_challenge_nonClientCannotChallenge() public {
        _registerDefault();

        vm.prank(attacker);
        vm.expectRevert(PayCrowEvaluator.NotClient.selector);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);
    }

    function test_challenge_cannotChallengeAfterEvaluation() public {
        _registerDefault();
        // Fast forward past grace period and auto-complete
        vm.warp(block.timestamp + 2 hours);
        evaluator.autoComplete(address(commerce), JOB_ID);

        vm.prank(client);
        vm.expectRevert(PayCrowEvaluator.AlreadyEvaluated.selector);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);
    }

    function test_challenge_emitsEvent() public {
        _registerDefault();

        vm.expectEmit(true, true, true, true);
        emit PayCrowEvaluator.JobChallenged(address(commerce), JOB_ID, client, CHALLENGE_REASON);

        vm.prank(client);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // autoComplete Tests
    // ═══════════════════════════════════════════════════════════════════════

    function test_autoComplete_afterGracePeriod() public {
        _registerDefault();
        // Unknown provider → normalGracePeriod = 1 hour
        vm.warp(block.timestamp + 1 hours);

        evaluator.autoComplete(address(commerce), JOB_ID);

        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(uint8(eval_.status), uint8(PayCrowEvaluator.EvalStatus.Completed));
        assertEq(evaluator.totalEvaluated(), 1);
        assertEq(evaluator.totalAutoCompleted(), 1);
        assertEq(commerce.getCompleteCallCount(), 1);
        (uint256 completedJobId, bytes32 reason) = commerce.completeCalls(0);
        assertEq(completedJobId, JOB_ID);
        assertEq(reason, keccak256("AUTO_COMPLETE_TRUST_VERIFIED"));
    }

    function test_autoComplete_revertsBeforeGracePeriodEnds() public {
        _registerDefault();
        // Warp to just before grace period end
        vm.warp(block.timestamp + 59 minutes);

        vm.expectRevert(PayCrowEvaluator.GracePeriodNotEnded.selector);
        evaluator.autoComplete(address(commerce), JOB_ID);
    }

    function test_autoComplete_revertsIfChallenged() public {
        _registerDefault();

        vm.prank(client);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);

        vm.warp(block.timestamp + 2 hours);

        vm.expectRevert(PayCrowEvaluator.AlreadyEvaluated.selector);
        evaluator.autoComplete(address(commerce), JOB_ID);
    }

    function test_autoComplete_anyoneCanCall() public {
        _registerDefault();
        vm.warp(block.timestamp + 1 hours);

        vm.prank(randomCaller);
        evaluator.autoComplete(address(commerce), JOB_ID);

        assertEq(commerce.getCompleteCallCount(), 1);
    }

    function test_autoComplete_emitsEvent() public {
        _registerDefault();
        vm.warp(block.timestamp + 1 hours);

        uint256 expectedScore = reputation.getScore(provider);

        vm.expectEmit(true, true, false, true);
        emit PayCrowEvaluator.JobAutoCompleted(address(commerce), JOB_ID, expectedScore);

        evaluator.autoComplete(address(commerce), JOB_ID);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // arbiterComplete / arbiterReject Tests
    // ═══════════════════════════════════════════════════════════════════════

    function test_arbiterComplete_completeChallengedJob() public {
        _registerDefault();

        vm.prank(client);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);

        bytes32 arbiterReason = keccak256("ARBITER_APPROVED");
        vm.prank(arbiter);
        evaluator.arbiterComplete(address(commerce), JOB_ID, arbiterReason);

        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(uint8(eval_.status), uint8(PayCrowEvaluator.EvalStatus.Completed));
        assertEq(evaluator.totalEvaluated(), 1);
        assertEq(commerce.getCompleteCallCount(), 1);
    }

    function test_arbiterReject_rejectChallengedJob() public {
        _registerDefault();

        vm.prank(client);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);

        bytes32 arbiterReason = keccak256("ARBITER_REJECTED");
        vm.prank(arbiter);
        evaluator.arbiterReject(address(commerce), JOB_ID, arbiterReason);

        PayCrowEvaluator.EvalConfig memory eval_ = evaluator.getEvaluation(address(commerce), JOB_ID);
        assertEq(uint8(eval_.status), uint8(PayCrowEvaluator.EvalStatus.Rejected));
        assertEq(evaluator.totalEvaluated(), 1);
        assertEq(commerce.getRejectCallCount(), 1);
    }

    function test_arbiterComplete_nonArbiterReverts() public {
        _registerDefault();
        vm.prank(client);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);

        vm.prank(attacker);
        vm.expectRevert(PayCrowEvaluator.NotArbiter.selector);
        evaluator.arbiterComplete(address(commerce), JOB_ID, keccak256("reason"));
    }

    function test_arbiterReject_nonArbiterReverts() public {
        _registerDefault();
        vm.prank(client);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);

        vm.prank(attacker);
        vm.expectRevert(PayCrowEvaluator.NotArbiter.selector);
        evaluator.arbiterReject(address(commerce), JOB_ID, keccak256("reason"));
    }

    function test_arbiterComplete_revertsOnNonChallengedJob() public {
        _registerDefault(); // Status is Pending, not Challenged

        vm.prank(arbiter);
        vm.expectRevert(PayCrowEvaluator.NotChallenged.selector);
        evaluator.arbiterComplete(address(commerce), JOB_ID, keccak256("reason"));
    }

    function test_arbiterReject_revertsOnNonChallengedJob() public {
        _registerDefault();

        vm.prank(arbiter);
        vm.expectRevert(PayCrowEvaluator.NotChallenged.selector);
        evaluator.arbiterReject(address(commerce), JOB_ID, keccak256("reason"));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Admin Tests
    // ═══════════════════════════════════════════════════════════════════════

    function test_setAutoCompleteThreshold_ownerCanSet() public {
        evaluator.setAutoCompleteThreshold(80);
        assertEq(evaluator.autoCompleteThreshold(), 80);
    }

    function test_setAutoCompleteThreshold_revertsAbove100() public {
        vm.expectRevert(PayCrowEvaluator.InvalidThreshold.selector);
        evaluator.setAutoCompleteThreshold(101);
    }

    function test_setAutoCompleteThreshold_nonOwnerReverts() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowEvaluator.NotOwner.selector);
        evaluator.setAutoCompleteThreshold(80);
    }

    function test_setGracePeriods_ownerCanSet() public {
        evaluator.setGracePeriods(5 minutes, 30 minutes, 2 hours);
        assertEq(evaluator.highTrustGracePeriod(), 5 minutes);
        assertEq(evaluator.normalGracePeriod(), 30 minutes);
        assertEq(evaluator.lowTrustGracePeriod(), 2 hours);
    }

    function test_setGracePeriods_nonOwnerReverts() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowEvaluator.NotOwner.selector);
        evaluator.setGracePeriods(5 minutes, 30 minutes, 2 hours);
    }

    function test_setMinTrustScore_ownerCanSet() public {
        evaluator.setMinTrustScore(10);
        assertEq(evaluator.minTrustScore(), 10);
    }

    function test_setMinTrustScore_revertsAbove100() public {
        vm.expectRevert(PayCrowEvaluator.InvalidThreshold.selector);
        evaluator.setMinTrustScore(101);
    }

    function test_setArbiter_ownerCanSet() public {
        address newArbiter = makeAddr("newArbiter");
        evaluator.setArbiter(newArbiter);
        assertEq(evaluator.arbiter(), newArbiter);
    }

    function test_setArbiter_revertsOnZeroAddress() public {
        vm.expectRevert(PayCrowEvaluator.ZeroAddress.selector);
        evaluator.setArbiter(address(0));
    }

    function test_setReputation_ownerCanSet() public {
        PayCrowReputation newRep = new PayCrowReputation();
        evaluator.setReputation(address(newRep));
        assertEq(address(evaluator.reputation()), address(newRep));
    }

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");
        evaluator.transferOwnership(newOwner);
        assertEq(evaluator.owner(), newOwner);
    }

    function test_transferOwnership_revertsOnZeroAddress() public {
        vm.expectRevert(PayCrowEvaluator.ZeroAddress.selector);
        evaluator.transferOwnership(address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // View Function Tests
    // ═══════════════════════════════════════════════════════════════════════

    function test_canAutoComplete_returnsTrueAfterGracePeriod() public {
        _registerDefault();
        vm.warp(block.timestamp + 1 hours);

        assertTrue(evaluator.canAutoComplete(address(commerce), JOB_ID));
    }

    function test_canAutoComplete_returnsFalseBeforeGracePeriod() public {
        _registerDefault();
        vm.warp(block.timestamp + 30 minutes);

        assertFalse(evaluator.canAutoComplete(address(commerce), JOB_ID));
    }

    function test_canAutoComplete_returnsFalseIfChallenged() public {
        _registerDefault();
        vm.prank(client);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);

        vm.warp(block.timestamp + 2 hours);
        assertFalse(evaluator.canAutoComplete(address(commerce), JOB_ID));
    }

    function test_canAutoComplete_returnsFalseForUnregistered() public view {
        assertFalse(evaluator.canAutoComplete(address(commerce), 999));
    }

    function test_getGracePeriod_highTrust() public {
        _buildReputation(provider, 80, 20); // score = 80
        assertEq(evaluator.getGracePeriod(provider), 15 minutes);
    }

    function test_getGracePeriod_normalTrust() public {
        _buildReputation(provider, 60, 40); // score = 60
        assertEq(evaluator.getGracePeriod(provider), 1 hours);
    }

    function test_getGracePeriod_lowTrust() public {
        _buildReputation(provider, 20, 80); // score = 20
        assertEq(evaluator.getGracePeriod(provider), 4 hours);
    }

    function test_getGracePeriod_unknownProvider() public view {
        // No reputation → score = 50 → normalGracePeriod
        assertEq(evaluator.getGracePeriod(provider), 1 hours);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Integration / Edge Case Tests
    // ═══════════════════════════════════════════════════════════════════════

    function test_fullFlow_registerVerifyAutoComplete() public {
        _registerWithHash();
        evaluator.verifyDeliverable(address(commerce), JOB_ID, EXPECTED_HASH);

        vm.warp(block.timestamp + 1 hours);
        evaluator.autoComplete(address(commerce), JOB_ID);

        assertEq(uint8(evaluator.getEvaluation(address(commerce), JOB_ID).status),
                 uint8(PayCrowEvaluator.EvalStatus.Completed));
        assertEq(commerce.getCompleteCallCount(), 1);
        assertEq(commerce.getRejectCallCount(), 0);
    }

    function test_fullFlow_registerChallengeArbiterReject() public {
        _registerDefault();

        vm.prank(client);
        evaluator.challenge(address(commerce), JOB_ID, CHALLENGE_REASON);

        vm.prank(arbiter);
        evaluator.arbiterReject(address(commerce), JOB_ID, keccak256("POOR_QUALITY"));

        assertEq(uint8(evaluator.getEvaluation(address(commerce), JOB_ID).status),
                 uint8(PayCrowEvaluator.EvalStatus.Rejected));
        assertEq(commerce.getRejectCallCount(), 1);
        assertEq(evaluator.totalEvaluated(), 1);
        assertEq(evaluator.totalChallenged(), 1);
    }

    function test_multipleJobs_independentTracking() public {
        // Register two different jobs
        evaluator.registerForEvaluation(address(commerce), 1, provider, client, bytes32(0));
        evaluator.registerForEvaluation(address(commerce), 2, provider, client, bytes32(0));

        // Challenge one, auto-complete the other
        vm.prank(client);
        evaluator.challenge(address(commerce), 1, CHALLENGE_REASON);

        vm.warp(block.timestamp + 1 hours);
        evaluator.autoComplete(address(commerce), 2);

        assertEq(uint8(evaluator.getEvaluation(address(commerce), 1).status),
                 uint8(PayCrowEvaluator.EvalStatus.Challenged));
        assertEq(uint8(evaluator.getEvaluation(address(commerce), 2).status),
                 uint8(PayCrowEvaluator.EvalStatus.Completed));
    }

    function test_autoComplete_revertsOnUnregisteredJob() public {
        vm.expectRevert(PayCrowEvaluator.NotRegistered.selector);
        evaluator.autoComplete(address(commerce), 999);
    }

    function test_challenge_revertsOnUnregisteredJob() public {
        vm.prank(client);
        vm.expectRevert(PayCrowEvaluator.NotRegistered.selector);
        evaluator.challenge(address(commerce), 999, CHALLENGE_REASON);
    }
}
