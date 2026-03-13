// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PayCrowEscrow} from "../src/PayCrowEscrow.sol";
import {PayCrowEscrowRouter, IERC20WithAuthorization} from "../src/PayCrowEscrowRouter.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Mock USDC with EIP-3009 transferWithAuthorization support
contract MockUSDCWithAuth is ERC20 {
    // Track used nonces to prevent replay
    mapping(bytes32 => bool) public authorizationUsed;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Simplified EIP-3009 for testing. In production USDC, this verifies
    ///      an EIP-712 signature. Here we just validate params and execute.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8, // v
        bytes32, // r
        bytes32 // s
    ) external {
        require(block.timestamp > validAfter, "auth not yet valid");
        require(block.timestamp < validBefore, "auth expired");
        require(!authorizationUsed[nonce], "nonce already used");
        authorizationUsed[nonce] = true;
        _transfer(from, to, value);
    }
}

// ─── createAndFundFor Tests (on PayCrowEscrow) ─────────────────────────────

contract CreateAndFundForTest is Test {
    PayCrowEscrow public escrow;
    MockUSDCWithAuth public usdc;

    address public owner = address(this);
    address public arbiter = makeAddr("arbiter");
    address public treasury = makeAddr("treasury");
    address public buyer = makeAddr("buyer");
    address public seller = makeAddr("seller");
    address public router = makeAddr("router");
    address public attacker = makeAddr("attacker");

    uint256 public constant ONE_USDC = 1_000_000;
    uint256 public constant TEN_USDC = 10_000_000;
    uint256 public constant DEFAULT_TIMELOCK = 30 minutes;
    uint256 public constant DEFAULT_FEE_BPS = 200;
    bytes32 public constant SERVICE_HASH = keccak256("https://api.example.com/data");

    function setUp() public {
        usdc = new MockUSDCWithAuth();
        escrow = new PayCrowEscrow(address(usdc), arbiter, treasury, DEFAULT_FEE_BPS);

        // Authorize the router
        escrow.setRouter(router, true);

        // Fund the router with USDC (simulating post-transferWithAuthorization)
        usdc.mint(router, 1000 * ONE_USDC);

        // Router approves escrow
        vm.prank(router);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ─── setRouter tests ──────────────────────────────────────────────

    function test_setRouter_authorizes() public view {
        assertTrue(escrow.authorizedRouters(router));
    }

    function test_setRouter_deauthorizes() public {
        escrow.setRouter(router, false);
        assertFalse(escrow.authorizedRouters(router));
    }

    function test_setRouter_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowEscrow.NotOwner.selector);
        escrow.setRouter(router, true);
    }

    function test_setRouter_revertsOnZero() public {
        vm.expectRevert(PayCrowEscrow.ZeroAddress.selector);
        escrow.setRouter(address(0), true);
    }

    function test_setRouter_emitsEvent() public {
        address newRouter = makeAddr("newRouter");
        vm.expectEmit(true, false, false, true);
        emit PayCrowEscrow.RouterUpdated(newRouter, true);
        escrow.setRouter(newRouter, true);
    }

    // ─── createAndFundFor happy path ──────────────────────────────────

    function test_createAndFundFor_happyPath() public {
        uint256 routerBalBefore = usdc.balanceOf(router);

        vm.prank(router);
        uint256 escrowId = escrow.createAndFundFor(
            buyer, seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        assertEq(escrowId, 0);

        // Check escrow state
        (address b, address s, uint256 amt,,,PayCrowEscrow.EscrowState state,) = escrow.getEscrow(escrowId);
        assertEq(b, buyer); // Buyer is the specified buyer, NOT the router
        assertEq(s, seller);
        assertEq(amt, TEN_USDC);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Funded));

        // USDC moved from router to escrow contract
        assertEq(usdc.balanceOf(router), routerBalBefore - TEN_USDC);
        assertEq(usdc.balanceOf(address(escrow)), TEN_USDC);
    }

    function test_createAndFundFor_buyerCanRelease() public {
        vm.prank(router);
        uint256 escrowId = escrow.createAndFundFor(
            buyer, seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        // Buyer (not router) releases
        vm.prank(buyer);
        escrow.release(escrowId);

        (,,,,, PayCrowEscrow.EscrowState state,) = escrow.getEscrow(escrowId);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Released));
    }

    function test_createAndFundFor_buyerCanDispute() public {
        vm.prank(router);
        uint256 escrowId = escrow.createAndFundFor(
            buyer, seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        // Buyer (not router) disputes
        vm.prank(buyer);
        escrow.dispute(escrowId);

        (,,,,, PayCrowEscrow.EscrowState state,) = escrow.getEscrow(escrowId);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Disputed));
    }

    function test_createAndFundFor_routerCannotRelease() public {
        vm.prank(router);
        uint256 escrowId = escrow.createAndFundFor(
            buyer, seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        // Router is NOT the buyer, cannot release
        vm.prank(router);
        vm.expectRevert(PayCrowEscrow.NotBuyer.selector);
        escrow.release(escrowId);
    }

    function test_createAndFundFor_emitsEvents() public {
        vm.prank(router);
        vm.expectEmit(true, true, true, true);
        emit PayCrowEscrow.EscrowCreated(0, buyer, seller, TEN_USDC, block.timestamp + DEFAULT_TIMELOCK, SERVICE_HASH);
        escrow.createAndFundFor(buyer, seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    // ─── createAndFundFor reverts ─────────────────────────────────────

    function test_createAndFundFor_revertsIfNotRouter() public {
        vm.prank(attacker);
        vm.expectRevert(PayCrowEscrow.NotAuthorizedRouter.selector);
        escrow.createAndFundFor(buyer, seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFundFor_revertsIfBuyerZero() public {
        vm.prank(router);
        vm.expectRevert(PayCrowEscrow.ZeroAddress.selector);
        escrow.createAndFundFor(address(0), seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFundFor_revertsIfSellerZero() public {
        vm.prank(router);
        vm.expectRevert(PayCrowEscrow.ZeroAddress.selector);
        escrow.createAndFundFor(buyer, address(0), TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFundFor_revertsIfBuyerIsSeller() public {
        vm.prank(router);
        vm.expectRevert(PayCrowEscrow.BuyerIsSeller.selector);
        escrow.createAndFundFor(buyer, buyer, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFundFor_revertsIfAmountTooLow() public {
        vm.prank(router);
        vm.expectRevert(PayCrowEscrow.AmountTooLow.selector);
        escrow.createAndFundFor(buyer, seller, 1, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFundFor_revertsIfAmountTooHigh() public {
        uint256 tooHigh = 100_000_001;
        usdc.mint(router, tooHigh);
        vm.prank(router);
        vm.expectRevert(PayCrowEscrow.AmountTooHigh.selector);
        escrow.createAndFundFor(buyer, seller, tooHigh, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    function test_createAndFundFor_revertsWhenPaused() public {
        escrow.pause();
        vm.prank(router);
        vm.expectRevert();
        escrow.createAndFundFor(buyer, seller, TEN_USDC, DEFAULT_TIMELOCK, SERVICE_HASH);
    }

    // ─── Fuzz: createAndFundFor amount ────────────────────────────────

    function testFuzz_createAndFundFor_amount(uint256 amount) public {
        amount = bound(amount, 100_000, 100_000_000);
        usdc.mint(router, amount);

        vm.prank(router);
        uint256 escrowId = escrow.createAndFundFor(
            buyer, seller, amount, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        (, , uint256 storedAmount,,,,) = escrow.getEscrow(escrowId);
        assertEq(storedAmount, amount);
    }
}

// ─── PayCrowEscrowRouter Tests ─────────────────────────────────────────────

contract PayCrowEscrowRouterTest is Test {
    PayCrowEscrow public escrow;
    PayCrowEscrowRouter public router;
    MockUSDCWithAuth public usdc;

    address public owner = address(this);
    address public arbiter = makeAddr("arbiter");
    address public treasury = makeAddr("treasury");
    address public buyer = makeAddr("buyer");
    address public seller = makeAddr("seller");
    address public facilitator = makeAddr("facilitator");

    uint256 public constant ONE_USDC = 1_000_000;
    uint256 public constant TEN_USDC = 10_000_000;
    uint256 public constant DEFAULT_TIMELOCK = 30 minutes;
    uint256 public constant DEFAULT_FEE_BPS = 200;
    bytes32 public constant SERVICE_HASH = keccak256("https://api.example.com/data");

    function setUp() public {
        usdc = new MockUSDCWithAuth();
        escrow = new PayCrowEscrow(address(usdc), arbiter, treasury, DEFAULT_FEE_BPS);
        router = new PayCrowEscrowRouter(address(usdc), address(escrow));

        // Authorize the router on the escrow contract
        escrow.setRouter(address(router), true);

        // Fund buyer with USDC (the buyer signs EIP-3009 auths in real x402 flow)
        usdc.mint(buyer, 1000 * ONE_USDC);
    }

    // ─── settleToEscrow happy path ────────────────────────────────────

    function test_settleToEscrow_happyPath() public {
        uint256 buyerBalBefore = usdc.balanceOf(buyer);

        vm.prank(facilitator);
        uint256 escrowId = router.settleToEscrow(
            buyer,          // from (signed EIP-3009 auth)
            TEN_USDC,       // value
            0,              // validAfter (any time)
            type(uint256).max, // validBefore (far future)
            keccak256("nonce1"), // nonce
            27, bytes32(0), bytes32(0), // v, r, s (mock doesn't verify sigs)
            seller,
            DEFAULT_TIMELOCK,
            SERVICE_HASH
        );

        // Escrow created with buyer = the original client
        (address b, address s, uint256 amt,,, PayCrowEscrow.EscrowState state,) = escrow.getEscrow(escrowId);
        assertEq(b, buyer);
        assertEq(s, seller);
        assertEq(amt, TEN_USDC);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Funded));

        // USDC moved from buyer → router → escrow contract
        assertEq(usdc.balanceOf(buyer), buyerBalBefore - TEN_USDC);
        assertEq(usdc.balanceOf(address(router)), 0); // Router holds nothing
        assertEq(usdc.balanceOf(address(escrow)), TEN_USDC);
    }

    function test_settleToEscrow_buyerCanRelease() public {
        vm.prank(facilitator);
        uint256 escrowId = router.settleToEscrow(
            buyer, TEN_USDC, 0, type(uint256).max,
            keccak256("nonce1"), 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        // Original buyer releases — funds go to seller minus fee
        uint256 sellerBalBefore = usdc.balanceOf(seller);
        vm.prank(buyer);
        escrow.release(escrowId);

        uint256 fee = (TEN_USDC * DEFAULT_FEE_BPS) / 10_000;
        assertEq(usdc.balanceOf(seller), sellerBalBefore + TEN_USDC - fee);
        assertEq(usdc.balanceOf(treasury), fee);
    }

    function test_settleToEscrow_buyerCanDispute() public {
        vm.prank(facilitator);
        uint256 escrowId = router.settleToEscrow(
            buyer, TEN_USDC, 0, type(uint256).max,
            keccak256("nonce1"), 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        // Buyer disputes
        vm.prank(buyer);
        escrow.dispute(escrowId);

        (,,,,, PayCrowEscrow.EscrowState state,) = escrow.getEscrow(escrowId);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Disputed));

        // Arbiter resolves — full refund to buyer
        uint256 distributable = TEN_USDC - (TEN_USDC * DEFAULT_FEE_BPS) / 10_000;
        vm.prank(arbiter);
        escrow.resolve(escrowId, distributable, 0);

        (,,,,, PayCrowEscrow.EscrowState resolved,) = escrow.getEscrow(escrowId);
        assertEq(uint8(resolved), uint8(PayCrowEscrow.EscrowState.Resolved));
    }

    function test_settleToEscrow_emitsEvent() public {
        vm.prank(facilitator);
        vm.expectEmit(true, true, true, true);
        emit PayCrowEscrowRouter.SettledToEscrow(0, buyer, seller, TEN_USDC, SERVICE_HASH);
        router.settleToEscrow(
            buyer, TEN_USDC, 0, type(uint256).max,
            keccak256("nonce1"), 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );
    }

    function test_settleToEscrow_routerHoldsZero() public {
        vm.prank(facilitator);
        router.settleToEscrow(
            buyer, TEN_USDC, 0, type(uint256).max,
            keccak256("nonce1"), 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        // Router never holds funds
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_settleToEscrow_multipleSettlements() public {
        // First settlement
        vm.prank(facilitator);
        uint256 id1 = router.settleToEscrow(
            buyer, TEN_USDC, 0, type(uint256).max,
            keccak256("nonce1"), 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        // Second settlement (different nonce)
        vm.prank(facilitator);
        uint256 id2 = router.settleToEscrow(
            buyer, ONE_USDC, 0, type(uint256).max,
            keccak256("nonce2"), 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        assertEq(id1, 0);
        assertEq(id2, 1);
        assertEq(usdc.balanceOf(address(escrow)), TEN_USDC + ONE_USDC);
    }

    // ─── settleToEscrow reverts ───────────────────────────────────────

    function test_settleToEscrow_revertsOnNonceReplay() public {
        bytes32 nonce = keccak256("nonce1");

        vm.prank(facilitator);
        router.settleToEscrow(
            buyer, TEN_USDC, 0, type(uint256).max,
            nonce, 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        // Same nonce should fail
        vm.prank(facilitator);
        vm.expectRevert("nonce already used");
        router.settleToEscrow(
            buyer, TEN_USDC, 0, type(uint256).max,
            nonce, 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );
    }

    function test_settleToEscrow_revertsIfAuthExpired() public {
        vm.prank(facilitator);
        vm.expectRevert("auth expired");
        router.settleToEscrow(
            buyer, TEN_USDC,
            0,    // validAfter
            1,    // validBefore = timestamp 1 (already passed)
            keccak256("nonce1"), 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );
    }

    function test_settleToEscrow_revertsIfInsufficientBalance() public {
        address poorBuyer = makeAddr("poorBuyer");
        // Don't mint — poorBuyer has 0 USDC

        vm.prank(facilitator);
        vm.expectRevert();
        router.settleToEscrow(
            poorBuyer, TEN_USDC, 0, type(uint256).max,
            keccak256("nonce1"), 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );
    }

    // ─── Full E2E: settle → verify → release with fee ─────────────────

    function test_e2e_settleVerifyRelease() public {
        uint256 amount = 50 * ONE_USDC; // $50
        usdc.mint(buyer, amount);

        // 1. Facilitator settles to escrow
        vm.prank(facilitator);
        uint256 escrowId = router.settleToEscrow(
            buyer, amount, 0, type(uint256).max,
            keccak256("e2e-nonce"), 27, bytes32(0), bytes32(0),
            seller, 1 hours, SERVICE_HASH
        );

        // 2. Verify escrow state
        (address b, address s, uint256 amt,,, PayCrowEscrow.EscrowState state,) = escrow.getEscrow(escrowId);
        assertEq(b, buyer);
        assertEq(s, seller);
        assertEq(amt, amount);
        assertEq(uint8(state), uint8(PayCrowEscrow.EscrowState.Funded));

        // 3. Buyer releases (delivery confirmed)
        vm.prank(buyer);
        escrow.release(escrowId);

        // 4. Verify: seller got amount minus 2% fee, treasury got fee
        uint256 fee = (amount * DEFAULT_FEE_BPS) / 10_000;
        assertEq(usdc.balanceOf(seller), amount - fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    // ─── Fuzz: settleToEscrow amount ──────────────────────────────────

    function testFuzz_settleToEscrow_amount(uint256 amount) public {
        amount = bound(amount, 100_000, 100_000_000); // $0.10 - $100
        usdc.mint(buyer, amount);

        vm.prank(facilitator);
        uint256 escrowId = router.settleToEscrow(
            buyer, amount, 0, type(uint256).max,
            keccak256(abi.encodePacked("fuzz-", amount)), 27, bytes32(0), bytes32(0),
            seller, DEFAULT_TIMELOCK, SERVICE_HASH
        );

        (, , uint256 stored,,,,) = escrow.getEscrow(escrowId);
        assertEq(stored, amount);
        assertEq(usdc.balanceOf(address(router)), 0);
    }
}
