// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Agora402Escrow
/// @notice USDC escrow for agent-to-agent commerce on top of x402.
///         State machine: CREATED → FUNDED → RELEASED | DISPUTED → RESOLVED | EXPIRED → REFUNDED
/// @dev All amounts are in USDC (6 decimals). Max escrow cap enforced for v1 safety.
contract Agora402Escrow is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ─── Types ───────────────────────────────────────────────────────────

    enum EscrowState {
        Created,   // 0 — escrow created, awaiting funding
        Funded,    // 1 — USDC deposited, awaiting delivery
        Released,  // 2 — delivery confirmed, funds sent to seller
        Disputed,  // 3 — buyer flagged bad delivery, awaiting arbiter
        Resolved,  // 4 — arbiter ruled on dispute
        Expired,   // 5 — timelock passed without release or dispute
        Refunded   // 6 — funds returned to buyer (from expired or dispute)
    }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        uint256 createdAt;
        uint256 expiresAt;
        EscrowState state;
        bytes32 serviceHash;  // keccak256 of the service URL / identifier
    }

    // ─── State ───────────────────────────────────────────────────────────

    IERC20 public immutable usdc;
    address public owner;
    address public arbiter;
    address public treasury;

    /// @notice Protocol fee in basis points (100 = 1%). Applied on release and resolve.
    ///         No fee on refund (expired) — buyer shouldn't pay if service wasn't delivered.
    uint256 public feeBps;

    /// @notice Total protocol fees collected (for transparency)
    uint256 public totalFeesCollected;

    uint256 public nextEscrowId;
    mapping(uint256 => Escrow) public escrows;

    /// @notice Maximum escrow amount in USDC base units (6 decimals). $100 = 100_000_000
    uint256 public constant MAX_ESCROW_AMOUNT = 100_000_000;

    /// @notice Minimum escrow amount. $0.10 = 100_000
    uint256 public constant MIN_ESCROW_AMOUNT = 100_000;

    /// @notice Minimum timelock duration (5 minutes)
    uint256 public constant MIN_TIMELOCK = 5 minutes;

    /// @notice Maximum timelock duration (30 days)
    uint256 public constant MAX_TIMELOCK = 30 days;

    /// @notice Maximum protocol fee: 5% (500 bps)
    uint256 public constant MAX_FEE_BPS = 500;

    /// @notice Basis points denominator
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ─── Events ──────────────────────────────────────────────────────────

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 expiresAt,
        bytes32 serviceHash
    );

    event EscrowFunded(uint256 indexed escrowId, uint256 amount);
    event EscrowReleased(uint256 indexed escrowId, uint256 amount);
    event EscrowDisputed(uint256 indexed escrowId, address indexed disputedBy);
    event EscrowResolved(uint256 indexed escrowId, uint256 buyerAmount, uint256 sellerAmount);
    event EscrowExpired(uint256 indexed escrowId);
    event EscrowRefunded(uint256 indexed escrowId, uint256 amount);

    event ArbiterUpdated(address indexed oldArbiter, address indexed newArbiter);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeCollected(uint256 indexed escrowId, uint256 feeAmount);

    // ─── Errors ──────────────────────────────────────────────────────────

    error NotBuyer();
    error NotArbiter();
    error NotOwner();
    error InvalidState(EscrowState current, EscrowState expected);
    error AmountTooLow();
    error AmountTooHigh();
    error TimelockTooShort();
    error TimelockTooLong();
    error NotExpired();
    error ZeroAddress();
    error BuyerIsSeller();
    error SplitExceedsAmount();
    error FeeTooHigh();

    // ─── Modifiers ───────────────────────────────────────────────────────

    modifier onlyBuyer(uint256 escrowId) {
        if (msg.sender != escrows[escrowId].buyer) revert NotBuyer();
        _;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier inState(uint256 escrowId, EscrowState expected) {
        EscrowState current = escrows[escrowId].state;
        if (current != expected) revert InvalidState(current, expected);
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────

    /// @param _usdc Address of the USDC token contract
    /// @param _arbiter Initial arbiter address for dispute resolution
    /// @param _treasury Address to receive protocol fees
    /// @param _feeBps Protocol fee in basis points (200 = 2%)
    constructor(address _usdc, address _arbiter, address _treasury, uint256 _feeBps) {
        if (_usdc == address(0) || _arbiter == address(0) || _treasury == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        usdc = IERC20(_usdc);
        arbiter = _arbiter;
        treasury = _treasury;
        feeBps = _feeBps;
        owner = msg.sender;
    }

    // ─── Core Functions ──────────────────────────────────────────────────

    /// @notice Create and fund an escrow in a single transaction.
    ///         Buyer must have approved this contract to spend `amount` USDC.
    /// @param seller Address of the seller/service provider
    /// @param amount USDC amount (6 decimals)
    /// @param timelockDuration Seconds until the escrow expires
    /// @param serviceHash keccak256 identifier of the service being purchased
    /// @return escrowId The ID of the newly created escrow
    function createAndFund(
        address seller,
        uint256 amount,
        uint256 timelockDuration,
        bytes32 serviceHash
    ) external nonReentrant whenNotPaused returns (uint256 escrowId) {
        if (seller == address(0)) revert ZeroAddress();
        if (seller == msg.sender) revert BuyerIsSeller();
        if (amount < MIN_ESCROW_AMOUNT) revert AmountTooLow();
        if (amount > MAX_ESCROW_AMOUNT) revert AmountTooHigh();
        if (timelockDuration < MIN_TIMELOCK) revert TimelockTooShort();
        if (timelockDuration > MAX_TIMELOCK) revert TimelockTooLong();

        escrowId = nextEscrowId++;
        uint256 expiresAt = block.timestamp + timelockDuration;

        escrows[escrowId] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            createdAt: block.timestamp,
            expiresAt: expiresAt,
            state: EscrowState.Funded,
            serviceHash: serviceHash
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit EscrowCreated(escrowId, msg.sender, seller, amount, expiresAt, serviceHash);
        emit EscrowFunded(escrowId, amount);
    }

    /// @notice Buyer confirms delivery and releases USDC to seller (minus protocol fee)
    /// @param escrowId The escrow to release
    function release(uint256 escrowId)
        external
        nonReentrant
        onlyBuyer(escrowId)
        inState(escrowId, EscrowState.Funded)
    {
        Escrow storage e = escrows[escrowId];
        e.state = EscrowState.Released;

        uint256 fee = _calculateFee(e.amount);
        uint256 sellerAmount = e.amount - fee;

        if (fee > 0) {
            totalFeesCollected += fee;
            usdc.safeTransfer(treasury, fee);
            emit FeeCollected(escrowId, fee);
        }
        usdc.safeTransfer(e.seller, sellerAmount);

        emit EscrowReleased(escrowId, sellerAmount);
    }

    /// @notice Buyer flags bad delivery, locking funds for arbiter review
    /// @param escrowId The escrow to dispute
    function dispute(uint256 escrowId)
        external
        onlyBuyer(escrowId)
        inState(escrowId, EscrowState.Funded)
    {
        escrows[escrowId].state = EscrowState.Disputed;

        emit EscrowDisputed(escrowId, msg.sender);
    }

    /// @notice Arbiter resolves a dispute by splitting funds between buyer and seller.
    ///         Fee is deducted first, then the remainder is split per arbiter's ruling.
    ///         buyerAmount + sellerAmount must equal (escrow amount - fee).
    /// @param escrowId The escrow to resolve
    /// @param buyerAmount Amount to refund to buyer (after fee)
    /// @param sellerAmount Amount to release to seller (after fee)
    function resolve(uint256 escrowId, uint256 buyerAmount, uint256 sellerAmount)
        external
        nonReentrant
        onlyArbiter
        inState(escrowId, EscrowState.Disputed)
    {
        Escrow storage e = escrows[escrowId];
        uint256 fee = _calculateFee(e.amount);
        uint256 distributable = e.amount - fee;
        if (buyerAmount + sellerAmount != distributable) revert SplitExceedsAmount();

        e.state = EscrowState.Resolved;

        if (fee > 0) {
            totalFeesCollected += fee;
            usdc.safeTransfer(treasury, fee);
            emit FeeCollected(escrowId, fee);
        }
        if (buyerAmount > 0) {
            usdc.safeTransfer(e.buyer, buyerAmount);
        }
        if (sellerAmount > 0) {
            usdc.safeTransfer(e.seller, sellerAmount);
        }

        emit EscrowResolved(escrowId, buyerAmount, sellerAmount);
    }

    /// @notice Mark an expired escrow. Anyone can call this after the timelock.
    /// @param escrowId The escrow to expire
    function markExpired(uint256 escrowId)
        external
        inState(escrowId, EscrowState.Funded)
    {
        Escrow storage e = escrows[escrowId];
        if (block.timestamp < e.expiresAt) revert NotExpired();

        e.state = EscrowState.Expired;

        emit EscrowExpired(escrowId);
    }

    /// @notice Refund an expired escrow back to the buyer. Anyone can call.
    /// @param escrowId The escrow to refund
    function refund(uint256 escrowId)
        external
        nonReentrant
        inState(escrowId, EscrowState.Expired)
    {
        Escrow storage e = escrows[escrowId];
        e.state = EscrowState.Refunded;

        usdc.safeTransfer(e.buyer, e.amount);

        emit EscrowRefunded(escrowId, e.amount);
    }

    // ─── View Functions ──────────────────────────────────────────────────

    /// @notice Get full escrow details
    function getEscrow(uint256 escrowId)
        external
        view
        returns (
            address buyer,
            address seller,
            uint256 amount,
            uint256 createdAt,
            uint256 expiresAt,
            EscrowState state,
            bytes32 serviceHash
        )
    {
        Escrow storage e = escrows[escrowId];
        return (e.buyer, e.seller, e.amount, e.createdAt, e.expiresAt, e.state, e.serviceHash);
    }

    /// @notice Check if an escrow has expired (timelock passed and still Funded)
    function isExpired(uint256 escrowId) external view returns (bool) {
        Escrow storage e = escrows[escrowId];
        return e.state == EscrowState.Funded && block.timestamp >= e.expiresAt;
    }

    // ─── Admin Functions ─────────────────────────────────────────────────

    /// @notice Update the arbiter address
    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        emit ArbiterUpdated(arbiter, newArbiter);
        arbiter = newArbiter;
    }

    /// @notice Transfer contract ownership
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Update the treasury address
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Update the protocol fee (in basis points)
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Pause the contract (emergency)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause the contract
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Internal ────────────────────────────────────────────────────────

    function _calculateFee(uint256 amount) internal view returns (uint256) {
        return (amount * feeBps) / BPS_DENOMINATOR;
    }
}
