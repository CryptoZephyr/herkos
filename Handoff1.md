# Handoff — Herkos

## What This Is
An exit-capacity oracle for FXRP.

Flare lending markets price FXRP at the FTSO XRP/USD price — a feed that watches XRP on centralized exchanges and knows nothing about whether FXRP can actually leave Flare. Herkos measures that exit capacity and publishes it through the exact price-oracle interface those markets already call.

The name is unchanged from the previous direction. The product underneath it is not — see Memory1.md for what was killed and why.

## Current State

- **Status:** Defined, measured and presented. **All six phases are closed** — 44 read-only checks, **54 reader checks**, **54 fork tests**, **32 publisher checks**, **42 demo-consumer checks**, **97 presentation checks**. Phase 3 closed the loop that mattered: the deployed `FdcVerification` accepts a **real mainnet FDC proof replayed on the fork** (tx `0x1df2dda2…`, round 1,420,598), and the oracle refuses both a wrong-subject proof and a post-pin one. Phase 4 then pointed the **real deployed Compound market** at Herkos — its own admin, on the fork, for 0 FLR — and closed the DEX-routing question that had been carried open since Phase 1. Phase 5 wrote `Writeup1.md` and the browser demo, and — more usefully — `npm run phase5`, which traces every figure in them back to the results file it came from and goes red if one drifts. **Next move: nothing is outstanding.** The remaining item is optional (the docs-mismatch GitHub issue in `Tasks1.md`).
- **Cost:** **$0**, and that is settled by measurement rather than intention — see *The $0 Proof* below.
- **Venues — three, and keeping them straight is what keeps the cost at zero:**
  - **Flare mainnet** — evidence only, read exclusively through `eth_call`. Every number in PRD1.md came from here. Free forever, because nothing is ever written to it.
  - **Anvil fork of Flare mainnet** — the demo venue. Real addresses, real state, real gas, real finalized FDC merkle roots, prefunded test accounts. This is where the oracle deploys and where the forked lending market switches over.
  - **Coston2** — optional public artifact, a clickable deployed address funded by the free faucet.

  This supersedes the earlier "deploy on Flare mainnet, not Coston2" decision, which assumed a funded deploy. Mainnet is still where the evidence and the real economy live; it is simply read rather than written. Native XRP attestation types remain enabled there, which was the original reason for choosing it, and that reason survives intact.
- **Evidence:** complete. Every number in PRD1.md was read from Flare contract state, Blockscout indexes, six EVM RPCs, and the XRP Ledger directly.
- **Contracts deployed:** none on mainnet. `phase4-results.json` records one deployed on the fork at `0x9E545E3C…`, repointed the real market's comptroller at it, and left the market live behind it (fresh anvil per run)
- **Live instance:** none
- **In this repo:** `npm run phase0` — the Phase 0 verifier; `npm run phase1` — the Phase 1 readers, 54/54, writing `readers.json` for Phase 3; `npm run phase2` — 54 fork tests; `npm run phase3` — the publisher, 32/32 against a live fork, writing `phase3-results.json`; `npm run phase4` — the demo consumer, 42/42 against the real forked lending market, writing `phase4-results.json`; `npm run phase5` — the presentation verifier, 97/97, needing no fork and no key, writing `phase5-results.json`; `npm run demo` — the browser demo on `localhost:8080`; plus `Writeup1.md` (the judge-facing writeup), `demo/` (the page, dependency-free), `scripts/lib/` (dependency-free keccak and JSON-RPC/ABI codec), `abi/AssetManager.json` (the merged diamond ABI), `src/` + `test/` (the oracle and its suite), `.github/workflows/publisher.yml` (the cron cadence), and `fork.json` (the pinned block, committed). **Still no `node_modules`, and never will be.**
- **Research scripts:** `C:\Users\HomePC\AppData\Local\Temp\fassets-research\` — pruned to the reusable set. **`README.md` in that directory is the authority**; do not maintain a second inventory here, it will drift.
  - **Signals** — `exit.js` (queue walk + incumbent oracle), `count.js` (full redemption event scan → `redemption-stats.json`), `size.js` (size distribution), `cv.js` (Core Vault + XRPL), `crosschain.js` (OFT across 6 chains), `ingredient.js` (holder distribution)
  - **$0 proof** — `free1.js` (archival depth + CORS), `free2.js` (Coston2 FAssets is live), `free4.js` (forked Relay roots), `hunt.js` → `replay.js` (the decisive proof replay)
  - **FDC** — `fdcfees-matrix.js` (type × source fee matrix), `fdcfees-xrp.js` (found the undocumented `XRPPayment` types), `fdcverify-abi.js` (real `verify*` struct shapes from the implementation)
  - **Support** — `k.js` (dependency-free keccak, imported by most of the above), `abi.js`, `cost.js`, `flr2.js`
  - **No install step.** Nothing imports a package; the whole toolkit runs on stock Node.

## The $0 Proof

Three results, each measured rather than assumed. Together they are why the build costs nothing without costing credibility.

1. **The public RPCs are archival.** `eth_getStorageAt` / `eth_getCode` / `eth_getBalance` return real data **1,000,000 blocks deep** on both mainnet and Coston2. Pinned forking works against the free public endpoint — no Alchemy, no paid archive node. Both also send `access-control-allow-origin: *`, so the frontend reads chain state straight from the browser and **there is no always-on backend to keep awake**.

2. **A fork reproduces mainnet gas.** `redemptionQueue(0,100)`: **535,964 on the fork vs 540,601 on mainnet — 0.9% apart.** Gas claims measured on the fork are honest claims.

3. **A real mainnet FDC proof re-verifies on the fork.** This is the decisive one. `Relay.merkleRoots(200, round)` matched mainnet on **5 of 5** pre-fork rounds, with a `fork+50` control coming back empty — without that empty control the test would prove nothing. Then transaction `0x615c03f28c743a5b2b7580c632d95bd7c8bb9ec4e03cd99405c51b1646665c70` (selector `0xa7556da6`, 1,764 bytes of calldata, mainnet block 66,967,661, status `0x1`, **728,630 gas**) replayed successfully on a fork pinned one block earlier — `eth_call` succeeded, `eth_estimateGas` returned **754,915**.

**The boundary, and state it before a judge asks.** Replay lets you *verify* an existing attestation for free. It does not let you *create* one — a new mainnet attestation still costs 20 FLR. The demo therefore replays attestations **FAssets itself already paid for**, of the same real Core Vault that Herkos measures. Asked "is that a real proof or a mock?", the answer is: real proof, real Core Vault, replayed rather than freshly requested. The request path is covered separately on Coston2, where every attestation type is fee-configured at **1000 wei** — real request flow, test data. Neither half is complete alone; both together are.

**Phase 3 closed both halves.** The verify half is no longer a research-script result: `npm run phase3` deploys the oracle on the fork and the *deployed* `FdcVerification` returns **true** for mainnet proof `0x1df2dda233160bc9d82e127bb8de73d7dca1e5bf491c7ae904f73114f0ef254c` (block 67,012,947, voting round 1,420,598, root `0x539e514f…`). Eight proofs were harvested from below the pin and **8/8 re-encode byte-identical** to the original mainnet calldata — the check that makes a hand-rolled ABI coder trustworthy. On the request half, all five attestation types are confirmed fee-configured on both networks, with the caveat that Coston2's source ids are `testXRP` / `testETH`.

## Phase 0 — closed 2026-08-09

`npm run phase0`: **44/44 checks**, read-only against mainnet, no keys, no cost. Re-runnable, and it is the fastest way to confirm nothing underneath has shifted. Writes `phase0-results.json`, `fork.json`, `abi/AssetManager.json`, `abi/AssetManagerFacets.json`.

- **Everything resolves at runtime** through `FlareContractsRegistry` → `AssetManagerController` `0x097b93ee…` → `getAssetManagers()` → FXRP by `fAsset()`. The known addresses are assertions that the resolver was right, never shortcuts around it.
- **The AssetManager is an EIP-2535 diamond** — 33 facets, 216 selectors, all 33 verified and merged into one ABI (219 functions, 82 events, 214 errors, 216/216 selectors named). This corrected a recorded "docs bug" that was actually a shell-pull artifact; see *What Matters* #6.
- **The fork pin is sticky.** Block **67,013,823**, held in `fork.json`, moved only by `REPIN=true`. Five fingerprints are read at that block and re-verified every run — a pin that follows the head is not a pin.
- **Re-measured, and it drifted:** supply 148.83M → 148.91M, queue 92 → **80** tickets, `redemptionQueue(0,100)` 540,601 → 476,592 gas. Backing still closes (−0.000004%). The thesis is unchanged, and the ticket count moving *down* is the point: the queue length is unbounded in both directions, so the hot path can never walk it. `maxRedeemedTickets = 20` bounds one redemption, not the queue.
- **topic0 for all 14 `Redemption*` events** extracted from the merged ABI, ready for the Phase 1 scan.

## Phase 3 — closed 2026-08-10

`npm run phase3`: **32/32 checks** against a live anvil fork at the pin. Dry-run by default; mainnet is read with `eth_call` only and nothing is broadcast. Writes `phase3-results.json`. Needs `npm run phase1` first for `readers.json`, and the anvil from *How to Run*.

- **The verify half is real.** The deployed `FdcVerification` (resolved through the registry, not hardcoded) returns **true** on the fork for mainnet proof `0x1df2dda2…`, block 67,012,947, voting round 1,420,598, root `0x539e514f…`. Eight proofs harvested from below the pin, **8/8 re-encoding byte-identical** to the original mainnet calldata — including the variable-length trailing `bytes` of `executeDirectMintingWithData`. The harvest anchor is `executeDirectMinting`, not `confirmXRPRedemptionPayment` as first assumed.
- **Both rejections fire for the right reason.** A proof FDC *itself accepts* is refused with `WrongSubject(string,string)` — the vault is that payment's destination, not its source, and crediting an inflow would raise capacity. A post-pin proof is refused with `ProofRejected()`, checked against an empty-root control so the refusal is not a false negative from something else.
- **The divergence gate declined to attest, correctly.** XRPL 7,063,788.996 vs Flare 7,050,810.428 FXRP: +12,978.568 (18 bips), under the 100,000 threshold *and* in the direction that would raise capacity. Either alone is disqualifying. **0 FLR of attestation fees** — a run that attests nothing is the normal outcome.
- **`poke()` reproduced at 1,852,899 gas** from an unrelated account, within 0.9% of Phase 2's 1,836,816.
- **The oracle agreed with the incumbent to 0.08 bips** — $1.039342 vs $1.039350, which is the 999,992 ppm haircut and nothing else.
- **Three venue artifacts worth knowing** before they surprise someone: the run rewinds anvil's clock to the pin (the forked FTSO feed is frozen there while anvil's clock tracks wall time), `forge create` needs `--legacy` (no `eth_feeHistory` on the fork), and Coston2's source ids are `testXRP` / `testETH`. Details in `Tasks1.md`, reasoning in `Memory1.md`.

## Phase 5 — closed 2026-08-10

`npm run phase5`: **97/97 checks**. The only phase that needs no fork, no key and no account — it reads the results files the other phases wrote and makes two read-only live probes. Writes `phase5-results.json`. Deliverables: **`Writeup1.md`** (the judge-facing writeup) and **`demo/`** (`npm run demo`, then `localhost:8080`).

- **The verifier is the deliverable, not the prose.** A presentation is the one artefact nobody re-runs, which is exactly how the ~600k `poke()` estimate and the "collateral factor tightens" phrasing survived as long as they did. So every figure in the writeup and on the page traces back to `fork.json`, `readers.json`, `phase3-results.json` or `phase4-results.json`, and corrupting a digit in any of them turns the run red.
- **The demo reads live, in the browser.** XRPL escrow objects from `xrplcluster.com`, queue and DEX state from Flare mainnet, and the FDC proof re-decoded out of real `executeDirectMinting` calldata and verified by calling the deployed `FdcVerification` from the page. `xrplcluster.com` rather than `s1.ripple.com:51234` for a checkable reason: s1 sends no `access-control-allow-origin`, so it answers curl and fails in a browser.
- **The correlation flag is re-derived, not asserted.** The page reads `token0()`/`token1()` on each pool and classifies from that, so FXRP/stXRP — **2,319,350 FXRP, the deepest pool on Flare** — is visibly counted as zero rather than being declared so.
- **Two lessons from writing the checks**, both kept in `Tasks1.md`: a check that fires on its own disclaimer is worse than no check (the first run flagged the writeup for the phrase it exists to reject), and retired figures should be *paired* rather than banned — no document may carry an old figure without the one that replaced it.
- **Read-only throughout.** Two probes: an `eth_call` to the registry and a CORS preflight. The Relay root for round 1,420,598 is the one fact a judge can check with none of our files.

## How to Run
See setup1.md. The writeup is `Writeup1.md`; the demo is `npm run demo`.

## What Matters

1. **The interface is the product strategy.** `getUnderlyingPrice(address)` unchanged means integration is one governance call. Invent a new interface and adoption is zero.

2. **The publisher must be structurally incapable of moving the number in the dangerous direction.** This is the answer to the "just another trust layer" objection — and state it in exactly that form, because the looser version ("the publisher cannot lie") is not true. Nearly everything Herkos needs is already on Flare and read on-chain by a permissionless `poke()` — queue, Core Vault accounting, OFT Adapter balance, DEX reserves — with FTSO read in the hot path. The small remainder carries an FDC proof verified against `FdcVerification`. The haircut is computed on-chain from those inputs, never submitted.

   FDC proves *specific transactions*, and the publisher picks which to submit, so it can lie **by omission** — attest inflows, skip outflows. Closed by making attested state one-directional: it may only *reduce* measured capacity, never raise it (`min(FlareAccounting, XRPLProved)`). Selective silence can then only make the haircut more conservative, and a publisher that submits nothing leaves the oracle on Flare's own accounting — where every consumer stands today. `XRPPaymentNonexistence` proves an absence outright when a specific claim needs closing. If the publisher dies, the oracle goes visibly stale — it cannot go optimistically wrong.

3. **The hot path must cost what the incumbent costs — and now measurably costs less.** Phase 2, both oracles side by side on the fork: Herkos **70,467 cold / 15,967 warm**, incumbent **110,614 / 24,108**. The 91,042 in earlier drafts is the bare FTSO feed read, not an oracle entrypoint. `getUnderlyingPrice` runs inside Compound's liquidity check on every borrow, redeem, and liquidation, so it reads a cached aggregate; the expensive walk lives in a permissionless `poke()` measuring 1.84M. Without this split the drop-in claim is false.

4. **Agree with the incumbent oracle under normal conditions.** Herkos returning $1.042118 alongside the existing oracle is not a weak demo — it is the credibility. Divergence has to be earned by a real change in measured capacity.

5. **Do not overclaim.** FXRP is healthy: 23,988 redemptions, 8 defaults, every defaulted redeemer made whole plus 5%. The pitch is a missing measurement, not a hidden crisis. Overclaiming loses the room faster than anything else.

6. **Verify against the deployed contract, never the docs — and the explorer is not the contract.** Four documented-vs-deployed mismatches found so far, and one of them — the phantom mainnet Web2Json verifier — would have sent the whole architecture down the wrong path if taken on faith. Pull the ABI. Probe the fee config. Take FDC verify-function struct shapes from the verified `FdcVerification` implementation, not the interface docs.

   Phase 0 added the harder half of this lesson. A fifth "mismatch" was **our own**: the AssetManager is an EIP-2535 diamond, its explorer ABI has zero functions and an incomplete event set, and we read that absence as a protocol fact ("direct-minting rate limits are not live" — they are, 4M XRP/hour). Ask the contract: `facets()` gives 33 facets and 216 dispatchable selectors. **Absence in an ABI proves nothing until you know the ABI is whole.**

## Known Risks

- **Nothing has broken yet.** A judge can reasonably ask why this matters now. The answer is the 61× ratio between lending collateral and permissionless exit, not a past failure.
- **The hot path is a gas budget, not a view call.** `getUnderlyingPrice` runs inside every borrow, redeem, and liquidation. Measured in Phase 2: Herkos 70,467 cold against the incumbent entrypoint's 110,614. The `poke()` / read split is what keeps the drop-in claim true — do not quietly move a queue walk back into the hot path; a test fails if hot-path cost ever implies one. And measure cold in a **separate transaction per oracle**: whichever runs second free-rides on the FTSO slots the first warmed.
- **A fresh `poke()` costs 1.84M gas, and permissionless is not the same as free.** Three times the ~600k originally estimated: agent-liveness filtering is ~282k per unique agent and dominates the queue read. Cost scales with unique agents, not tickets — 80 tickets resolve to 6 agents. Production wants an incentive for whoever pays it. On the fork it costs nothing, and for the demo the publisher pays — but the claim to make is that the refresh is *permissionless*, never that it is *free*. Anyone can call it, including a judge; that is the property worth defending.
- **FDC proves transactions, not balances, and the publisher chooses which to submit.** Lying by omission is the real attack, not forgery. Bounded by the one-directional rule (`min(FlareAccounting, XRPLProved)`) and `XRPPaymentNonexistence`. State the bound, not an absolute.
- **766,000 FXRP/day is demonstrated throughput, not capacity.** It measures how much has been asked for, not how much is possible. The honest framing: real capacity is unknown, and that unknown is exactly the gap Herkos fills.
- **FDC fees are 20 FLR per attestation** on mainnet (3 FLR for `ConfirmedBlockHeightExists`). A naive 15-minute heartbeat is ~96 requests/day ≈ **1,920 FLR ≈ $11.74/day** at $0.0061133/FLR — real money over time, for no new information. So the publisher is event-driven: attest on divergence, not on a timer. Budget and log the spend. **The hackathon build never pays this at all** — the demo replays attestations FAssets already paid for, and the request path is exercised on Coston2 where every type is fee-configured at ~0. Present it as a production cost note, not a wall you hit.
- **Per-chain OFT supply is not FDC-provable on mainnet.** `EVMTransaction` covers ETH/FLR/SGB only. Mitigated correctly: the OFT Adapter's locked balance on Flare is the aggregate of all remote claims and reconciles to a gap of exactly 0 — same-block, 12,941,706,148,299 UBA on both sides (Phase 1). Comparing the pin against remote heads gives 0.0917%; that is bridging in the interval, and the reader now reports both readings rather than one. State this plainly rather than implying per-chain proofs exist.
- **Liveness modelling is a judgement call.** Decay constants and default penalties are chosen, not derived. Publish them and defend them rather than hiding them in a constant.
- **Escrow release is condition-gated, not time-gated.** The XRPL escrows carry `Condition` + `CancelAfter`; only one has `FinishAfter`. Release needs multisig operators presenting a preimage. Any "time until unlock" model must reflect operator cadence, not a countdown — an earlier draft got this wrong. The object count is itself evidence for that: 17 escrows at the original pass, **15** at the 2026-08-09 re-measurement, holding the same ~140M XRP. The cycle re-forms; do not read the count as a balance.
- **XRPL balance snapshots are not a native attestation type.** FDC proves XRP *transactions*, not "the account held N at time T." Herkos handles this by reading Flare-side CV accounting on-chain and using XRPL attestations as a *divergence check* — proving flows the Flare bookkeeping has not reflected. That is the honest capability; do not describe it as a proved balance.
- **Small agent set.** 6 agents back the whole queue. Concentration is a real input to the model, not a footnote.
- **Registering the DEX pools used to tighten the haircut, and the fix generalises.** `_clearingPPM` filled its DEX slice with `min(amount, dexExitUBA)` unconditionally, so pools *raised* `exitCapacity` while *tightening* the reference haircut — 999,992 ppm at `dexExitUBA = 0` versus **627,540 ppm** with the three FXRP/USD₮0 pools registered, because constant product charges `x/(x+dx)` for 1M FXRP against a 1.68M reserve. **Phase 4 closed it.** The principle to carry forward: **an exit venue is optional**, so knowing one exists can never make an exit price worse than it was without it — `_clearingPPM(n) >= _redeemPPM(n)` is an invariant, not a preference. The slice is capped at `dx* = dex × (1 − √k)/√k`, where the marginal DEX unit stops beating redemption. Measured after: the same pools now move capacity **8.91M → 10.60M FXRP with the haircut unchanged at 999,992 ppm**. Pinned by three tests; the first fails against the old code at its first rung. Still say which state a number came from.
- **An oracle cannot move a collateral factor — do not say it does.** `collateralFactorMantissa` is a governance constant and reads 0.70 on the live cFXRP market at every `referenceSize`. What Herkos moves is the *USD value of collateral*, hence borrowing power. Report **effective CF = CF × haircut** and real `getAccountLiquidity` deltas: 0.7000 → 0.6894, $2,662,798 → $2,585,734 across 8 real borrowers, 1M → 300M FXRP, zero shortfalls. The looser phrasing was in four documents and a judge breaks it by reading the comptroller.
- **Publisher key.** It pays gas and attestation fees but holds no authority over values. Keep it on the backend, out of the browser, and make its powerlessness explicit in the writeup — it is the exact thing that sank the earlier design.

## Ownership
Solo build, shipping with model assistance. No external dependencies on other people.
