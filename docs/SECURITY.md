# Security model

This page states who Arra trusts, what each role can do to LP and merchant funds, and what the code enforces regardless. Findings from the November 2026 review are in [REVIEW.md](REVIEW.md).

## Roles

| Role | Who | Key held by |
| --- | --- | --- |
| Owner (guardian) | Deployer. Admin and veto power. | One EOA on testnet. Should be a multisig behind a timelock in production. |
| Operator | Pricing service. Signs quotes, records hedges. | The pricer / hedger process (`OPERATOR_PRIVATE_KEY`). |
| Settlers | Attest Gemini's result. 2-of-3 on testnet. | Three keys. In production, three independent operators. |
| LP | Deposits USDC, holds `arLP`. | Anyone. |
| Merchant | Buys cover with an operator-signed quote. | Anyone holding a quote bound to their address. |
| Anyone | `finalize`, `claim` (pays the holder), `returnHedgeProceeds`. | Permissionless. |

## Trust assumptions: what each privileged role can do

No role can transfer vault USDC to an arbitrary address. Every outflow is either an LP withdrawal (limited to free capital) or a `claim` paid to the policy holder. The risk is that a privileged role decides **who becomes a policy holder, and which outcome pays**.

| Role | Power | Worst case if the key is compromised or malicious | What bounds it |
| --- | --- | --- | --- |
| Owner | `setSettler`, `setSettlementParams` | Adds itself as the only settler (settler count 1 = unanimous), then settles any event on any outcome instantly. Combined with a cover it holds, this drains up to the free capital it can get locked. | Votes cast before a settler or threshold change stop counting (`settlerEpoch`), so a removed key's vote can't complete a quorum. Beyond that, nothing onchain. **Full trust.** Production needs a multisig and a timelock on settler and threshold changes. |
| Owner | `setSettlementParams(window)` | Shortens the dispute window of an event that is already Proposed (the window is read at `finalize` time), so a bad proposal can be finalized at once. | Nothing onchain. |
| Owner | `setOperator` | Installs an operator that signs arbitrary quotes (see the operator rows). | Nothing onchain. |
| Owner | `vetoResult` | Vetoes every proposal, forever. Merchant payouts are delayed and collateral stays locked. Funds don't move, but merchants are never paid while the guardian refuses. | Unanimous settler votes bypass the veto (fast path). |
| Owner | `voidEvent` | Voids an Open event, or a Proposed one inside its dispute window: holders get their premium back instead of the payout, even when the true result would have paid them. | Same window as a veto. A Settled event, or a proposal whose window has closed, cannot be voided. |
| Owner | `writeOffHedgeReceivable` | Cuts NAV by writing off hedge proceeds that might still arrive. LPs take the loss. No USDC moves to the owner. | Capped at the current `hedgeReceivable`. |
| Owner | `setEventCapBps` | Raises the per-event risk limit up to 100% of NAV. | `≤ BPS`. Solvency still holds: every open payout stays fully backed. |
| Operator | Signs quotes | Sells itself (or an accomplice) cover at any premium, including 0, on an event whose result is already public. Honest settlers then vote the real result and the vault pays. | Per-event cap on unhedged payout, the solvency check, and the 60 s TTL. Across many events the loss is bounded only by free capital. **Full trust.** |
| Operator | `recordHedge` | Records hedges that were never placed. This lowers the event's worst unhedged payout and lifts the cap. At settlement it books a fake `hedgeReceivable`, which inflates NAV and freezes LP withdrawals until the guardian writes it off. | `hedged ≤ liability` per outcome. No onchain proof of a Gemini fill. |
| Settler quorum | `voteResult` | `threshold` settlers propose any outcome, including VOID. With every settler agreeing, it settles instantly with no veto. | Guardian veto during the dispute window (threshold path only). |
| One settler | `voteResult` | Withholds or splits votes. This blocks the unanimous fast path but not the threshold path. | Threshold below settler count. |
| LP | `withdraw` / `redeem` | Exits only from free capital (USDC not backing open covers or unpaid claims). Frozen while hedge proceeds sit offchain. | `maxWithdraw` / `maxRedeem`. |

## What the contract enforces for everyone

- **Full collateralization.** `totalLocked + pendingClaims ≤ USDC balance` after every sale. Per event, `locked = max(max_i L_i, Σ premiums)`: the worst single payout, or refunding everyone if the event is voided. Checked by the `invariant_FullyCollateralized` and `invariant_LockedIsWorstCaseOutcome` fuzz invariants.
- **Netting is exact.** Outcomes of one event are mutually exclusive by construction (the offchain adapter refuses non-exclusive markets such as player props, spreads and totals).
- **Quotes** are EIP-712 typed data (`name "Arra"`, `version "1"`, chain id, vault address). Each is bound to one buyer, used once (nonce), and valid for 60 s, and sales close at the quote's own `eventStart`. OpenZeppelin ECDSA rejects malleable signatures. Replay across chains or vaults fails the domain check.
- **NAV is not stale at settlement.** Once a result is Proposed, its net loss is already in `totalAssets` (`proposedLoss`), so no LP can exit at the pre-loss price during the dispute window. Deposits close while a loss is booked, so nobody can buy marked-down shares and wait for a veto.
- **Votes belong to a settler set.** Any settler or threshold change bumps `settlerEpoch`. Votes cast before it stop counting: an Open event starts a fresh round, and a Proposed one takes no more votes.
- **First-depositor inflation** is blunted by a 6-decimal virtual share offset. A 10,000 USDC donation costs the attacker about 5,000 USDC and the victim under 0.01 USDC (`test_Review_InflationAttackUnprofitable`).

## Threat model

| Adversary | Goal | Mitigation | Residual risk |
| --- | --- | --- | --- |
| Merchant who knows the result | Buy cover on an outcome that has already happened | Sales close per quote. In-game cover only within a per-sport window that ends inside a regulation game (Gemini keeps finished games open for days). No quote above 50% probability. No quote without a real ask. | A game that ends early (blowout, mercy rule) can still be quoted inside the window if its book is stale. |
| LP who sees a loss coming | Exit before the loss is booked | Proposed losses are booked into NAV immediately. | **Before the first vote** (between Gemini's result and the quorum's votes) an LP watching Gemini can still exit at the pre-loss price. A withdrawal request queue with a delay longer than settlement latency would close this. Not implemented. |
| LP | Deposit just before a gain | NAV never jumps up at settlement: premiums are in NAV from the sale, and settlement can only book a loss (`L_w − H_w ≥ 0`). The one upward move, a veto restoring a booked loss, can't be bought into: deposits are closed while `proposedLoss > 0`. | None found. |
| Front-runner | Steal or replay a quote | Quotes are buyer-bound, single-use and domain-separated. | None found. |
| Webhook spammer | Make the hedger place duplicate Gemini orders | The webhook fails closed without a shared secret (constant-time compare), drops redelivered logs, and serializes hedges per event. | A leaked secret still lets an attacker trigger hedges, but each hedge is sized from onchain state, so it cannot over-hedge. |
| Gemini data drift | Mis-settle on a changed response | The settler votes only when every contract is settled and exactly one is YES (or none, which is VOID, with only threshold votes so the guardian can look). Outcome order is pinned at the first sale, so a contract Gemini adds later can't shift indexes already sold. The evidence hash covers the exact response bytes. | Gemini's own result is trusted. Settlers only attest it. The pricer, hedger and settler must share the registry that holds the pinned order. |
| Gas griefing | DoS through unbounded loops | No loop is reachable by unprivileged callers. `recordHedge` rescans at most 128 outcomes and is operator-paid. `insuredVolume` is a view. | None found. |

## Known limits

- Hedge proceeds are custodial: they come back from Gemini through the operator, not trustlessly.
- The evidence hash proves *which bytes* a settler attested, not that Gemini served them. Anyone can refetch and compare, but Gemini responses change over time (prices, timestamps), so the raw bytes are stored at vote time for later verification (see `offchain/scripts/verify-settlement.js`).
- A void refunds premiums but does not credit any Gemini refund on voided hedges. Those come back offchain.
