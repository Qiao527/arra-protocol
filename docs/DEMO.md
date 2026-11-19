# Demo guide

Everything below runs live: the site, the pricer and keeper, the vault on Arc testnet, and Gemini's real markets.

| | |
| --- | --- |
| Site | https://qiao527.github.io/arra-protocol/ |
| Pricer + keeper | https://arra-pricer.onrender.com (`/health`, `/events`, `/keeper`, `/registry`, `/proofs`) |
| Vault | [`0x1D69e0fE014df1007aE66A68a5c9714a7E833d6f`](https://explorer.testnet.arc.io/address/0x1D69e0fE014df1007aE66A68a5c9714a7E833d6f), source verified |

## What's real and what's testnet

Say this up front. Judges trust a demo more when you tell them where the edges are.

| Piece | Status |
| --- | --- |
| Prices | **Real.** Gemini's production order books: REST for markets, the WebSocket depth stream for the book walk. A quote shows "Gemini depth (live)". |
| Markets | **Real.** Today's NFL, NBA and NHL games and the season championships, straight from Gemini. |
| Money | **Testnet.** Arc testnet USDC. No real money moves. |
| Contract | **Deployed and verified** on Arc testnet. Reviewed: see [REVIEW.md](REVIEW.md) and [SECURITY.md](SECURITY.md). |
| Hedge | **A real order on Gemini's sandbox.** Order `145853902323013843`, 5/5 filled and recorded onchain with that id. The sandbox has no sports markets, so the order went to a sandbox stand-in contract. |
| Settlement | **Automatic from Gemini's result.** The keeper votes when Gemini settles a market. The two settlements so far used synthetic results (labelled in their evidence) because the games hadn't been played. A real one is pending: $5 on Indianapolis, Nov 19, policy #8. |
| Settlers | **Demo setup.** Three settler keys in one keeper. In production they'd be three independent operators. |
| Evidence | **Real.** The hash of Gemini's exact response bytes goes onchain, and the bytes are stored and served publicly. Anyone can re-check them. |

## Script (about 2½ minutes)

**0:00 The problem.** "Bars and shops love 'if our team wins, it's on us.' Big players insure it. Mattress Mack paid 10–20% to brokers. A neighbourhood bar can't buy that. Arra sells it in one click, priced by a prediction market and backed by USDC you can see."

**0:15 Make a promise.** On the site, pick a game. Show that the price comes from Gemini's live order book. Choose **$5 testnet**, type a bar name, then **Get signed quote**: the premium, the marketing multiple, and "Gemini depth (live)". Click **Seal the promise** and approve in MetaMask. The receipt shows the promise number and a QR code.

**0:50 Scan it.** Scan the QR with a phone. This is what a customer sees: the promise exists onchain, the $5 is locked, the vault can pay every open promise at once, and how it settles. "No account, no trusting us. It reads the chain."

**1:15 Risk desk.** Open **Risk desk** and the 2027 Pro Basketball Champion market. Five bars, five teams, $25 promised, **$5 locked**. "Only one team can win, so one lock backs every promise. That's why it's cheap." Scroll to **Hedges on Gemini**: the real sandbox order id.

**1:40 Settlement.** Open https://arra-pricer.onrender.com/keeper. "This keeper checks every promise each minute. When Gemini settles the game, it votes the result with the hash of Gemini's response and pays the bar." Then show one check in a terminal:

```bash
cd offchain && node scripts/verify-settlement.js NHL-2611200000-PHI-OTT-M --offline
```

"Anyone can run this. It fetches the exact bytes the settlers voted on, checks them against the onchain hash, and recomputes the winner."

**2:10 Trust.** "We reviewed it adversarially: fuzz invariants, an independent second pass, live testing against Gemini that found real bugs. Every half hour a GitHub job re-verifies every settled promise from public data." Mention the trust table in SECURITY.md: settlers and the guardian are the trust points, and here's how production splits them up.

**2:30 Close.** "Promises, pre-paid. Priced by Gemini, locked on Arc, provable by anyone."

## Before you present

- **Wake the service** about a minute before: open https://arra-pricer.onrender.com/health. The free plan can sleep. A keep-alive job pings it every 10 minutes, but GitHub can delay scheduled runs.
- **Wallet:** about 0.5 testnet USDC on Arc (from https://faucet.circle.com). A $5 promise costs roughly $0.20–$1.10 in premium plus a cent of gas, depending on the team.
- **If sealing fails with "chain … does not match":** switch MetaMask to **Arc Testnet** by hand and click Seal again. (A wallet that already knows the site skips the automatic network switch; the frontend fix is pending.)
- **Vault room:** each game can take a $5 promise while the vault holds about $50 or more (10% per-game cap). Several different games at once are fine. If a quote says "Vault capacity reached", pick another game, or have an LP deposit faucet USDC.
- **Pick a game that hasn't started**, or a championship. In-game cover closes well before a game could end.
- **If tonight's real settlement lands**, show it: `node scripts/verify-settlement.js NFL-2611200115-IND-HOU-M` without `--offline`, passing the live Gemini check too.
