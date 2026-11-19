// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArraVault} from "../src/ArraVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Random sequences of deposits, cover sales, hedges, settlements, claims,
/// withdrawals and hedge sweeps. After every call the invariants below must hold.
contract Handler is Test {
    ArraVault public vault;
    MockUSDC public usdc;
    uint256 internal operatorPk;
    address internal operator;
    address internal s1 = vm.addr(0x51);
    address internal s2 = vm.addr(0x52);

    address[] internal actors;
    bytes32[] public eventIds;
    uint256 internal nonce = 1;
    uint256 public maxUnhedgedSeenBps; // worst observed unhedged/assets ratio at sale time
    uint256 public coversSold;
    uint256 public buyAttempts;
    uint256 public settlements;

    constructor(ArraVault v, MockUSDC u, uint256 pk) {
        vault = v;
        usdc = u;
        operatorPk = pk;
        operator = vm.addr(pk);
        for (uint256 i; i < 4; i++) {
            address a = address(uint160(0x1000 + i));
            actors.push(a);
            usdc.mint(a, 1_000_000e6);
            vm.prank(a);
            usdc.approve(address(vault), type(uint256).max);
        }
        for (uint256 i; i < 3; i++) eventIds.push(keccak256(abi.encode("event", i)));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 seed, uint256 amt) external {
        amt = bound(amt, 1e6, 100_000e6);
        address a = _actor(seed);
        if (vault.maxDeposit(a) == 0) return;
        vm.prank(a);
        vault.deposit(amt, a);
    }

    function withdraw(uint256 seed, uint256 amt) external {
        address a = _actor(seed);
        uint256 max = vault.maxWithdraw(a);
        if (max == 0) return;
        amt = bound(amt, 1, max);
        vm.prank(a);
        vault.withdraw(amt, a, a);
    }

    function buyCover(uint256 seed, uint256 evSeed, uint8 outcome, uint256 payout, uint256 premiumBps) external {
        bytes32 id = eventIds[evSeed % eventIds.length];
        (ArraVault.EventState st,,,,,,,) = vault.events(id);
        if (st == ArraVault.EventState.Settled || st == ArraVault.EventState.Proposed) return;
        outcome = outcome % 4;
        payout = 1e6 + (payout % 7_000e6); // uniform: ~70% fit under the cap, the rest must revert
        buyAttempts++;
        premiumBps = bound(premiumBps, 100, 5_000);
        address buyer = _actor(seed);

        ArraVault.Quote memory q = ArraVault.Quote({
            eventId: id,
            outcome: outcome,
            payout: payout,
            premium: (payout * premiumBps) / 10_000,
            expiry: uint64(block.timestamp + 60),
            eventStart: uint64(1_000_000_000_000),
            buyer: buyer,
            nonce: nonce++
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorPk, vault.hashQuote(q));
        vm.prank(buyer);
        try vault.buyCover(q, abi.encodePacked(r, s, v)) {
            uint256 bps = (vault.worstUnhedged(id) * 10_000) / vault.totalAssets();
            if (bps > maxUnhedgedSeenBps) maxUnhedgedSeenBps = bps;
            coversSold++;
        } catch {}
    }

    function hedge(uint256 evSeed, uint8 outcome, uint256 amt) external {
        bytes32 id = eventIds[evSeed % eventIds.length];
        outcome = outcome % 4;
        uint256 room = vault.liability(id, outcome) - vault.hedged(id, outcome);
        if (room == 0) return;
        (ArraVault.EventState st,,,,,,,) = vault.events(id);
        if (st != ArraVault.EventState.Open) return;
        amt = bound(amt, 1, room);
        vm.prank(operator);
        vault.recordHedge(id, outcome, amt, "inv");
    }

    /// 2-of-3 votes: Proposed, dispute window opens. winner 255 = void.
    function propose(uint256 evSeed, uint8 winner) external {
        bytes32 id = eventIds[evSeed % eventIds.length];
        (ArraVault.EventState st,,,,,,,) = vault.events(id);
        if (st != ArraVault.EventState.Open) return;
        uint8 w = winner % 5 == 4 ? 255 : winner % 4;
        vm.prank(s1);
        vault.voteResult(id, w, keccak256("evidence"));
        vm.prank(s2);
        vault.voteResult(id, w, keccak256("evidence"));
    }

    function finalize(uint256 evSeed) external {
        bytes32 id = eventIds[evSeed % eventIds.length];
        (ArraVault.EventState st,,,,,,,) = vault.events(id);
        if (st != ArraVault.EventState.Proposed) return;
        vm.warp(block.timestamp + vault.disputeWindow());
        vault.finalize(id);
        settlements++;
    }

    function veto(uint256 evSeed) external {
        bytes32 id = eventIds[evSeed % eventIds.length];
        (ArraVault.EventState st,,, uint64 proposedAt,,,,) = vault.events(id);
        if (st != ArraVault.EventState.Proposed || block.timestamp >= proposedAt + vault.disputeWindow()) return;
        vault.vetoResult(id); // handler is the guardian
    }

    function voidEvent(uint256 evSeed) external {
        bytes32 id = eventIds[evSeed % eventIds.length];
        (ArraVault.EventState st,,,,,,,) = vault.events(id);
        if (st != ArraVault.EventState.Open && st != ArraVault.EventState.Proposed) return;
        vault.voidEvent(id);
        settlements++;
    }

    function claimAll() external {
        uint256 n = vault.policyCount();
        for (uint256 i; i < n; i++) {
            (, bytes32 id, uint8 outcome,,, bool claimed) = vault.policies(i);
            (ArraVault.EventState st, uint8 win,,,,,,) = vault.events(id);
            if (st == ArraVault.EventState.Settled && !claimed && (outcome == win || win == 255)) vault.claim(i);
        }
    }

    function sweepHedge(uint256 amt) external {
        uint256 owed = vault.hedgeReceivable();
        if (owed == 0) return;
        amt = bound(amt, 1, owed);
        usdc.mint(address(this), amt);
        usdc.approve(address(vault), amt);
        vault.returnHedgeProceeds(amt);
    }
}

contract ArraVaultInvariantTest is Test {
    ArraVault vault;
    MockUSDC usdc;
    Handler handler;
    uint256 constant OPERATOR_PK = 0xA11CE;

    function setUp() public {
        usdc = new MockUSDC();
        address[] memory settlers = new address[](3);
        settlers[0] = vm.addr(0x51);
        settlers[1] = vm.addr(0x52);
        settlers[2] = vm.addr(0x53);
        vault = new ArraVault(IERC20(address(usdc)), vm.addr(OPERATOR_PK), settlers, 2, 30 minutes, 1_000);
        handler = new Handler(vault, usdc, OPERATOR_PK);
        vault.transferOwnership(address(handler)); // handler plays the guardian (veto / void)

        // seed liquidity
        usdc.mint(address(this), 50_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(50_000e6, address(this));

        targetContract(address(handler));
    }

    /// Every open payout and every unpaid claim is backed by USDC in the vault.
    function invariant_FullyCollateralized() public view {
        assertLe(vault.totalLocked() + vault.pendingClaims(), usdc.balanceOf(address(vault)));
    }

    /// No cover was ever sold that pushed unhedged exposure on one outcome past the cap.
    function invariant_EventCapNeverBreachedAtSale() public view {
        assertLe(handler.maxUnhedgedSeenBps(), vault.eventCapBps());
    }

    /// LPs can never withdraw USDC that backs open covers or unpaid claims.
    function invariant_WithdrawableNeverExceedsFree() public view {
        assertLe(vault.maxWithdraw(address(this)), vault.freeAssets());
    }

    /// While hedge proceeds sit at Gemini, LP entries and exits are frozen.
    function invariant_FrozenWhileHedgeOffchain() public view {
        if (vault.hedgeReceivable() > 0) {
            assertEq(vault.maxWithdraw(address(this)), 0);
            assertEq(vault.maxDeposit(address(this)), 0);
        }
    }

    function afterInvariant() public view {
        // Not vacuous: when a run tried to sell a few covers, at least one went through.
        if (handler.buyAttempts() >= 8) assertGt(handler.coversSold(), 0, "no covers sold");
    }

    /// Locked collateral is exactly the sum over unsettled events of max_i L_i.
    function invariant_WorstUnhedgedMatchesRescan() public view {
        for (uint256 i; i < 3; i++) {
            bytes32 id = handler.eventIds(i);
            uint256 m;
            for (uint8 o; o < 4; o++) {
                uint256 u = vault.liability(id, o) - vault.hedged(id, o);
                if (u > m) m = u;
            }
            assertEq(vault.worstUnhedged(id), m);
        }
    }

    /// Locked collateral is the worst case over every outcome, including void (refund all premiums).
    function invariant_LockedIsWorstCaseOutcome() public view {
        uint256 sum;
        for (uint256 i; i < 3; i++) {
            bytes32 id = handler.eventIds(i);
            (ArraVault.EventState st,,,,,,,) = vault.events(id);
            if (st == ArraVault.EventState.Open || st == ArraVault.EventState.Proposed) {
                uint256 m = vault.premiumsOf(id); // the void outcome refunds every premium
                for (uint8 o; o < 4; o++) {
                    uint256 l = vault.liability(id, o);
                    if (l > m) m = l;
                }
                sum += m;
            }
        }
        assertEq(vault.totalLocked(), sum);
    }

    /// proposedLoss is exactly the net loss of every Proposed event's result (void = all premiums).
    function invariant_ProposedLossMatchesRescan() public view {
        uint256 sum;
        for (uint256 i; i < 3; i++) {
            bytes32 id = handler.eventIds(i);
            (ArraVault.EventState st, uint8 w,,,,,,) = vault.events(id);
            if (st != ArraVault.EventState.Proposed) continue;
            sum += w == 255 ? vault.premiumsOf(id) : vault.liability(id, w) - vault.hedged(id, w);
        }
        assertEq(vault.proposedLoss(), sum);
    }

    /// Hedges never exceed what was sold.
    function invariant_HedgeBoundedByLiability() public view {
        for (uint256 i; i < 3; i++) {
            bytes32 id = handler.eventIds(i);
            for (uint8 o; o < 4; o++) {
                assertLe(vault.hedged(id, o), vault.liability(id, o));
            }
        }
    }
}

contract HandlerSmokeTest is Test {
    function test_handlerCanSell() public {
        MockUSDC usdc = new MockUSDC();
        address[] memory settlers = new address[](3);
        settlers[0] = vm.addr(0x51);
        settlers[1] = vm.addr(0x52);
        settlers[2] = vm.addr(0x53);
        ArraVault vault = new ArraVault(IERC20(address(usdc)), vm.addr(0xA11CE), settlers, 2, 30 minutes, 1_000);
        Handler h = new Handler(vault, usdc, 0xA11CE);
        usdc.mint(address(this), 50_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(50_000e6, address(this));
        h.buyCover(0, 0, 0, 1_000e6, 500);
        assertEq(h.coversSold(), 1);
    }
}
