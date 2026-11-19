// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Arra vault
/// @notice USDC cover vault for event-linked merchant promotions ("Proof-of-Promise").
///         - LPs deposit USDC and receive ERC-4626 shares.
///         - Merchants buy cover with a 60-second EIP-712 quote signed by the operator,
///           which prices off Gemini Prediction Markets order-book depth.
///         - An event has up to 128 mutually exclusive outcomes (a binary game: 0 = YES, 1 = NO;
///           a championship: one outcome per team). Exactly one outcome can pay, so collateral
///           is locked for the WORST outcome only: locked(event) = max_i L_i. Eight bars in
///           eight cities each insuring their own team lock one payout, not eight.
///         - Settlement (optimistic fast path): settlers vote Gemini's result with a hash of the raw
///           Gemini settlement payload as evidence. If EVERY settler agrees, the event settles
///           instantly. If only the threshold agrees (e.g. 2 of 3), a dispute window opens during
///           which the guardian (owner) can veto; anyone finalizes afterwards.
/// @dev    Every open payout is fully collateralized by USDC held in the vault. Hedges on
///         Gemini reduce risk (the per-event cap) but not the onchain collateral need,
///         because Gemini proceeds arrive offchain and are swept back later.
contract ArraVault is ERC4626, EIP712, Ownable {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct Quote {
        bytes32 eventId;   // keccak256 of the Gemini event ticker
        uint8 outcome;     // mutually exclusive outcome index (< MAX_OUTCOMES)
        uint256 payout;    // USDC (6 decimals) paid if the outcome happens
        uint256 premium;   // USDC (6 decimals) the buyer pays now
        uint64 expiry;     // quote valid until this timestamp (~60s after signing)
        uint64 eventStart; // sales close for THIS quote (kickoff for pre-game; can be in-game for live "comeback" cover)
        address buyer;     // only this address can use the quote
        uint256 nonce;     // one-time use
    }

    struct Policy {
        address holder;
        bytes32 eventId;
        uint8 outcome;
        uint256 payout;
        uint256 premium;
        bool claimed;
    }

    enum EventState {
        None,
        Open,
        Proposed,
        Settled
    }

    struct EventInfo {
        EventState state;
        uint8 winningOutcome;   // proposed, then final
        uint64 eventStart;
        uint64 proposedAt;
        uint32 round;           // bumps on veto, invalidating old votes
        uint8 numOutcomes;      // highest outcome index sold + 1
        bytes32 evidenceHash;   // keccak256 of the raw Gemini settlement payload
        uint256 locked;         // collateral locked = max_i liability[i]
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 eventId,uint8 outcome,uint256 payout,uint256 premium,uint64 expiry,uint64 eventStart,address buyer,uint256 nonce)"
    );

    uint256 public constant BPS = 10_000;
    uint8 public constant MAX_OUTCOMES = 128; // a 94-team college championship fits

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    address public operator;        // signs quotes and records hedges (the pricing service)
    mapping(address => bool) public isSettler;
    uint8 public settlerCount;      // unanimous agreement settles instantly (fast path)
    uint8 public settlerThreshold;  // votes needed to propose a result (e.g. 2 of 3)
    uint64 public disputeWindow;    // seconds the guardian has to veto a proposed result
    uint256 public eventCapBps;     // max worst-case unhedged payout per event, as bps of assets

    uint256 public totalLocked;     // sum over unsettled events of max_i L_i
    uint256 public pendingClaims;   // payouts owed to winners not yet claimed
    uint256 public hedgeReceivable; // hedge proceeds sitting at Gemini, not yet swept back

    mapping(bytes32 => EventInfo) public events;
    mapping(bytes32 => mapping(uint8 => uint256)) public liability; // eventId => outcome => payouts sold
    mapping(bytes32 => mapping(uint8 => uint256)) public hedged;    // eventId => outcome => payout hedged on Gemini
    mapping(bytes32 => uint256) internal _worstUnhedged;              // eventId => max_i (L_i - H_i), kept incrementally
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) public hasVoted;
    mapping(bytes32 => mapping(uint32 => mapping(uint8 => uint8))) public voteCount;
    mapping(uint256 => bool) public nonceUsed;

    Policy[] public policies;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event CoverPurchased(
        uint256 indexed policyId,
        address indexed holder,
        bytes32 indexed eventId,
        uint8 outcome,
        uint256 payout,
        uint256 premium
    );
    event HedgeRecorded(bytes32 indexed eventId, uint8 outcome, uint256 payoutCovered, string geminiOrderId);
    event ResultVoted(bytes32 indexed eventId, address indexed settler, uint8 outcome, bytes32 evidenceHash, uint32 round);
    event ResultProposed(bytes32 indexed eventId, uint8 outcome, bytes32 evidenceHash, uint64 finalizableAt);
    event ResultVetoed(bytes32 indexed eventId, uint32 newRound);
    event EventSettled(bytes32 indexed eventId, uint8 winningOutcome, uint256 owed, bytes32 evidenceHash);
    event CoverPaid(uint256 indexed policyId, address indexed holder, uint256 payout);
    event HedgeReceivableSet(uint256 amount);
    event HedgeProceedsReturned(address indexed from, uint256 amount);
    event OperatorUpdated(address operator);
    event SettlerUpdated(address settler, bool allowed);
    event SettlementParamsUpdated(uint8 threshold, uint64 disputeWindow);
    event EventCapUpdated(uint256 bps);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error NotOperator();
    error NotSettler();
    error BadOutcome();
    error QuoteExpired();
    error WrongBuyer();
    error NonceUsed();
    error BadSignature();
    error SalesClosed();
    error EventNotOpen();
    error ExceedsEventCap();
    error Insolvent();
    error ZeroAmount();
    error AlreadyVoted();
    error NotProposed();
    error DisputeWindowOpen();
    error DisputeWindowClosed();
    error NotSettled();
    error AlreadyClaimed();
    error NotWinner();
    error HedgeExceedsLiability();
    error BadParams();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlySettler() {
        if (!isSettler[msg.sender]) revert NotSettler();
        _;
    }

    constructor(
        IERC20 usdc,
        address operator_,
        address[] memory settlers,
        uint8 threshold,
        uint64 disputeWindow_,
        uint256 eventCapBps_
    ) ERC20("Arra LP", "arLP") ERC4626(usdc) EIP712("Arra", "1") Ownable(msg.sender) {
        if (threshold == 0 || threshold > settlers.length || eventCapBps_ > BPS) revert BadParams();
        operator = operator_;
        for (uint256 i; i < settlers.length; i++) {
            if (!isSettler[settlers[i]]) settlerCount++;
            isSettler[settlers[i]] = true;
            emit SettlerUpdated(settlers[i], true);
        }
        settlerThreshold = threshold;
        disputeWindow = disputeWindow_;
        eventCapBps = eventCapBps_;
    }

    // ------------------------------------------------------------------
    // Admin (owner = guardian)
    // ------------------------------------------------------------------

    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorUpdated(operator_);
    }

    function setSettler(address settler, bool allowed) external onlyOwner {
        if (allowed && !isSettler[settler]) settlerCount++;
        if (!allowed && isSettler[settler]) settlerCount--;
        isSettler[settler] = allowed;
        emit SettlerUpdated(settler, allowed);
    }

    function setSettlementParams(uint8 threshold, uint64 window) external onlyOwner {
        if (threshold == 0) revert BadParams();
        settlerThreshold = threshold;
        disputeWindow = window;
        emit SettlementParamsUpdated(threshold, window);
    }

    function setEventCapBps(uint256 bps) external onlyOwner {
        if (bps > BPS) revert BadParams();
        eventCapBps = bps;
        emit EventCapUpdated(bps);
    }

    // ------------------------------------------------------------------
    // Merchant: buy cover with a signed quote
    // ------------------------------------------------------------------

    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.eventId,
                    q.outcome,
                    q.payout,
                    q.premium,
                    q.expiry,
                    q.eventStart,
                    q.buyer,
                    q.nonce
                )
            )
        );
    }

    function buyCover(Quote calldata q, bytes calldata signature) external returns (uint256 policyId) {
        if (q.payout == 0) revert ZeroAmount();
        if (q.outcome >= MAX_OUTCOMES) revert BadOutcome();
        if (block.timestamp > q.expiry) revert QuoteExpired();
        if (block.timestamp >= q.eventStart) revert SalesClosed();
        if (msg.sender != q.buyer) revert WrongBuyer();
        if (nonceUsed[q.nonce]) revert NonceUsed();
        if (ECDSA.recover(hashQuote(q), signature) != operator) revert BadSignature();
        nonceUsed[q.nonce] = true;

        EventInfo storage e = events[q.eventId];
        if (e.state == EventState.None) {
            e.state = EventState.Open;
            e.eventStart = q.eventStart;
        } else if (e.state != EventState.Open) {
            revert EventNotOpen();
        }

        // Pull the premium first so it counts toward assets.
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), q.premium);

        // Update outcome liability and the netted collateral requirement. A sale only raises
        // L_o, so both maxima update in O(1): max_i L_i and max_i (L_i - H_i) can only grow to
        // the new value at o. Gas does not depend on how many outcomes the event has.
        if (q.outcome >= e.numOutcomes) e.numOutcomes = q.outcome + 1;
        uint256 l = liability[q.eventId][q.outcome] + q.payout;
        liability[q.eventId][q.outcome] = l;
        uint256 newLocked = l > e.locked ? l : e.locked;
        totalLocked = totalLocked + newLocked - e.locked;
        e.locked = newLocked;
        uint256 u = l - hedged[q.eventId][q.outcome];
        if (u > _worstUnhedged[q.eventId]) _worstUnhedged[q.eventId] = u;

        // Risk limit: the worst-case unhedged payout on this event stays under the cap.
        if (_worstUnhedged[q.eventId] * BPS > totalAssets() * eventCapBps) revert ExceedsEventCap();

        // Solvency: the worst case of every open event is fully backed by onchain USDC.
        if (totalLocked + pendingClaims > _usdcBalance()) revert Insolvent();

        policyId = policies.length;
        policies.push(
            Policy({
                holder: msg.sender,
                eventId: q.eventId,
                outcome: q.outcome,
                payout: q.payout,
                premium: q.premium,
                claimed: false
            })
        );
        emit CoverPurchased(policyId, msg.sender, q.eventId, q.outcome, q.payout, q.premium);
    }

    // ------------------------------------------------------------------
    // Operator: hedges
    // ------------------------------------------------------------------

    /// @notice Record that the hedger bought `payoutCovered` worth of this outcome on Gemini.
    function recordHedge(bytes32 eventId, uint8 outcome, uint256 payoutCovered, string calldata geminiOrderId)
        external
        onlyOperator
    {
        if (outcome >= MAX_OUTCOMES) revert BadOutcome();
        if (events[eventId].state != EventState.Open) revert EventNotOpen();
        uint256 l = liability[eventId][outcome];
        uint256 h0 = hedged[eventId][outcome];
        uint256 h = h0 + payoutCovered;
        if (h > l) revert HedgeExceedsLiability();
        hedged[eventId][outcome] = h;
        // A hedge only lowers (L_o - H_o). Rescan only if o held the maximum (operator-paid).
        if (l - h0 == _worstUnhedged[eventId]) _worstUnhedged[eventId] = _scanWorstUnhedged(eventId);
        emit HedgeRecorded(eventId, outcome, payoutCovered, geminiOrderId);
    }

    // ------------------------------------------------------------------
    // Settlement: quorum vote -> dispute window -> finalize
    // ------------------------------------------------------------------

    /// @notice A settler votes Gemini's result. `evidenceHash` = keccak256 of the raw Gemini
    ///         settlement response, so anyone can re-fetch it and check what was attested.
    function voteResult(bytes32 eventId, uint8 outcome, bytes32 evidenceHash) external onlySettler {
        if (outcome >= MAX_OUTCOMES) revert BadOutcome();
        EventInfo storage e = events[eventId];
        // Votes keep counting while Proposed, so a late unanimous vote can fast-path settle.
        if (e.state != EventState.Open && e.state != EventState.Proposed) revert EventNotOpen();
        if (e.state == EventState.Proposed && outcome != e.winningOutcome) revert EventNotOpen();
        uint32 r = e.round;
        if (hasVoted[eventId][r][msg.sender]) revert AlreadyVoted();
        hasVoted[eventId][r][msg.sender] = true;
        uint8 c = ++voteCount[eventId][r][outcome];
        emit ResultVoted(eventId, msg.sender, outcome, evidenceHash, r);

        if (c >= settlerCount) {
            // Fast path: every settler independently attested the same result.
            e.winningOutcome = outcome;
            e.evidenceHash = evidenceHash;
            _settle(eventId, e);
        } else if (c >= settlerThreshold && e.state == EventState.Open) {
            e.state = EventState.Proposed;
            e.winningOutcome = outcome;
            e.proposedAt = uint64(block.timestamp);
            e.evidenceHash = evidenceHash;
            emit ResultProposed(eventId, outcome, evidenceHash, uint64(block.timestamp) + disputeWindow);
        }
    }

    /// @notice Guardian veto during the dispute window: votes reset, settlers must re-attest.
    function vetoResult(bytes32 eventId) external onlyOwner {
        EventInfo storage e = events[eventId];
        if (e.state != EventState.Proposed) revert NotProposed();
        if (block.timestamp >= uint256(e.proposedAt) + disputeWindow) revert DisputeWindowClosed();
        e.state = EventState.Open;
        e.round += 1;
        e.evidenceHash = bytes32(0);
        emit ResultVetoed(eventId, e.round);
    }

    /// @notice After the dispute window, anyone can finalize. Releases collateral and books winners' claims.
    function finalize(bytes32 eventId) external {
        EventInfo storage e = events[eventId];
        if (e.state != EventState.Proposed) revert NotProposed();
        if (block.timestamp < uint256(e.proposedAt) + disputeWindow) revert DisputeWindowOpen();
        _settle(eventId, e);
    }

    function _settle(bytes32 eventId, EventInfo storage e) internal {
        e.state = EventState.Settled;

        uint8 w = e.winningOutcome;
        uint256 owed = liability[eventId][w];
        totalLocked -= e.locked;
        pendingClaims += owed;

        uint256 hedgeWin = hedged[eventId][w];
        if (hedgeWin > 0) {
            hedgeReceivable += hedgeWin;
            emit HedgeReceivableSet(hedgeReceivable);
        }
        emit EventSettled(eventId, w, owed, e.evidenceHash);
    }

    /// @notice Pay a winning cover. Anyone can call (the settler bot pushes payouts);
    ///         USDC always goes to the policy holder.
    function claim(uint256 policyId) external {
        Policy storage p = policies[policyId];
        EventInfo storage e = events[p.eventId];
        if (e.state != EventState.Settled) revert NotSettled();
        if (p.claimed) revert AlreadyClaimed();
        if (p.outcome != e.winningOutcome) revert NotWinner();
        p.claimed = true;
        pendingClaims -= p.payout;
        IERC20(asset()).safeTransfer(p.holder, p.payout);
        emit CoverPaid(policyId, p.holder, p.payout);
    }

    /// @notice Sweep hedge proceeds back from Gemini (in production: Circle Mint / CCTP).
    function returnHedgeProceeds(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        hedgeReceivable = amount >= hedgeReceivable ? 0 : hedgeReceivable - amount;
        emit HedgeProceedsReturned(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function policyCount() external view returns (uint256) {
        return policies.length;
    }

    /// @notice Worst-case payout not covered by Gemini hedges: max_i (L_i - H_i).
    ///         Only one outcome can win, so this is the most the vault can lose to payouts.
    function worstUnhedged(bytes32 eventId) public view returns (uint256) {
        return _worstUnhedged[eventId];
    }

    /// @notice Total payouts sold on an event across all outcomes (insured volume).
    function insuredVolume(bytes32 eventId) external view returns (uint256 v) {
        uint8 n = events[eventId].numOutcomes;
        for (uint8 i; i < n; i++) {
            v += liability[eventId][i];
        }
    }

    /// @notice USDC not backing any open cover or unpaid claim.
    function freeAssets() public view returns (uint256) {
        uint256 bal = _usdcBalance();
        uint256 committed = totalLocked + pendingClaims;
        return bal > committed ? bal - committed : 0;
    }

    /// @notice Event utilization U / U_max used by the pricer's convex surcharge, in bps.
    function utilizationBps(bytes32 eventId) external view returns (uint256) {
        uint256 cap = (totalAssets() * eventCapBps) / BPS;
        if (cap == 0) return BPS;
        uint256 u = (worstUnhedged(eventId) * BPS) / cap;
        return u > BPS ? BPS : u;
    }

    // ------------------------------------------------------------------
    // ERC-4626 overrides
    // ------------------------------------------------------------------

    /// @dev NAV = USDC held + hedge proceeds owed back from Gemini - claims owed to winners.
    function totalAssets() public view override returns (uint256) {
        uint256 gross = _usdcBalance() + hedgeReceivable;
        return gross > pendingClaims ? gross - pendingClaims : 0;
    }

    /// @dev LPs can only take out capital that is not backing open covers,
    ///      and nothing moves while hedge proceeds are still offchain.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (hedgeReceivable > 0) return 0;
        uint256 own = super.maxWithdraw(owner_);
        uint256 free = freeAssets();
        return own < free ? own : free;
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return _convertToShares(maxWithdraw(owner_), Math.Rounding.Floor);
    }

    function maxDeposit(address) public view override returns (uint256) {
        return hedgeReceivable > 0 ? 0 : type(uint256).max;
    }

    function maxMint(address) public view override returns (uint256) {
        return hedgeReceivable > 0 ? 0 : type(uint256).max;
    }

    /// @dev Virtual share offset blunts first-depositor inflation attacks.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function _scanWorstUnhedged(bytes32 eventId) internal view returns (uint256 m) {
        uint8 n = events[eventId].numOutcomes;
        for (uint8 i; i < n; i++) {
            uint256 u = liability[eventId][i] - hedged[eventId][i];
            if (u > m) m = u;
        }
    }

    function _usdcBalance() internal view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }
}
