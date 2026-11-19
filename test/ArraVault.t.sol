// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArraVault} from "../src/ArraVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract ArraVaultTest is Test {
    MockUSDC usdc;
    ArraVault vault;

    uint256 constant OPERATOR_PK = 0xA11CE;
    uint256 constant S1_PK = 0x51;
    uint256 constant S2_PK = 0x52;
    uint256 constant S3_PK = 0x53;
    address operator;
    address s1;
    address s2;
    address s3;

    address lp = makeAddr("lp");
    address bar = makeAddr("bar");   // Austin bar, insures "Texas wins" (YES)
    address cafe = makeAddr("cafe"); // Norman cafe, insures "Texas loses" (NO)

    bytes32 constant EVT = keccak256("GEMI-NCAAF-TEX-OU");
    bytes32 constant EVT2 = keccak256("GEMI-NBA-HOU-OKC");
    bytes32 constant EVIDENCE = keccak256("raw gemini settlement json");
    uint64 constant WINDOW = 30 minutes;
    uint64 eventStart;
    uint256 nextNonce = 1;

    uint256 constant USDC = 1e6;

    function setUp() public {
        operator = vm.addr(OPERATOR_PK);
        s1 = vm.addr(S1_PK);
        s2 = vm.addr(S2_PK);
        s3 = vm.addr(S3_PK);
        address[] memory settlers = new address[](3);
        settlers[0] = s1;
        settlers[1] = s2;
        settlers[2] = s3;

        usdc = new MockUSDC();
        vault = new ArraVault(IERC20(address(usdc)), operator, settlers, 2, WINDOW, 1_000); // 2-of-3, 10% cap

        usdc.mint(lp, 100_000 * USDC);
        usdc.mint(bar, 100_000 * USDC);
        usdc.mint(cafe, 100_000 * USDC);
        vm.prank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bar);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(cafe);
        usdc.approve(address(vault), type(uint256).max);

        vm.prank(lp);
        vault.deposit(50_000 * USDC, lp);

        eventStart = uint64(block.timestamp + 1 days);
    }

    // ---------------------------------------------------------------- helpers

    function _quote(bytes32 evt, address buyer, uint8 outcome, uint256 payout, uint256 premium)
        internal
        returns (ArraVault.Quote memory q, bytes memory sig)
    {
        q = ArraVault.Quote({
            eventId: evt,
            outcome: outcome,
            payout: payout,
            premium: premium,
            expiry: uint64(block.timestamp + 60),
            eventStart: eventStart,
            buyer: buyer,
            nonce: nextNonce++
        });
        sig = _sign(q, OPERATOR_PK);
    }

    function _sign(ArraVault.Quote memory q, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    function _buy(bytes32 evt, address buyer, uint8 outcome, uint256 payout, uint256 premium)
        internal
        returns (uint256 id)
    {
        (ArraVault.Quote memory q, bytes memory sig) = _quote(evt, buyer, outcome, payout, premium);
        vm.prank(buyer);
        id = vault.buyCover(q, sig);
    }

    function _buy(address buyer, uint8 outcome, uint256 payout, uint256 premium) internal returns (uint256) {
        return _buy(EVT, buyer, outcome, payout, premium);
    }

    function _settle(bytes32 evt, uint8 outcome) internal {
        vm.prank(s1);
        vault.voteResult(evt, outcome, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(evt, outcome, EVIDENCE);
        vm.warp(block.timestamp + WINDOW);
        vault.finalize(evt);
    }

    function _state(bytes32 evt) internal view returns (ArraVault.EventState st) {
        (st,,,,,,,) = vault.events(evt);
    }

    // ---------------------------------------------------------------- happy path

    function test_BuyCover_LocksPayoutAndTakesPremium() public {
        uint256 id = _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        assertEq(id, 0);
        assertEq(vault.totalLocked(), 5_000 * USDC);
        assertEq(usdc.balanceOf(address(vault)), 50_718 * USDC);
        assertEq(vault.liability(EVT, 0), 5_000 * USDC);
    }

    function test_WinnerPaidAutomatically_LoserReleased() public {
        uint256 winId = _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        uint256 loseId = _buy(cafe, 1, 2_000 * USDC, 1_800 * USDC);

        vm.warp(eventStart + 3 hours);
        _settle(EVT, 0);

        assertEq(vault.totalLocked(), 0);
        assertEq(vault.pendingClaims(), 5_000 * USDC);

        uint256 before = usdc.balanceOf(bar);
        vault.claim(winId); // anyone (the settler bot) can push the payout
        assertEq(usdc.balanceOf(bar) - before, 5_000 * USDC);
        assertEq(vault.pendingClaims(), 0);

        vm.expectRevert(ArraVault.NotWinner.selector);
        vault.claim(loseId);

        // LPs keep both premiums minus the payout: 50,000 + 718 + 1,800 - 5,000
        assertEq(vault.totalAssets(), 47_518 * USDC);
    }

    // ---------------------------------------------------------------- outcome netting

    /// Austin bar insures "Texas wins" for 5k; Norman cafe insures "Texas loses" for 4k.
    /// Insured volume is 9k but only 5k must be locked: both can never pay.
    function test_OppositeSidesNetCollateral() public {
        _buy(bar, 0, 5_000 * USDC, 700 * USDC);
        uint256 lockedAfterFirst = vault.totalLocked();
        _buy(cafe, 1, 4_000 * USDC, 3_400 * USDC);

        assertEq(vault.insuredVolume(EVT), 9_000 * USDC);
        assertEq(vault.totalLocked(), lockedAfterFirst); // stays flat at 5k
        assertEq(vault.totalLocked(), 5_000 * USDC);
        assertEq(vault.worstUnhedged(EVT), 5_000 * USDC);
    }

    /// "If our team wins the championship": bars in 8 cities each insure their own team for 5k.
    /// $40k of promises, but exactly one team wins, so only $5k is locked.
    function test_ChampionshipEightCitiesLockOnePayout() public {
        bytes32 champ = keccak256("GEMI-NCAAF-CHAMP-2026");
        for (uint8 team; team < 8; team++) {
            address cityBar = address(uint160(0xC17 + team));
            usdc.mint(cityBar, 10_000 * USDC);
            vm.prank(cityBar);
            usdc.approve(address(vault), type(uint256).max);
            _buy(champ, cityBar, team, 5_000 * USDC, 700 * USDC);
        }
        assertEq(vault.insuredVolume(champ), 40_000 * USDC);
        assertEq(vault.totalLocked(), 5_000 * USDC);
        assertEq(vault.worstUnhedged(champ), 5_000 * USDC);

        // Team 5 wins: only that city's bar is paid; the vault keeps all 8 premiums.
        _settle(champ, 5);
        uint256 before = usdc.balanceOf(address(uint160(0xC17 + 5)));
        vault.claim(5);
        assertEq(usdc.balanceOf(address(uint160(0xC17 + 5))) - before, 5_000 * USDC);
        assertEq(vault.totalAssets(), (50_000 + 8 * 700 - 5_000) * USDC);
    }

    /// Selling a different outcome is allowed even when one outcome is "full",
    /// because it does not raise the worst case.
    function test_OppositeSideAllowedPastCap() public {
        _buy(bar, 0, 5_000 * USDC, 700 * USDC); // at the ~5k cap on YES
        (ArraVault.Quote memory q, bytes memory sig) = _quote(EVT, cafe, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(cafe);
        vm.expectRevert(ArraVault.ExceedsEventCap.selector);
        vault.buyCover(q, sig); // more YES: rejected

        _buy(cafe, 1, 3_000 * USDC, 2_600 * USDC); // NO side: accepted, worst case unchanged
        assertEq(vault.worstUnhedged(EVT), 5_000 * USDC);
        assertEq(vault.totalLocked(), 5_000 * USDC);
    }

    // ---------------------------------------------------------------- quote security

    function test_RevertWhen_QuoteExpired() public {
        (ArraVault.Quote memory q, bytes memory sig) = _quote(EVT, bar, 0, 1_000 * USDC, 150 * USDC);
        vm.warp(block.timestamp + 61);
        vm.prank(bar);
        vm.expectRevert(ArraVault.QuoteExpired.selector);
        vault.buyCover(q, sig);
    }

    function test_RevertWhen_SignedByStranger() public {
        (ArraVault.Quote memory q,) = _quote(EVT, bar, 0, 1_000 * USDC, 150 * USDC);
        bytes memory badSig = _sign(q, 0xBAD);
        vm.prank(bar);
        vm.expectRevert(ArraVault.BadSignature.selector);
        vault.buyCover(q, badSig);
    }

    function test_RevertWhen_PremiumTampered() public {
        (ArraVault.Quote memory q, bytes memory sig) = _quote(EVT, bar, 0, 1_000 * USDC, 150 * USDC);
        q.premium = 1;
        vm.prank(bar);
        vm.expectRevert(ArraVault.BadSignature.selector);
        vault.buyCover(q, sig);
    }

    function test_RevertWhen_QuoteReused() public {
        (ArraVault.Quote memory q, bytes memory sig) = _quote(EVT, bar, 0, 1_000 * USDC, 150 * USDC);
        vm.startPrank(bar);
        vault.buyCover(q, sig);
        vm.expectRevert(ArraVault.NonceUsed.selector);
        vault.buyCover(q, sig);
        vm.stopPrank();
    }

    function test_RevertWhen_SomeoneElseUsesQuote() public {
        (ArraVault.Quote memory q, bytes memory sig) = _quote(EVT, bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(cafe);
        vm.expectRevert(ArraVault.WrongBuyer.selector);
        vault.buyCover(q, sig);
    }

    function test_RevertWhen_GameAlreadyStarted() public {
        (ArraVault.Quote memory q,) = _quote(EVT, bar, 0, 1_000 * USDC, 150 * USDC);
        q.expiry = uint64(eventStart + 60);
        bytes memory sig = _sign(q, OPERATOR_PK);
        vm.warp(eventStart);
        vm.prank(bar);
        vm.expectRevert(ArraVault.SalesClosed.selector);
        vault.buyCover(q, sig);
    }

    function test_RevertWhen_OutcomeOutOfRange() public {
        (ArraVault.Quote memory q,) = _quote(EVT, bar, 16, 1_000 * USDC, 150 * USDC);
        bytes memory sig = _sign(q, OPERATOR_PK);
        vm.prank(bar);
        vm.expectRevert(ArraVault.BadOutcome.selector);
        vault.buyCover(q, sig);
    }

    // ---------------------------------------------------------------- risk limits

    function test_RevertWhen_OverEventCap() public {
        _buy(bar, 0, 5_000 * USDC, 700 * USDC);
        (ArraVault.Quote memory q, bytes memory sig) = _quote(EVT, cafe, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(cafe);
        vm.expectRevert(ArraVault.ExceedsEventCap.selector);
        vault.buyCover(q, sig);
    }

    function test_HedgeFreesCapRoom() public {
        _buy(bar, 0, 5_000 * USDC, 700 * USDC);
        vm.prank(operator);
        vault.recordHedge(EVT, 0, 4_000 * USDC, "sandbox-order-123");
        _buy(cafe, 0, 2_000 * USDC, 300 * USDC);
        assertEq(vault.liability(EVT, 0), 7_000 * USDC);
    }

    function test_RevertWhen_HedgeExceedsLiability() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(operator);
        vm.expectRevert(ArraVault.HedgeExceedsLiability.selector);
        vault.recordHedge(EVT, 0, 2_000 * USDC, "x");
    }

    function test_RevertWhen_Insolvent() public {
        vault.setEventCapBps(10_000); // remove the cap to reach the solvency check
        _buy(EVT, cafe, 0, 30_000 * USDC, 1_000 * USDC);
        // Same-direction risk on a DIFFERENT event does not net: 30k + 30k > ~52k on hand.
        (ArraVault.Quote memory q, bytes memory sig) = _quote(EVT2, bar, 0, 30_000 * USDC, 1_000 * USDC);
        vm.prank(bar);
        vm.expectRevert(ArraVault.Insolvent.selector);
        vault.buyCover(q, sig);
    }

    // ---------------------------------------------------------------- settlement quorum

    /// All three settlers agree: settles instantly, no dispute window.
    function test_UnanimousVotesSettleInstantly() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE);
        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Proposed)); // 2-of-3: window
        vm.prank(s3);
        vault.voteResult(EVT, 0, EVIDENCE);
        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Settled)); // 3-of-3: instant
        uint256 before = usdc.balanceOf(bar);
        vault.claim(0);
        assertEq(usdc.balanceOf(bar) - before, 1_000 * USDC);
    }

    /// Live "comeback" cover: a quote whose sales close is later than an earlier quote's.
    function test_InGameQuoteAllowedWithLaterSalesClose() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC); // pre-game, closes at kickoff
        vm.warp(eventStart + 90 minutes); // halftime
        ArraVault.Quote memory q = ArraVault.Quote({
            eventId: EVT,
            outcome: 0,
            payout: 2_000 * USDC,
            premium: 160 * USDC,
            expiry: uint64(block.timestamp + 15),
            eventStart: uint64(block.timestamp + 10 minutes), // in-game sales close
            buyer: cafe,
            nonce: nextNonce++
        });
        bytes memory sig = _sign(q, OPERATOR_PK);
        vm.prank(cafe);
        vault.buyCover(q, sig);
        assertEq(vault.liability(EVT, 0), 3_000 * USDC);
    }

    function test_OneVoteIsNotEnough() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Open));
    }

    function test_ConflictingVotesDoNotPropose() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 1, EVIDENCE);
        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Open));
        vm.prank(s3);
        vault.voteResult(EVT, 0, EVIDENCE); // third settler breaks the tie
        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Proposed));
    }

    function test_RevertWhen_FinalizeDuringDisputeWindow() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.expectRevert(ArraVault.DisputeWindowOpen.selector);
        vault.finalize(EVT);
    }

    function test_GuardianVetoResetsVotes() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 1, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 1, EVIDENCE); // wrong result proposed
        vault.vetoResult(EVT); // owner = guardian
        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Open));

        _settle(EVT, 0); // settlers re-attest the correct result in round 1
        uint256 before = usdc.balanceOf(bar);
        vault.claim(0);
        assertEq(usdc.balanceOf(bar) - before, 1_000 * USDC);
    }

    function test_RevertWhen_VetoAfterWindow() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(ArraVault.DisputeWindowClosed.selector);
        vault.vetoResult(EVT);
    }

    function test_RevertWhen_NonSettlerVotes() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(bar);
        vm.expectRevert(ArraVault.NotSettler.selector);
        vault.voteResult(EVT, 0, EVIDENCE);
    }

    function test_RevertWhen_SettlerVotesTwice() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.startPrank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.expectRevert(ArraVault.AlreadyVoted.selector);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.stopPrank();
    }

    function test_NoSalesWhileResultProposed() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE);
        (ArraVault.Quote memory q, bytes memory sig) = _quote(EVT, cafe, 1, 1_000 * USDC, 150 * USDC);
        vm.prank(cafe);
        vm.expectRevert(ArraVault.EventNotOpen.selector);
        vault.buyCover(q, sig);
    }

    // ---------------------------------------------------------------- LP protections

    function test_LpCannotWithdrawCapitalBackingCovers() public {
        _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        assertEq(vault.maxWithdraw(lp), 45_718 * USDC);
        vm.prank(lp);
        vm.expectRevert();
        vault.withdraw(46_000 * USDC, lp, lp);
    }

    function test_LpFrozenWhileHedgeProceedsOffchain() public {
        _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        vm.prank(operator);
        vault.recordHedge(EVT, 0, 5_000 * USDC, "sandbox-order-456");
        vm.warp(eventStart + 3 hours);
        _settle(EVT, 0);
        vault.claim(0);

        assertEq(vault.hedgeReceivable(), 5_000 * USDC);
        assertEq(vault.maxWithdraw(lp), 0);
        assertEq(vault.maxDeposit(lp), 0);
        assertEq(vault.totalAssets(), 50_718 * USDC);

        usdc.mint(address(this), 5_000 * USDC);
        usdc.approve(address(vault), 5_000 * USDC);
        vault.returnHedgeProceeds(5_000 * USDC);
        assertEq(vault.hedgeReceivable(), 0);
        assertGt(vault.maxWithdraw(lp), 0);
    }

    function test_OnlyOperatorRecordsHedges() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(bar);
        vm.expectRevert(ArraVault.NotOperator.selector);
        vault.recordHedge(EVT, 0, 500 * USDC, "x");
    }

    // ---------------------------------------------------------------- fuzz

    /// Any mix of opposite-side covers and outcomes: the vault can always pay, and
    /// locked collateral is exactly the worst single outcome.
    function testFuzz_NettingAndSolvency(uint96 p1, uint96 p2, uint8 winner) public {
        vault.setEventCapBps(10_000);
        uint256 pay1 = bound(uint256(p1), 1 * USDC, 20_000 * USDC);
        uint256 pay2 = bound(uint256(p2), 1 * USDC, 20_000 * USDC);
        _buy(bar, 0, pay1, pay1 / 10);
        _buy(cafe, 1, pay2, pay2 / 2);

        assertEq(vault.totalLocked(), pay1 > pay2 ? pay1 : pay2);
        assertLe(vault.totalLocked() + vault.pendingClaims(), usdc.balanceOf(address(vault)));

        _settle(EVT, winner % 2);
        vault.claim(winner % 2 == 0 ? 0 : 1);

        assertEq(vault.totalLocked(), 0);
        assertEq(vault.pendingClaims(), 0);
    }
}
