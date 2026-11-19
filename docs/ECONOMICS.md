# Arra: economics, risk, and references

## 1. Pricing

```
premium = L·p·(1 + b + k·u²) + r·ΔLocked·(1 − p)
```

| Symbol | Meaning | MVP |
| --- | --- | --- |
| `L` | payout = merchant's real cost of honoring the promo (cost of goods, not menu price) | merchant input |
| `p` | executable price: average price to buy `L` contracts of the insured outcome, walking Gemini's book | live |
| `b` | hedge buffer: spread and slippage between quote and hedge | 5% |
| `k`, `u` | convex utilization surcharge; `u` = post-trade worst-case unhedged payout ÷ per-event cap, in [0, 1] | k = 20% |
| `r` | capital charge on the collateral this cover adds | 2% |
| `ΔLocked` | increase in `max_i L_i` (the event's locked collateral) caused by this cover | computed |

**Why the executable price, not the mid.** Tail contracts have wide spreads and thin books. A mid-price quote on a 5% market with a 4/6 spread would sell cover below what the hedge costs. Walking the book for the full size makes the quote equal to what the vault would actually pay to lay the risk off.

**Why a capital charge on ΔLocked.** The vault must hold the event's worst-case payout in USDC until settlement. Outcomes of one event are mutually exclusive, so a cover on a different outcome often adds no collateral at all. Charging only for added collateral passes the netting benefit to merchants and still pays LPs for what is actually tied up.

**Why convex in utilization.** The per-event cap is a hard wall. The `k·u²` term makes the last dollars before the wall progressively more expensive, so demand self-limits and the vault keeps room for the hedge to catch up.

**Why we refuse likely outcomes.** The pricer rejects quotes where `p > 0.5`. Cover on a coin flip costs about as much as the giveaway itself; it is the tail-risk promo (`p ≤ 0.15`) where a small fixed fee buys a big headline.

### Worked example (from `./script/e2e-anvil.sh`)

| Item | Value |
| --- | --- |
| Promo | "If the underdog wins, everyone's tab is free, up to $5,000" |
| Book walk for 5,000 contracts | 2,000 @ 0.11 · 2,500 @ 0.12 · 500 @ 0.14 → `p = 0.118` |
| Hedge cost | $590.00 |
| Buffer (5%) | $29.50 |
| Utilization surcharge (20% × 0.5² × $590) | $29.50 |
| Capital charge (2% × 0.882 × $5,000 added collateral) | $88.20 |
| **Premium** | **$737.20 (14.7% of payout, 6.8× multiple)** |

### Championship netting example

Four bars in four cities each insure their own team to win the title ($5,000 each). Only one team can win, so the vault locks $5,000, not $20,000. The first bar pays the capital charge on $5,000 of added collateral; the next three add none and pay $0 capital charge.

Benchmark: Mattress Mack paid 10–20% of the refund amount for traditional promo insurance in 2017. We land in that range, but instantly, at $1k–$10k sizes, with no broker.

### The favorite–longshot bias works in LPs' favor

Prediction-market prices for long shots tend to run *above* their true win rates. A 2026 study of Kalshi finds low-price contracts win less often than they need to break even after fees (Bürgi & Deng, 2026; see also Wolfers & Zitzewitz, 2004). Two consequences:

1. Pricing off the market is **conservative for LPs**: on average, the vault charges more than the true probability.
2. With enough independent events in the book, the vault can **under-hedge long shots** and keep part of that edge, passing savings to merchants. The MVP hedges only above `HEDGE_THRESHOLD_USDC`; a production version would size hedges to a solvency target instead.

## 2. Risk controls (enforced onchain)

| Control | Implementation | Tested by |
| --- | --- | --- |
| Signed quotes | EIP-712 `Quote(eventId, outcome, payout, premium, expiry, eventStart, buyer, nonce)`; 60-second expiry; bound to buyer; nonce consumed | `test_RevertWhen_QuoteExpired`, `_PremiumTampered`, `_QuoteReused`, `_SomeoneElseUsesQuote`, `_SignedByStranger` |
| Outcome netting | up to 128 mutually exclusive outcomes; `locked = max_i L_i`, maintained in O(1) per sale | `test_OppositeSidesNetCollateral`, `test_ChampionshipEightCitiesLockOnePayout`, `test_LargeChampionshipLastTeamWins`, `test_BuyGasIndependentOfOutcomeCount`, `test_WorstUnhedgedTracksHedges`, `testFuzz_NettingAndSolvency`, `invariant_LockedIsWorstCaseOutcome`, `invariant_WorstUnhedgedMatchesRescan` |
| Per-event cap | worst-case unhedged payout `max_i (L_i − H_i)` ≤ `eventCapBps` × assets; netting covers that reduce risk are allowed past the cap | `test_RevertWhen_OverEventCap`, `test_HedgeFreesCapRoom`, `test_OppositeSideAllowedPastCap`, `invariant_EventCapNeverBreachedAtSale` |
| Full collateral | `totalLocked + pendingClaims ≤ USDC balance` | `test_RevertWhen_Insolvent`, `invariant_FullyCollateralized` |
| Sales close | per-quote `eventStart`: kickoff for pre-game cover, later for in-game cover | `test_RevertWhen_GameAlreadyStarted`, `test_InGameQuoteAllowedWithLaterSalesClose` |
| Settlement quorum | threshold votes open a dispute window; unanimous votes settle instantly; guardian veto bumps the round | `test_OneVoteIsNotEnough`, `test_ConflictingVotesDoNotPropose`, `test_UnanimousVotesSettleInstantly`, `test_GuardianVetoResetsVotes`, `test_RevertWhen_FinalizeDuringDisputeWindow`, `_VetoAfterWindow`, `_NonSettlerVotes`, `_SettlerVotesTwice`, `test_NoSalesWhileResultProposed` |
| LP withdrawals | only free capital; frozen while hedge proceeds are offchain | `test_LpCannotWithdrawCapitalBackingCovers`, `test_LpFrozenWhileHedgeProceedsOffchain`, `invariant_WithdrawableNeverExceedsFree`, `invariant_FrozenWhileHedgeOffchain` |
| Hedge sanity | only the operator records hedges; hedged ≤ liability per outcome | `test_OnlyOperatorRecordsHedges`, `test_RevertWhen_HedgeExceedsLiability`, `invariant_HedgeBoundedByLiability` |

Invariant campaign: 256 runs × 32 random calls across deposit, withdraw, buyCover, hedge, settle, claim and sweep, with an `afterInvariant` check that every run which tried to sell covers actually sold some (no vacuous passes).

## 3. CeFi / DeFi reconciliation

Winning hedges pay out at Gemini in USD; the merchant is paid immediately from Arc USDC.

1. Settlement (`voteResult` → instant or `finalize`) moves winners' payouts into `pendingClaims` and books the winning hedge as `hedgeReceivable`.
2. NAV = `USDC + hedgeReceivable − pendingClaims`, so share price doesn't dip while money is in transit.
3. LP deposits and withdrawals pause until `returnHedgeProceeds` sweeps the money back. In production that sweep is Circle Mint → USDC on Arc (or CCTP from another chain).

Idle capital (roadmap): Arc supports Circle's tokenized Treasury fund USYC natively; free vault USDC could sit in USYC between games.

## 4. Regulatory context (Nov 2026)

- **CFTC proposed rule, June 10, 2026** ("Prediction Markets; Public Interest Determinations", amending Rule 40.11). Its multi-factor public-interest test explicitly weighs whether an event contract provides hedging or price-basing utility. Arra is a concrete example of that utility.
- **Federal–state fight.** On November 13, 2026 the CFTC sued Louisiana, its twelfth state lawsuit, arguing federal law preempts state bans on CFTC-regulated event contracts. Real commercial hedging is the strongest factual answer to "this is just gambling."

The MVP is a testnet prototype. A production version would distribute cover through a licensed insurer or MGA, with Gemini (a CFTC-regulated venue) as the hedge counterparty.

## 5. References

Verified (opened or confirmed):

- Wolfers, J., & Zitzewitz, E. (2004). Prediction Markets. *Journal of Economic Perspectives*, 18(2), 107–126. https://doi.org/10.1257/0895330041371321
- Bürgi, C., & Deng, W. (2026). Kalshi prices and the favorite–longshot bias. GWU Research Program on Forecasting working paper 2026-001. https://www2.gwu.edu/~forcpgm/2026-001.pdf
- Goffard, P.-O., & Loisel, S. (2025). Collaborative and parametric insurance on the Ethereum blockchain. *ASTIN Bulletin* (online Nov 2025); arXiv:2412.05321. A pool of "surplus providers" underwrites parametric policies in a Solidity contract, with solvency-capital calculations; the same three roles as our vault.
- CFTC (2026, Nov 13). CFTC Sues Louisiana After State Court Blocks CFTC-Regulated Exchanges. Release 9326-26. https://www.cftc.gov/PressRoom/PressReleases/9326-26
- Greenberg Traurig (2026, June). CFTC Proposes New Rules for Events Contracts on Prediction Markets. https://www.gtlaw.com/en/insights/2026/6/cftc-proposes-new-rules-for-events-contracts-on-prediction-markets

Widely cited, check the exact claim before quoting on stage:

- Arrow, K. J., et al. (2008). The Promise of Prediction Markets. *Science*, 320, 877–878. https://doi.org/10.1126/science.1157679
- Zhang, F., et al. (2020). DECO: Liberating Web Data Using Decentralized Oracles for TLS. *ACM CCS*. https://doi.org/10.1145/3372297.3417239 (basis for the zkTLS oracle roadmap)
- Cousaert, S., Vadgama, N., & Xu, J. (2022). Token-based Insurance Solutions on Blockchain. In *Blockchains and the Token Economy*. https://doi.org/10.1007/978-3-030-95108-5_9
