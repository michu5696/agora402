// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {PayCrowEscrow} from "../src/PayCrowEscrow.sol";
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

contract PayCrowEscrowTest is Test {
    PayCrowEscrow public escrow;
    MockUSDC public usdc;

    address public owner = address(this);
    address public arbiter = makeAddr("arbiter");
    address public treasuryAddr = makeAddr("treasury");
    address public buyer = makeAddr("buyer");
    address public seller = makeAddr("seller");
    address public attacker = makeAddr("attacker");

    uint256 public constant ONE_USDC = 1_000_000; // 6 decimals
    uint256 public constant TEN_USDC = 10_000_000;
    uint256 public constant HUNDRED_USDC = 100_000_000;
    uint256 public constant DEFAULT_TIMELOCK = 30 minutes;
    uint256 public constant DEFAULT_FEE_BPS = 200; // 2%

    bytes32 public constant SERVICE_HASH = keccak256("https://api.example.com/translate");

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new PayCrowEscrow(address(usdc), arbiter, treasuryAddr, DEFAULT_FEE_BPS);

        // Fund buyer with USDC
        usdc.mint(buyer, 1000 * ONE_USDC);

        // Buyer approves escrow contract
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ─── Constructor Tests ───────────────────────────────────────────────

    function test_constructor_setsState() public view {
        assertEq(address(escrow.usdc()), address(usdc));
        assertEq(escrow.arbiter(), arbiter);
        assertEq(escrow.treasury(), treasuryAddr);
        assertEq(escrow.feeBps(), DEFAULT_FEE_BPS);
        assertEq(escrow.owner(), owner);
        assertEq(escrow.nextEscrowId(), 0);
    }

    function test_constructor_revertsOnZeroUsdc() public {
        vm.expectRevert(PayCrowEscrow.ZeroAddress.selector);
        new PayCrowEscrow(address(0), arbiter, treasuryAddr, DEFAULT_FEE_BPS);
    }

    function test_constructor_revertsOnZeroArbiter() public {
        vm.expectRevert(PayCrowEscrow.ZeroAddress.selector);
        new PayCrowEscrow(address(usdc), address(0), treasuryAddr, DEFAULT_FEE_BPS);
    }

    function test_constructor_revertsOnZeroTreasury() public {
        vm.expectRevert(PayCrowEscrow.ZeroAddress.selector);
        new PayCrowEscrow(address(usdc), arbiter, address(0), DEFAULT_FEE_BPS);
    }

    function test_constructor_revertsOnFeeTooHigh() public {
        vm.expectRevert(PayCrowEscrow.FeeTooHigh.selector);
        new PayCrowEscrow(address(usdc), arbiter, treasuryAddr, 501);
    }

    // ─── createAndFund Tests ─────────────────────────────────────────────

    function test_createAndFund_happyPath() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        assertEq(id, 0);
        assertEq(escrow.nextEscrowId(), 1);

        (
            address b, address s, uint256 amt,
            uint256 createdAt, uint256 expiresAt,
            PayCrowEscrow.EscrowState state, bytes32 sHash
        ) = escrow.getEscrow(id);

        assertEq(b, buyer);
        assertEq(s, seller);
        assertEq(amt, TEN_USDC);
        assertEq(createdAt, block.timestamp);
        assertEq(expiresAt, block.timestamp + DEFAULT_TIMELOCK);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Funded));
        assertEq(sHash, SERVICE_HASH);

        // USDC transferred to contract
        assertEq(usdc.balanceOf(address(escrow)), TEN_USDC);
    }

    function test_createAndFund_emitsEvents() public {
        vm.prank(buyer);

        vm.expectEmit(true, true, true, true);
        emit PayCrowEscrow.EscrowCreated(
            0, buyer, seller, TEN_USDC,
            block.timestamp + DEFAULT_TIMELOCK, SERVICE_HASH
        );

        vm.expectEmit(true, false, false, true);
        emit PayCrowEscrow.EscrowFunded(0, TEN_USDC);

        escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFund_incrementsId() public {
        vm.startPrank(buyer);
        uint256 id0 = escrow.createAndFund(seller, ONE_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
        uint256 id1 = escrow.createAndFund(seller, ONE_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
        vm.stopPrank();

        assertEq(id0, 0);
        assertEq(id1, 1);
    }

    function test_createAndFund_revertsOnZeroSeller() public {
        vm.prank(buyer);
        vm.expectRevert(PayCrowEscrow.ZeroAddress.selector);
        escrow.createAndFund(address(0), TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFund_revertsOnBuyerIsSeller() public {
        vm.prank(buyer);
        vm.expectRevert(PayCrowEscrow.BuyerIsSeller.selector);
        escrow.createAndFund(buyer, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFund_revertsOnAmountTooLow() public {
        vm.prank(buyer);
        vm.expectRevert(PayCrowEscrow.AmountTooLow.selector);
        escrow.createAndFund(seller, 99_999, DEFAULT_TIMELOCK, SERVICE_HASH); // < $0.10
    }

    function test_createAndFund_revertsOnAmountTooHigh() public {
        vm.prank(buyer);
        vm.expectRevert(PayCrowEscrow.AmountTooHigh.selector);
        escrow.createAndFund(seller, HUNDRED_USDC + 1, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFund_revertsOnTimelockTooShort() public {
        vm.prank(buyer);
        vm.expectRevert(PayCrowEscrow.TimelockTooShort.selector);
        escrow.createAndFund(seller, TEN_USDC, 4 minutes, SERVICE_HASH);
    }

    function test_createAndFund_revertsOnTimelockTooLong() public {
        vm.prank(buyer);
        vm.expectRevert(PayCrowEscrow.TimelockTooLong.selector);
        escrow.createAndFund(seller, TEN_USDC, 31 days, SERVICE_HASH);
    }

    function test_createAndFund_revertsWhenPaused() public {
        escrow.pause();
        vm.prank(buyer);
        vm.expectRevert();
        escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFund_minAmount() public {
        address minBuyer = makeAddr("minBuyer");
        usdc.mint(minBuyer, escrow.MIN_ESCROW_AMOUNT());
        vm.startPrank(minBuyer);
        usdc.approve(address(escrow), escrow.MIN_ESCROW_AMOUNT());
        uint256 id = escrow.createAndFund(seller, escrow.MIN_ESCROW_AMOUNT(), DEFAULT_TIMELOCK, SERVICE_HASH);
        vm.stopPrank();
        (, , uint256 amt, , , , ) = escrow.getEscrow(id);
        assertEq(amt, escrow.MIN_ESCROW_AMOUNT());
    }

    function test_createAndFund_maxAmount() public {
        address maxBuyer = makeAddr("maxBuyer");
        usdc.mint(maxBuyer, escrow.MAX_ESCROW_AMOUNT());
        vm.startPrank(maxBuyer);
        usdc.approve(address(escrow), escrow.MAX_ESCROW_AMOUNT());
        uint256 id = escrow.createAndFund(seller, escrow.MAX_ESCROW_AMOUNT(), DEFAULT_TIMELOCK, SERVICE_HASH);
        vm.stopPrank();
        (, , uint256 amt, , , , ) = escrow.getEscrow(id);
        assertEq(amt, escrow.MAX_ESCROW_AMOUNT());
    }

    // ─── release Tests ───────────────────────────────────────────────────

    function test_release_happyPath() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 treasuryBefore = usdc.balanceOf(treasuryAddr);

        vm.prank(buyer);
        escrow.release(id);

        // 2% fee on $10 = $0.20 = 200_000
        uint256 expectedFee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 expectedSeller = TEN_USDC - expectedFee;

        (, , , , , PayCrowEscrow.EscrowState state, ) = escrow.getEscrow(id);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Released));
        assertEq(usdc.balanceOf(seller), sellerBefore + expectedSeller);
        assertEq(usdc.balanceOf(treasuryAddr), treasuryBefore + expectedFee);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalFeesCollected(), expectedFee);
    }

    function test_release_emitsEvent() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        uint256 expectedFee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 expectedSeller = TEN_USDC - expectedFee;

        vm.prank(buyer);
        vm.expectEmit(true, false, false, true);
        emit PayCrowEscrow.EscrowReleased(id, expectedSeller);
        escrow.release(id);
    }

    function test_release_revertsIfNotBuyer() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(attacker);
        vm.expectRevert(PayCrowEscrow.NotBuyer.selector);
        escrow.release(id);
    }

    function test_release_revertsIfNotFunded() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.release(id); // First release succeeds

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PayCrowEscrow.InvalidState.selector,
                PayCrowEscrow.EscrowState.Released,
                PayCrowEscrow.EscrowState.Funded
            )
        );
        escrow.release(id); // Second release fails
    }

    // ─── dispute Tests ───────────────────────────────────────────────────

    function test_dispute_happyPath() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.dispute(id);

        (, , , , , PayCrowEscrow.EscrowState state, ) = escrow.getEscrow(id);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Disputed));
        // Funds stay in contract
        assertEq(usdc.balanceOf(address(escrow)), TEN_USDC);
    }

    function test_dispute_emitsEvent() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        vm.expectEmit(true, true, false, false);
        emit PayCrowEscrow.EscrowDisputed(id, buyer);
        escrow.dispute(id);
    }

    function test_dispute_revertsIfNotBuyer() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(seller);
        vm.expectRevert(PayCrowEscrow.NotBuyer.selector);
        escrow.dispute(id);
    }

    function test_dispute_revertsIfNotFunded() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.release(id);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PayCrowEscrow.InvalidState.selector,
                PayCrowEscrow.EscrowState.Released,
                PayCrowEscrow.EscrowState.Funded
            )
        );
        escrow.dispute(id);
    }

    // ─── resolve Tests ───────────────────────────────────────────────────

    function test_resolve_fullRefund() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.dispute(id);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 fee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 distributable = TEN_USDC - fee;

        vm.prank(arbiter);
        escrow.resolve(id, distributable, 0);

        (, , , , , PayCrowEscrow.EscrowState state, ) = escrow.getEscrow(id);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Resolved));
        assertEq(usdc.balanceOf(buyer), buyerBefore + distributable);
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(treasuryAddr), fee);
    }

    function test_resolve_fullRelease() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.dispute(id);

        uint256 fee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 distributable = TEN_USDC - fee;

        vm.prank(arbiter);
        escrow.resolve(id, 0, distributable);

        assertEq(usdc.balanceOf(seller), distributable);
        assertEq(usdc.balanceOf(treasuryAddr), fee);
    }

    function test_resolve_partialSplit() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.dispute(id);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 fee = TEN_USDC * DEFAULT_FEE_BPS / 10_000; // 200_000
        uint256 distributable = TEN_USDC - fee; // 9_800_000
        // 30/70 split of distributable
        uint256 buyerAmt = distributable * 30 / 100; // 2_940_000
        uint256 sellerAmt = distributable - buyerAmt; // 6_860_000

        vm.prank(arbiter);
        escrow.resolve(id, buyerAmt, sellerAmt);

        assertEq(usdc.balanceOf(buyer), buyerBefore + buyerAmt);
        assertEq(usdc.balanceOf(seller), sellerAmt);
        assertEq(usdc.balanceOf(treasuryAddr), fee);
    }

    function test_resolve_emitsEvent() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.dispute(id);

        uint256 fee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 distributable = TEN_USDC - fee;
        uint256 buyerAmt = distributable * 30 / 100;
        uint256 sellerAmt = distributable - buyerAmt;

        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true);
        emit PayCrowEscrow.EscrowResolved(id, buyerAmt, sellerAmt);
        escrow.resolve(id, buyerAmt, sellerAmt);
    }

    function test_resolve_revertsIfNotArbiter() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.dispute(id);

        uint256 fee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 distributable = TEN_USDC - fee;

        vm.prank(attacker);
        vm.expectRevert(PayCrowEscrow.NotArbiter.selector);
        escrow.resolve(id, distributable, 0);
    }

    function test_resolve_revertsIfNotDisputed() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        uint256 fee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 distributable = TEN_USDC - fee;

        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(
                PayCrowEscrow.InvalidState.selector,
                PayCrowEscrow.EscrowState.Funded,
                PayCrowEscrow.EscrowState.Disputed
            )
        );
        escrow.resolve(id, distributable, 0);
    }

    function test_resolve_revertsIfSplitWrong() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.dispute(id);

        uint256 fee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 distributable = TEN_USDC - fee;

        vm.prank(arbiter);
        vm.expectRevert(PayCrowEscrow.SplitExceedsAmount.selector);
        escrow.resolve(id, distributable, 1); // Sum exceeds distributable
    }

    // ─── Expiry + Refund Tests ───────────────────────────────────────────

    function test_markExpired_happyPath() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        // Warp past expiry
        vm.warp(block.timestamp + DEFAULT_TIMELOCK);

        escrow.markExpired(id);

        (, , , , , PayCrowEscrow.EscrowState state, ) = escrow.getEscrow(id);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Expired));
    }

    function test_markExpired_revertsBeforeExpiry() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.warp(block.timestamp + DEFAULT_TIMELOCK - 1);

        vm.expectRevert(PayCrowEscrow.NotExpired.selector);
        escrow.markExpired(id);
    }

    function test_markExpired_anyoneCanCall() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.warp(block.timestamp + DEFAULT_TIMELOCK);

        vm.prank(attacker); // Anyone can mark expired
        escrow.markExpired(id);
    }

    function test_refund_happyPath() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.warp(block.timestamp + DEFAULT_TIMELOCK);
        escrow.markExpired(id);

        uint256 buyerBefore = usdc.balanceOf(buyer);

        escrow.refund(id);

        (, , , , , PayCrowEscrow.EscrowState state, ) = escrow.getEscrow(id);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Refunded));
        assertEq(usdc.balanceOf(buyer), buyerBefore + TEN_USDC);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_refund_emitsEvent() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.warp(block.timestamp + DEFAULT_TIMELOCK);
        escrow.markExpired(id);

        vm.expectEmit(true, false, false, true);
        emit PayCrowEscrow.EscrowRefunded(id, TEN_USDC);
        escrow.refund(id);
    }

    function test_refund_revertsIfNotExpired() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.expectRevert(
            abi.encodeWithSelector(
                PayCrowEscrow.InvalidState.selector,
                PayCrowEscrow.EscrowState.Funded,
                PayCrowEscrow.EscrowState.Expired
            )
        );
        escrow.refund(id);
    }

    // ─── View Function Tests ─────────────────────────────────────────────

    function test_isExpired_returnsTrueWhenExpired() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        assertFalse(escrow.isExpired(id));

        vm.warp(block.timestamp + DEFAULT_TIMELOCK);
        assertTrue(escrow.isExpired(id));
    }

    function test_isExpired_returnsFalseAfterRelease() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.release(id);

        vm.warp(block.timestamp + DEFAULT_TIMELOCK);
        assertFalse(escrow.isExpired(id)); // Not Funded anymore
    }

    // ─── Admin Tests ─────────────────────────────────────────────────────

    function test_setArbiter() public {
        address newArbiter = makeAddr("newArbiter");
        escrow.setArbiter(newArbiter);
        assertEq(escrow.arbiter(), newArbiter);
    }

    function test_setArbiter_emitsEvent() public {
        address newArbiter = makeAddr("newArbiter");
        vm.expectEmit(true, true, false, false);
        emit PayCrowEscrow.ArbiterUpdated(arbiter, newArbiter);
        escrow.setArbiter(newArbiter);
    }

    function test_setArbiter_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowEscrow.NotOwner.selector);
        escrow.setArbiter(makeAddr("newArbiter"));
    }

    function test_setArbiter_revertsOnZero() public {
        vm.expectRevert(PayCrowEscrow.ZeroAddress.selector);
        escrow.setArbiter(address(0));
    }

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");
        escrow.transferOwnership(newOwner);
        assertEq(escrow.owner(), newOwner);
    }

    function test_transferOwnership_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowEscrow.NotOwner.selector);
        escrow.transferOwnership(makeAddr("newOwner"));
    }

    function test_pause_unpause() public {
        escrow.pause();
        assertTrue(escrow.paused());
        escrow.unpause();
        assertFalse(escrow.paused());
    }

    function test_pause_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowEscrow.NotOwner.selector);
        escrow.pause();
    }

    // ─── Full Lifecycle Tests ────────────────────────────────────────────

    function test_lifecycle_happyPath() public {
        // 1. Buyer creates and funds escrow
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        // 2. Service delivers (off-chain)
        // 3. Buyer confirms and releases
        vm.prank(buyer);
        escrow.release(id);

        uint256 fee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;

        // Verify final state
        (, , , , , PayCrowEscrow.EscrowState state, ) = escrow.getEscrow(id);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Released));
        assertEq(usdc.balanceOf(seller), TEN_USDC - fee);
        assertEq(usdc.balanceOf(treasuryAddr), fee);
    }

    function test_lifecycle_disputeFullRefund() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 fee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 distributable = TEN_USDC - fee;

        // Buyer disputes
        vm.prank(buyer);
        escrow.dispute(id);

        // Arbiter rules full refund (of distributable, fee still taken)
        vm.prank(arbiter);
        escrow.resolve(id, distributable, 0);

        assertEq(usdc.balanceOf(buyer), buyerBefore + distributable);
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(treasuryAddr), fee);
    }

    function test_lifecycle_expireRefund() public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        uint256 buyerBefore = usdc.balanceOf(buyer);

        // Nobody acts, timelock expires
        vm.warp(block.timestamp + DEFAULT_TIMELOCK);

        // Anyone marks expired
        escrow.markExpired(id);

        // Anyone triggers refund — NO FEE on refund
        escrow.refund(id);

        assertEq(usdc.balanceOf(buyer), buyerBefore + TEN_USDC);
        assertEq(usdc.balanceOf(treasuryAddr), 0); // No fee charged
    }

    function test_multipleEscrows_independent() public {
        vm.startPrank(buyer);
        uint256 id0 = escrow.createAndFund(seller, ONE_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
        uint256 id1 = escrow.createAndFund(seller, 5 * ONE_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        // Release first, dispute second
        escrow.release(id0);
        escrow.dispute(id1);
        vm.stopPrank();

        uint256 fee1 = 5 * ONE_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 distributable1 = 5 * ONE_USDC - fee1;

        // Resolve second — full refund to buyer
        vm.prank(arbiter);
        escrow.resolve(id1, distributable1, 0);

        (, , , , , PayCrowEscrow.EscrowState state0, ) = escrow.getEscrow(id0);
        (, , , , , PayCrowEscrow.EscrowState state1, ) = escrow.getEscrow(id1);

        assertEq(uint8(state0), uint8(PayCrowEscrow.EscrowState.Released));
        assertEq(uint8(state1), uint8(PayCrowEscrow.EscrowState.Resolved));
    }

    // ─── Fuzz Tests ──────────────────────────────────────────────────────

    function testFuzz_createAndFund_validAmounts(uint256 amount) public {
        amount = bound(amount, escrow.MIN_ESCROW_AMOUNT(), escrow.MAX_ESCROW_AMOUNT());

        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, amount, DEFAULT_TIMELOCK, SERVICE_HASH);

        (, , uint256 stored, , , , ) = escrow.getEscrow(id);
        assertEq(stored, amount);
        assertEq(usdc.balanceOf(address(escrow)), amount);
    }

    function testFuzz_createAndFund_validTimelocks(uint256 timelock) public {
        timelock = bound(timelock, escrow.MIN_TIMELOCK(), escrow.MAX_TIMELOCK());

        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, timelock, SERVICE_HASH);

        (, , , , uint256 expiresAt, , ) = escrow.getEscrow(id);
        assertEq(expiresAt, block.timestamp + timelock);
    }

    function testFuzz_resolve_validSplits(uint256 buyerAmt) public {
        uint256 fee = TEN_USDC * DEFAULT_FEE_BPS / 10_000;
        uint256 distributable = TEN_USDC - fee;
        buyerAmt = bound(buyerAmt, 0, distributable);
        uint256 sellerAmt = distributable - buyerAmt;

        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.dispute(id);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 sellerBefore = usdc.balanceOf(seller);

        vm.prank(arbiter);
        escrow.resolve(id, buyerAmt, sellerAmt);

        assertEq(usdc.balanceOf(buyer), buyerBefore + buyerAmt);
        assertEq(usdc.balanceOf(seller), sellerBefore + sellerAmt);
        assertEq(usdc.balanceOf(treasuryAddr), fee);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function testFuzz_expiry_onlyAfterTimelock(uint256 warpTime) public {
        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        warpTime = bound(warpTime, 0, DEFAULT_TIMELOCK * 2);
        vm.warp(block.timestamp + warpTime);

        if (warpTime < DEFAULT_TIMELOCK) {
            vm.expectRevert(PayCrowEscrow.NotExpired.selector);
            escrow.markExpired(id);
        } else {
            escrow.markExpired(id);
            (, , , , , PayCrowEscrow.EscrowState state, ) = escrow.getEscrow(id);
            assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Expired));
        }
    }

    // ─── Invariant: No USDC Leakage ─────────────────────────────────────

    function testFuzz_noUsdcLeakage_release(uint256 amount) public {
        amount = bound(amount, escrow.MIN_ESCROW_AMOUNT(), escrow.MAX_ESCROW_AMOUNT());

        uint256 totalBefore = usdc.balanceOf(buyer) + usdc.balanceOf(seller)
            + usdc.balanceOf(address(escrow)) + usdc.balanceOf(treasuryAddr);

        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, amount, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.release(id);

        uint256 totalAfter = usdc.balanceOf(buyer) + usdc.balanceOf(seller)
            + usdc.balanceOf(address(escrow)) + usdc.balanceOf(treasuryAddr);
        assertEq(totalBefore, totalAfter, "USDC leaked during release");
    }

    function testFuzz_noUsdcLeakage_dispute(uint256 amount, uint256 buyerAmt) public {
        amount = bound(amount, escrow.MIN_ESCROW_AMOUNT(), escrow.MAX_ESCROW_AMOUNT());
        uint256 fee = amount * DEFAULT_FEE_BPS / 10_000;
        uint256 distributable = amount - fee;
        buyerAmt = bound(buyerAmt, 0, distributable);
        uint256 sellerAmt = distributable - buyerAmt;

        uint256 totalBefore = usdc.balanceOf(buyer) + usdc.balanceOf(seller)
            + usdc.balanceOf(address(escrow)) + usdc.balanceOf(treasuryAddr);

        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, amount, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.prank(buyer);
        escrow.dispute(id);

        vm.prank(arbiter);
        escrow.resolve(id, buyerAmt, sellerAmt);

        uint256 totalAfter = usdc.balanceOf(buyer) + usdc.balanceOf(seller)
            + usdc.balanceOf(address(escrow)) + usdc.balanceOf(treasuryAddr);
        assertEq(totalBefore, totalAfter, "USDC leaked during dispute resolution");
    }

    function testFuzz_noUsdcLeakage_expiry(uint256 amount) public {
        amount = bound(amount, escrow.MIN_ESCROW_AMOUNT(), escrow.MAX_ESCROW_AMOUNT());

        uint256 totalBefore = usdc.balanceOf(buyer) + usdc.balanceOf(seller)
            + usdc.balanceOf(address(escrow)) + usdc.balanceOf(treasuryAddr);

        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, amount, DEFAULT_TIMELOCK, SERVICE_HASH);

        vm.warp(block.timestamp + DEFAULT_TIMELOCK);
        escrow.markExpired(id);
        escrow.refund(id);

        uint256 totalAfter = usdc.balanceOf(buyer) + usdc.balanceOf(seller)
            + usdc.balanceOf(address(escrow)) + usdc.balanceOf(treasuryAddr);
        assertEq(totalBefore, totalAfter, "USDC leaked during expiry refund");
    }

    // ─── Fee-Specific Tests ──────────────────────────────────────────────

    function test_zeroFee_noTreasuryTransfer() public {
        // Deploy a zero-fee escrow
        PayCrowEscrow zeroFeeEscrow = new PayCrowEscrow(address(usdc), arbiter, treasuryAddr, 0);
        usdc.mint(buyer, TEN_USDC);
        vm.prank(buyer);
        usdc.approve(address(zeroFeeEscrow), TEN_USDC);

        vm.prank(buyer);
        uint256 id = zeroFeeEscrow.createAndFund(seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);

        uint256 treasuryBefore = usdc.balanceOf(treasuryAddr);

        vm.prank(buyer);
        zeroFeeEscrow.release(id);

        assertEq(usdc.balanceOf(seller), TEN_USDC); // Full amount to seller
        assertEq(usdc.balanceOf(treasuryAddr), treasuryBefore); // No fee
    }

    function test_setFeeBps() public {
        escrow.setFeeBps(100); // 1%
        assertEq(escrow.feeBps(), 100);
    }

    function test_setFeeBps_revertsIfTooHigh() public {
        vm.expectRevert(PayCrowEscrow.FeeTooHigh.selector);
        escrow.setFeeBps(501);
    }

    function test_setFeeBps_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowEscrow.NotOwner.selector);
        escrow.setFeeBps(100);
    }

    function test_setTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        escrow.setTreasury(newTreasury);
        assertEq(escrow.treasury(), newTreasury);
    }

    function test_setTreasury_revertsOnZero() public {
        vm.expectRevert(PayCrowEscrow.ZeroAddress.selector);
        escrow.setTreasury(address(0));
    }

    function testFuzz_feeCalculation(uint256 amount) public {
        amount = bound(amount, escrow.MIN_ESCROW_AMOUNT(), escrow.MAX_ESCROW_AMOUNT());

        vm.prank(buyer);
        uint256 id = escrow.createAndFund(seller, amount, DEFAULT_TIMELOCK, SERVICE_HASH);

        uint256 expectedFee = amount * DEFAULT_FEE_BPS / 10_000;
        uint256 treasuryBefore = usdc.balanceOf(treasuryAddr);

        vm.prank(buyer);
        escrow.release(id);

        assertEq(usdc.balanceOf(treasuryAddr), treasuryBefore + expectedFee);
        assertEq(usdc.balanceOf(seller), amount - expectedFee);
    }
}
