# Independent review and hardening

Review of `fe4ed3b` ("Support real championships") on branch `review/hardening`, Nov 19, 2026. Scope: `src/ArraVault.sol`, `offchain/src/`, and the Gemini integration against the live production API, the live WebSocket feed and the Gemini sandbox. Line numbers below refer to `fe4ed3b` unless they say otherwise.

Method: map trust boundaries, build a coverage list (every vault state transition, every offchain trust input), write a failing test or a live reproduction for each candidate, fix it, re-run. A second, independent pass then re-checked every finding against `fe4ed3b` with its own PoCs and attacked the fixes. It confirmed all findings, corrected two severities, and found six new issues in the fixes. Those are fixed below as N-1 to N-8.

## Baseline

All three suites passed before any change, so there is no "finding #1".

```
$ forge test
Ran 3 test suites: 35 tests passed, 0 failed          # the brief says 41; the suite had 35
$ cd offchain && npm ci && npm test
ℹ tests 16  ℹ pass 16  ℹ fail 0
$ ./script/e2e-anvil.sh
... S3. Austin bar received 5,000 USDC (game) | vault NAV 99,766.02 | hedge receivable 6,000
E2E OK
```

After the work:

```
$ forge test                 50 passed (48 unit/fuzz + invariant suite with 8 invariants, 256 runs x 32 calls)
$ cd offchain && npm test    67 passed
$ ./script/e2e-anvil.sh      E2E OK (now also checks the settlement with the verifier)
$ ./script/e2e-live-gemini.sh  E2E LIVE OK (real markets and live depth; settles a championship team past index 16, e.g. 21 of 94, 26 of 30)
$ forge coverage             src/ArraVault.sol lines 87.1% -> 89.8%, branches 63.9% -> 69.4%
```

## Findings

| ID | Severity | Title | Status |
| --- | --- | --- | --- |
| H-1 | High | LPs exit at the pre-loss price during the dispute window | Fixed |
| H-2 | High | Settler can't settle a championship won by any team past the 16th | Fixed |
| H-3 | High | In-game cover sold on finished games, priced off display prices | Fixed |
| Z-1 | Medium | `ArraResultProofs` accepts claims that don't prove the winner | Fixed: redeployed at `0xFBdd…FB72` with an exact parameter check and an owner `clear`; proof page also checks |
| M-1 | Medium | One short hedge sweep freezes every LP until someone pays the gap | Fixed |
| M-2 | Medium | Hedger records the requested quantity, not the fill | Fixed |
| M-3 | Medium | Hedger webhook: optional auth, no dedupe, concurrent duplicate orders | Fixed |
| M-4 | Medium | No void path; first YES wins when Gemini reports several | Fixed |
| M-5 | Medium | Modeled depth overstates real Gemini liquidity about 10x | Fixed (real WebSocket depth) |
| M-6 | Medium | Gemini trading client could never place an order; order ids corrupted | Fixed |
| M-7 | Medium | Outcome indexes shift if Gemini lists a new contract after sales | Fixed |
| M-8 | Medium | Removed settler's vote still counts, and can complete the unanimous fast path | Fixed |
| N-1 | Medium | `voidEvent` (new) could override a result after its dispute window | Fixed before redeploy |
| N-2 | Medium | Deposits during a booked loss (new) win if the proposal is vetoed | Fixed before redeploy |
| L-1 | Low | Premium rounded to the nearest cent before rounding up | Fixed |
| L-2 | Low | Evidence hash over decoded text, not the response bytes | Fixed |
| L-3 | Low | `maxRedeem` leaves rounding dust | Fixed |
| L-4 | Low | Dispute window change applies to results already proposed | Not fixed (owner power, documented) |
| L-5 | Low | Pricer API: open CORS, no rate limit, no input validation | Fixed |
| N-3 | Low | Depth: in-flight deltas after a gap became a partial book | Fixed |
| N-4 | Low | Verifier didn't check the bytes were for this event | Fixed |
| N-5 | Low | Pricer's collateral mirror ignored premiums | Fixed |
| N-6 | Low | Automatic VOID with all keys in one process skipped the veto window | Fixed |
| N-7 | Low | Depth freshness is per socket, not per symbol | Fixed for in-game quotes |
| I-1..I-6 | Info | Slither triage, inflation attack check, residual risks, live API facts | See below |

---

### H-1 LPs exit at the pre-loss price during the dispute window

`src/ArraVault.sol:443-446` (`totalAssets`), `:335-341` (proposal). NAV ignored a Proposed result's loss until `finalize`. The result is public for the whole dispute window, so an LP who exits in that window takes their pre-loss share and leaves their part of the loss to everyone else.

Scenario: two LPs with 50,000 each, a 5,000 cover sold for a 500 premium (assets 100,500). Two settlers propose the covered outcome. LP2 redeems everything. After `finalize`, LP1 holds 45,250 and LP2 walked away with 50,250. The fair split is 47,750 each.

```
$ forge test --match-test test_Review_ProposedLossIsInNav_NoExitAtStalePrice     # against fe4ed3b
[FAIL: assertion failed: 50249999999 !~= 47750000000 (max delta: 10, real delta: 2499999999)]
```

Fix: `proposedLoss`, the net loss (`L_w − H_w`, or every premium for a void) of each Proposed result, is subtracted in `totalAssets`. It is added at proposal and removed at veto, finalize, the unanimous fast path from Proposed, and void. Invariant `invariant_ProposedLossMatchesRescan` checks it against a rescan. Tests: `test_Review_ProposedLossIsInNav_NoExitAtStalePrice`, `test_Review_VetoRestoresNav`, `test_Review_ProposedLossNetOfHedge`.

Residual (I-4): between Gemini publishing a result and the first settler vote, an LP who watches Gemini can still exit at the old price. Closing that needs a withdrawal queue with a delay longer than settlement latency. Not implemented.

### H-2 Settler can't settle a championship won by any team past the 16th

`offchain/src/settler.js:57`: `if (... outcome > 15) throw new Error("bad outcome")`. The vault and pricer accept indexes up to 127. In the 30-team NBA market, indexes 16-29 (14 teams) were unsettleable. `watch()` caught the error and retried every 30 s forever, so the collateral stayed locked and the merchant was never paid.

```
$ node -e '... await vote("NCAAM-2627CHAMP", 57, "evidence")'
vote(…, 57): bad outcome
vote(…, 15): HTTP request failed.          # 15 gets as far as the RPC
```

Fix: `checkVoteOutcome` accepts `0..127` and `VOID_OUTCOME`. Test: `H-2: settler can vote any real championship index`. Live proof: `./script/e2e-live-gemini.sh` prefers a team past index 15 and settled Illinois (21 of 94, NCAAM) and San Antonio (26 of 30, NBA) end to end on different runs.

### H-3 In-game cover sold on finished games, priced off display prices

`offchain/src/pricer.js:31-37`, `offchain/src/gemini.js:151-152`. Two problems that compound.

1. In-game sales had no upper bound. They stayed open as long as Gemini listed the contract `open`, and Gemini keeps finished games open, with `isLive: true`, until it settles them.
2. With no `bestAsk`, the book fell back to `prices.buy.yes`. On the live API that field falls back to the bid when nobody is selling. `1 − buy.no` likewise turned an ask into a "bid".

Live evidence (captured to `offchain/test/fixtures/gemini-events-stale-ingame.json`):

```
NCAAM-2611150000-ULL-UNCW-M isLive: true now-start(h): 103.5
  salesWindow: {"mode":"in-game",...}
NCAAM-2611190300-HAW-WSU-M isLive: true now-start(h): 4.5
    WSU bestAsk (none) buy.yes 0.47 -> modeled avg 0.490 filled 5000 QUOTABLE
```

So the pricer would have signed a $5,000 "in-game" cover on WSU, priced at 0.49 against an ask that didn't exist, on a game that had already ended. Anyone who knew the final score could buy the winner, and the hedger had nothing to buy.

Fix: in-game cover is sold only within a per-sport limit after the scheduled start (basketball and soccer 1.5 h, hockey 2 h, football and baseball 2.5 h; `IN_GAME_MAX_SEC` overrides). Books are built only from `bestAsk`/`bestBid`. Tests: `H-3: no in-game cover once the game is surely over…`, `H-3: buy/sell are display prices…`, `H-3 residual: in-game windows end well inside a regulation game`.

Residual: inside the window, a game that ends early (blowout, mercy rule) could still be quoted if its book was stale. `MAX_PROBABILITY` (0.5) blocks the winner's normal ~0.99 price. Closed on Nov 19: an in-game quote now also needs a live depth book that a delta moved within the last 180 s (`IN_GAME_BOOK_MAX_AGE_MS`); a snapshot alone doesn't count, and the modeled REST fallback is refused in-game (`test/ingame-book.test.js`). Measured on the live IND-HOU game: the two sides updated 15 and 8 times in 2 minutes, with a longest gap of 73 s, so 60 s would have closed normal live sales.

### M-1 One short hedge sweep froze every LP

`src/ArraVault.sol:394-399`, `:450-467`. `maxWithdraw`/`maxDeposit` return 0 while `hedgeReceivable > 0`, and only `returnHedgeProceeds` lowered it. If proceeds came back short (partial fill, see M-2, or a venue loss), LPs stayed frozen until someone paid the gap out of pocket. The verification pass rated this lower than the first draft did ("frozen until someone pays", not "forever"). Fix: `writeOffHedgeReceivable(amount)`, owner only, capped at the receivable. NAV drops by the amount and no USDC moves. Test: `test_Review_GuardianWritesOffUnrecoverableHedge`.

### M-2 Hedger records the requested quantity, not the fill

`offchain/src/hedger.js:41-51` called `recordHedge` with the IOC's requested size. An IOC can fill partly or not at all. The vault then over-states its hedge, lifts the event cap by hedges that don't exist, and books a `hedgeReceivable` that will never arrive (see M-1). Fix: `filledContracts(order)` reads `filledQuantity`, the field confirmed on the real sandbox response, capped at the request. Nothing is recorded when nothing filled or the shape is unknown. Tests use both real responses: a 5/5 fill and a `cancelled` 0/5 (`offchain/test/fixtures/gemini-sandbox-orders.json`).

### M-3 Hedger webhook: optional auth, no dedupe, concurrent duplicate orders

`offchain/src/hedger.js:59-79`. The shared secret was optional (unset meant anyone could post), compared with `!==`, and every delivery ran `hedgeIfNeeded` immediately. Two deliveries close together, or one attacker sending many requests, all read the same onchain books before the first `recordHedge` landed. Each placed its own Gemini order, and the later `recordHedge` calls reverted with `HedgeExceedsLiability` after money had already been spent at Gemini. Fix: the webhook returns 503 without `QUICKNODE_WEBHOOK_SECRET` and compares in constant time. It drops redelivered logs (`txHash:logIndex`) and runs one event's hedges one at a time (`serializeByKey`). Tests: three `M-3` tests in `offchain/test/review.test.js`.

Not covered: two hedger processes at once (webhook plus `--poll`). Run one.

### M-4 No void path; first YES wins when Gemini reports several

`offchain/src/settler.js:24-31`, `src/ArraVault.sol`. A full-game NFL moneyline has no tie contract. On a tie every contract resolves NO, `settledOutcome` returned null forever, and the vault had no way to refund. Settlers could still manually vote an unsold index to release collateral, as the verification pass pointed out, but merchants could never get their premiums back. Several YES results were also settled on the first one.

Fix (Part B item 2): `VOID_OUTCOME = 255`. Settlers can vote it, or the guardian calls `voidEvent` on an Open event, or on a Proposed one inside its dispute window (N-1). Collateral is released and each holder claims their exact premium (`PremiumRefunded`). Collateral per event is now `max(max_i L_i, Σ premiums)`. Without that, refunds could exceed the lock while LPs withdrew premiums as free capital (`test_Void_RefundsAlwaysCollateralized`). Offchain, all-NO votes VOID and more than one YES doesn't vote. Tests: six `test_Void_*` tests, plus invariants that now include propose, veto and void.

### M-5 Modeled depth overstates real liquidity about 10x

`offchain/src/gemini.js:153-160`. Gemini's REST API publishes no depth, so the pricer modeled 10 levels of 1,000 contracts. The live WebSocket book for the Boston NBA-title YES contract, on the same day:

```
{"e":"depthUpdate","s":"gemi-nbaf-2627champ-bos",...,"a":[["0.1300","50.00"],["0.1600","476.00"]]}
```

That's 526 contracts of asks, against 10,000 modeled. Large covers were priced off liquidity that wasn't there and couldn't be hedged.

Fix (Part B item 1): `offchain/src/depth.js` streams `{instrumentSymbol}@depth` from `wss://ws.gemini.com?snapshot=-1`. `getBook()` uses it while the stream is alive and reports `bookSource: "ws-depth"`. The parser was written from a live capture (`offchain/test/fixtures/gemini-ws-depth.json`, 3 minutes, 1,078 deltas), not from the docs alone, and the capture showed three things the docs don't say:

- Update IDs chain. Each frame's `U` equals the previous `u` (1,077 of 1,078; the other one straddles the snapshot).
- Symbols come back lowercased.
- A single `SUBSCRIBE` for 150 streams got no reply at all, while 20 per message worked, so subscriptions are batched.

The modeled fallback (used when the stream is down) now defaults to 100 contracts per level, matching live books. Mutation check: breaking the qty-0 removal, the gap rule or the lowercase key each fails the suite.

### M-6 Gemini trading client could never place an order; order ids corrupted

Found by trading on the sandbox (Part B item 4), `offchain/src/gemini.js:196-227`.

```
InvalidNonce: Nonce '"1795074893453"' was not parseable as a number.
InvalidNonce: Nonce '1795074909145' is not within 30 seconds of server time '1795074909'
```

The nonce was a string, and in milliseconds. No sandbox order could ever have been placed. Separately, `orderId` comes back as a bare JSON number above 2^53 (`145853902323006128`), and `JSON.parse` rounds it to a different order (`…6130`), so the order id recorded onchain would have been wrong. Fix: a strictly increasing number of seconds for the nonce, and `parseOrderResponse` keeps `orderId` exact. Tests: `offchain/test/sandbox.test.js` on the captured responses.

### M-7 Outcome indexes shift if Gemini lists a new contract after sales

Pre-existing; found by the verification pass. Outcome `i` was "position `i` in contracts sorted by symbol" at the moment of each call. If Gemini adds a team to a futures market after covers were sold, every later index shifts, and the settler pays (and the hedger hedges) the wrong team. Fix: the first quote pins the canonical order in the registry. Later contracts get the next free index. The settler refuses to vote if a pinned contract disappears, and stores the pinned order next to the evidence so the public verifier can recompute it. Tests: two `N-3` tests in `offchain/test/review2.test.js`. Constraint: the pricer, hedger and settler must share the registry (`REGISTRY_PATH`). A hosted pricer and a local settler don't, so production needs a shared store.

### M-8 Removed settler's vote still counts, and can complete the unanimous fast path

`src/ArraVault.sol:196-201`, `:318-342`. Votes were keyed by round only. When the guardian removed a compromised settler, its vote stayed in the count. And because `settlerCount` dropped, a single remaining vote could reach "unanimous" and settle instantly with no dispute window (the verification pass's PoC ended in Settled). The first draft rated this Low; it is Medium. Fix: `settlerEpoch` bumps on any settler or threshold change. Votes cast under an older set stop counting. An Open event starts a fresh round, and a Proposed one takes no more votes (`SettlersChanged`), so the guardian vetoes or lets it finalize. Tests: `test_Review_SettlerChangeResetsOpenVotes`, `test_Review_SettlerChangeBlocksFastPathWhileProposed`.

### N-1 `voidEvent` could override a result after its dispute window

Introduced by M-4's first version. The guardian could void a Proposed event at any time before someone finalized, including after the window in which a veto is allowed. Fix: the same bound as a veto. Test: `test_Void_RevertWhen_ProposedWindowClosed`.

### N-2 Deposits during a booked loss win if the proposal is vetoed

Introduced by H-1's fix. While Proposed, NAV is marked down, and a veto restores it, so a deposit made in between bought cheap shares from the LPs who were already in (PoC: deposit 45,500, worth 48,000 after the veto). Fix: `maxDeposit`/`maxMint` are 0 while `proposedLoss > 0`. Test: `test_Review_NoDepositWhileLossProposed`.

### Low findings

- **L-1** `pricing.js:39,73`: `round2` then `ceil` charged the premium to the nearest cent, up to $0.005 under. Now `ceil` of the exact value (`premiumUnits`).
- **L-2** `gemini.js:28-33,96-104`: the evidence hash was over `res.text()`, which decodes and drops a BOM. Now over the response bytes (`arrayBuffer`). Impact is negligible for normal JSON, but the claim "hash of the raw response" is now true.
- **L-3** `ArraVault.sol:457-459`: `maxRedeem = convertToShares(maxWithdraw, Floor)` left dust even when free capital covered the whole position. Seen live when recovering the first vault: 30,042 shares left behind. Fixed. Recovering the second vault left 0 shares.
- **L-4** `ArraVault.sol:203-208`: `setSettlementParams` changes the window that `finalize` and `vetoResult` read for results already proposed. PoC: shorten to 0, finalize at once. Not fixed. It's an owner power on par with the others in [SECURITY.md](SECURITY.md), and the fix is a timelock on the owner.
- **L-5** `pricer.js:112-156`: `cors()` allowed every origin, there was no rate limit, input went straight to Gemini and the RPC, and every error was a 400 that echoed internals. Now an origin allowlist, 60 requests per minute per IP, strict validation, a 10 kB body cap, and 502 for upstream failures (`offchain/test/api.test.js`).
- **N-3** `depth.js`: after a sequence gap, deltas still in flight became a partial "snapshot". Now only a frame with `U == u` starts a book (all 23 live snapshots had `U == u`; none of 1,078 deltas did).
- **N-4** `verify.js`: the verifier didn't check the bytes named the event being verified, and passed when the live re-fetch failed. Both fixed.
- **N-5** `pricing.js:57`: the pricer computed locked collateral as `max L_i`, ignoring `premiumsOf`, so it under-charged capital on crowded championships and didn't see `Insolvent` reverts coming. Fixed.
- **N-6** `settler.js`: with every key in one process, an automatic VOID was unanimous and skipped the veto window. An automatic VOID now casts only `threshold` votes.
- **N-7** `depth.js:79`: freshness was "the socket delivered any frame in the last 5 s", so a symbol whose stream went quiet kept its last book. Fixed where it matters: each book records when a delta last changed it, and in-game quotes require a change within 180 s (see H-3). Pre-game quotes still accept a quiet book, which is usually the true book; `buildQuote` also requires Gemini's REST `marketState: "open"`.

### Informational

- **I-1 Slither** (`slither . --filter-paths "lib/|test/|script/"`, 0.11.6, run before and after): 10 results, all false positives or by design.
  | Detector | Location | Triage |
  | --- | --- | --- |
  | incorrect-equality | `utilizationBps`: `cap == 0` | Intended: guards division by zero. |
  | missing-zero-check | constructor and `setOperator` (`operator_`) | Owner input. A zero operator stops quoting, nothing else. Left as is. |
  | timestamp (3) | `buyCover`, `vetoResult`, `finalize` | Intended: 60 s quote TTLs and dispute windows. Arc's block-time drift is far smaller. |
  | costly-loop | constructor `settlerCount++` | Runs once, 3 settlers. |
  | cyclomatic-complexity | `buyCover` | Accepted. Every branch is a check with its own test. |
  | unindexed-event-address (2) | `OperatorUpdated`, `SettlerUpdated` | Indexing would change topic layout for existing consumers. Left as is. |
- **I-2** `EventInfo.eventStart` is set from the first quote and never read. Sales close per quote, by design (in-game cover).
- **I-3** First-depositor inflation: the 6-decimal offset is enough. A 10,000 USDC donation costs the attacker about 5,000 and the victim under 0.01 (`test_Review_InflationAttackUnprofitable`). Rounding directions are OpenZeppelin's (favour the vault).
- **I-4** Residual LP front-running before the first vote; see H-1.
- **I-5** Reentrancy: `claim` follows checks-effects-interactions, and USDC has no hooks. `buyCover` pulls the premium before updating state; that's safe for this token and would need a guard for a token with callbacks.
- **I-6** Live API facts used above: the sandbox lists only crypto and commodity markets (no sports), so the real sandbox hedge goes to a stand-in contract (`SANDBOX_SYMBOL_MAP`). `isLive` stays true for days after a game. Depth is only on the WebSocket.

## Coverage of the brief's Part A checklist

| Item | Result |
| --- | --- |
| Slither + coverage | I-1; coverage table above |
| Accounting desync across every transition | Invariants: full collateral, `locked == worst case` (incl. void), `worstUnhedged == rescan`, `proposedLoss == rescan`, hedge ≤ liability, over random sequences of deposit / withdraw / buy / hedge / propose / veto / void / finalize / claim / sweep. No desync found. |
| ERC-4626 inflation, rounding, max* consistency | I-3, L-3; `maxDeposit/maxMint` now also 0 during a booked loss (N-2) |
| LP front-running settlement, NAV while Proposed | H-1, N-2, I-4 |
| EIP-712 domain vs `chain.js`, replay, malleability | Domain matches (`"Arra"`, `"1"`, chain id, vault). OZ ECDSA rejects high-s. Buyer binding and nonce tested. No finding. |
| Buying after the result is known | H-3 |
| Votes across rounds, settler changes mid-vote, threshold changes | M-8, L-4 |
| Finalize/claim reentrancy, uncovered winner | I-5. A winner with no covers releases the lock (`test_LargeChampionshipLastTeamWins`, PoC in the verification pass). |
| Gas / DoS | No unbounded loop reachable by an unprivileged caller. `recordHedge` rescans at most 128 outcomes and is operator-paid. |
| Admin powers table | [SECURITY.md](SECURITY.md) |
| Pricing units and rounding, cap pre-check mirror | L-1, N-5. The pre-check uses NAV before the premium, so it is stricter than the contract, never looser. |
| Canonical outcome order everywhere | No raw-order path (`grep` over `src/` and `scripts/`); M-7 for order drift over time |
| Settler evidence, partial settlement, tie | L-2, M-4; partial settlement never settles (test) |
| Hedger schema, HMAC headers, idempotency | M-6 (nonce), M-2, M-3; order schema confirmed by real fills |
| Live shape check | Matches; see the H-3 and M-5 captures |

## Part B status

| Item | Status |
| --- | --- |
| 1. Real WebSocket depth | Done (M-5). Live quotes report `bookSource: "ws-depth"`. |
| 2. Void / tie path | Done (M-4, N-1). |
| 3. Public evidence verifier | Done: `offchain/scripts/verify-settlement.js`, evidence stored in `offchain/evidence/`. On the testnet settlement the offline check passes and the live check fails, because the game hasn't been played. That's the right answer. |
| 4. Gemini sandbox hedge end to end | Done: order `145853902323013843` filled 5/5 and was recorded onchain with that id (hashes in `deployments/arc-testnet.json`). |
| 5. Live-data local E2E | Done: `script/e2e-live-gemini.sh`. |
| 6. Trust assumptions + threat model | Done: [SECURITY.md](SECURITY.md). |
| 7. QuickNode Streams live | Not done: needs the owner's QuickNode account. The webhook now requires a secret; the stream filter is unchanged. |
| 8. Hosted pricer API | Code done and run locally with production settings (live Gemini, Arc RPC, CORS). `render.yaml` and `offchain/Dockerfile` are ready. Not deployed: needs the owner's hosting account. `pricerUrl` goes into `deployments/arc-testnet.json` once it's live. |

## After the review: running it live

Deploying the pricer and running the system unattended turned up five more problems. All are fixed, with tests:

- **Arc's public RPC refused the hosted pricer** ("Request exceeds defined limit"). A quote read `liability` and `hedged` per outcome as separate calls, about 64 for a 30-team championship. Reads now go through Multicall3 (5 requests for 30 outcomes), and RPC limit errors return 502 instead of 400 (`test/rpc.test.js`).
- **Live games were invisible past the first page.** `listActiveEvents` read only the first 50 results per query, so an NFL game with a $5 promise on it would never have been settled. The keeper's recovery now pages through every result (about 1,400 events); the public list stays one page so `/events` stays fast.
- **Nothing settled without someone at a terminal.** The keeper ([`offchain/src/keeper.js`](../offchain/src/keeper.js)) runs the pricer and the settler in one Render service. It persists the registry and the evidence bytes to the `keeper-data` branch, because Render wipes its disk on restart. It also serves hash-checked evidence publicly, so the verifier works even though the repo is private. Its key concentration is described in [SECURITY.md](SECURITY.md#the-demo-keeper).
- **Winners would not have been paid a day after deploy.** Arc's RPC refuses `eth_getLogs` over more than 10,000 blocks, and the payout step scanned `CoverPurchased` from the deploy block, about 105,000 blocks back by the evening of Nov 19. The vote would have landed, the payout would have thrown, and later passes skipped `Settled` events, so the bar would never have been paid. Every scan now goes through `getLogsChunked` (10,000-block windows), and the keeper re-checks each settled event once per start and pays any unclaimed winner (`test/logs.test.js`; checked against the live RPC: 9 of 9 promises found in 3.6 s). The demo seeding script also swallowed this error and would have bought duplicate covers on a re-run; it now stops.
- **Evidence writes raced.** Two syncs committed to the same branch at once and GitHub answered 409. Writes are now serialized and single-flight, 409s are retried, and identical bytes aren't re-committed (`test/keeper.test.js`).

A real settlement is pending: policy #8, $5 on Indianapolis in `NFL-2611200115-IND-HOU-M`, bought through the live pricer before kickoff. The keeper settles it from Gemini's result once Gemini settles the market.

## Z-1 ArraResultProofs accepts claims that don't prove the winner

`src/ArraResultProofs.sol:78-83`. Found in the final pre-submission pass, after the contract was deployed at `0x0F59f81392bB71AB05A7cA7052CB4D6149Db8d2D`.

`prove` checks that two strings occur somewhere in the claim's `parameters`: `"url":"<Gemini event URL><ticker>"` and the escaped winner regex. It doesn't check where they occur. A Reclaim attestor signs whatever request the requester asked it to make, so a requester can get these claims signed and the contract records them:

1. A regex with an extra branch, `<winner pattern>|"ticker"`. The real Gemini response always contains `"ticker"`, so the match succeeds for a team that lost.
2. An inverted match, `{"invert":true, ...}`, which proves the pattern is absent. Reclaim's provider schema has `invert` (`attestor-core/lib/types/providers.gen.d.ts`).
3. The request sent to another host, with Gemini's URL in a request header named `url`. The canonical parameters then contain `"headers":{"url":"https://api.gemini.com/..."}`.
4. A non-empty `responseRedactions`. Matching runs on the redacted response, which can splice parts of different contracts together.

`prove` is permissionless and the first proof per event is final (`AlreadyProven`) with no owner override, so a false proof also blocks the true one for good. PoC: local forge tests with a test attestor key; cases 1 and 3 are recorded, and the true winner's proof then reverts with `AlreadyProven`. No real Reclaim proof was spent on the PoC.

Impact today: the contract moves no money and the vault doesn't read it. The risk is the proof page showing a false "proven" badge, and colluding settlers backing a wrong vote with a matching "proof". Mitigation shipped: the proof page reads the claim from its `prove` transaction, parses `parameters`, and requires the exact URL, exactly one `{type, value}` regex equal to the winner pattern, no redactions, and a winner equal to the vault's settled outcome (`frontend/src/lib/zkcheck.js`, tests in `zkcheck.test.js` including the real recorded proof). **Fixed the same night.** `ArraResultProofs` was redeployed at `0xFBddD7f4c2319bFecBE126bf9b48e0186d82FB72`. `prove` now rebuilds the exact `parameters` bytes for the ticker and winner (`expectedParameters`) and compares hashes, so all four forgeries revert (`test_rejectsRegexWithExtraBranch`, `test_rejectsInvertedMatch`, `test_rejectsRedactions`, `test_rejectsOtherHostWithGeminiUrlInHeader`). `test_expectedParametersEqualRealClaimBytes` pins the rebuilt string to a real Reclaim claim. The owner can `clear` a bad record. The real proof was recorded again on the new contract (tx `0x50d5c7ef501b77c0f25debdb827f26d6b704141d30315971cf52205c6bdcc544`). The old contract (`0x0F59f81392bB71AB05A7cA7052CB4D6149Db8d2D`) is retired.

## Deployments

| Vault | Status |
| --- | --- |
| `0x1D69e0fE014df1007aE66A68a5c9714a7E833d6f` | Current. Source verified. Smoke test and sandbox hedge run in `deployments/arc-testnet.json`. |
| `0x8fA63E69a91101156a2ebda4bAD78B518Ceee334` | Retired: first round of fixes, before N-1, N-2 and M-8. LP funds redeemed. |
| `0x3CC34beE579B6caD4Ab3c13582138c263812831C` | Retired: pre-review contract. LP funds withdrawn. |
