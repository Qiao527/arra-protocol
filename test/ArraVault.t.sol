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
        // Worst case is one payout (5,000) or, if the event is voided, all 8 premiums back
        // (5,600). Either way a fraction of the 40,000 promised.
        assertEq(vault.totalLocked(), 5_600 * USDC);
        assertEq(vault.worstUnhedged(champ), 5_000 * USDC);

        // Team 5 wins: only that city's bar is paid; the vault keeps all 8 premiums.
        _settle(champ, 5);
        uint256 before = usdc.balanceOf(address(uint160(0xC17 + 5)));
        vault.claim(5);
        assertEq(usdc.balanceOf(address(uint160(0xC17 + 5))) - before, 5_000 * USDC);
        assertEq(vault.totalAssets(), (50_000 + 8 * 700 - 5_000) * USDC);
    }

    /// Real championships have 30-94 teams (NBA 30, NHL 32, college basketball 94).
    /// The last team index must be sellable and settle like any other.
    function test_LargeChampionshipLastTeamWins() public {
        bytes32 champ = keccak256("NCAAMCHAMP27");
        uint8 last = vault.MAX_OUTCOMES() - 1;
        _buy(champ, bar, 3, 2_000 * USDC, 100 * USDC);
        _buy(champ, cafe, last, 4_000 * USDC, 100 * USDC);
        assertEq(vault.totalLocked(), 4_000 * USDC);
        assertEq(vault.insuredVolume(champ), 6_000 * USDC);
        _settle(champ, last);
        uint256 before = usdc.balanceOf(cafe);
        vault.claim(1);
        assertEq(usdc.balanceOf(cafe) - before, 4_000 * USDC);
        // An uncovered team winning pays nobody and releases the lock.
        bytes32 other = keccak256("NBAF-2627CHAMP");
        _buy(other, bar, 7, 1_000 * USDC, 50 * USDC);
        _settle(other, 29);
        assertEq(vault.totalLocked(), 0);
        assertEq(vault.pendingClaims(), 0);
    }

    /// buyCover does O(1) work: its gas must not grow with the number of outcomes sold.
    function test_BuyGasIndependentOfOutcomeCount() public {
        bytes32 champ = keccak256("MANY");
        _buy(champ, bar, 0, 100 * USDC, 5 * USDC);
        (ArraVault.Quote memory q1, bytes memory sig1) = _quote(champ, cafe, 1, 100 * USDC, 5 * USDC);
        vm.prank(cafe);
        uint256 g0 = gasleft();
        vault.buyCover(q1, sig1);
        uint256 few = g0 - gasleft();

        for (uint8 i = 2; i < 120; i++) _buy(champ, bar, i, 10 * USDC, 1 * USDC);
        (ArraVault.Quote memory q2, bytes memory sig2) = _quote(champ, cafe, 125, 100 * USDC, 5 * USDC);
        vm.prank(cafe);
        g0 = gasleft();
        vault.buyCover(q2, sig2);
        uint256 many = g0 - gasleft();
        assertLt(many, few + 30_000, "buy gas grew with outcome count");
    }

    /// The incrementally tracked worst case must equal a full rescan after hedges move the max.
    function test_WorstUnhedgedTracksHedges() public {
        _buy(bar, 0, 4_000 * USDC, 100 * USDC);
        _buy(cafe, 1, 3_000 * USDC, 100 * USDC);
        assertEq(vault.worstUnhedged(EVT), 4_000 * USDC);
        vm.startPrank(operator);
        vault.recordHedge(EVT, 0, 2_000 * USDC, "g1"); // outcome 0 drops to 2k; max moves to outcome 1
        assertEq(vault.worstUnhedged(EVT), 3_000 * USDC);
        vault.recordHedge(EVT, 1, 500 * USDC, "g2"); // 2.5k
        assertEq(vault.worstUnhedged(EVT), 2_500 * USDC);
        vault.recordHedge(EVT, 0, 1_000 * USDC, "g3"); // not the max holder: unchanged
        assertEq(vault.worstUnhedged(EVT), 2_500 * USDC);
        vm.stopPrank();
        assertEq(vault.totalLocked(), 4_000 * USDC, "hedges never reduce onchain collateral");
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
        (ArraVault.Quote memory q,) = _quote(EVT, bar, vault.MAX_OUTCOMES(), 1_000 * USDC, 150 * USDC);
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

    // ---------------------------------------------------------------- review findings

    address lp2 = makeAddr("lp2");

    function _secondLp() internal {
        usdc.mint(lp2, 50_000 * USDC);
        vm.startPrank(lp2);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(50_000 * USDC, lp2);
        vm.stopPrank();
    }

    /// REVIEW H-1: once a losing result is Proposed, everyone can see the loss coming for the
    /// whole dispute window. NAV must already reflect it, or an LP who exits during the window
    /// pushes their share of the loss onto the LPs who stay.
    function test_Review_ProposedLossIsInNav_NoExitAtStalePrice() public {
        _secondLp();
        _buy(bar, 0, 5_000 * USDC, 500 * USDC); // 100,500 assets, two equal LPs
        vm.warp(eventStart + 3 hours);
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE); // Proposed: the vault will owe 5,000

        // Fair exit price shares the 5,000 loss equally: (100,500 - 5,000) / 2.
        uint256 shares2 = vault.balanceOf(lp2);
        assertApproxEqAbs(vault.previewRedeem(shares2), 47_750 * USDC, 10);
        uint256 maxShares = vault.maxRedeem(lp2);
        assertEq(maxShares, shares2); // free capital covers the whole exit
        vm.prank(lp2);
        uint256 out = vault.redeem(maxShares, lp2, lp2);

        vm.warp(block.timestamp + WINDOW);
        vault.finalize(EVT);
        vault.claim(0);

        // The LP who stayed ends with the same value the leaver took out.
        assertApproxEqAbs(vault.previewRedeem(vault.balanceOf(lp)), out, 10);
    }

    /// A veto puts the pending loss back: NAV returns to its pre-proposal value.
    function test_Review_VetoRestoresNav() public {
        _buy(bar, 0, 5_000 * USDC, 500 * USDC);
        uint256 navBefore = vault.totalAssets();
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE);
        assertEq(vault.totalAssets(), navBefore - 5_000 * USDC);
        vault.vetoResult(EVT);
        assertEq(vault.totalAssets(), navBefore);
    }

    /// The pending loss is net of the winning outcome's Gemini hedge, matching what settlement books.
    function test_Review_ProposedLossNetOfHedge() public {
        _buy(bar, 0, 5_000 * USDC, 500 * USDC);
        vm.prank(operator);
        vault.recordHedge(EVT, 0, 3_000 * USDC, "o-1");
        uint256 navBefore = vault.totalAssets();
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE);
        uint256 navProposed = vault.totalAssets();
        assertEq(navProposed, navBefore - 2_000 * USDC);
        vm.warp(block.timestamp + WINDOW);
        vault.finalize(EVT);
        assertEq(vault.totalAssets(), navProposed); // settlement books exactly what was pending
        assertEq(vault.proposedLoss(), 0);
    }

    /// REVIEW M-1: hedge proceeds that never fully come back (partial IOC fill, Gemini loss)
    /// froze every LP forever. The guardian can write the shortfall off; NAV drops by it.
    function test_Review_GuardianWritesOffUnrecoverableHedge() public {
        _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        vm.prank(operator);
        vault.recordHedge(EVT, 0, 3_000 * USDC, "partially-filled");
        vm.warp(eventStart + 3 hours);
        _settle(EVT, 0);
        vault.claim(0);

        usdc.mint(address(this), 1_000 * USDC); // only 1,000 of 3,000 ever arrives
        usdc.approve(address(vault), 1_000 * USDC);
        vault.returnHedgeProceeds(1_000 * USDC);
        assertEq(vault.maxWithdraw(lp), 0); // still frozen

        uint256 navBefore = vault.totalAssets();
        vm.prank(bar);
        vm.expectRevert();
        vault.writeOffHedgeReceivable(2_000 * USDC);
        vm.expectRevert(ArraVault.BadParams.selector);
        vault.writeOffHedgeReceivable(2_001 * USDC);

        vault.writeOffHedgeReceivable(2_000 * USDC);
        assertEq(vault.hedgeReceivable(), 0);
        assertEq(vault.totalAssets(), navBefore - 2_000 * USDC);
        assertGt(vault.maxWithdraw(lp), 0);
    }

    // ---------------------------------------------------------------- void / tie

    uint8 constant VOID = 255;

    /// A tie on a full-game moneyline (no draw contract): every contract resolves NO.
    /// Quorum votes VOID -> collateral released, every holder gets their exact premium back.
    function test_Void_QuorumRefundsExactPremiums() public {
        uint256 a = _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        uint256 b = _buy(cafe, 1, 2_000 * USDC, 1_100 * USDC);
        uint256 navBefore = vault.totalAssets();
        vm.warp(eventStart + 3 hours);
        _settle(EVT, VOID);

        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Settled));
        assertEq(vault.totalLocked(), 0);
        assertEq(vault.pendingClaims(), 1_818 * USDC);
        assertEq(vault.totalAssets(), navBefore - 1_818 * USDC); // premiums are no longer earned

        uint256 barBefore = usdc.balanceOf(bar);
        uint256 cafeBefore = usdc.balanceOf(cafe);
        vault.claim(a);
        vault.claim(b);
        assertEq(usdc.balanceOf(bar) - barBefore, 718 * USDC); // premium, not payout
        assertEq(usdc.balanceOf(cafe) - cafeBefore, 1_100 * USDC);
        assertEq(vault.pendingClaims(), 0);
        vm.expectRevert(ArraVault.AlreadyClaimed.selector);
        vault.claim(a);
    }

    /// Guardian can void an Open event directly (e.g. game cancelled, no Gemini result coming).
    function test_Void_GuardianVoidsOpenEvent() public {
        uint256 a = _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        vm.prank(bar);
        vm.expectRevert();
        vault.voidEvent(EVT);
        vault.voidEvent(EVT);
        (, uint8 w,,,,,,) = vault.events(EVT);
        assertEq(w, VOID);
        assertEq(vault.totalLocked(), 0);
        uint256 before = usdc.balanceOf(bar);
        vault.claim(a);
        assertEq(usdc.balanceOf(bar) - before, 718 * USDC);
    }

    /// Voiding a Proposed event drops the proposed loss and books the refunds instead.
    function test_Void_GuardianVoidsProposedEvent() public {
        _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        uint256 navBefore = vault.totalAssets();
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE);
        vault.voidEvent(EVT);
        assertEq(vault.proposedLoss(), 0);
        assertEq(vault.pendingClaims(), 718 * USDC);
        assertEq(vault.totalAssets(), navBefore - 718 * USDC);
    }

    function test_Void_RevertWhen_AlreadySettled() public {
        _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        _settle(EVT, 0);
        vm.expectRevert(ArraVault.EventNotOpen.selector);
        vault.voidEvent(EVT);
        vm.expectRevert(ArraVault.EventNotOpen.selector);
        vault.voidEvent(EVT2); // never sold
    }

    /// No payout on void: hedge on the "winning" side earns nothing onchain (Gemini refunds offchain).
    function test_Void_NoPayoutNoHedgeCredit() public {
        _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        vm.prank(operator);
        vault.recordHedge(EVT, 0, 3_000 * USDC, "o-1");
        _settle(EVT, VOID);
        assertEq(vault.hedgeReceivable(), 0);
        assertEq(vault.pendingClaims(), 718 * USDC);
    }

    /// Refunds can exceed the worst single payout (many covers across a championship), and
    /// premiums are withdrawable free capital. Collateral must cover the void case too.
    function test_Void_RefundsAlwaysCollateralized() public {
        vault.setEventCapBps(10_000);
        for (uint8 i; i < 8; i++) {
            _buy(EVT, i % 2 == 0 ? bar : cafe, i, 1_000 * USDC, 400 * USDC); // 3,200 premiums > 1,000 max payout
        }
        assertEq(vault.totalLocked(), 3_200 * USDC);
        uint256 max = vault.maxWithdraw(lp);
        vm.prank(lp);
        vault.withdraw(max, lp, lp); // LP takes every free dollar
        _settle(EVT, VOID);
        for (uint256 i; i < 8; i++) vault.claim(i); // every refund still pays
        assertEq(vault.pendingClaims(), 0);
    }

    // ---------------------------------------------------------------- independent-verifier findings

    /// N-1: the guardian may void a Proposed result only inside its dispute window, like a veto.
    function test_Void_RevertWhen_ProposedWindowClosed() public {
        _buy(bar, 0, 5_000 * USDC, 718 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(ArraVault.DisputeWindowClosed.selector);
        vault.voidEvent(EVT);
        vault.finalize(EVT); // the proposed result stands
        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Settled));
    }

    /// N-2: while a loss is booked (Proposed), deposits are closed: a veto would hand a
    /// depositor the marked-down shares' rebound at the other LPs' expense.
    function test_Review_NoDepositWhileLossProposed() public {
        _buy(bar, 0, 5_000 * USDC, 500 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE);
        assertEq(vault.maxDeposit(cafe), 0);
        assertEq(vault.maxMint(cafe), 0);
        vm.prank(cafe);
        vm.expectRevert();
        vault.deposit(1_000 * USDC, cafe);
        vault.vetoResult(EVT);
        assertEq(vault.maxDeposit(cafe), type(uint256).max);
    }

    /// N-3 (L-4): votes cast before a settler-set change no longer count. A removed settler's
    /// vote can neither complete a quorum nor, with the smaller count, the unanimous fast path.
    function test_Review_SettlerChangeResetsOpenVotes() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 1, EVIDENCE); // s1 later found compromised
        vault.setSettler(s1, false);
        address s4 = makeAddr("s4");
        vault.setSettler(s4, true);
        vm.prank(s2);
        vault.voteResult(EVT, 1, EVIDENCE); // would have reached 2-of-3 with s1's stale vote
        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Open));
        vm.prank(s4);
        vault.voteResult(EVT, 1, EVIDENCE);
        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Proposed));
    }

    function test_Review_SettlerChangeBlocksFastPathWhileProposed() public {
        _buy(bar, 0, 1_000 * USDC, 150 * USDC);
        vm.prank(s1);
        vault.voteResult(EVT, 0, EVIDENCE);
        vm.prank(s2);
        vault.voteResult(EVT, 0, EVIDENCE); // Proposed
        vault.setSettler(s1, false); // settlerCount 3 -> 2: s3 alone would now "complete" unanimity
        vm.prank(s3);
        vm.expectRevert(ArraVault.SettlersChanged.selector);
        vault.voteResult(EVT, 0, EVIDENCE);
        // The guardian still has the window; afterwards anyone finalizes as usual.
        vm.warp(block.timestamp + WINDOW);
        vault.finalize(EVT);
        assertEq(uint8(_state(EVT)), uint8(ArraVault.EventState.Settled));
    }

    /// Check (no fix needed): the 6-decimal virtual offset makes a first-depositor
    /// donation attack cost the attacker ~1e6x what it takes from the victim.
    function test_Review_InflationAttackUnprofitable() public {
        ArraVault fresh = new ArraVault(IERC20(address(usdc)), operator, new address[](1), 1, WINDOW, 1_000);
        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");
        usdc.mint(attacker, 10_001 * USDC);
        usdc.mint(victim, 10_000 * USDC);
        vm.startPrank(attacker);
        usdc.approve(address(fresh), type(uint256).max);
        fresh.deposit(1, attacker);
        usdc.transfer(address(fresh), 10_000 * USDC); // donation
        vm.stopPrank();
        vm.startPrank(victim);
        usdc.approve(address(fresh), type(uint256).max);
        uint256 shares = fresh.deposit(10_000 * USDC, victim);
        vm.stopPrank();
        assertGt(shares, 0);
        // Victim loses less than 0.01 USDC; the attacker gets back only about half of the
        // donation (the 1e6 virtual shares absorb the rest), so the attack is a pure loss.
        assertGe(fresh.previewRedeem(shares), 10_000 * USDC - 10_000);
        assertLt(fresh.previewRedeem(fresh.balanceOf(attacker)), 5_001 * USDC);
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
