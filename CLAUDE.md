# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Herkos is an exit-capacity oracle for FXRP on Flare, targeting Flare Summer Signal Bounty 1. **The design is complete, measured and presented. All six phases are closed** — the repo holds a dependency-free verification pass (`npm run phase0`, 44/44 read-only checks), the off-chain readers (`npm run phase1`, 54/54, writing `readers.json`), the oracle contract with 54 fork tests (`npm run phase2`, 54/54 + 2 gas budgets), the publisher (`npm run phase3`, 32/32 against a live fork, writing `phase3-results.json`), the demo consumer (`npm run phase4`, 42/42 against the real forked lending market, writing `phase4-results.json`), the writeup and static demo page with their verifier (`npm run phase5`, 97/97, writing `phase5-results.json`), and the seven markdown files. Phase 2 was built ahead of Phase 1 against the deployed contracts directly, so the contract existed before the relayer that feeds it.

Phase 2 corrected three numbers the docs had asserted from estimate rather than measurement — hot-path gas, the scaling multiplier, and `poke()` cost. All six files carry the corrections; `Memory1.md` holds the reasoning. Do not restore the older figures.

Phase 3 closed the FDC loop against the **real** verifier rather than a mocked boundary: the registry-resolved, deployed `FdcVerification` returns true on the fork for mainnet proof `0x1df2dda2…` (block 67,012,947, round 1,420,598), 8 harvested proofs re-encode **8/8 byte-identical** to the original mainnet calldata, and the oracle refuses both a wrong-subject proof (`WrongSubject`) and a post-pin one (`ProofRejected`, checked against an empty-root control). The divergence gate correctly **declined to attest** — 18 bips, under threshold and in the capacity-raising direction — and a run that attests nothing is the normal outcome, not a skipped step.

Phase 4 pointed the **real deployed Compound market** at Herkos — its own admin, impersonated on the fork, for 0 FLR — and closed the DEX-routing question Phase 3 had carried open. The clearing fill is now capped at `dx* = dex × (1 − √k)/√k`, the depth where the marginal DEX unit stops beating redemption, so registering exit pools moves capacity **8.91M → 10.60M FXRP with the haircut unchanged at 999,992 ppm** instead of tightening it to 627,540. Three tests pin the invariant `_clearingPPM(n) >= _redeemPPM(n)`; the reasoning is `Memory1.md`, first entry. Phase 4 also grew the Phase 2 suite from 51 to 54, and corrected a claim that had stood in four documents — see *Positioning* on collateral factors.

Phase 5 is the presentation: `Writeup1.md`, the static `demo/` page (`npm run demo`), and `scripts/phase5.js`. **The verifier is the deliverable there, not the prose** — it re-reads every figure the writeup and the demo assert against the results file that produced it, so corrupting a digit in `readers.json`, `fork.json`, `phase3-results.json` or `phase4-results.json` turns the run red. It also enforces the *Positioning* rules below as checks. Two lessons from building it, both in `Memory1.md`: match a forbidden phrasing against the **negation window** around it, because these documents deliberately quote the wrong sentence in order to reject it; and **pair a retired figure with its replacement rather than banning it**, because naming the old number is how a reader learns it moved.

Do not re-derive the on-chain numbers. They were measured live and are recorded in `Memory1.md` — treat them as facts, and re-measure only when one is load-bearing for new work. Phase 0 re-measured a few and they drifted (supply, queue tickets, Core Vault); `Memory1.md` records both the original and the delta. Drift is not contradiction.

## Document map

Each file has a distinct job, and they are kept consistent with each other by hand.

| File | Role |
|---|---|
| `Handoff1.md` | Start here. Current state, what matters, known risks |
| `PRD1.md` | Problem, the five signals, success criteria, honest weaknesses |
| `Architecture1.md` | The three loops, gas budget, FDC availability, trust model, data sources |
| `Memory1.md` | Hard decisions, every measured number, rejected directions. The authority on *why* |
| `Tasks1.md` | Phased checklist, Phase 0 → Phase 5. The work queue |
| `setup1.md` | Prerequisites, `.env` shape, run commands, verification checklist |
| `Writeup1.md` | The judge-facing submission — the argument, the evidence, the weaknesses, the reproduction steps |

When a decision changes, update all of them. They cross-reference deliberately, and a stale claim in one is worse than no claim. `npm run phase5` enforces the numeric half of that by hand-checking every figure against the results file it came from — run it after touching any document.

## Research toolkit — lives outside this repo

The read-only measurement scripts backing every number in `PRD1.md` are at:

```
C:\Users\HomePC\AppData\Local\Temp\fassets-research\
```

`README.md` in that directory is the authority on its contents; do not maintain a second inventory here. It sits in a temp directory, so treat it as fragile — the event caches are regenerable but slow (`redemption-stats.json` means rescanning ~20M blocks).

```bash
npm run measure   # the five signals — queue, core vault, cross-chain, holders, sizes
npm run free      # the $0 proof — archival depth, CORS, forked Relay roots
npm run replay    # the decisive proof replay — needs anvil on :8546 first
npm run fdc       # FDC fee matrix + real FdcVerification struct shapes
npm run price     # live FLR/USD and gas price
```

**No install step, and no `node_modules` — ever.** Nothing there imports a package; `k.js` is a dependency-free keccak standing in for `ethers`. Being dependency-free is part of the $0 story, not an accident.

## Planned build commands

From `setup1.md`. All six phases exist — `phase0` through `phase5`.

```bash
npm run phase0        # Phase 0 verification: registry resolution, deployed shapes, diamond
                      # ABI, held fork pin. 44 read-only checks. REPIN=true moves the pin
npm run phase1        # Phase 1 readers: queue walk, ~20M-block event scan, liveness, XRPL,
                      # OFT, DEX, reconciliation. 54 read-only checks. Writes readers.json +
                      # phase1-results.json + a pin-keyed scan cache. RESCAN=true refetches
npm run phase2        # Phase 2 contract tests: 54 fork tests + 2 gas budgets. Needs the
                      # anvil below already running — and FRESH: ForkBase forks anvil's
                      # HEAD, so a fork dirtied by phase4 fails the pin assertion.
                      # Writes phase2-results.json
npm run phase3        # Phase 3 publisher: collection pass, divergence gate, poke(), harvest,
                      # real proof verification, both rejections, Coston2 request half,
                      # provenance. 32 checks against a live fork. Needs phase1's readers.json
                      # and the anvil below. Writes phase3-results.json. PUBLISH=true submits
npm run phase4        # Phase 4 demo consumer: deploy, repoint the REAL cFXRP comptroller at
                      # Herkos via its impersonated admin, agreement, referenceSize ladder,
                      # borrower liquidity, side-by-side. 42 checks against a live fork.
                      # Leaves the market live behind Herkos, so reboot anvil before phase2.
                      # Writes phase4-results.json
npm run phase5        # Phase 5 presentation verification: traces every figure in Writeup1.md
                      # and demo/ back to fork.json / readers.json / phase3-results.json /
                      # phase4-results.json, and enforces the Positioning rules as checks.
                      # 97 checks over the repo's own files — no fork, no key, no account.
                      # Writes phase5-results.json
npm run measure       # read-only research pass against mainnet, no keys, no cost
npm run publisher     # alias of phase3 — dry-run by default; PUBLISH=true to submit
npm run demo          # static demo UI on :8080, reads the RPC from the browser

# boot the demo venue — a fork of Flare mainnet at the PINNED block (67,013,823, fork.json)
# --no-rate-limit is required: a poke() is hundreds of state fetches and the public RPC
# will otherwise rate-limit the queue walk into transport failures
anvil --fork-url https://flare-api.flare.network/ext/C/rpc \
      --fork-block-number $FORK_BLOCK --port 8545 --no-rate-limit

# --legacy is required: anvil forking Flare does not serve eth_feeHistory, so EIP-1559 fee
# estimation fails outright. Flare mainnet is legacy-priced anyway. (Phase 3 finding)
forge create src/ExitCapacityOracle.sol:ExitCapacityOracle \
      --rpc-url http://localhost:8545 \
      --private-key <anvil account 0 key> --legacy --broadcast
```

Prerequisites: Node 20+, Foundry (`anvil`, `forge`, `cast`). No funded account anywhere.

## The three venues — confusing them is the only way this build costs money

| Venue | Role | Rule |
|---|---|---|
| Flare mainnet | Evidence | **Read-only forever.** `eth_call` only |
| Anvil fork of mainnet | The demo — deploy, stress, FDC verification | Where all writes go. Pin the fork block |
| Coston2 | Optional public artifact | Free faucet, ~2 C2FLR per deploy |

**Never point `forge create --broadcast` at the mainnet RPC.** That costs real FLR and nothing in this build needs it. `PUBLISHER_KEY` on the fork is an Anvil test key, never a funded mainnet key.

The fork is load-bearing rather than a shortcut: it carries real addresses, real state, gas within 0.9% of mainnet (`redemptionQueue(0,100)`: 535,964 vs 540,601), and real finalized FDC Merkle roots — a genuine mainnet FDC proof was replayed on it successfully.

## Architecture — three loops at different speeds

The separation exists because of measured gas, and collapsing it breaks the product claim.

1. **Publisher** (off-chain, stateless, event-driven) — reads Flare/XRPL/remote chains, requests FDC attestations only on divergence, submits `(data, proof)`. Cadence comes from a GitHub Actions cron, not a resident process. It is a relayer, not an authority.
2. **`poke()`** (on-chain, permissionless, **1,836,816 gas measured**) — walks `AssetManager.redemptionQueue()`, reads `CoreVaultManager`, OFT Adapter balance, DEX reserves; writes the aggregate to storage with a block and timestamp. No arguments, no privilege, no submitted values. The ~600k in earlier drafts covered the queue read alone and omitted agent-liveness filtering, which dominates at ~282k per unique agent.
3. **`getUnderlyingPrice(address cToken)`** (on-chain, hot path) — reads the cached aggregate plus FTSO XRP/USD, applies the haircut. Nothing else.

## Invariants — do not violate these without new evidence

- **The hot path never walks the queue.** `getUnderlyingPrice` runs inside Compound's `getHypotheticalAccountLiquidityInternal` on every borrow, redeem, and liquidation. A full queue walk is 540,601 gas and grows unbounded. Target ≤ ~100k. Measured in Phase 2 on the fork: **Herkos 70,467 cold / 15,967 warm against the incumbent entrypoint's 110,614 / 24,108** — cheaper, not merely at parity. The 91,042 in earlier drafts is the bare FTSO feed read, not any oracle entrypoint. Measure cold in a *separate transaction per oracle*, or the second free-rides on the FTSO slots the first warmed.
- **Attested state is one-directional:** store `min(FlareAccounting, XRPLProved)`. Submitted data may only make the number more conservative, never less. This is what makes lying by omission harmless — forgery was never possible, selective silence was.
- **A rotation is not an exit.** DEX depth counts only *uncorrelated* venues. FXRP/stXRP is the deepest pool on Flare (2.32M FXRP) and contributes **zero**; the three FXRP/USDT0 pools (1.68M) are what count. Counting the correlated pool would inflate capacity — the one forbidden direction. The flag is per-pool and governance-settable, so a mislabelling is correctable without redeploying; `test_correlationFlagIsTheWholeDifference` proves the flag alone is the difference.
- **An exit venue is optional, so registering one can never make the price worse.** `_clearingPPM(n) >= _redeemPPM(n)` is an invariant, not a preference — nobody is forced onto an AMM. Until Phase 4 the DEX slice filled at `min(n, dexExitUBA)` unconditionally, which *tightened* the reference haircut to 627,540 ppm while raising capacity. The fill is capped at `dx* = dex × (1 − √k)/√k`, where the marginal DEX unit stops beating redemption; `k` is evaluated once against the whole amount, erring toward routing *more* to the DEX, never less. Three tests pin it, and `_sqrt` stays off the hot path (reached only from `_recompute()` and public views).
- **The haircut is computed on-chain** from stored inputs. Never submitted.
- **Same interface, no new one.** Integration must stay one governance call (`comptroller._setPriceOracle`) or adoption is zero.
- **Agree with the incumbent under normal conditions.** Returning $1.042118 alongside the existing oracle is the credibility; divergence has to be earned.
- **Stale beats confidently wrong.** Staleness guards on both the poked aggregate and the attested state.
- **FXRP is 6 decimals**, as are the vault collateral stablecoins. Scaling is `1e(36 - decimals)` = `1e30`. An 18-decimal assumption silently prints zeros.
- **Resolve addresses through `FlareContractsRegistry`** (`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`) at runtime. The addresses in the docs are there to check the resolver returned the right thing, not to hardcode.
- **Spend FDC fees on divergence, never on a timer.** 20 FLR per attestation; a 15-minute heartbeat is ~$11.74/day for no new information.

## Verify against deployed contracts, never the docs

This has paid off four times, and one of the four would have sent the architecture down the wrong path if taken on faith (the phantom mainnet Web2Json verifier that serves 200 but has no fee configured). It has also misfired once, in the direction worth remembering: **the explorer is not the deployed contract either.** See the mismatch list in `Memory1.md`.

- Pull ABIs from the explorer rather than from documentation signatures — then check the ABI is complete. **The AssetManager is an EIP-2535 diamond**: its explorer ABI is the proxy shell with **zero functions**, and an incomplete event set. Read the dispatch table from `facets()` on-chain and merge the 33 facet ABIs; a selector in the loupe is dispatchable whatever the explorer says. `npm run phase0` does this and writes `abi/AssetManager.json`.
- **Absence in an ABI proves nothing until you know the ABI is whole.** We recorded "direct-minting rate limits are not live" from a shell pull; they are live (4M XRP/hour, 40M/day).
- Take FDC `verify*` struct shapes from the verified `FdcVerification` **implementation** (`0xf7f0057b…`) — the proxy has no ABI and the documented shapes differ.
- Probe `getRequestFee` before designing around an attestation type. A pair with no configured fee cannot be requested, and a live verifier endpoint does not mean the type is enabled.
- Prefer `XRPPayment` over generic `Payment`: it returns the XRPL address as a `string` rather than a hashed `bytes32`.
- Not every documented name is a getter. `maxRedeemedTickets` is `getSettings()` component 30, not a function — check the dispatch table before assuming a selector exists.

## Positioning — how to talk about this

Overclaiming loses the room faster than anything else, and several phrasings here are deliberate.

- **FXRP is not broken.** 23,988 redemptions, 8 defaults (0.0334%), every defaulted redeemer made whole plus 5%. The pitch is a missing measurement, not a hidden crisis.
- Say **"the publisher cannot move the number in the dangerous direction,"** not "the publisher cannot lie." The loose version is false and a judge breaks it in one question.
- Say the refresh is **permissionless**, not free — `poke()` costs someone 1.84M gas (6.5% of a Flare block, ~1.19 FLR at 650 gwei). Cost scales with *unique agents*, not tickets: 80 tickets resolve to 6 agents.
- On FDC proofs: **real proof, real Core Vault, replayed rather than freshly requested.** Replay verifies an existing attestation for free; it does not create one. The demo replays attestations FAssets itself already paid for.
- 766,000 FXRP/day is **demonstrated throughput, not capacity** — it reflects demand, not a limit. That unknown is the product.
- Per-chain OFT supply is not FDC-provable on mainnet (`EVMTransaction` covers ETH/FLR/SGB only). The OFT Adapter's locked balance on Flare is the aggregate of all remote claims, reconciled to a gap of exactly 0 **when both sides are read at the same block** — the pin-vs-remote-head comparison reads 0.0917% and that is elapsed bridging, not a discrepancy. State that plainly rather than implying per-chain proofs exist.
- **An oracle cannot move a collateral factor.** Say the market **loses borrowing power**, never that "the collateral factor tightens." `collateralFactorMantissa` is a governance constant and reads 0.70 on the live cFXRP market at every `referenceSize`. What moves is the *USD value of the collateral*. Report **effective CF = CF × haircut** and real `getAccountLiquidity` deltas: 0.7000 → 0.6894, $2,662,798.48 → $2,585,733.56 across 8 real borrowers as `referenceSize` walks 1M → 300M FXRP, zero shortfalls. The loose phrasing stood in four documents until Phase 4 and a judge breaks it by reading the comptroller.
- On the Phase 4 demo: **the real deployed market, its own admin impersonated.** The mechanism is proved; the impersonation is the exact distance to adoption, and switching a live market is a governance conversation rather than a deploy.

`Memory1.md` records five rejected directions, each killed by evidence. Do not resurrect one without new evidence — notably the agent-side operator tooling and the TEE/trust-layer framing, which set the standing quality bar: added apparatus reads as wrapper padding.

