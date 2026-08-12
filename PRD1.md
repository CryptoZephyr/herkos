# PRD — Herkos

**Product:** Herkos
**Focus:** Exit-capacity oracle for FXRP
**Status:** Defined, built and presented — all six phases closed, rewritten after on-chain measurement
**Target:** Flare Summer Signal — Bounty 1, Interoperable Asset Products

## Problem

Every lending market on Flare prices FXRP at the FTSO XRP/USD price. Verified live:

```
cFXRP.comptroller()        0x15f69897e6aebe0463401345543c26d1fd994abb
comptroller.oracle()       0x61f77ef0064736ffa68c31d960e55baf67f79a4b
getUnderlyingPrice(cFXRP)  $1.042118
oracle.ftsoV2()            0x7bde3df0624114edb3a67dfe6753e62f4e7c1d20
```

That feed observes XRP on centralized exchanges. It has no view of anything on Flare.

Meanwhile the realizable exit for FXRP is far narrower than the mark implies. Measured against Flare contract state, Blockscout indexes, and the XRP Ledger directly:

> These are live figures and they move. Re-checked 2026-08-09 at block 67,013,823 (`npm run phase0`, then `npm run phase1` at 54/54): queue **1,860,950 FXRP across 80 tickets**, Core Vault 7,050,810 available / 140,000,000 escrowed across **15** XRPL escrows rather than 17, supply 148,911,767. Every ratio below holds; the queue is a hair deeper and a dozen tickets shorter, and the same ~140M XRP re-formed into fewer escrow objects — the rolling cycle turning over, not funds leaving. Memory1.md carries the full delta table.

| | FXRP | vs. queue |
|---|---|---|
| permissionless redemption queue (92 tickets) | 1,850,570 | 1× |
| largest redemption ever attempted, 11 months | 521,540 | 0.28× |
| FXRP bridged off Flare, must route back through it | 12,929,748 | **7×** |
| FXRP posted as lending collateral | ~113,600,000 | **61×** |

The rest of supply sits behind the Core Vault: 6,988,558 XRP liquid, 140,008,959 XRP in 17 condition-gated XRPL escrows. User-facing direct redemption there requires KYC approval, a 10,000 FXRP minimum, and once-daily processing at lower priority than agent requests.

True DEX depth to stablecoins is **$3.01M**, not the $13.28M nominal — $7.95M of that nominal is FXRP/stXRP, a correlated pair that is a rotation, not an exit.

The system settled **258,952,156 FXRP over 338 days = 766,000/day**. At its own demonstrated rate, unwinding the collateral currently posted in lending markets takes roughly **150 days**. The oracle marks all of it as instantly worth spot.

**Nothing is broken today.** 23,988 redemptions, 8 defaults (0.0334%), every defaulted redeemer made whole plus a 5% premium. The backing is real and was counted on two chains. This is not a solvency problem.

It is a **measurement** problem: the number that decides whether $118M of leverage unwinds safely has never been measured, and nothing on Flare measures it.

## Solution

Herkos is a **drop-in replacement for the price oracle Flare lending markets already use for FXRP.**

Same interface, same signature, one different number:

```solidity
function getUnderlyingPrice(address cToken) external view returns (uint256);
```

It returns the FTSO price multiplied by a **haircut derived from measured exit capacity**. When FXRP can leave freely the haircut is 1.0 and Herkos returns exactly what they get today. When exit capacity tightens, the number moves before anyone is hurt.

Integration is one governance call: `comptroller._setPriceOracle(herkos)`.

That call is only safe if the gas is safe. `getUnderlyingPrice` runs inside Compound's liquidity check on every borrow, redeem, and liquidation — so it reads a cached aggregate plus FTSO and nothing else. Measured against the deployed incumbent on identical footing: **70,467 gas cold, against the incumbent's 110,614.** Herkos is cheaper than the oracle it replaces, which is a stronger claim than the parity originally targeted. The expensive part — walking the redemption queue and filtering agents by liveness, 1.84M gas — lives in a separate `poke()` that anyone may call and nobody may steer. See Architecture1.md.

Underneath, richer surfaces for anyone who wants them:
- `exitCapacity()` — how much FXRP can leave right now, permissionlessly
- `clearingPrice(uint256 amount)` — what N FXRP actually clears at
- `timeToExit(uint256 amount)` — how long N FXRP takes to fully exit

## What It Measures

Five signals. None exist in any feed today.

| # | Signal | Source | Today |
|---|---|---|---|
| A | Permissionless queue depth | `AssetManager.redemptionQueue()`, walked | 1,850,570 FXRP / 92 tickets |
| B | Agent liveness | 11 months of `RedemptionPerformed` / `RedemptionDefault` | 6 agents, 8 defaults on 4 days |
| C | Core Vault state | `CoreVaultManager` + **XRPL ground truth via FDC** | 6.99M available / 140.0M escrowed |
| D | Real DEX depth | Pool reserves, correlated pairs excluded | $3.01M, not $13.28M |
| E | Cross-chain claims | OFT Adapter locked balance on Flare | 12.93M FXRP |

Two involve genuine modelling, not a lookup:

**B — liveness.** An agent with tickets in the queue but no settlement in 48 hours is not exit capacity. Each ticket is weighted by its agent's recent behaviour, built from event history nobody has assembled.

**D — correlated pairs.** Excluding FXRP/stXRP is the difference between a real number and a misleading one.

## Computation

```
effectiveQueue = Σ ( ticket.value × liveness(ticket.agent) )
                   liveness ∈ [0,1], decays with time since last settlement,
                   drops hard on a recent default
                   on-chain poke() applies the binary half only (status ≤ 1);
                   the decay refines it downward, never upward

cvReachable    = availableFunds
               + escrowed × P(operators cycle within horizon)

dexDepth(x)    = slippage curve, correlated pairs excluded

clearingPrice(N):
    fill from DEX until slippage exceeds redemption cost
    route the remainder to redemption — par value, but not par timing
    discount the remainder by r × timeToExit(N)

timeToExit(N):
    N ≤ effectiveQueue               → minutes  (measured agent settlement p50/p95)
    N ≤ effectiveQueue + cvAvailable → ~1 day   (CV daily cycle)
    beyond                           → days     (escrow release cadence)

haircut = clearingPrice(referenceSize) / spotPrice
```

**One line of that was aspiration rather than deployed behaviour until Phase 4, and the
correction is worth stating because it runs backwards from intuition.** `clearingPrice` used to
fill the DEX slice with `min(N, dexExitUBA)` *unconditionally* — it made no comparison against
redemption cost at all. So registering the exit pools raised `exitCapacity` from 8.91M to 10.60M
FXRP while **tightening** the reference haircut from 999,992 to **627,540 ppm**, because constant
product charges `x/(x+dx)` for 1M FXRP against a 1.68M reserve. Both halves moved the wrong way
together. **Phase 4 fixed it, and the one-line reason is that an exit venue is *optional*:**
nobody is forced onto an AMM, so knowing a pool exists can never make an exit price worse than it
was without it. The slice is now capped at the depth where the two legs price equally,
`dx* = dex × (1 − √k)/√k` for `k` the redemption ratio — filling past that point buys nothing,
since every further unit clears below what redeeming it would have paid. Measured after the fix
on the live market: the same three pools move capacity **8.91M → 10.60M FXRP with the haircut
holding at 999,992 ppm**. Every haircut quoted in this document was measured at `dexExitUBA = 0`
and stays correct; registering depth no longer changes them for the worse. Three tests pin the
invariant, and the first fails against the old code at its first rung.

`referenceSize` is the single governance knob: *what exit size do you want to stay solvent at?* A lending market sets it to the largest position it might have to liquidate. That parameter turns a research number into a risk control.

## Target User

1. **Lending protocols on Flare** holding FXRP collateral — Compound fork, Morpho markets, Liquity fork. They already have the exposure and already call an oracle.
2. **Liquidators** sizing bids against real clearing price rather than spot.
3. **FAssets governance** as a system-health gauge.
4. **Large holders** planning an exit, especially the 12.93M FXRP sitting on Ethereum and Monad.

## Goals

- Publish a verifiable, on-chain measure of FXRP exit capacity that does not exist today
- Expose it through the exact interface lending markets already consume
- Prove off-Flare state (XRPL, remote chains) with FDC rather than asserting it
- Make the publisher structurally incapable of forging a number
- Ship a demo where a forked lending market visibly changes behaviour when pointed at Herkos

## Non-Goals

- Claiming FXRP is illiquid or mispriced today — it isn't, and overclaiming is the fastest way to lose the room
- Agent-side operator tooling (the previous direction — killed, see Memory1.md)
- Any trust layer, TEE attestation, or LLM in the valuation path
- Retail dashboards or portfolio trackers
- Liquidation bots

## Success Criteria

- `getUnderlyingPrice(cFXRP)` on Herkos returns the same value as the incumbent oracle under normal conditions, and diverges correctly under stress
- Core Vault XRPL state on Flare carries a verified FDC proof, not a backend assertion
- Queue depth, agent liveness, DEX depth, and cross-chain supply all feed the published number
- A forked lending market pointed at Herkos visibly loses borrowing power at a large `referenceSize` — **note the wording.** `collateralFactorMantissa` is a governance constant an oracle cannot touch; it reads 0.70 at every reference size. What Herkos moves is the *USD value of the collateral*, hence borrow capacity. Measured on the real market: effective collateral factor **0.7000 → 0.6894** and total capacity across 8 real borrowers **$2,662,798.48 → $2,585,733.56** as `referenceSize` walks 1M → 300M FXRP, with **zero** accounts pushed into shortfall
- Every number in the demo traces to a source a judge can independently check — **and the tracing is mechanical rather than promised.** `npm run phase5` re-reads every figure in `Writeup1.md` and `demo/` against `fork.json`, `readers.json`, `phase3-results.json` and `phase4-results.json`: 97 checks, and corrupting a digit in any of those files turns the run red
- The whole thing is reproducible at **$0** — free public RPCs, a local fork, a free faucet, free hosting. A judge with Foundry installed can re-run it without an account anywhere

## Monetization

Secondary to the hackathon, but designed in:
- Per-consumer subscription for the feed, gated at the oracle contract
- Or protocol-paid: a lending market pays for a risk input that reduces its own bad-debt exposure

Not a success fee — there is no capital movement to take a cut of.

## Honest Weaknesses

State these before a judge finds them.

- **Nothing has broken yet.** "Before it breaks" is a harder pitch than "after."
- **766,000/day is demonstrated throughput, not capacity.** It reflects demand, not a limit. Real capacity is probably higher — how much higher is unknown, and that unknown is the product.
- **The counterargument is real:** FXRP does redeem 1:1 eventually, so a lender can argue time doesn't matter. The rebuttal is that liquidation engines are priced on immediacy.
- **6 agents.** Small system. The leverage on top is what's big.
- **FDC attestation fees are 20 FLR per request** on mainnet. This makes a fixed heartbeat wasteful — ~$11.74/day at a 15-minute cadence — so the publisher is event-driven. A design choice with a cost behind it, not a blocker. See Architecture1.md.
- **The demo runs on a fork of Flare mainnet, and the FDC proofs it verifies are ones FAssets already paid for.** Both halves are honest and both should be said out loud. The fork carries real addresses, real state, real gas (within 0.9% of mainnet) and real finalized Merkle roots — and in Phase 3 the **deployed** `FdcVerification` accepted a genuine mainnet proof through the oracle's own submission path, refusing both a wrong-subject proof and a post-pin one. What the fork does *not* do is let Herkos originate a new attestation for free; that still costs 20 FLR on mainnet. A judge who asks "is this a real proof or a mock?" gets: real proof, real Core Vault, replayed rather than freshly requested.
- **Not every remote chain is FDC-provable.** `EVMTransaction` covers ETH/FLR/SGB only. Handled by reading the OFT Adapter's locked balance on Flare, which is the aggregate of all remote claims and reconciles to a gap of exactly 0 when both sides are read at the same moment (12,941,706,148,299 UBA either way; compare across the pin/head boundary instead and it reads 0.0917%, which is elapsed bridging) — but say so plainly rather than implying per-chain proofs exist.
- **FDC proves specific transactions, so the publisher can lie by omission** — attest inflows, quietly skip outflows. Forged data is impossible; selective silence is not. Bounded by making attested state one-directional: it may only reduce measured capacity, never raise it. Selective silence can then only make Herkos more conservative, and total silence falls back to Flare's own on-chain accounting. Worth stating out loud rather than claiming the publisher "cannot lie."
- **A fresh number costs someone gas.** `poke()` measures **1.84M** — three times the ~600k first estimated, because agent-liveness filtering costs ~282k per unique agent and the early figure counted only the queue read. That is 6.5% of a Flare block, ~1.19 FLR at 650 gwei. Cost scales with unique agents rather than tickets (80 tickets resolve to 6 agents), so the queue can grow a long way before it moves; a walk reaching ~97 distinct agents would fill a block, and the page budget is the knob for that. In production this wants an incentive; for the demo the publisher pays it, and the honest framing is that the refresh is *permissionless*, not that it is free.
- **The demo is a forked market, not a live integration.** Phase 4 pointed the *real* deployed Compound market at Herkos — same address, same storage, its own admin making the call for 0 FLR — and the market behaved: agreement at 0.08 bips, then $2,662,798 of borrow capacity walking down to $2,585,734 as `referenceSize` rises, with no account pushed into shortfall. But the admin is a contract that had to be **impersonated**, and that is the whole distance between this and adoption. The fork proves the mechanism; switching the live market is a governance conversation, not a deploy.

*Resolved:* the `Web2Json` availability question that previously topped this list. Measured — it is genuinely unavailable on Flare mainnet, and the design no longer needs it. See Architecture1.md.

*Also resolved:* whether a $0 build weakens the evidence. It does not. Mainnet is read for free, the demo forks it at a pinned block with 0.9% gas fidelity, and a real mainnet FDC proof re-verifies on that fork. The only thing money would buy is originating a *new* attestation — and the Core Vault attestations FAssets already produces are of the same account Herkos measures.
