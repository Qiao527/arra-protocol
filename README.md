# Arra

**Promises, pre-paid.** Arra turns a merchant's game-day promise ("if our team wins, it's on us") into a verifiable, fully collateralized USDC contract on Arc. Cover is priced from Gemini Prediction Markets order-book depth, hedged on Gemini, and paid out automatically when the result settles.

> *Arra* comes from the Roman *arrha*: earnest money paid up front to make a promise binding.

A bar promises: *"If the underdog wins, everyone's tab is free, up to $5,000."* It pays about $737 for cover. A QR code on the table lets any customer check that the $5,000 is locked onchain. If the upset happens, the $5,000 lands in the bar's wallet within seconds. If not, the bar paid for a banner that packed the room.

Track: **DeFi & Onchain Applications** · Chain award: **Best use of Arc** · Bounty: **Gemini Prediction Markets**

| | |
| --- | --- |
| Network | Arc Testnet (chain ID 5042002) |
| `ArraVault` | [`0x9A60F13454E641c8d7a745675DDDa022C322235B`](https://explorer.testnet.arc.io/address/0x9A60F13454E641c8d7a745675DDDa022C322235B) (source verified) |
| LP share token | `Arra LP` (`arLP`), ERC-4626 |
| Settlement | 2-of-3 settlers, 60 s dispute window, unanimous vote settles instantly |
| Live smoke test | deposit → signed quote → buyCover → recordHedge → 3/3 votes → claim. Tx hashes in [`deployments/arc-testnet.json`](deployments/arc-testnet.json) |
| USDC (ERC-20 interface) | `0x3600000000000000000000000000000000000000` |
| Explorer | https://explorer.testnet.arc.io |

---

## Why this exists

- **The demand is real.** Houston's "Mattress Mack" has hedged "refund if the Astros win" promotions for years: traditional promo insurance at 10–20% of the refund amount, sportsbook bets, and in 2026 a Kalshi position. Small merchants can't buy any of that. Prize-indemnity insurance is broker-led and slow.
- **The price signal is here.** Sports dominate event-contract volume. Prediction markets have the price and the depth, but no product turns them into cover a merchant can buy in one click.
- **What Arra adds:** an onchain USDC pool that underwrites the cover, prices it from Gemini order-book depth, nets mutually exclusive outcomes, hedges the excess on Gemini, and pays winners without a claims process.

## How it works

```
 Liquidity providers ─1 deposit USDC─▶ ┌────────────────────────┐ ◀─2 signed quote── Pricer ◀── Gemini order book
                                       │    ArraVault (Arc)     │
 Merchant ─────────3 premium─────────▶ │  USDC · netting · caps │ ─hedge excess─▶ Hedger ──▶ Gemini order
          ◀────────6 payout──────────── │  solvency · quorum     │ ◀─4 CoverPurchased (QuickNode Stream)
                                       └────────────────────────┘ ◀─5 votes + evidence── Settlers ◀── Gemini result
```

1. **LPs deposit USDC** into the ERC-4626 vault and receive `arLP` shares.
2. **Pricer** walks Gemini's order book for the full payout size and signs a 60-second EIP-712 quote.
3. **Merchant calls `buyCover(quote, sig)`.** The contract checks signature, expiry, buyer, nonce, sales close, per-event cap and solvency, then takes the premium.
4. **Hedger** receives the `CoverPurchased` log via QuickNode Streams, buys the same outcome on Gemini when unhedged exposure crosses a threshold, and calls `recordHedge` with the Gemini order ID.
5. **Settlers** vote Gemini's result with `voteResult`, attaching `keccak256(raw Gemini settlement payload)` as evidence.
6. **Anyone calls `claim`.** USDC goes straight to the merchant.

## Economic design

```
premium = L·p·(1 + b + k·u²) + r·ΔLocked·(1 − p)
```

| Symbol | Meaning | MVP value |
| --- | --- | --- |
| `L` | payout (the merchant's real cost of honoring the promo) | merchant input |
| `p` | executable price: average price to buy `L` contracts, walking Gemini's book (≥ best ask) | live |
| `b` | hedge buffer | 5% |
| `k`, `u` | convex utilization surcharge; `u` = post-trade worst-case unhedged payout ÷ per-event cap | k = 20% |
| `r` | capital charge, levied only on the collateral this cover **adds** | 2% |
| `ΔLocked` | increase in `max_i L_i` caused by this cover | computed |

**Worked example (local end-to-end run):** $5,000 payout on a 100k vault, book walk gives `p = 0.118`, `u = 0.5`:
hedge cost $590.00 + buffer $29.50 + utilization surcharge $29.50 + capital charge $88.20 = **$737.20 premium (14.7%)**, a 6.8× marketing multiple. Mattress Mack's traditional insurance cost 10–20%.

The pricer **refuses covers on likely outcomes** (`MAX_PROBABILITY`, default 50%). Cover on a coin flip costs nearly as much as the giveaway itself.

### Outcome netting: one payout locked, many promises backed

Every event has up to 16 **mutually exclusive** outcomes (a game: YES/NO; a championship: one per team). Only one can pay, so the vault locks `max_i L_i`, not `Σ L_i`.

| Scenario (local E2E run) | Insured | Locked | A 1:1 wrapper would lock |
| --- | --- | --- | --- |
| Bars in Austin, Columbus, Athens and Boston each insure their own team to win the title, $5k each | $20,000 | **$5,000** | $20,000 |

Merchants share the benefit: because the capital charge applies only to added collateral, the 2nd–4th cities paid **$0** capital charge.

### Convex utilization pricing

As one event fills up, each extra dollar of cover costs more (`k·u²`). The vault defends its own capacity without a human underwriter, and the hard per-event cap still applies on top.

### Settlement: optimistic fast path

- **All settlers agree → settles instantly.** The merchant is paid within seconds of the final whistle.
- **Only the threshold agrees (2 of 3) → dispute window.** The guardian can veto and force a re-vote; anyone finalizes afterwards.

### Risk controls (enforced in `ArraVault.sol`)

| Control | Rule |
| --- | --- |
| Signed quotes | EIP-712, 60-second expiry, bound to buyer, one-time nonce. No stale-price sniping after injury news. |
| Per-event cap | Worst-case unhedged payout `max_i (L_i − H_i)` ≤ 10% of vault assets (`eventCapBps`). Hedges free cap room. |
| Full collateral | Every event's worst case is backed by USDC in the vault (`totalLocked + pendingClaims ≤ balance`). |
| Sales close | Each signed quote carries its own sales close: kickoff for pre-game cover, or minutes ahead for in-game ("halftime comeback") cover. |
| Settlement quorum | Unanimous = instant; threshold = dispute window + guardian veto; votes carry Gemini payload hashes. |
| LP withdrawals | Only capital not backing open covers; frozen while hedge proceeds sit at Gemini. |
| NAV integrity | `totalAssets = USDC + hedgeReceivable − pendingClaims`, so no one enters or exits at a fake discount mid-settlement. |

### Which Gemini markets Arra covers

Only markets whose outcomes are **mutually exclusive**, because netting depends on it: game winners (`sports_market_type=moneyline`) and championship futures (`futures`), plus any single-contract YES/NO market. Player props are refused ("2+ assists" and "4+ assists" can both resolve YES). Outcome `i` is the `i`-th contract sorted by `instrumentSymbol`, so the pricer, hedger, settler and the public verify page all derive the same mapping from the same Gemini event. Contracts must be `marketState: open` (not `post_only`) so the hedge can actually execute. Game markets nest period markets (quarters, halves, each with a tie contract); the pricer lists them too, so live "halftime comeback" cover prices off Gemini's real 2nd-half winner market.

**Pricing without published depth.** Gemini's event endpoints return top of book (`bestBid`, `bestAsk`, `buy.{yes,no}`) but usually no depth. The pricer then models a ladder: each level is one tick worse and holds `TOP_OF_BOOK_DEPTH` contracts (default 1,000), so a $5k cover pays slippage instead of the best ask. **In-game quotes** are allowed only while Gemini keeps the contract open, and live for `IN_GAME_TTL_SEC` (default 20 s).

### Risk assumptions

- **Oracle trust.** Results need a settler quorum and carry a hash of the raw Gemini response; the guardian can veto during the dispute window. Quotes are signed by one operator key (pricing only, not settlement). Roadmap: a zkTLS proof that the payload came from api.gemini.com.
- **Hedge reconciliation.** Winning hedges pay out at Gemini (offchain USD). The vault pays the merchant from onchain USDC first and records a `hedgeReceivable`; production sweeps proceeds back to Arc USDC via Circle Mint / CCTP (`returnHedgeProceeds`) before LP withdrawals unlock.
- **Settlement source.** Arra inherits Gemini's CFTC-regulated settlement, not token voting.
- **Regulation.** Testnet prototype, no real-money cover. Production would distribute through a licensed insurer or MGA, with Gemini as the regulated hedge venue.
- **Void, cancelled or tied events** are not handled in the MVP. A full-game NFL moneyline has no tie contract, so a tie would leave the event unsettled until a guardian void path ships; period markets include an explicit tie contract and are unaffected.

Full math, the favorite–longshot discussion, regulatory context and references: [`docs/ECONOMICS.md`](docs/ECONOMICS.md).

## Repo layout

```
src/ArraVault.sol                   vault, quotes, netting, caps, settlement (Solidity 0.8.26, OpenZeppelin v5.1)
src/mocks/MockUSDC.sol              local testing only
test/ArraVault.t.sol                30 unit + fuzz tests
test/ArraVault.invariant.t.sol      6 invariants over random action sequences
script/Deploy.s.sol                 Arc / local deploy
script/e2e-anvil.sh                 one-command local end-to-end run
offchain/src/pricer.js              HTTP quote server (Gemini depth → EIP-712 signed quote)
offchain/src/hedger.js              QuickNode Streams webhook (or --poll): Gemini hedge + recordHedge
offchain/src/settler.js             votes Gemini results, finalizes, pushes payouts
offchain/quicknode/stream-filter.js QuickNode Streams filter for CoverPurchased on Arc
offchain/scripts/e2e-local.js       full flow: single game + 4-city championship
offchain/scripts/testnet-smoke.js   live run against the Arc deployment
offchain/test/                      Gemini adapter tests + real API fixture
docs/ECONOMICS.md                   pricing math, reconciliation, regulation, references
```

## Run it

**Prereqs:** Foundry, Node 20+. For Arc: a testnet wallet with USDC from https://faucet.circle.com (USDC is also Arc's gas token).

```bash
git clone --recurse-submodules https://github.com/Qiao527/arra-protocol && cd arra-protocol
forge test                                         # 37 contract tests
(cd offchain && npm ci && npm test)                # 13 Gemini adapter tests (real API fixtures)
./script/e2e-anvil.sh                              # full local flow, no keys needed
```

Deploy to Arc testnet:

```bash
export ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
OPERATOR_ADDRESS=0xOperator SETTLERS=0xS1,0xS2,0xS3 DISPUTE_WINDOW_SEC=60 \
  forge script script/Deploy.s.sol --rpc-url $ARC_TESTNET_RPC_URL --broadcast --private-key $PRIVATE_KEY
```

Offchain services:

```bash
cd offchain && cp .env.example .env   # VAULT_ADDRESS, OPERATOR_PRIVATE_KEY, SETTLER_PRIVATE_KEYS, Gemini sandbox keys
npm run pricer      # http://localhost:8787  (GET /events, POST /quote)
npm run hedger      # webhook on :8788/quicknode (add -- --poll to poll instead)
npm run settler     # watch mode; demo: npm run settle -- <EVENT-TICKER> <outcome index | YES | NO>
```

## QuickNode Streams (real-time hedging)

| Setting | Value |
| --- | --- |
| Network | Arc Testnet (5042002) |
| Dataset | Logs |
| Filter | [`offchain/quicknode/stream-filter.js`](offchain/quicknode/stream-filter.js): keeps only `ArraVault` `CoverPurchased` logs (topic0 `0x55605d8a…ffe8`) |
| Destination | Webhook → `POST https://<hedger-host>/quicknode` (optional header `x-arra-secret`) |

The hedger decodes each log, checks unhedged exposure on that outcome, places a Gemini order if it crosses the threshold, and calls `recordHedge` with the Gemini order ID.

## Tests

```
forge test
  ArraVault.t.sol             30 passed  (quotes, netting, championship, caps, solvency, quorum, fast path, veto, in-game sales, LP locks, fuzz)
  ArraVault.invariant.t.sol    6 passed  (256 runs × 32 calls: full collateral, cap at sale, locked == max_i L_i, LP locks, hedge bounds)
npm test (offchain)            13 passed (real Gemini responses: shape, empty books, settled resolutionSide; props refused; canonical outcome order)
./script/e2e-anvil.sh          E2E OK    (single game via 2-of-3 + dispute window; 4-city championship via 3-of-3 instant)
```

## What's next

1. Fan protection ("lose the game, get half your ticket back") sold through ticketing apps.
2. Sponsorship bonus hedges ("playoff appearance" clauses).
3. Weather and economics markets for outdoor businesses and borrowers.
4. Idle vault USDC parked in USYC, Circle's tokenized Treasury fund.
5. Circle Wallets so merchants sign in with email and never see a seed phrase.

## License

MIT
