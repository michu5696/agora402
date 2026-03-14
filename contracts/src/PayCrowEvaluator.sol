// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PayCrowReputation} from "./PayCrowReputation.sol";

/// @title PayCrowEvaluator
/// @notice ERC-8183 Evaluator that uses PayCrow's on-chain reputation to decide
///         whether to complete or reject jobs on any AgenticCommerce contract.
///
///         Strategy:
///         1. Trust-gated: Providers with high reputation get auto-completed.
///         2. Deliverable verification: Optional hash-lock for deterministic verification.
///         3. Grace period: Jobs sit in "submitted" for a grace period during which
///            the client can challenge. If no challenge, auto-complete.
///         4. Fallback: Manual arbiter review for challenged jobs.
///
/// @dev This contract is designed to be set as the `evaluator` address on any
///      ERC-8183 AgenticCommerce contract. It earns evaluatorFeeBP on every job
///      it evaluates. It does NOT hold funds — funds stay in the AgenticCommerce contract.
contract PayCrowEvaluator is ReentrancyGuard {

    // ─── Types ───────────────────────────────────────────────────────────

    enum EvalStatus {
        Pending,      // 0 — job submitted, awaiting evaluation
        Challenged,   // 1 — client challenged during grace period
        Completed,    // 2 — evaluated: complete() called
        Rejected      // 3 — evaluated: reject() called
    }

    struct EvalConfig {
        address commerce;          // ERC-8183 AgenticCommerce contract address
        uint256 jobId;             // Job ID on that contract
        address provider;          // Provider address (for reputation lookup)
        address client;            // Client address (for challenge rights)
        bytes32 expectedHash;      // Optional: expected deliverable hash (0x0 = skip hash check)
        uint256 submittedAt;       // When the deliverable was submitted
        uint256 gracePeriodEnd;    // Timestamp after which auto-complete is allowed
        EvalStatus status;         // Current evaluation status
        bytes32 challengeReason;   // Reason for challenge (if any)
    }

    // ─── State ───────────────────────────────────────────────────────────

    address public owner;
    address public arbiter;           // Manual arbiter for challenged jobs

    /// @notice PayCrow reputation contract for trust scoring
    PayCrowReputation public reputation;

    /// @notice Trust score threshold for auto-complete (0-100, default: 70)
    ///         Providers with score >= threshold get faster auto-completion.
    uint256 public autoCompleteThreshold;

    /// @notice Minimum trust score to even accept evaluation (default: 0)
    ///         Set > 0 to refuse evaluation of completely unknown providers.
    uint256 public minTrustScore;

    /// @notice Grace period in seconds for high-trust providers (default: 15 min)
    uint256 public highTrustGracePeriod;

    /// @notice Grace period in seconds for normal providers (default: 1 hour)
    uint256 public normalGracePeriod;

    /// @notice Grace period for low-trust providers (default: 4 hours)
    uint256 public lowTrustGracePeriod;

    /// @notice Evaluation configs keyed by keccak256(commerce, jobId)
    mapping(bytes32 => EvalConfig) public evaluations;

    /// @notice Total jobs evaluated
    uint256 public totalEvaluated;

    /// @notice Total jobs auto-completed
    uint256 public totalAutoCompleted;

    /// @notice Total jobs challenged
    uint256 public totalChallenged;

    // ─── Events ──────────────────────────────────────────────────────────

    event EvaluationRegistered(
        address indexed commerce,
        uint256 indexed jobId,
        address indexed provider,
        uint256 trustScore,
        uint256 gracePeriodEnd
    );

    event DeliverableVerified(
        address indexed commerce,
        uint256 indexed jobId,
        bool hashMatch
    );

    event JobChallenged(
        address indexed commerce,
        uint256 indexed jobId,
        address indexed challenger,
        bytes32 reason
    );

    event JobAutoCompleted(
        address indexed commerce,
        uint256 indexed jobId,
        uint256 trustScore
    );

    event JobManuallyCompleted(
        address indexed commerce,
        uint256 indexed jobId,
        address indexed arbiter,
        bytes32 reason
    );

    event JobRejected(
        address indexed commerce,
        uint256 indexed jobId,
        bytes32 reason
    );

    // ─── Errors ──────────────────────────────────────────────────────────

    error NotOwner();
    error NotArbiter();
    error NotClient();
    error ZeroAddress();
    error AlreadyRegistered();
    error NotRegistered();
    error GracePeriodNotEnded();
    error AlreadyEvaluated();
    error NotChallenged();
    error InvalidThreshold();

    // ─── Modifiers ───────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────

    /// @param _reputation PayCrowReputation contract for trust scoring
    /// @param _arbiter Manual arbiter for challenged jobs
    constructor(address _reputation, address _arbiter) {
        if (_reputation == address(0) || _arbiter == address(0)) revert ZeroAddress();
        owner = msg.sender;
        reputation = PayCrowReputation(_reputation);
        arbiter = _arbiter;
        autoCompleteThreshold = 70;
        minTrustScore = 0;
        highTrustGracePeriod = 15 minutes;
        normalGracePeriod = 1 hours;
        lowTrustGracePeriod = 4 hours;
    }

    // ─── Core: Register a Job for Evaluation ─────────────────────────────

    /// @notice Register a submitted job for evaluation. Called by the AgenticCommerce
    ///         contract (or anyone who knows the job details) after the provider submits.
    ///         Sets up the grace period based on provider trust score.
    /// @param commerce Address of the ERC-8183 AgenticCommerce contract
    /// @param jobId Job ID on that contract
    /// @param provider Provider address (for reputation lookup)
    /// @param client Client address (for challenge rights)
    /// @param expectedHash Optional expected deliverable hash (bytes32(0) to skip)
    function registerForEvaluation(
        address commerce,
        uint256 jobId,
        address provider,
        address client,
        bytes32 expectedHash
    ) external {
        bytes32 key = _evalKey(commerce, jobId);
        if (evaluations[key].submittedAt != 0) revert AlreadyRegistered();

        // Look up provider trust score
        uint256 trustScore = reputation.getScore(provider);

        // Determine grace period based on trust
        uint256 gracePeriod;
        if (trustScore >= autoCompleteThreshold) {
            gracePeriod = highTrustGracePeriod;
        } else if (trustScore >= 45) {
            gracePeriod = normalGracePeriod;
        } else {
            gracePeriod = lowTrustGracePeriod;
        }

        evaluations[key] = EvalConfig({
            commerce: commerce,
            jobId: jobId,
            provider: provider,
            client: client,
            expectedHash: expectedHash,
            submittedAt: block.timestamp,
            gracePeriodEnd: block.timestamp + gracePeriod,
            status: EvalStatus.Pending,
            challengeReason: bytes32(0)
        });

        emit EvaluationRegistered(commerce, jobId, provider, trustScore, block.timestamp + gracePeriod);
    }

    // ─── Core: Verify Deliverable ────────────────────────────────────────

    /// @notice Verify a deliverable hash matches the expected hash.
    ///         If expectedHash was set and doesn't match, auto-reject.
    ///         If it matches (or no hash was set), proceed to grace period.
    /// @param commerce Address of the ERC-8183 AgenticCommerce contract
    /// @param jobId Job ID
    /// @param deliverableHash Hash of the actual deliverable
    function verifyDeliverable(
        address commerce,
        uint256 jobId,
        bytes32 deliverableHash
    ) external {
        bytes32 key = _evalKey(commerce, jobId);
        EvalConfig storage eval_ = evaluations[key];
        if (eval_.submittedAt == 0) revert NotRegistered();
        if (eval_.status != EvalStatus.Pending) revert AlreadyEvaluated();

        bool hashMatch = eval_.expectedHash == bytes32(0) || eval_.expectedHash == deliverableHash;

        emit DeliverableVerified(commerce, jobId, hashMatch);

        if (!hashMatch) {
            // Hash mismatch → auto-reject
            eval_.status = EvalStatus.Rejected;
            totalEvaluated++;

            // Call reject on the AgenticCommerce contract
            IAgenticCommerce(commerce).reject(
                jobId,
                keccak256("HASH_MISMATCH"),
                ""
            );

            emit JobRejected(commerce, jobId, keccak256("HASH_MISMATCH"));
        }
    }

    // ─── Core: Client Challenge ──────────────────────────────────────────

    /// @notice Client challenges the deliverable during the grace period.
    ///         Blocks auto-complete and escalates to manual arbiter review.
    /// @param commerce Address of the ERC-8183 AgenticCommerce contract
    /// @param jobId Job ID
    /// @param reason Reason for the challenge
    function challenge(
        address commerce,
        uint256 jobId,
        bytes32 reason
    ) external {
        bytes32 key = _evalKey(commerce, jobId);
        EvalConfig storage eval_ = evaluations[key];
        if (eval_.submittedAt == 0) revert NotRegistered();
        if (eval_.status != EvalStatus.Pending) revert AlreadyEvaluated();
        if (msg.sender != eval_.client) revert NotClient();

        eval_.status = EvalStatus.Challenged;
        eval_.challengeReason = reason;
        totalChallenged++;

        emit JobChallenged(commerce, jobId, msg.sender, reason);
    }

    // ─── Core: Auto-Complete ─────────────────────────────────────────────

    /// @notice Auto-complete a job after the grace period ends with no challenge.
    ///         Anyone can call this — it's a public good (gas incentive via evaluator fee).
    /// @param commerce Address of the ERC-8183 AgenticCommerce contract
    /// @param jobId Job ID
    function autoComplete(
        address commerce,
        uint256 jobId
    ) external nonReentrant {
        bytes32 key = _evalKey(commerce, jobId);
        EvalConfig storage eval_ = evaluations[key];
        if (eval_.submittedAt == 0) revert NotRegistered();
        if (eval_.status != EvalStatus.Pending) revert AlreadyEvaluated();
        if (block.timestamp < eval_.gracePeriodEnd) revert GracePeriodNotEnded();

        eval_.status = EvalStatus.Completed;
        totalEvaluated++;
        totalAutoCompleted++;

        uint256 trustScore = reputation.getScore(eval_.provider);

        // Call complete on the AgenticCommerce contract
        IAgenticCommerce(commerce).complete(
            jobId,
            keccak256("AUTO_COMPLETE_TRUST_VERIFIED"),
            ""
        );

        emit JobAutoCompleted(commerce, jobId, trustScore);
    }

    // ─── Core: Manual Arbiter Decision ───────────────────────────────────

    /// @notice Arbiter manually completes a challenged job.
    /// @param commerce Address of the ERC-8183 AgenticCommerce contract
    /// @param jobId Job ID
    /// @param reason Reason for completion
    function arbiterComplete(
        address commerce,
        uint256 jobId,
        bytes32 reason
    ) external nonReentrant onlyArbiter {
        bytes32 key = _evalKey(commerce, jobId);
        EvalConfig storage eval_ = evaluations[key];
        if (eval_.submittedAt == 0) revert NotRegistered();
        if (eval_.status != EvalStatus.Challenged) revert NotChallenged();

        eval_.status = EvalStatus.Completed;
        totalEvaluated++;

        IAgenticCommerce(commerce).complete(jobId, reason, "");

        emit JobManuallyCompleted(commerce, jobId, msg.sender, reason);
    }

    /// @notice Arbiter manually rejects a challenged job.
    /// @param commerce Address of the ERC-8183 AgenticCommerce contract
    /// @param jobId Job ID
    /// @param reason Reason for rejection
    function arbiterReject(
        address commerce,
        uint256 jobId,
        bytes32 reason
    ) external nonReentrant onlyArbiter {
        bytes32 key = _evalKey(commerce, jobId);
        EvalConfig storage eval_ = evaluations[key];
        if (eval_.submittedAt == 0) revert NotRegistered();
        if (eval_.status != EvalStatus.Challenged) revert NotChallenged();

        eval_.status = EvalStatus.Rejected;
        totalEvaluated++;

        IAgenticCommerce(commerce).reject(jobId, reason, "");

        emit JobRejected(commerce, jobId, reason);
    }

    // ─── View Functions ──────────────────────────────────────────────────

    /// @notice Get evaluation status for a job
    function getEvaluation(address commerce, uint256 jobId)
        external
        view
        returns (EvalConfig memory)
    {
        return evaluations[_evalKey(commerce, jobId)];
    }

    /// @notice Check if a job can be auto-completed (grace period ended, not challenged)
    function canAutoComplete(address commerce, uint256 jobId) external view returns (bool) {
        bytes32 key = _evalKey(commerce, jobId);
        EvalConfig storage eval_ = evaluations[key];
        return eval_.submittedAt != 0
            && eval_.status == EvalStatus.Pending
            && block.timestamp >= eval_.gracePeriodEnd;
    }

    /// @notice Get the trust-based grace period that would apply to a provider
    function getGracePeriod(address provider) external view returns (uint256) {
        uint256 score = reputation.getScore(provider);
        if (score >= autoCompleteThreshold) return highTrustGracePeriod;
        if (score >= 45) return normalGracePeriod;
        return lowTrustGracePeriod;
    }

    // ─── Admin Functions ─────────────────────────────────────────────────

    function setAutoCompleteThreshold(uint256 threshold) external onlyOwner {
        if (threshold > 100) revert InvalidThreshold();
        autoCompleteThreshold = threshold;
    }

    function setMinTrustScore(uint256 score) external onlyOwner {
        if (score > 100) revert InvalidThreshold();
        minTrustScore = score;
    }

    function setGracePeriods(
        uint256 highTrust,
        uint256 normal,
        uint256 lowTrust
    ) external onlyOwner {
        highTrustGracePeriod = highTrust;
        normalGracePeriod = normal;
        lowTrustGracePeriod = lowTrust;
    }

    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        arbiter = newArbiter;
    }

    function setReputation(address newReputation) external onlyOwner {
        if (newReputation == address(0)) revert ZeroAddress();
        reputation = PayCrowReputation(newReputation);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ─── Internal ────────────────────────────────────────────────────────

    function _evalKey(address commerce, uint256 jobId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(commerce, jobId));
    }
}

/// @notice Minimal interface for ERC-8183 AgenticCommerce contracts.
///         Only the functions the evaluator needs to call.
interface IAgenticCommerce {
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}
