# Arra

**Promises, pre-paid.** Arra turns a merchant's game-day promise ("if our team wins, it's on us") into a verifiable, fully collateralized USDC contract on Arc. Cover is priced from Gemini Prediction Markets order-book depth, hedged on Gemini, and paid out automatically when the result settles.

> *Arra* comes from the Roman *arrha*: earnest money paid up front to make a promise binding.

A bar promises: *"If the underdog wins, everyone's tab is free, up to $5,000."* It pays about $737 for cover. A QR code on the table lets any customer check that the $5,000 is locked onchain. If the upset happens, the $5,000 lands in the bar's wallet within seconds. If not, the bar paid for a banner that packed the room.

Track: **DeFi & Onchain Applications** · Chain award: **Best use of Arc** · Bounty: **Gemini Prediction Markets**

| | |
| --- | --- |
| Network | Arc Testnet (chain ID 5042002) |
| `ArraVault` | [`0x1D69e0fE014df1007aE66A68a5c9714a7E833d6f`](https://explorer.testnet.arc.io/address/0x1D69e0fE014df1007aE66A68a5c9714a7E833d6f) (source verified). Replaces `0x3CC3…831C` and `0x8fA6…e334` after the [review](docs/REVIEW.md). |
| LP share token | `Arra LP` (`arLP`), ERC-4626 |
| Settlement | 2-of-3 settlers, 60 s dispute window, unanimous vote settles instantly |
| Live smoke test | deposit → signed quote → buyCover → recordHedge → 3/3 votes → claim. Tx hashes in [`deployments/arc-testnet.json`](deployments/arc-testnet.json) |
| Real Gemini hedge | Gemini sandbox order `145853902323013843`, 5/5 filled, recorded onchain with that id ([details](#gemini-sandbox-hedge-on-arc-testnet)) |
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

Every event has up to 128 **mutually exclusive** outcomes (a game: one per team; a championship: one per team, e.g. 30 for the NBA title, 94 for college basketball). Only one can pay, so the vault locks `max_i L_i`, not `Σ L_i`. Both `max_i L_i` and the worst unhedged payout are tracked incrementally, so `buyCover` costs the same gas whether an event has 2 outcomes or 128.

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
| NAV integrity | `totalAssets = USDC + hedgeReceivable − pendingClaims − proposedLoss`. Once a result is proposed, its net loss is already in the share price, so nobody can exit at the old price during the dispute window. |
| Void / tie | Settlers can vote `VOID_OUTCOME` (255), or the guardian calls `voidEvent`. Collateral is released and every holder claims their exact premium back. Collateral per event is `max(max_i L_i, Σ premiums)`, so refunds are always backed. |

### Which Gemini markets Arra covers

Only markets whose outcomes are **mutually exclusive**, because netting depends on it: game and period winners (`sports_market_type=moneyline`), championships (Gemini tags these `eventTags: futures` with a single-winner title such as "Pro Basketball Champion"), and any single-contract YES/NO market. Player props are refused ("2+ assists" and "4+ assists" can both resolve YES). Outcome `i` is the `i`-th contract sorted by `instrumentSymbol`, so the pricer, hedger, settler and the public verify page all derive the same mapping from the same Gemini event. Contracts must be `marketState: open` (not `post_only`) so the hedge can actually execute. Game markets nest period markets (quarters, halves, each with a tie contract); the pricer lists them too, so live "halftime comeback" cover prices off Gemini's real 2nd-half winner market.

**Real order-book depth.** Gemini's REST endpoints carry only top of book, so the pricer and hedger stream depth from `wss://ws.gemini.com?snapshot=-1` (`{instrumentSymbol}@depth`, see [`offchain/src/depth.js`](offchain/src/depth.js)). The quote walks that book while the stream is alive and reports `bookSource: "ws-depth"`. If the stream is down it falls back to a modeled ladder (`top-of-book+slippage`). Real books are thin: on Nov 19 the Boston NBA-title YES book held 526 contracts of asks where the old ladder assumed 10,000, so a cover the book can't fill is now refused instead of underpriced. Only `bestAsk`/`bestBid` count as executable. `buy`/`sell` are display prices that fall back to the other side of the book.

**In-game quotes** live for `IN_GAME_TTL_SEC` (20 s) and are sold only within a per-sport limit after the scheduled start (basketball 2 h, football 3 h). Gemini leaves finished games `open` with `isLive: true` until it settles them, once for 103 hours in our live data, so the market state can't be trusted to close sales.

### Risk assumptions

- **Oracle trust.** Results need a settler quorum and carry a hash of the raw Gemini response; the guardian can veto during the dispute window. Quotes are signed by one operator key (pricing only, not settlement). Roadmap: a zkTLS proof that the payload came from api.gemini.com.
- **Hedge reconciliation.** Winning hedges pay out at Gemini (offchain USD). The vault pays the merchant from onchain USDC first and records a `hedgeReceivable`; production sweeps proceeds back to Arc USDC via Circle Mint / CCTP (`returnHedgeProceeds`) before LP withdrawals unlock.
- **Settlement source.** Arra inherits Gemini's CFTC-regulated settlement, not token voting.
- **Regulation.** Testnet prototype, no real-money cover. Production would distribute through a licensed insurer or MGA, with Gemini as the regulated hedge venue.
- **Void, cancelled or tied events.** A full-game NFL moneyline has no tie contract. If every contract resolves NO, the settler votes VOID and holders get their premiums back. More than one YES is contradictory, so the settler doesn't vote and a human has to look.
- **Who can do what.** The trust table for owner, operator and settlers is in [`docs/SECURITY.md`](docs/SECURITY.md).

Full math, the favorite–longshot discussion, regulatory context and references: [`docs/ECONOMICS.md`](docs/ECONOMICS.md).

## Repo layout

```
src/ArraVault.sol                   vault, quotes, netting, caps, settlement (Solidity 0.8.26, OpenZeppelin v5.1)
src/mocks/MockUSDC.sol              local testing only
test/ArraVault.t.sol                48 unit + fuzz tests
test/ArraVault.invariant.t.sol      8 invariants over random action sequences
script/Deploy.s.sol                 Arc / local deploy
script/e2e-anvil.sh                 one-command local end-to-end run (mock Gemini)
script/e2e-live-gemini.sh           same flow on REAL Gemini markets and live depth (no keys)
offchain/src/pricer.js              HTTP quote server (Gemini depth → EIP-712 signed quote)
offchain/src/hedger.js              QuickNode Streams webhook (or --poll): Gemini hedge + recordHedge
offchain/src/settler.js             votes Gemini results (or VOID), stores the attested bytes, finalizes, pays
offchain/src/depth.js               live order books from Gemini's WebSocket depth stream
offchain/src/verify.js              evidence check: bytes -> onchain evidenceHash -> winning outcome
offchain/scripts/verify-settlement.js  public verifier, no keys: node scripts/verify-settlement.js <eventTicker>
offchain/scripts/testnet-hedge.js   Arc testnet run with a real Gemini sandbox hedge
offchain/src/keeper.js              pricer + settler (+ hedger) in one service; /keeper health, /evidence
offchain/src/store.js               durable registry + evidence on the keeper-data branch (GitHub contents API)
offchain/scripts/buy-promise.js     buy one promise through the live pricer from a demo bar wallet
offchain/scripts/seed-championship.js  demo data: 4 bars x $5 on the NBA title market via the live pricer ($20 insured, $5 locked)
offchain/evidence/                  Gemini bytes the settlers attested, one file per evidenceHash
offchain/Dockerfile, render.yaml    hosted pricer API
offchain/quicknode/stream-filter.js QuickNode Streams filter for CoverPurchased on Arc
offchain/scripts/e2e-local.js       full flow: single game + 4-city championship
offchain/scripts/testnet-smoke.js   live run against the Arc deployment
offchain/test/                      adapter, depth, sandbox, verifier and API tests on real captures
docs/ECONOMICS.md                   pricing math, reconciliation, regulation, references
docs/SECURITY.md                    roles, trust assumptions, threat model
docs/REVIEW.md                      independent review: findings, evidence, fixes
docs/DEMO.md                        live demo script, what's real vs testnet, pre-demo checklist
```

## Run it

**Prereqs:** Foundry, Node 20+. For Arc: a testnet wallet with USDC from https://faucet.circle.com (USDC is also Arc's gas token).

```bash
git clone --recurse-submodules https://github.com/Qiao527/arra-protocol && cd arra-protocol
forge test                                         # 50 contract tests (incl. 8 invariants)
(cd offchain && npm ci && npm test)                # 89 offchain tests on real Gemini captures
./script/e2e-anvil.sh                              # full local flow, no keys needed
./script/e2e-live-gemini.sh                        # same, on live Gemini markets (needs network)
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

## Frontend

`frontend/` (Vite + React + viem). Three pages, all reading the vault live from Arc:

- **Make a promise**: pick a Gemini game (or championship), pick the long shot, set the payout, get a signed quote from the pricer, seal it with one wallet transaction, and get a QR code. "Halftime comeback" switches to Gemini's real 2nd-half winner market for live in-game cover.
- **Proof of promise** (`#/p/<id>`): what a customer sees after scanning the QR. Checks that the policy exists, that `keccak256(ticker)` matches its event, that the payout is locked, that the vault is solvent, the Gemini hedge order IDs (from onchain `HedgeRecorded` logs), and the settlement evidence. No server of ours is involved.
- **Risk desk**: NAV, utilization, per-game outcome bars (owed vs hedged), netting ratio, the hedge log with Gemini order IDs, and LP deposit/withdraw.

Without a pricer URL the app browses a captured Gemini snapshot and shows indicative premiums (same formula); sealing needs the live pricer. Contract reads are batched through Multicall3 (Arc's public RPC rate-limits), and history comes from the Blockscout API (Arc's RPC caps `eth_getLogs` ranges).

```bash
cd frontend && npm ci
VITE_PRICER_URL=https://<pricer-host> npm run dev     # or npm run build -> dist/
```
Deployed by `.github/workflows/pages.yml` to GitHub Pages; set the repo variable `PRICER_URL` to bake in the live pricer.

## QuickNode Streams (real-time hedging)

| Setting | Value |
| --- | --- |
| Network | Arc Testnet (5042002) |
| Dataset | Logs |
| Filter | [`offchain/quicknode/stream-filter.js`](offchain/quicknode/stream-filter.js): keeps only `ArraVault` `CoverPurchased` logs (topic0 `0x55605d8a…ffe8`) |
| Destination | Webhook → `POST https://<hedger-host>/quicknode` with header `x-arra-secret: $QUICKNODE_WEBHOOK_SECRET` (required: without it the hedger answers 503) |

The hedger decodes each log, checks unhedged exposure on that outcome, places a Gemini order if it crosses the threshold, and calls `recordHedge` with the quantity Gemini actually filled and the Gemini order ID. Redelivered logs are ignored and hedges for one event never run in parallel, so a retry can't place a second order.

## Gemini sandbox hedge on Arc testnet

`offchain/scripts/testnet-hedge.js` runs the whole loop against the deployed vault with a real Gemini order. The sandbox has different markets than production (on Nov 19 it had only crypto and commodity hourlies, no sports), so the hedge goes to a sandbox stand-in contract set by `SANDBOX_SYMBOL_MAP`. The game hadn't been played, so the result is synthetic, and the evidence file says so.

| Step | Value |
| --- | --- |
| Cover | $5 on Philadelphia, `NHL-2611200000-PHI-OTT-M`, premium $2.41, p = 0.38 off live WebSocket depth |
| Gemini order | sandbox `145853902323013843` on stand-in `GEMI-BTC2611192200-HI62250`, IOC, 5/5 filled at 0.59 |
| buyCover | [`0x4dfa42e8…fdb3`](https://explorer.testnet.arc.io/tx/0x4dfa42e816ba46f33e00b464e1bd07737ec30521c757f55b0a317e130d2cfdb3) |
| recordHedge (5 USDC, order id onchain) | [`0xe64f99ff…e0ad`](https://explorer.testnet.arc.io/tx/0xe64f99ff2f61b1addbb9434f5141ffc7c5781d503ce3b635866b6fa63a16e0ad) |
| votes 1–3 (instant settle) | [`0xddfccab5…69c1`](https://explorer.testnet.arc.io/tx/0xddfccab51b413528bbdaf3cb1a61cd59d73d1d27b980363b36b45fdc65b669c1), [`0xb7b6b2b4…7031`](https://explorer.testnet.arc.io/tx/0xb7b6b2b40ea39e44b7f5efb69f800a957321e9ddd1665310334903d186817031), [`0x6b707c77…c373`](https://explorer.testnet.arc.io/tx/0x6b707c777ef41ef900a968efd0148720884532c024536be365e94125120bc373) |
| claim (5 USDC to the merchant) | [`0xe110746b…210a`](https://explorer.testnet.arc.io/tx/0xe110746baf39698f9b27627df15d57c7e8718a959610a7fe85558b25d362210a) |
| sweep hedge proceeds | [`0x542a707b…ac0c`](https://explorer.testnet.arc.io/tx/0x542a707b47affc604d2e02b921f54588d3dabf9d3835dddddbd22b959376ac0c) |

Three things only showed up once real orders went through: the request nonce must be a number of seconds, `orderId` is a JSON number above 2^53 that `JSON.parse` silently rounds, and the fill is reported in `filledQuantity`. The captured responses are in [`offchain/test/fixtures/gemini-sandbox-orders.json`](offchain/test/fixtures/gemini-sandbox-orders.json).

## Keeper: settles on its own

The Render service runs [`offchain/src/keeper.js`](offchain/src/keeper.js): the pricer API plus the settler loop in one process. Every minute it checks each event the vault sold cover on. When Gemini settles a market, the keeper votes the result with the hash of Gemini's exact response bytes and pays the winners, with nobody at a terminal. (Gemini can take a while to settle a finished game.) Running in one process also means the outcome order pinned at an event's first sale is shared by the pricer and the settler.

- Health: [`/keeper`](https://arra-pricer.onrender.com/keeper) shows when each loop last ran, the events it tracks, its recent actions and the last error. It never shows keys.
- Durability: Render wipes the disk on every restart, so the registry and the evidence bytes are written to the `keeper-data` branch through a GitHub token limited to this repo's contents. On startup the keeper restores the registry and recovers any missing events from onchain `CoverPurchased` logs.
- Public evidence: `/evidence/<ticker>/<evidenceHash>.json` serves the attested bytes, and only if they hash to the requested name. `verify-settlement.js` falls back to it when there's no local copy.
- A GitHub Actions job pings it every 10 minutes so the free instance doesn't sleep.
- The hedger joins the same loop when Gemini API keys are configured. It isn't on Render now: the demo's $5 promises sit under the $2,000 retention threshold, and the real sandbox hedge path is shown above.

A real promise is waiting for the keeper: $5 on Indianapolis in `NFL-2611200115-IND-HOU-M` (Nov 19, 8:15 PM ET), policy #8, bought through the live pricer ([`0x9f8f7639…9b6932`](https://explorer.testnet.arc.io/tx/0x9f8f7639563a24399283d913c133b549a6bfcc1248a517c8b87dd9cb509b6932)). When Gemini settles the game, the keeper settles it from the real result, and `node scripts/verify-settlement.js NFL-2611200115-IND-HOU-M` passes the live check too.

## Verify a settlement

Anyone can check what the settlers attested, without keys:

```bash
cd offchain && node scripts/verify-settlement.js NHL-2611200000-PHI-OTT-M --offline
```

It reads the onchain `evidenceHash` and winning outcome, hashes the bytes stored in `offchain/evidence/` when the vote was cast, and recomputes the winner from them in canonical order. Without `--offline` it also re-fetches Gemini and requires Gemini's live result to agree. A re-fetch almost never hashes to the attested value, because prices, volume and timestamps change, which is why the exact bytes are stored at vote time. Run on the testnet settlement above, the offline check passes and the live check fails, since Gemini hasn't settled a game that hasn't been played. That's the result it should give.

## Hosted pricer API

Live at **https://arra-pricer.onrender.com** (Render free plan: the first request after 15 idle minutes takes ~30–60 s while it wakes). `GET /health`, `GET /events`, `POST /quote`. Deploy with [`render.yaml`](render.yaml) (or `offchain/Dockerfile` anywhere). The operator key and allowed frontend origins are host secrets (`OPERATOR_PRIVATE_KEY`, `ALLOWED_ORIGINS`), never in the repo or image. CORS only allows the configured origins, each client IP gets 60 requests a minute, `/quote` rejects malformed input before it touches Gemini or the RPC, bodies over 10 kB are refused, and upstream failures return 502 without internals. The services read the vault ABI from `offchain/abi/ArraVault.json` when there is no Foundry build. CI checks it matches `forge build` (`npm run abi` refreshes it).

## Tests

```
forge test
  ArraVault.t.sol             48 passed  (quotes, netting, 128-team championships, O(1) gas, caps, solvency, quorum, fast path, veto, void, settler changes, NAV during disputes, inflation attack, LP locks, fuzz)
  ArraVault.invariant.t.sol    8 passed  (256 runs × 32 calls incl. propose / veto / void: full collateral, cap at sale, locked == worst case incl. void, proposedLoss == rescan, LP locks, hedge bounds)
npm test (offchain)            59 passed (real Gemini captures: REST events, stale in-game markets, WebSocket depth, sandbox orders; settler, hedger webhook, verifier, API)
./script/e2e-anvil.sh          E2E OK    (single game via 2-of-3 + dispute window; 4-city championship via 3-of-3 instant; verifier PASS)
./script/e2e-live-gemini.sh    E2E LIVE OK (real moneyline + championship off live depth; settles a team past index 16; verifier PASS)
```

## What's next

1. Fan protection ("lose the game, get half your ticket back") sold through ticketing apps.
2. Sponsorship bonus hedges ("playoff appearance" clauses).
3. Weather and economics markets for outdoor businesses and borrowers.
4. Idle vault USDC parked in USYC, Circle's tokenized Treasury fund.
5. Circle Wallets so merchants sign in with email and never see a seed phrase.

## License

MIT
