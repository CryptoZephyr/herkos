# Tasks — Herkos

Goal: an on-chain oracle that publishes FXRP exit capacity, consumed through the standard Compound price-oracle interface, with all off-Flare inputs carrying FDC proofs.

**Phases 0, 1, 2, 3 and 4 are closed.** `npm run phase0` (44 read-only checks), `npm run phase1` (54 reader checks), `npm run phase2` (**54** fork tests + 2 gas budgets), `npm run phase3` (32 checks against a live fork), `npm run phase4` (42 checks against the real forked lending market). Phase 2 was built ahead of Phase 1 because the contract is what the gas budget and the trust model both live in. Nothing in Phase 2 depends on Phase 1: `poke()` reads the chain itself. Phase 4 grew the Phase 2 suite from 51 to 54 — the three routing tests that pin the DEX fix. What remains is Phase 5 (presentation).

## Phase 0 — Prep

Phase 0 is closed. `npm run phase0` re-verifies all of it read-only against mainnet in one pass — **44/44 checks**, no keys, no cost. It writes `phase0-results.json`, `fork.json`, `abi/AssetManager.json`.

- [x] ~~Resolve AssetManager FXRP + FXRP token through `FlareContractsRegistry` at runtime~~ — **done.** `getAllContracts()` → `AssetManagerController` `0x097b93ee…` (not previously recorded) → `getAssetManagers()` → identify FXRP by `fAsset()` → `symbol()`. Never hardcoded; the known addresses only assert the resolver returned the right thing
- [x] ~~Confirm `redemptionQueue(uint256,uint256)` return shape~~ — **done, structurally.** `(RedemptionTicketInfo[], uint256 nextId)`, struct `{ticketId, agentVault, ticketValueUBA}`, confirmed by `bodyWords === len × 3` rather than assumed, then cross-checked: every decoded `agentVault` is a contract. Dispatched from facet `0xe57cea67…`
- [x] ~~Confirm `CoreVaultManager` accessors~~ — **done.** `availableFunds()`, `escrowedFunds()`, `totalRequestAmountWithFee()`, and `coreVaultAddress()` returning the XRPL account as a **string** (`rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj`) — bind attestations to that. Reached via `getCoreVaultManager()`, resolved, not hardcoded
- [x] ~~Verify `Web2Json` availability on the target network~~ — **done.** Probed `getRequestFee` across all type/source pairs: unavailable on Flare mainnet, available on Coston2. Design no longer needs it (Architecture1.md)
- [x] ~~Decide deployment target~~ — **three venues, $0 total.** Mainnet supplies evidence (read-only). The demo deploys to an **Anvil fork of Flare mainnet** — real addresses, real state, real gas, real FDC roots. Coston2 is an optional public artifact off the free faucet. This supersedes the earlier "mainnet, not Coston2" decision, which assumed a funded deploy
- [x] ~~Measure the gas cost of a queue walk~~ — **done, and it changed the design.** `redemptionQueue(0,100)` costs 540,601 gas vs the incumbent oracle's 91,042. Too expensive for the hot path → `poke()` / `getUnderlyingPrice` split (Architecture1.md)
- [x] ~~Confirm `FdcHub.requestAttestation` is permissionless~~ — **done.** `payable`, no access control
- [x] ~~Locate the on-chain verifier~~ — **done.** `FdcVerification` `0x5c14fe9d…` is an ERC-1967 proxy → impl `0xf7f0057b…`. Pull verify-function struct shapes from **that** ABI; the docs' shapes differ
- [x] ~~Confirm FDC Relay + DA Layer endpoints for mainnet~~ — **done.** Relay `0xccf30790…`, `merkleRoots(uint256,uint256)`, `fdcProtocolId()` = 200. DA Layer proof route is `POST /api/v1/fdc/proof-by-request-round` (`GET` → 405; bad bytes → 400 `attestation request not found`)
- [x] ~~Fund the publisher with FLR~~ — **not required.** The build costs $0. Anvil prefunds account 0 for the fork deploy; the Coston2 faucet (100 C2FLR / 24 h, ungated) covers the optional public artifact. Never point `--broadcast` at mainnet
- [x] ~~Verify the free path actually works~~ — **done, and it is the strongest evidence in the project.** Public RPCs are archival 1M blocks deep · forked gas within 0.9% of mainnet (535,964 vs 540,601) · `Relay.merkleRoots` matched on 5/5 pre-fork rounds with the `fork+50` control empty · **mainnet tx `0x615c03f2…` carrying a real FDC proof replayed successfully on a fork pinned one block earlier** (mainnet 728,630 gas, fork estimate 754,915) · both RPCs send `access-control-allow-origin: *` so no backend is needed
- [x] ~~Pull the deployed AssetManager ABI from the explorer~~ — **done, and the explorer alone would have been a trap.** The AssetManager is an **EIP-2535 diamond**: asking the explorer for the ABI at `0x2a3fe068…` returns only the proxy shell — 71 items, **zero functions**. The authority is the on-chain loupe. `facets()` → 33 facets / 216 selectors; each facet's ABI fetched and merged → **219 functions, 82 events, 214 errors, 216/216 selectors named**. Written to `abi/AssetManager.json`, dispatch table to `abi/AssetManagerFacets.json`. A selector present in the loupe **is** dispatchable, whatever any explorer says. This corrected one recorded mismatch — see Memory1.md
- [x] ~~Pin a fork block and record it~~ — **done. `67,013,823`** (2026-08-09T14:16:54Z), in `fork.json`, committed. The pin is **sticky**: once `fork.json` exists the block is held and only `REPIN=true` moves it — a pin that follows the head is not a pin. Five fingerprints (FXRP supply, queue tickets/value, CV available/escrowed) are read **at** the pinned block and re-verified byte-for-byte on every run; a mismatch means the RPC lost archival depth or is serving a different chain. Confirmed still archival 1,000,000 blocks deep

## Phase 1 — Readers (off-chain, no chain writes)

**Status: closed. `npm run phase1` — 54/54 checks passed.** All eight items are implemented in
`scripts/phase1.js` — read-only, dependency-free, every Flare read at the pinned block,
everything resolved through `FlareContractsRegistry` at runtime. Writes `readers.json` (what the
Phase 3 publisher consumes), `phase1-results.json`, and `cache-redemption-events.json` keyed to
the pin, so a re-run at the same pin skips the ~20M-block scan.

Every recorded number reproduced. The scan found **24,010 requests / 23,988 settlements /
259,044,318 FXRP settled / 8 defaults (0.0333%)** over 338 days, confirming live that the
documented `RedemptionPerformed` signature finds zero settlements and the deployed topic0
(`0xd5150395…`) finds all of them. 80 queue tickets resolve to **6 unique agents**, which is why
`poke()` scales with agents rather than tickets.

The first run was 52/54. Both failures were section 6, and both were one mistake — mine, not the
system's:

- **The OFT reconciliation was comparing across time.** The adapter was read at the pin while the
  five remote chains were read at their heads, producing a −11,851 FXRP (0.0917%) gap. Reading
  the adapter at the head as well closes it to **0 UBA — exact, to the last digit**
  (12,941,706,148,299 both sides). The invariant was never broken; the comparison was. Both
  readings are now reported: the pin figure is what `poke()` stored and what Phase 2
  fingerprinted, the head figure is the one that can reconcile. Asserted as a 1-bip band rather
  than exact equality — seven reads at seven instants, and one bridge transaction landing
  mid-sweep moves the sum honestly.
- **Katana was mislabelled `UNREACHABLE`.** `rpc.katana.network` answers (chainId `0xb67d2`);
  `eth_getCode` at the shared OFT address returns `0x`. There is no FXRP deployment there. The
  reader now separates *does the chain answer* from *is FXRP deployed* with an explicit
  `getCode`, and asserts only the first — a chain that answers and holds no FXRP contributes a
  true zero, while a chain that cannot be reached would understate the total silently.

What was verifiable without executing was verified first, by reading:

- topic0 for all four scanned events recomputed from the merged facet ABI in
  `phase0-results.json`, and the deployed `RedemptionPerformed` hash (`0xd5150395…`) asserted
  *different* from the documented `uint64 requestId` signature — the docs bug that made the
  earlier research pass report zero settlements
- value-field word indices read from `abi/AssetManager.json` rather than counted:
  `RedemptionRequested.valueUBA` w1, `RedemptionWithTagRequested.valueUBA` w1,
  `RedemptionPerformed.redemptionAmountUBA` w1, `RedemptionDefault.redemptionAmountUBA` w0;
  `agentVault` is `topics[1]` in all four
- the exit model is an exact port of `_clearingPPM` / `_timeToExit` / `_recompute`, checked
  line by line, and its constants against the deployed constructor
- the arithmetic behind every assertion recomputed by hand from `fork.json` and
  `phase2-results.json`: `1,860,950,000,000 + 7,050,810,428,154 = 8,911,760,428,154` capacity,
  999,992 ppm at the 1M reference, 997,526 ppm at 50M, the three `timeToExit` tiers
  (1,800 / 88,200 / 5,272,200 s), and backing closing at −0.0000042%
- `client.call` / `client.probe` in `scripts/lib/rpc.js` do **not** hex-convert a numeric block
  the way `getStorageAt` does, so every one of the ~20 Flare call sites passes a pre-hexed `at`
- every Flare read now passes `at`, **including the six resolution reads** — registry
  `getAllContracts()`, `getAssetManagers()`, `fAsset()`, `symbol()`, `decimals()`,
  `getCoreVaultManager()`. They were reading at `latest` while the state reads were at the pin.
  Nothing breaks today, and the `EXPECT` assertions would have caught a swapped AssetManager
  loudly — but identity is state, and resolving at `latest` to then read pre-pin state is a
  contradiction the file header explicitly disclaims. `M.blockNumber()` stays at head, since
  comparing head to pin is its whole job, and the six remote chains stay at their own heads
  with the cross-time artifact stated

Eight runtime defects were found and fixed this way, none of which a syntax check would have
caught: `Math.abs` on a BigInt, unguarded `BigInt()` on explorer log fields, no retry on a 20M
block scan, silent truncation at an un-bisectable block, a ~24k-element argument spread, a DEX
pool with an unreadable quote token coercing to zero, `Infinity` reaching `JSON.stringify`, and
— found last, by diffing the port against `src/ExitCapacityOracle.sol:508` line by line — a
missing `rate == 0 ? 3650 : …` branch in `timeToExit`. The deployed escrow rate is nonzero, so
that branch is unreachable today; a governance setter taking it to zero would divide by zero in
the reader while the contract answered 3,650 days. A port that drops a branch because the
current state never reaches it stops being a port.

Ten in total: execution then found the two the reading passes could not, both in section 6 and
both described above — the cross-time OFT comparison and the conflation of an unreachable chain
with an absent deployment. Neither is reachable by inspection; both needed the network to answer.
That is the argument for running the thing, not the argument against reading it first — reading
caught eight, and the two that survived were assumptions about the world rather than errors in
the code.

- [x] ~~Walk the full redemption queue, page through `nextId`, produce per-agent totals~~ — **done.** 100-ticket pages to the contract's `maxQueuePages` = 40, 3-word tuple stride. **Measured: 80 tickets / 1,860,950 FXRP across 6 unique agents**, cursor terminating at 0 in 1 page; per-agent totals sum back to the queue total, and the `fork.json` fingerprint reproduced
- [x] ~~Scan `RedemptionRequested` + `RedemptionWithTagRequested` + `RedemptionPerformed` + `RedemptionDefault` over the full deployment window, cached~~ — **done.** topic0 recomputed from `phase0-results.json` (`facts.redemptionEventTopics`), never from docs signatures. Blockscout `getLogs` with bisect-on-cap, retry/backoff, cache keyed to the pin. **Measured over 47,098,178 → 67,013,823 (19,915,645 blocks): 24,010 requests · 509 tagged · 23,988 settlements · 8 defaults · 259,044,318 FXRP settled · 766,223 FXRP/day · sizes p50 450 / p90 22,337 / max 521,540**
- [x] ~~Build `liveness(agent)` from settlement recency + default history~~ — **done.** Two layers kept distinct: the binary `status <= 1` filter `poke()` applies on-chain via `getAgentInfo` (`0x152052b0`, selector asserted equal to the one the contract staticcalls), and an off-chain recency/default decay that only ever weights downward. **Measured: 7 agents across 48,006 events; 6/6 queue agents pass the on-chain filter, while the off-chain model weights 1,860,950 raw FXRP down to 496,638** — the two layers disagreeing is the point, and the constants print at runtime so they can be argued with
- [x] ~~Read XRPL Core Vault: `account_info` balance, `account_objects` escrow list~~ — **done.** JSON-RPC POST against the `coreVaultAddress()` string `rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj`. **Measured: 7,063,789 XRP at the validated ledger vs 7,050,810 on Flare at the pin = +12,979 XRP (18.4 bips)**, and **15 escrows totalling 140,000,020 XRP, 15/15 condition-gated** with only 1 carrying `FinishAfter`. Divergence is computed as the publisher's one attest/don't-attest decision, and only a divergence that *lowers* capacity is attestable
- [x] ~~Read the OFT Adapter's locked FXRP balance on Flare — this is the aggregate of all remote claims~~ — **done.** **Measured 12,929,855,160,693 UBA at the pin**, matching the `remoteClaimsUBA` Phase 2 recorded exactly; 8.68% of supply, inside total supply rather than added to it, and never counted as exit capacity
- [x] ~~Read per-chain OFT supply (Ethereum, Monad, HyperEVM, Base, BNB) for presentation; confirm it still reconciles to the adapter balance~~ — **done, and it reconciles to 0 UBA exactly.** **Ethereum 7,834,742 · Monad 3,797,975 · HyperEVM 1,101,503 · Base 123,873 · BNB 83,613 = 12,941,706,148,299 UBA, identical to the adapter at the same head.** Katana answers but has no FXRP deployment at the OFT address (`eth_getCode` → `0x`), so it contributes a proven zero rather than an assumed one. Compare against the pin instead and the gap is −11,851 FXRP — elapsed bridging, not a discrepancy
- [x] ~~Read DEX pool reserves; classify pairs as exit vs correlated; build slippage curve~~ — **done.** Classification by calling `token0()`/`token1()` and reading the quote symbol, never by trusting a constant's name. **Measured: 4 FXRP pools — FXRP/stXRP 2,319,350,567,176 excluded as correlated, three FXRP/USD₮0 summing to 1,684,853,279,972 counted**, the excluded pool being the deeper one. Quote side normalises to 1,192,547,828,650 at 6 dp, and the curve reproduces 999,992 ppm at 1M and 997,526 at 50M
- [x] ~~Reconcile: queue + CV available + CV escrowed vs FXRP total supply (should close under 0.02%)~~ — **done.** **1,860,950 + 7,050,810 + 140,000,000 = 148,911,760 vs 148,911,767 supply → −0.000004%**, three orders of magnitude inside the 0.02% bound

**Carried out of Phase 1 into Phase 4, and closed there — a real finding, flagged rather than absorbed.**
`_clearingPPM` used to fill its DEX slice with `min(amount, dexExitUBA)` unconditionally, so
registering the exit pools *raised* `exitCapacity` (8,911,760,428,154 → 10,596,613,708,126)
while *tightening* the reference haircut — constant product charges `x/(x+dx)` for 1M FXRP
against a 1.68M reserve, taking 999,992 ppm down to **627,540 ppm**. The comment at
`src/ExitCapacityOracle.sol:468` said "fill from the DEX until it stops being cheaper than
redeeming"; the code made no such comparison. Phase 2 measured every haircut at
`dexExitUBA = 0`, so nothing recorded was ever wrong — but a market that registered pools got
a materially different number. **Phase 4 made the comment true.** The slice is now capped at
the depth where the two legs price equally, `dx* = dex × (1 − √k) / √k` for `k` the redemption
ratio, because *nobody is forced onto an AMM* — an exit venue you may ignore cannot make the
exit price worse. Registering the same three pools now moves capacity
**8,911,760.428 → 10,596,613.708 FXRP with the haircut holding at 999,992 ppm**. Three tests
pin it (`test_dexCanOnlyImprove`, `test_registeringPoolsWidensCapacityWithoutTighteningTheHaircut`,
`test_clearingPriceStaysMonotonicWithPoolsRegistered`); the first fails against the old code at
its first rung.

**How to reproduce Phase 1**

```bash
npm run phase1              # RESCAN=true npm run phase1  forces a fresh event scan
```

No anvil, no keys, no funded account — `eth_call` at the pin, Blockscout `getLogs`, XRPL
JSON-RPC, and the six remote-chain RPCs, all read-only. The first pass is slow: four event
types across ~20M blocks (47,098,178 → the pin), bisecting whenever a page returns at the
1,000-log cap. It caches to `cache-redemption-events.json` keyed to the pin, so a second run at
the same pin is instant and moving the pin invalidates the cache on its own. Writes
`readers.json` (what the Phase 3 publisher consumes) and `phase1-results.json`; both are
gitignored alongside `phase0-results.json`, because they are regenerable measurement output and
the publisher should read live state rather than trust a checked-in snapshot.

The script exits non-zero if any check fails, so it is a gate rather than a report.

## Phase 2 — Oracle Contract

**Status: closed.** `npm run phase2` runs the suite and writes `phase2-results.json`
— **54/54 fork tests** across five files, against a local anvil pinned at 67,013,823.
Three claims written below were measured false; each is corrected in place and the
strikethrough is kept so the correction is legible rather than silently absorbed. The suite
grew from 51 to 54 in Phase 4: the three routing tests that pin the DEX-slice fix.

**Hot path — ~~must stay at parity with the incumbent (~91k gas)~~ measured cheaper than the incumbent, both cold and warm**

- [x] `ExitCapacityOracle.sol` with Compound-compatible `getUnderlyingPrice(address)` — `src/ExitCapacityOracle.sol`, one governance call to adopt, `isPriceOracle() == true`
- [x] ~~Return `ftsoPrice × 1e30 / 1e18` scaling~~ — **wrong by twelve orders of magnitude.** The feed is 6 decimals and so is FXRP, so the mantissa is `value × 10^(36 − 6 − 6)` = `value × 1e24`. Verified against the incumbent exactly: `mine == theirs × haircut ÷ 1e6`, so the haircut (999,992 ppm, 8 ppm) is the entire difference and no scaling error hides inside it
- [x] `getUnderlyingPrice` reads **only** the cached aggregate + FTSO XRP/USD, then applies the haircut — never walks the queue. Guarded by a test that fails if hot-path cost ever implies a walk
- [x] Measured. **70,467 cold / 15,967 warm** vs the incumbent's **110,614 / 24,108** on identical footing. ~~the incumbent's 91,042~~ — that figure is the bare FTSO feed read, not an oracle entrypoint; measuring both in one transaction is order-biased, so cold is measured in two separate transactions with fresh access lists
- [x] Non-FXRP markets delegate to the incumbent unchanged. `_setPriceOracle` repoints every market at once, so without this, adopting Herkos would break isoUSDT0 and isoSTXRP and the one-call claim would be false

**Refresh path — permissionless, expensive, off the hot path**

- [x] `poke()` — walks the queue, reads `CoreVaultManager` funds, OFT Adapter balance, DEX reserves; writes the aggregate + block + timestamp to storage
- [x] No arguments, no access control, no submitted values. Two different callers in the same block land on the same haircut
- [x] Page the queue walk defensively — bounded by `maxQueuePages × queuePageSize`, and hitting the budget sets `queueTruncated` rather than returning a short number as though it were complete
- [x] ~~poke() costs ~600k gas~~ — **measured 1,836,816.** The 600k covered `redemptionQueue(0,100)` alone (472,212 forked / 540,601 mainnet) and omitted agent-status filtering, the dominant term at **~282k per unique agent**. The walk caches each vault, so 80 tickets resolve to **6 unique agents** and per-ticket cost is 13,055 on a warm re-poke. 1.84M is 6.5% of Flare's 28,027,352 block limit, ~1.19 FLR at 650 gwei. Bound stated plainly: ~97 distinct agents would fill a block; `setQueueWalkBounds` is the knob and truncation is flagged
- [x] Exit venues wired and correlation-aware — the deepest FXRP pool at the pin is **FXRP/stXRP (2.32M FXRP)** and both sides are XRP, so it is a rotation, not an exit. Registered and excluded; it contributes **0** to `dexExitUBA` and does not move capacity by one UBA. Real uncorrelated depth is three FXRP/USD₮0 pools, **1,684,853 UBA**. The OFT Adapter's 12,929,855 UBA is recorded as remote claims, never counted as exit capacity

**Proof path**

- [x] Storage for attested off-Flare state + timestamp
- [x] FDC proof verification against `FdcVerification` before any attested value is stored — struct shapes from the verified implementation ABI. A proof FDC does not accept is refused; so is a failed XRPL payment, a replayed transaction id, and a non-positive or `uint128`-overflowing amount (wrapping would *shrink* the reduction, the one unsafe direction)
- [x] Reject proofs whose attested subject is not the Core Vault address — read from the deployed `CoreVaultManager` at call time, not stored at construction, so it cannot drift from the live vault
- [x] **One-directional rule** holds. `test_omittedOutflowCannotInflateCapacity` is the test: staying silent leaves the oracle on Flare's own accounting — exactly where every consumer stands today — and reporting a 500k outflow moves capacity 8,911,760,428,154 → 8,411,760,428,154 and can only lower the price. There is no input, from any caller, that raises capacity above Flare's accounting. Anyone may relay, which is what keeps the publisher a relayer rather than an authority
- [x] Proofs are retired only when Flare's own accounting catches up — the sound reason, since double-counting would then understate capacity. Ageing a proof out never restores capacity

> Proofs are mocked at the `FdcVerification` boundary here; what is under test is what Herkos does with a proof once FDC has accepted it, including refusing one. Replaying a **real** finalized mainnet attestation is Phase 3 (`npm run replay`).

**Derived surfaces and guards**

- [x] `clearingPricePPM(uint256)`, `timeToExit(uint256)`, `exitCapacity()`. Clearing price falls with size (999,992 at 10k and 1M FXRP, 997,526 at 50M); `timeToExit` is tiered — 1,800s inside the queue, 88,200s reaching the Core Vault, 5,272,200s beyond it. No exit is instant: even 1 UBA waits for measured agent settlement
- [x] Haircut computed on-chain from stored inputs, not submitted. There is no setter for the price, the haircut, or capacity — asserted by selector, so adding one later breaks the test
- [x] Staleness guard on **both**. An unpoked oracle **refuses to price** rather than falling back or pricing at par; the feed has its own separate window so neither guard masks the other; and staleness is cleared by anyone poking, which is what makes refusing acceptable. Non-FXRP markets keep working through a stale FXRP measurement. Attested state is **flagged, never cleared** — expiring a proof would raise capacity
- [x] Governance setters: `referenceSize`, exit model (settlement, vault cycle, escrow rate, discount rate), haircut floor, divergence threshold, staleness windows, queue-walk bounds, exit pools, OFT adapter. All gated; bad parameters refused rather than stored; governance transfer is two-step

## Phase 3 — Publisher

**Status: closed. `npm run phase3` — 32/32 checks passed** against a live anvil fork at the pin.
Implemented in `scripts/phase3.js`, dependency-free like the rest. Writes `phase3-results.json`.

The full FDC loop is **request → finalize → fetch proof → submit → verify**. At $0 it is covered in two halves, and together they exercise every step:

- **Verify half, on the mainnet fork — real data, real proof.** Harvest a finalized attestation FAssets itself already paid for (it drives FDC constantly to confirm XRPL redemption payments of the same Core Vault Herkos measures), then submit that `(data, proof)` to the oracle and watch `FdcVerification` accept it. Proven working: mainnet tx `0x1df2dda2…` (block 67,012,947, voting round 1,420,598) replayed on the fork, `verifyXRPPayment` → **true**
- **Request half, on Coston2 — real request path, test data.** Every attestation type is fee-configured at 1000 wei there, so the request path costs effectively nothing. The caveat is testXRP, and the writeup states it

Neither half alone is complete; both together are, and the boundary is stated rather than blurred.

- [x] ~~Wire the Phase 1 readers into a single collection pass~~ — **done.** Section 1 loads `readers.json`, asserts it is at the same pin as `fork.json`, then re-reads the Core Vault live rather than trusting the snapshot
- [x] ~~Call `poke()` on the publisher's own cadence~~ — **done, and the permissionlessness is the assertion.** Called from Anvil account 1, an address with no relationship to the deployer and no governance role: **1,852,899 gas** (~1.20 FLR at 650 gwei, 6.6% of a Flare block). Within 0.9% of the 1,836,816 measured in Phase 2. Calldata is 4 bytes — the selector and nothing else, so there is no submitted value to trust
- [x] ~~Divergence check: XRPL Core Vault reality vs `CoreVaultManager` accounting~~ — **done, and it correctly declined to attest.** XRPL 7,063,788.996 vs Flare 7,050,810.428 FXRP — **+12,978.568 FXRP (18 bips)**, under the 100,000 threshold *and* in the direction that would raise capacity. Either alone is disqualifying. A run that attests nothing is the normal outcome, not a skipped step
- [x] ~~**Harvest path:** scan AssetManager transactions for proof-carrying calldata…~~ — **done.** 8 `IXRPPayment` proofs decoded from below the pin, and **8/8 re-encode byte-identical to the original mainnet calldata** — the load-bearing check for a hand-rolled ABI coder, including the variable-length trailing `bytes` of `executeDirectMintingWithData`. The anchor is `executeDirectMinting`, **not** `confirmXRPRedemptionPayment` as first assumed
- [x] ~~**Request path (Coston2):** request `XRPPayment` for Core Vault flows~~ — **done as dry-run calldata.** `requestAttestation(bytes)` built to 164 bytes and printed, not broadcast. `XRPPayment` over generic `Payment` confirmed by the response body: the XRPL address arrives as a `string`
- [x] ~~Use `BalanceDecreasingTransaction` (XRP) for outflows~~ — fee-configured both networks (C2 1000 wei / mainnet 20 FLR)
- [x] ~~Request `XRPPaymentNonexistence` (XRP)~~ — fee-configured both networks (C2 1000 wei / mainnet 20 FLR)
- [x] ~~Request `ConfirmedBlockHeightExists` (XRP) as the freshness anchor~~ — confirmed **cheapest type: 3 FLR** on mainnet vs 20 for the rest, 1000 wei on C2
- [x] ~~Optional: `EVMTransaction` (ETH) for Ethereum OFT supply~~ — fee-configured, and left optional. Mainnet `EVMTransaction` covers ETH/FLR/SGB only, so per-chain OFT supply stays non-provable; the OFT Adapter's locked balance remains the aggregate
- [x] ~~Poll for voting-round finalization, fetch Merkle proof from the DA Layer~~ — **done, with the boundary stated.** The endpoint is live and answering (`POST …/proof-by-request-round`). This run does **not** reconstruct the original request bytes — they carry a MIC not recoverable from a proof — so the DA fetch is informational. The binding check is the next line: `FdcVerification` validates the Merkle path against a root the fork already holds, which trusts no off-chain API
- [x] ~~Submit `(data, proof)` to the oracle; confirm on-chain verification passes~~ — **done. `FdcVerification.verifyXRPPayment` → true** on the fork for real mainnet proof `0x1df2dda2…`, round 1,420,598, root `0x539e514f…`. Real proof, real Core Vault, **replayed rather than freshly requested** — replay verifies an existing attestation for free; it does not create one
- [x] ~~Reject a proof for the wrong subject and a proof for a post-fork round — both should fail, and failing is the test~~ — **done, and both failed for the right reason.** A proof FDC *itself accepts* is refused with `WrongSubject(string,string)` because the vault is that payment's destination, not its source — crediting an inflow would raise capacity. A round-1,421,530 proof (finalized after the pin) is refused with `ProofRejected()`: the fork holds no root for it, verified against an empty-root control
- [x] ~~Event-driven scheduler with heartbeat floor…~~ — **done.** `.github/workflows/publisher.yml`: cron `7,37 * * * *` (offset off the hour deliberately), `concurrency` group so a slow run cannot overlap and double-submit, `PUBLISH` defaulting false. It *checks* every 30 min and *attests* only on divergence
- [x] ~~Track FLR spend per published update; log it~~ — **done.** Fork 0 FLR; mainnet-equivalent poke 1.20 FLR; **0 attestations requested**, because the gate was closed. Logged either way
- [x] ~~Log every published number with its input provenance~~ — **done.** `inputs()` returns all 12 derived values in one call, so a consumer can re-derive the haircut rather than trust it. Herkos priced **$1.039342** against the incumbent's **$1.039350** — 0.08 bips apart, which is the 999,992 ppm haircut and nothing else

## Phase 4 — Demo Consumer

**Status: closed.** `npm run phase4` runs the whole demo and writes `phase4-results.json`
— **42/42 checks** against a live fork, in one pass, from a clean anvil at the pin.

Runs entirely on an **Anvil fork of Flare mainnet** at a pinned block. Not a mock market and not a testnet redeploy — the real deployed Compound fork at `0x15f69897…`, the real cFXRP at `0xD1b7A5eF…`, the real incumbent oracle at `0x61f77ef0…`, all carrying their real mainnet storage.

- [x] ~~Boot `anvil --fork-url <mainnet> --fork-block-number $FORK_BLOCK`~~ — **done.** Head at 67,013,823, chainId 14, and bytecode present at all three market addresses before anything is read from them
- [x] ~~Read the live comptroller / cFXRP / incumbent oracle **through the fork**; confirm they return the same values as mainnet~~ — **done, 7/7 reads identical** at the pinned block: `comptroller()`, `oracle()`, `getUnderlyingPrice(cFXRP)`, `markets(cFXRP)`, `exchangeRateStored()`, `totalSupply()`, `underlying()`. Fork and mainnet queried at the same block height, so a match is a match rather than a coincidence of timing
- [x] ~~Point it at the incumbent oracle; record collateral factor and borrow capacity~~ — **done, and it already was pointed there** — the check is that the run *starts* on the incumbent, not that it is put there. **CF 0.70, incumbent price $1.039350, exchangeRate 200,101,723,146,878**, and **8 real borrowers** carrying **$2,662,839.03** of combined borrow capacity with **zero** accounts in shortfall
- [x] ~~Deploy `ExitCapacityOracle` with Anvil's prefunded account 0 — no faucet, no FLR~~ — **done.** `forge create --legacy --broadcast` against `http://localhost:8545`, deployed at `0x9E545E3C…`, then `registerFXRPMarket(cFXRP)` and a first `poke()` — **1,853,742 gas from an unprivileged caller** (Anvil account 2, which has no relationship to the deployer)
- [x] ~~Impersonate the comptroller admin (`anvil_impersonateAccount` / `anvil_setBalance`) and call `_setPriceOracle(herkos)`~~ — **done, and the negative case first.** The admin is `0x37c6c7c7…`, and it is a **contract** rather than an EOA — impersonation is what makes it callable at all. An unprivileged `_setPriceOracle` returns **error code 1** rather than reverting (Compound signals by return value, so a run that only checked for a revert would have recorded a silent no-op as success). Impersonated, it costs 35,577 gas and `comptroller.oracle()` reads back Herkos. This is the step that is impossible on real mainnet without governance, and the exact reason a fork is the right venue rather than a shortcut
- [x] ~~Confirm identical behaviour at `referenceSize` = small — agreement first, divergence has to be earned~~ — **done.** Herkos **$1.039342** against the incumbent's **$1.039350** — **0.08 bips**, which is the 999,992 ppm haircut and nothing else. `spotUnderlyingPrice()` is byte-identical to the incumbent, so the entire difference is the haircut and none of it is a feed discrepancy. cUSDT0 — a market Herkos does *not* measure — delegates to the fallback and prices **byte-identically at $0.999210**, which is what makes this a drop-in rather than an FXRP-only oracle
- [x] ~~Raise `referenceSize` to 10M FXRP; show the collateral factor tighten~~ — **done, and the claim needed correcting.** `collateralFactorMantissa` is a **governance constant**; it reads 0.70 at every rung and an oracle cannot move it. What an oracle moves is the *USD value of collateral*, hence borrowing power. Reported as **effective CF = CF × haircut** plus real `getAccountLiquidity` deltas across the 8 borrowers: **1M → 999,992 ppm / 0.7000 / $2,662,798.48**, **10M → 999,170 / 0.6994 / $2,658,632.54**, **50M → 997,526 / 0.6983 / $2,650,300.65**, **150M → 992,184 / 0.6945 / $2,623,227.07**, **300M → 984,786 / 0.6894 / $2,585,733.56**. Time-to-exit walks 0.0d → 2.0d → 6.0d → 19.0d → 37.0d, the haircut is monotonically decreasing, and the 500,000 ppm floor holds
- [x] ~~Submit a harvested real FDC proof to the oracle **on the fork** and watch `FdcVerification` accept it~~ — **done, and the pairing is the point.** The proof is re-decoded from real mainnet calldata (`executeDirectMinting`, 1,120 bytes, tx `0x1df2dda2…`, round 1,420,598); the fork holds root `0x539e514f…`; the **deployed** `FdcVerification` returns **true**. The oracle then refuses the same proof with `WrongSubject(string,string)` — `rwerD4SoJ8sHPKqXWTf93n7QgQfAJy4HEo` is that payment's *source*, not the vault, so crediting it would raise capacity. Capacity and haircut are unchanged afterwards. **`FdcVerification` judges authenticity; Herkos judges direction**, and both have to pass
- [x] ~~Side-by-side view: incumbent price vs Herkos price vs the inputs that separate them~~ — **done.** incumbent $1.039350 · Herkos $1.039342 · spot $1.039350 · 0.08 bips · 999,992 ppm, over inputs a judge can re-derive: effectiveQueue **1,860,950**, coreVault **7,050,810.428**, dexExit **1,684,853.280**, remoteClaims 0, capacity **10,596,613.708 FXRP**, 80 tickets, untruncated, poked at block 67,013,852. Plus the hot-path gas both oracles cost: **70,467 vs 110,614**

**Also closed here — the DEX routing question Phase 1 raised**, because a demo that registers real pools cannot leave it open. Registering the three uncorrelated FXRP/USD₮0 pools moves capacity **8,911,760.428 → 10,596,613.708 FXRP while the haircut holds at 999,992 ppm**. Under the old unconditional fill the same registration dropped it to 627,540. The correlated FXRP/stXRP pool — the deepest on Flare — is deliberately *not* registered: a rotation is not an exit. `addExitPool` from an unrelated account reverts `NotGovernance()`.

## Phase 5 — Presentation

- [x] ~~Drill-down showing XRPL escrow objects with their FDC proof~~ — **done, and live rather than screenshotted.** Panel 2 of `demo/index.html` queries `account_objects` on `rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj` against `xrplcluster.com` **from the browser**, lists each escrow with its amount and finish time, and sets them against `CoreVaultManager.availableFunds()` read at the same moment. The proof beside it is not baked in as bytes: the page pulls tx `0x1df2dda2…` with `eth_getTransactionByHash`, re-decodes the 1,120-byte attestation out of the real `executeDirectMinting` calldata, and calls the **deployed** `FdcVerification.verifyXRPPayment` itself. `xrplcluster.com` was chosen over `s1.ripple.com:51234` for one reason a judge can check — it sends `access-control-allow-origin: *` and s1 does not, so s1 answers curl and fails in a browser
- [x] ~~Queue depth vs cross-chain claims vs lending collateral, as measured~~ — **done.** Section 1 of `Writeup1.md` and the ratio bars in panel 1: queue **1,860,950 FXRP = 1×**, uncorrelated DEX depth **1,684,853 = 0.91×**, Core Vault liquid **7,050,810 = 3.8×**, bridged off Flare **12,929,855 = 7×**, posted as lending collateral **~113,600,000 = 61×**, against a total supply of **148,911,767 = 80×**. The demo re-derives the correlation flag in the browser from `token0()`/`token1()` rather than trusting a constant, so FXRP/stXRP — **2,319,350 FXRP, the deepest pool on Flare** — is visibly counted as zero next to the three FXRP/USD₮0 pools that count
- [x] ~~Written statement of the honest weaknesses (see PRD1.md) — do not let a judge surface them first~~ — **done, 12 numbered items**, in `Writeup1.md` §5 and again on the demo page where a judge will actually look. Every one PRD1.md treats as non-negotiable is checked for by name, so dropping one turns the run red rather than quietly strengthening a claim: nothing has broken yet, throughput is not capacity, 20 FLR per attestation, replayed rather than freshly requested, per-chain OFT supply is not FDC-provable, lying by omission is possible, a refresh costs someone gas, and the admin had to be impersonated. §6 closes with *What would have to be true for this to be wrong*
- [x] ~~Reproduction steps so every number can be independently checked~~ — **done, and mechanically verified.** `Writeup1.md` §6 carries the three venues, the anvil command with the pin, a per-phase command table, and the two ordering constraints that bite (`phase1` before `phase3`; a fresh anvil before `phase2`, because `phase4` leaves the market repointed). `npm run phase5` then re-checks the presentation against the files the runs wrote — **97 checks**, and it is written to be capable of failing: corrupt a digit in `phase4-results.json` and it goes red

**The verifier is the deliverable here, not the prose.** A presentation is the one artefact nobody re-runs, which is exactly how the ~600k `poke()` estimate and the "collateral factor tightens" phrasing survived as long as they did. So `phase5.js` traces every figure back to `fork.json`, `readers.json`, `phase3-results.json` and `phase4-results.json`; re-checks the forbidden phrasings in both the writeup and the demo page; asserts the page loads no external script, sends no transaction and asks for no wallet; and probes mainnet read-only for the three facts that live outside the repo — CORS on both endpoints, registry resolution, and the finalized Relay root for round 1,420,598, which a judge can check with none of our files.

Two things the verifier taught, both worth keeping:

- **A check that fires on its own disclaimer is worse than no check.** The first run flagged `Writeup1.md` for the phrase *"the publisher cannot lie"* — in the line that exists to reject it. Forbidden phrasings are now matched negation-aware, over a window around each hit.
- **Retired figures are paired, not banned.** "1.84M, three times the ~600k first estimated" is how a reader learns the number moved. The rule is that no document may carry a retired figure *without* the one that replaced it — decidable, unlike classifying prose as assertion or record.

## Optional — Community Contribution

- [ ] File a GitHub issue against the Flare docs for the four deployed-vs-documented mismatches found. **Re-verify each against the merged facet ABI before filing** — a fifth entry was withdrawn after `npm run phase0` showed it came from the diamond's shell ABI, not from the contract:
  - `RedemptionPerformed` declared `uint64 indexed requestId`, deployed emits `uint256` (topic0 `0xd5150395`, confirmed 2026-08-09)
  - The FAssets skill doc points readers at `RedemptionAmountIncomplete`; **both** events are deployed (`0x904705a8`) but the one actually emitted is `RedemptionRequestIncomplete` (`0xffb29516`, 29 observed). A scanner following the doc silently finds nothing
  - ~~`DirectMintingDelayed` / `LargeDirectMintingDelayed` absent from the deployed contract~~ — **withdrawn, this was our bug.** Both are deployed and the limits are live (4M XRP/hour, 40M/day). Do not file
  - The API Resources page lists a **Flare Mainnet Web2Json verifier** (`fdc-verifiers-mainnet.flare.network/verifier/web2/`) which returns 200, but no `Web2Json` fee is configured on mainnet `FdcRequestFeeConfigurations`, so requests cannot be made. Misleading for anyone planning a mainnet integration.
  - `FdcVerification`'s deployed verify-function struct shapes differ from the documented interfaces. Guessing selectors from the docs makes real, deployed functions look absent. Also worth documenting `XRPPayment` / `XRPPaymentNonexistence`, which are fee-configured on mainnet but do not appear in the attestation-type reference.

## Definition of Done

A judge can call `getUnderlyingPrice(cFXRP)` on both the incumbent oracle and Herkos, see them agree under normal conditions, raise `referenceSize`, watch Herkos diverge, and trace that divergence back through queue depth, agent liveness, XRPL escrow state carrying a verified FDC proof, and cross-chain OFT supply — every step independently checkable.

**And they can reproduce the entire thing at $0:** Foundry installed, no account anywhere, no FLR. Anvil boots the fork off the free public RPC, prefunds its own test accounts, and the demo runs.

**Reached so far:** a judge can do exactly this, end to end, on a fork booted from a free public RPC with no account anywhere. **The real deployed Compound market at `0x15f69897…` is repointed at Herkos by its own admin, for 0 FLR**, and both oracles are callable side by side — agreeing to **0.08 bips** at a small `referenceSize`. Raising it to 300M FXRP walks the haircut to 984,786 ppm and total borrow capacity across 8 real borrowers from **$2,662,798.48 to $2,585,733.56**, and the divergence traces back through queue depth, agent liveness, Core Vault state and registered DEX depth. **The XRPL leg carries a real replayed FDC proof rather than a mocked verifier** — the deployed `FdcVerification` accepts mainnet proof `0x1df2dda2…` on the fork, and the oracle still refuses it for the right reason, alongside a wrong-subject and a post-pin rejection in Phase 3. **The writeup and the demo page are written, and `npm run phase5` traces every figure in them back to the file a run wrote.** All six phases are closed.

**How to reproduce Phase 5**

```bash
npm run phase5      # 97 checks; writes phase5-results.json
npm run demo        # then open http://localhost:8080/
```

No fork, no key, no account, and nothing to install — this is the one phase that runs on a clean
checkout. It needs `fork.json`, `readers.json`, `phase3-results.json` and `phase4-results.json` to be
present to trace figures against, so run the earlier phases first or use the committed ones.

The two live probes are `eth_call` and an `OPTIONS` preflight against Flare mainnet and
`xrplcluster.com`. The Relay root check is the one worth watching: round **1,420,598** is finalized on
mainnet forever, so it is checkable with none of the files in this repo.

**How to reproduce Phase 4**

```bash
anvil --fork-url https://flare-api.flare.network/ext/C/rpc \
      --fork-block-number 67013823 --port 8545 --no-rate-limit
npm run phase4      # 42 checks; writes phase4-results.json
```

Boot anvil **fresh at the pin** for each run. The run repoints the live comptroller at its own
Herkos, so a second run against a dirty fork fails its "starts on the incumbent" check — which
is the check doing its job, not a flake.

**How to reproduce Phase 3**

```bash
anvil --fork-url https://flare-api.flare.network/ext/C/rpc \
      --fork-block-number 67013823 --port 8545 --no-rate-limit
npm run phase1      # writes readers.json at the pin, which phase3 consumes
npm run phase3      # 32 checks; dry-run by default
```

Three things about this run are worth knowing before it surprises someone:

- **It rewinds the fork's clock.** Anvil's clock advances with wall time, but the forked FTSO feed is frozen at the pinned timestamp, so a run lasting longer than `maxFeedAge` (420s, the incumbent's own `maxStalePeriod`) would be refused by the staleness guard. `pinForkClock` warps the clock back to the pin — never the windows, which stay exactly as deployed. `pokedAt` is a hard floor: winding back *behind* the poke made `block.timestamp - pokedAt` underflow to a 0x11 panic, which is how the interaction was found.
- **`forge create` needs `--legacy`.** Anvil forking Flare does not serve `eth_feeHistory`, so EIP-1559 estimation fails outright. Flare mainnet is legacy-priced anyway.
- **Coston2's source ids are `testXRP` / `testETH`,** never `XRP` / `ETH`. Probing mainnet's ids there reads back "not configured" for types that are in fact enabled — a self-inflicted false negative that briefly looked like a Coston2 gap.

Mainnet stays `eth_call`-only throughout; nothing here broadcasts, and `PUBLISH` defaults false.

**How to reproduce Phase 2**

```bash
anvil --fork-url https://flare-api.flare.network/ext/C/rpc \
      --fork-block-number 67013823 --port 8545 --no-rate-limit
npm run phase2      # or: HERKOS_RPC=http://localhost:8545 forge test -vv
```

The local fork is not optional convenience: a `poke()` is hundreds of state fetches, and the public RPC rate-limits the queue walk into transport failures. `ForkBase` asserts `block.number == 67,013,823` whichever venue it is pointed at, so a mis-booted anvil cannot quietly move the ground under every measured number above. Mainnet stays read-only.
