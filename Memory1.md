# Memory — Herkos

## Core Identity

- **Name:** Herkos (retained from the previous direction — the name stays, the product beneath it changed completely)
- **Purpose:** Measure and publish how much FXRP can actually leave Flare, and at what price
- **One-liner:** *Lending markets price FXRP off a feed that watches XRP on exchanges. Nothing watches whether FXRP can actually leave — and the claims on that exit now exceed anything it has ever been asked to do by 60×.*
- **Shape:** A drop-in Compound-compatible price oracle. Same signature, one different number.

## Hard Decisions

- **Product name is Herkos.** Fixed.
- **Three venues, total cost $0.** Reversed an earlier "deploy on Flare mainnet, not Coston2" decision after measuring what mainnet deployment would actually require. Mainnet stays the **evidence** source (read-only `eth_call`, free). The **demo** runs on an Anvil fork of Flare mainnet — real addresses, real state, real FDC proofs, prefunded from nothing. Coston2 carries the optional **public artifact**, funded by the free faucet. Nothing in the build requires buying FLR.
- **The consumed interface is `getUnderlyingPrice(address cToken)`.** No new interface. Integration must be one governance call or adoption is zero.
- **Refresh and read are separate functions.** `poke()` (permissionless, measured **1.84M** gas) walks the queue and writes an aggregate to storage; `getUnderlyingPrice` reads storage + FTSO at **70,467 cold against the incumbent's 110,614** — cheaper than the oracle it replaces, not merely at parity. Forced by measurement — the hot path runs inside every liquidation. Putting the queue walk in the hot path would make the drop-in claim false.
- **Attested state is one-directional: `min(FlareAccounting, XRPLProved)`.** It may only reduce measured capacity, never raise it. This is the fix for lying by omission, which is the *real* publisher attack — forgery was never possible, selective silence was.
- **Say "cannot move the number in the dangerous direction," not "cannot lie."** The loose claim is false and a judge can break it in one question.
- **The publisher is a relayer, not an authority.** On-Flare data the contract reads itself; the small off-Flare remainder carries an FDC proof; the haircut is computed on-chain. Non-negotiable — it is the direct answer to the objection that killed the previous design.
- **No TEE, no LLM, no signing key in the trust model.**
- **One governance knob: `referenceSize`.** "What exit size do you want to stay solvent at?" Everything else is measured or derived.
- **The publisher is event-driven, not a timer.** 20 FLR per attestation makes a fixed heartbeat wasteful — a 15-minute cadence is ~1,920 FLR/day ≈ **$11.74/day** at $0.0061133/FLR. Real money over time, but a production cost note, not a hard constraint. Attest on divergence. For the hackathon it does not arise at all: the demo replays attestations FAssets already paid for.
- **Under normal conditions Herkos must return the same price as the incumbent oracle.** Agreement is the credibility; divergence has to be earned.
- **Never trust the docs over the deployed contract.** Pull the ABI. Probe the fee config. Take FDC struct shapes from the verified implementation. This has paid off four times — and once it bit back: **the explorer is not the deployed contract either.** Reading the AssetManager's ABI from the explorer returned zero functions, and we recorded that absence as a protocol fact. Ask the contract (`facets()`), not a service describing it.
- **Do not claim FXRP is broken.** It isn't. The pitch is a missing measurement.
- **The DEX slice used to fill unconditionally. Phase 4 closed it, and the one-line reason is that an exit venue is *optional*.** `_clearingPPM` routed `min(amount, dexExitUBA)` through the pools whether or not that was cheaper than redeeming. So registering the exit pools *raised* `exitCapacity` (8,911,760,428,154 → 10,596,613,708,126) while *tightening* the reference haircut: constant product charges `x/(x+dx)` for 1M FXRP against a 1.68M reserve, taking 999,992 ppm to **627,540 ppm** — a 37% haircut where the unregistered state gives 8 ppm. The comment at `src/ExitCapacityOracle.sol:468` ("fill from the DEX until it stops being cheaper than redeeming") described a comparison the code did not make. **Nothing recorded was wrong** — Phase 2 measured every haircut at `dexExitUBA = 0`, which is what a fresh `poke()` leaves — but a market that registered pools got a materially different number. Surfaced by the Phase 1 reader porting `_clearingPPM` exactly and running it in both states.

  **The fix, and why it is not a judgement call.** Nobody is forced onto an AMM. If constant-product execution is worse than waiting for redemption at par, the correct answer is to wait — so knowing a pool exists can never make an exit price *worse* than it was without it. That makes `_clearingPPM(n) >= _redeemPPM(n)` an invariant, not a preference, and the old fill violated it. Constant product pays an average of `x/(x+dx)` and a **marginal** `x²/(x+dx)²`, so the two legs price equally at `dx* = dex × (1 − √k) / √k` for `k` the redemption ratio; filling past `dx*` buys nothing, because every further unit clears below what redeeming it would have paid. `k` is evaluated once against the whole amount rather than solved as a fixed point — one pass, and it errs by treating the redemption leg as slower than it will be, which routes *more* to the DEX, never less. Measured after the fix, on the live market: registering the same three pools moves capacity **8,911,760.428 → 10,596,613.708 FXRP with the haircut holding at 999,992 ppm**. Both halves finally move the same way. Three tests pin it — `test_dexCanOnlyImprove` (a 6-rung ladder, 10k → 150M), `test_registeringPoolsWidensCapacityWithoutTighteningTheHaircut`, `test_clearingPriceStaysMonotonicWithPoolsRegistered` — and the first fails against the old code at its first rung, 1M FXRP at 627,540 ppm against 999,992 without.

  Monotonicity is the part that would have been easy to miss. `referenceSize` means *"what exit size do you want to stay solvent at?"*, which is meaningless if answering with a bigger size can return a better price — and the old fill broke exactly that once pools were registered, because a fixed 1.68M DEX slice averaged against a growing near-par remainder priced 10M **above** 1M.
- **A price oracle cannot move a collateral factor, and saying it does loses the room.** `collateralFactorMantissa` is a governance constant — it reads 0.70 on the live cFXRP market at every rung of the Phase 4 ladder, and no oracle can touch it. What an oracle moves is the **USD value of the collateral**, hence borrowing power. So the demo reports **effective CF = CF × haircut** alongside real `getAccountLiquidity` deltas over 8 real borrowers, and never claims the market "tightens its collateral factor." The earlier phrasing was in four documents. Measured: nominal 0.70 throughout; effective **0.7000 → 0.6894** and total borrow capacity **$2,662,798.48 → $2,585,733.56** as `referenceSize` walks 1M → 300M FXRP.
- **"Written" and "measured" are different states, and this file only records the second — the distinction paid for itself.** Phase 1's reader was implemented and statically verified against the deployed contracts across three sessions in which the shell was unavailable, and recording it as closed would have put an unverified number in the file everything else cross-references. When it finally ran it scored **52/54**, and both failures were assumptions about the world that no amount of reading could have caught. Held for one run; the run is what closed it.
- **The documents are verified by a run, not by care.** Six markdown files that cross-reference each other by hand drift silently, and a stale claim in one is worse than no claim. `npm run phase5` re-reads every asserted figure against the results file that produced it, so the consistency rule is enforced rather than intended. Two sub-rules came out of building it and generalise past this repo: check a forbidden phrasing against the **negation window around it**, because the documents deliberately quote the wrong sentence in order to reject it; and treat a **retired figure as something to pair with its replacement, never to ban**, because naming the old number is how a reader learns it moved. Both pick the decidable test over the one that needs to classify prose.

## Key Facts (all measured on-chain, not recalled)

> **Re-measured 2026-08-09 at block 67,013,823** by `npm run phase0` (44/44 checks) and `npm run phase1` (54/54). The figures below are the original measurement and stay as recorded; the chain has simply moved since. Deltas, so nobody mistakes drift for a contradiction:
>
> | Fact | As recorded | 2026-08-09 |
> |---|---|---|
> | FXRP total supply | 148,826,359 | 148,911,767 |
> | Queue | 1,850,570 / 92 tickets | 1,860,950 / **80 tickets** |
> | Agents in queue | 6 | 6 |
> | CV available | 6,988,558 | 7,050,810 |
> | CV escrowed | 140,008,959 | 140,000,000 |
> | XRPL escrow objects | 17 | **15** (140,000,020 XRP, 15/15 condition-gated) |
> | XRPL `account_info` balance | 6,988,558 | 7,063,789 |
> | Backing drift | −0.015% | **−0.000004%** |
> | gas `redemptionQueue(0,20)` | 141,687 | 141,687 |
> | gas `redemptionQueue(0,100)` | 540,601 | 476,592 (fewer tickets) |
> | Settlements found | 0 (docs topic0) | **23,988** (deployed topic0) |
> | OFT locked | 12,929,748 | 12,929,855 at the pin · 12,941,706 at head |
>
> The shape of the thesis is unchanged: the queue is small, the Core Vault is large, backing closes, and the walk is far too expensive for the hot path. Ticket count moves both ways — 92 → 80 — which is exactly why the queue length cannot be treated as bounded. The escrow count moves the same way: 17 → 15 objects for the *same* ~140M XRP, which is the rolling self-escrow cycle re-forming, not funds leaving.
>
> Two corrections from that pass:
> - **`maxRedeemedTickets` is not a getter.** It is `getSettings()` component **30** (`uint16`), value **20**. Assuming a standalone `maxRedeemedTickets()` was our error, not a docs error — the selector is absent from the diamond's 216-selector dispatch table. `lotSize()` **is** a real getter: 10,000,000 UBA = 10 XRP, matching `getSettings().lotSizeAMG`.
> - `AssetManagerController` = `0x097b93eebe9b76f2611e1e7d9665a9d7ff5280b3` — the resolution hop from the registry to the AssetManager, not previously recorded.

**Supply and where it lives**
- FXRP total supply 148,826,359 (~$155M), 6 decimals
- **92.7% sits in contracts, not EOAs — FXRP is levered, not idle**
- Firelight 39.3% · Morpho 21.0% · Compound fork 13.9% · OFT Adapter 8.7% · Liquity fork 2.1% · AlgebraPool 1.6%
- ≈113.6M FXRP ≈ **$118M posted as lending collateral**

**The exit**
- Permissionless redemption queue: **1,850,570 FXRP across 92 tickets, 6 agents**
- Front-20 per-tx ceiling (`maxRedeemedTickets = 20`): 613,810 FXRP
- Core Vault: 6,988,558 XRP available · 140,008,959 XRP escrowed in 17 XRPL objects
- Escrows are **condition-gated** (`Condition` + `CancelAfter`; only 1 of 17 has `FinishAfter`) — fulfillment-locked, not time-locked. `CancelAfter` 2026-08-07 → 2026-08-22, a rolling ~2-week self-escrow cycle
- CV direct redemption for users: KYC required, 1000-lot (10,000 FXRP) minimum, once daily, lower priority than agent requests
- Backing reconciles: 148,848,087 vs 148,826,359 supply, **drift −0.015%**
- XRPL independently confirms: `account_info` 6,988,558.602 XRP vs `availableFunds()` 6,986,903

**Off Flare**
- 12,929,748 FXRP locked in the OFT Adapter, backing remote supply — **reconciliation gap exactly 0**, and Phase 1 re-confirmed it to the last digit (12,941,706,148,299 UBA on both sides) with the caveat the original pass did not state: the gap is 0 only when Flare and the remote chains are read at the *same moment*. Pin-vs-head reads 0.0917%, which is bridging in the interval
- Ethereum 7,806,597 · Monad 3,797,975 · HyperEVM 1,101,503 · Base 140,061 · BNB 83,613 · Katana 0
- **Katana's zero is a real absence, not an unread chain.** `rpc.katana.network` answers (chainId `0xb67d2`) and `eth_getCode` at the shared OFT address `0xCE6170EA…` returns `0x` — FXRP is not deployed there. Worth recording because the two are indistinguishable in a reader that only calls `totalSupply` and catches the throw, and Phase 1 initially reported it as `UNREACHABLE`
- 8.69% of all FXRP is off Flare and must route back through it to exit
- The adapter balance on Flare **is** the aggregate of remote claims — readable on-chain, no proof needed

**History**
- 23,988 redemption requests over 338 days; 8 defaults = **0.0334%** (1 in 2,999)
- Every defaulted redeemer made whole **plus 5%**; zero pool collateral drawn; defaults cluster on 4 days
- Sizes: p50 450 · p75 3,780 · p90 22,380 · p99 186,200 · **max 521,540** FXRP
- Total settled 258,952,156 FXRP = **766,000/day demonstrated throughput**
- `RedemptionRequestIncomplete` fired 29 times, **all with zero remainder** — dust rounding, never a ceiling hit
- `RedemptionTicketsConsolidated`: 0 occurrences

**Pricing**
- `getUnderlyingPrice(cFXRP)` = **$1.042118**; XRP spot $1.0427 — FXRP trades at par
- Oracle exposes `ftsoV2()` → `0x7bde3df0624114edb3a67dfe6753e62f4e7c1d20`
- DEX depth $13.28M nominal but $7.95M is FXRP/stXRP (correlated) → **true stablecoin exit ≈ $3.01M**

**FDC availability — probed via `getRequestFee(bytes)`, a pair with no fee cannot be requested**
- Flare mainnet: `Payment` / `BalanceDecreasingTransaction` / `ReferencedPaymentNonexistence` / `AddressValidity` on XRP·BTC·DOGE at 20 FLR; `ConfirmedBlockHeightExists` at 3 FLR; `EVMTransaction` on ETH·FLR·SGB at 20 FLR
- Flare mainnet also has **`XRPPayment` and `XRPPaymentNonexistence` (XRP, 20 FLR)** — undocumented in the attestation-type reference. `XRPPayment`'s response returns the XRPL address as a **`string`**, not a hashed `bytes32`, which makes binding to the known Core Vault account far easier. Prefer it over generic `Payment`.
- Flare mainnet: **`Web2Json` and `JsonApi` are NOT available** — no fee configured
- Coston2: `Web2Json` (PublicWeb2) available and ~free; `EVMTransaction` testETH only; test-chain XRP/BTC/DOGE types incl. `XRPPayment`
- **Coston2's source ids are `testXRP` / `testETH`, never `XRP` / `ETH`** — re-probed in Phase 3 and worth writing down because getting it wrong is silent. All five types Herkos needs are configured there at **1000 wei** each (`XRPPayment`, `XRPPaymentNonexistence`, `BalanceDecreasingTransaction`, `ConfirmedBlockHeightExists` against `testXRP`; `EVMTransaction` against `testETH`). Probing mainnet's ids reads back "not configured" for types that are in fact enabled, which looks exactly like a Coston2 gap. Say **1000 wei**, not "0 FLR": effectively free, faucet-covered, and not literally zero
- **A mainnet Web2Json verifier endpoint exists and returns 200 — it is a red herring.** The type cannot be requested on mainnet.
- `FdcHub.requestAttestation(bytes)` is `payable` with **no access control** — the request path is permissionless
- `FdcVerification` is an ERC-1967 proxy; the verified implementation carries all nine verify functions. **The docs' struct shapes are wrong** — guessing selectors from them made five of seven look absent.

**Gas — measured on Flare mainnet via `eth_estimateGas` (includes 21k base)**
- FTSO `getFeedById(bytes21)`, i.e. what the incumbent oracle costs today: **91,042**
- `redemptionQueue(0,20)` 141,687 · `redemptionQueue(0,100)` **540,601** (full 92-ticket queue) · `(0,1000)` 720,842
- Return data caps at 8,928 bytes but **gas keeps climbing** — the loop runs regardless of what fits
- `getUnderlyingPrice` is called inside Compound's `getHypotheticalAccountLiquidityInternal`, on **every borrow, redeem, and liquidation**, once per entered market. It is a real transaction's gas, not a free view
- **This forced the `poke()` split.** Hot path target ≈95k; refresh pays the walk

**Gas — measured in Phase 2 on the pinned fork, both oracles side by side (no 21k base; these are internal costs)**
- Herkos `getUnderlyingPrice(cFXRP)`: **70,467 cold / 15,967 warm**
- Incumbent `getUnderlyingPrice(cFXRP)`: **110,614 cold / 24,108 warm**
- **The 91,042 above is the bare FTSO feed read, not an oracle entrypoint.** The incumbent's own entrypoint costs 110,614 — the wrapper around the feed is not free. Herkos is cheaper than the oracle it replaces both cold and warm, so the drop-in claim is stronger than "parity", which is how it had been written. Say *measured cheaper*, not *at parity*
- Cold must be measured in **two separate transactions**. Whichever oracle runs second free-rides on the FTSO slots the first warmed; measuring both in one transaction reported Herkos at 70,467 against a fake 58,108 and would have been an unforced error in a demo
- `poke()`: **1,836,816**, against the ~600k in Architecture1.md. The 600k covered `redemptionQueue(0,100)` alone (472,212 forked / 540,601 mainnet) and omitted **agent-status filtering — the dominant term at ~282k per unique agent** (`getAgentInfo`)
- The walk caches by vault, so cost scales with **unique agents, not tickets**: 80 tickets → **6 agents**, 13,055 per ticket on a warm re-poke. Bound: ~97 distinct agents would fill a block (28,027,352). 1.84M is 6.5% of the limit, ~1.19 FLR at 650 gwei
- Cheaper substitutes checked in the merged diamond ABI and rejected: `getAgentLiquidationFactorsAndMaxAmount` (151,714) returns 0,0,0 for a healthy agent; `maxRedemptionFromAgent` (132,775) answers a different question

**Scaling — the Tasks1.md formula was wrong by twelve orders of magnitude**
- Written as `ftsoPrice × 1e30 / 1e18`. Implementing that literally would have printed `value × 1e12`
- The feed returns **6 decimals** (`getFeedById` → `(1039350, 6)`) and FXRP is 6, so the multiplication is `value × 10^(36 − assetDecimals − feedDecimals)` = **`value × 1e24`**
- The *output scale* `1e(36 − underlyingDecimals)` = `1e30` in Architecture1.md and setup1.md is correct and unrelated — 1.03935e30 is $1.039 at that scale. The error was in the multiplier, not the format. Do not "fix" those two lines
- Verified exactly rather than approximately: `mine == theirs × haircut ÷ 1e6`. The haircut is the entire difference, so no scaling error can hide inside a plausible-looking one

**Exit venues — the deepest FXRP pool is not an exit**
- Largest pool at the pin is **FXRP/stXRP** (AlgebraPool `0x2a91D9296ee2fe4139b49c7071b2f29f59a9f9aE`, 2,319,350 FXRP). Both sides are XRP-correlated: selling FXRP into stXRP is a **rotation, not an exit**, and counting it would inflate capacity — the one forbidden direction. Registered with `correlated = true` and contributes **0**
- Real uncorrelated depth is three **FXRP/USD₮0** pools totalling **1,684,853 UBA** (quote side 1,192,547) — smaller than the correlated pool, which is the point. No pool address appears in any doc; these were found by calling `token0()`/`token1()` on every contract in `fxrp-holders.json`
- OFT Adapter `0xd70659a6396285BF7214d7Ea9673184e7C72E07E`: **12,929,855 UBA** recorded as remote claims, never counted as exit capacity. Those tokens are someone else's, and per-chain attribution is not FDC-provable on mainnet

**Phase 2 state at the pin (block 67,013,823)**
- 80 tickets / 1 page · effectiveQueue **1,860,950,000,000** · Core Vault available 7,050,810,428,154 + escrowed 140,000,000,000,000
- exitCapacity **8,911,760,428,154** (8.91M FXRP) → **10,596,613,708,126** once uncorrelated DEX depth is registered
- haircut **999,992 ppm** (8 ppm) — clearing price 999,992 at 10k and 1M FXRP, **997,526 at 50M**
- timeToExit **1,800s** in queue / **88,200s** reaching the vault / **5,272,200s** beyond. No exit is instant: 1 UBA still waits for measured agent settlement
- A proven 500k outflow moves capacity 8,911,760,428,154 → 8,411,760,428,154

**Phase 4 state — the live lending market, measured on the fork at the pin**

Every figure here comes from the real deployed Compound fork at `0x15f69897…`, the real cFXRP at `0xD1b7A5eF…` and the real incumbent oracle at `0x61f77ef0…`, carrying their real mainnet storage. `npm run phase4`, 42/42, `phase4-results.json`.

- **Fork/mainnet parity: 7 of 7 reads identical** at block 67,013,823 — `comptroller()`, `oracle()`, `getUnderlyingPrice(cFXRP)`, `markets(cFXRP)`, `exchangeRateStored()`, `totalSupply()`, `underlying()`. Both sides queried at the same height, so the match is a match rather than a coincidence of timing
- **Baseline under the incumbent:** CF **0.70**, price **$1.039350**, exchangeRate **200,101,723,146,878**, **8 borrowers** carrying **$2,662,839.03** of combined borrow capacity, **0 in shortfall**
- **The governance call is real.** cFXRP's comptroller admin is `0x37c6c7c7…` and it is a **contract**, so impersonation is what makes `_setPriceOracle` reachable at all. Unprivileged, it returns **error code 1** rather than reverting — Compound signals by return value, and a check that only looked for a revert would record a silent no-op as success. Impersonated: **35,577 gas**, and `comptroller.oracle()` reads back Herkos. Cost on the fork: **0 FLR**
- **Agreement:** Herkos **$1.039342** vs incumbent **$1.039350** — **0.08 bips**, which is the 999,992 ppm haircut and nothing else. `spotUnderlyingPrice()` is byte-identical to the incumbent, so none of the difference is a feed discrepancy. **cUSDT0 — a market Herkos does not measure — delegates to the fallback and prices byte-identically at $0.999210.** That is what makes it a drop-in rather than an FXRP-only oracle
- **The `referenceSize` ladder.** Nominal CF is **0.70 at every rung** and stays there; what moves is collateral value:

  | referenceSize | haircut ppm | price | effective CF | time to exit | total borrow capacity |
  |---|---|---|---|---|---|
  | 1M FXRP | 999,992 | $1.0393417 | 0.7000 | 0.0d | $2,662,798.48 |
  | 10M | 999,170 | $1.0384873 | 0.6994 | 2.0d | $2,658,632.54 |
  | 50M | 997,526 | $1.0367786 | 0.6983 | 6.0d | $2,650,300.65 |
  | 150M | 992,184 | $1.0312264 | 0.6945 | 19.0d | $2,623,227.07 |
  | 300M | 984,786 | $1.0235373 | 0.6894 | 37.0d | $2,585,733.56 |

  Monotonically decreasing, the 500,000 ppm floor holds, and **0 accounts fall into shortfall at any rung** — the market tightens, it does not break. Note the shape: 300× the reference size costs only ~1.5% of price, because the queue and Core Vault absorb the first 8.9M and the escrow cadence is what prices the rest
- **`poke()` from an unprivileged caller: 1,853,742 gas.** Anvil account 2, no relationship to the deployer, 4 bytes of calldata — the selector and nothing else, so there is no submitted value to trust
- **Registering exit venues:** the three uncorrelated FXRP/USD₮0 pools move capacity **8,911,760.428 → 10,596,613.708 FXRP with the haircut unchanged at 999,992 ppm** (dexExit 1,684,853.280, dexQuote 1,192,547.829). The correlated FXRP/stXRP pool — the deepest on Flare — is deliberately not registered. `addExitPool` from an unrelated account reverts `NotGovernance()`
- **The FDC leg, and the pairing is the point.** The proof is re-decoded from real mainnet calldata (`executeDirectMinting`, 1,120 bytes, tx `0x1df2dda2…`, block 67,012,947, round 1,420,598); the fork holds root `0x539e514f…`; the **deployed** `FdcVerification` at `0x5c14fe9d…` returns **true**. Herkos then refuses the very same proof with `WrongSubject(string,string)` — `rwerD4SoJ8sHPKqXWTf93n7QgQfAJy4HEo` is that payment's *source*, not the vault, so crediting it would raise capacity. Capacity and haircut are untouched afterwards. **`FdcVerification` judges authenticity; Herkos judges direction**, and a proof has to pass both
- **Side-by-side inputs at block 67,013,852:** effectiveQueue 1,860,950 · coreVault 7,050,810.428 · dexExit 1,684,853.280 · remoteClaims 0 · pendingProvenOutflows 0 · capacity **10,596,613.708 FXRP** · 80 tickets, untruncated. Hot path: **70,467 gas vs the incumbent's 110,614**

**An anvil pitfall that cost real time, recorded so it is not re-derived.** Anvil's implicit gas estimate for a transaction it is also executing carries **no headroom**, and a `poke()` that newly writes `dexExitUBA`/`dexQuoteUBA` pays two 20,000-gas SSTOREs the estimate did not price. It died out of gas at *exactly* its own estimate (gasUsed 1,864,816) — and an out-of-gas receipt is indistinguishable from a revert at the receipt level, so it surfaced as "registering pools did not change capacity" with a stale `pokedAtBlock`, three steps away from the cause. Two lessons, both kept in `scripts/phase4.js`: **estimate explicitly and buffer** (`eth_estimateGas` × 3/2, capped at the block gas limit), and **never let a status `0x0` receipt pass silently** — `sendTx` throws and re-simulates to recover the reason. The first diagnosis was wrong (the fork clock), and the loud receipt is what made the real cause findable.


**The ratios that make the case**
| | vs. permissionless queue |
|---|---|
| largest redemption ever | 0.28× |
| FXRP off Flare | 7× |
| Ethereum alone | 4.2× |
| lending collateral | **61×** |

**The zero-cost build path — measured, not assumed**

Every line below was verified live before being written down.

- **Public Flare RPCs are archival.** `eth_getStorageAt` / `eth_getCode` / `eth_getBalance` all return real data **1,000,000 blocks deep** on mainnet and Coston2. Forking at a pinned block works against the free public endpoint — no Alchemy, no paid archive node
- **Both RPCs send `access-control-allow-origin: *`.** A static frontend can read chain state straight from the browser. **There is no always-on backend in the design**, which is what makes free hosting sufficient rather than merely cheap
- **A fork reproduces mainnet gas.** `redemptionQueue(0,100)`: **535,964 on the fork vs 540,601 on mainnet — 0.9% apart.** Gas claims measured on the fork are honest
- **Anvil prefunds accounts from nothing.** `0xf39Fd6e5…` starts with 10,000 FLR-equivalent; `forge create` deployed a probe contract to `0x9E545E3C0baAB3E08CdfD552C960A1050f373042` with no funding step
- **Finalized FDC merkle roots survive the fork.** `Relay.merkleRoots(200, round)` matched mainnet on **5 of 5** pre-fork rounds (fork−2, −10, −100, −1000, −10000). The control — `fork+50`, a round finalized *after* the fork point — came back empty, which is what makes the test discriminating rather than decorative
- **A real mainnet FDC proof re-verifies on the fork.** This is the decisive result. Transaction `0x615c03f28c743a5b2b7580c632d95bd7c8bb9ec4e03cd99405c51b1646665c70` (selector `0xa7556da6`, 1,764 bytes of calldata, mainnet block 66,967,661, status `0x1`, 728,630 gas) replayed successfully on a fork pinned one block earlier at 66,967,660 — `eth_call` succeeded, `eth_estimateGas` returned 754,915
- **Coston2 FAssets is a real system, not an empty shell.** 4,134,805.39 FXRP supply, 4 available agents, non-empty redemption queue
- **The Coston2 faucet is ungated.** 100 C2FLR + 10 USDT0 + 10 FXRP per address per 24 h, no social login. A deploy costs ~2 C2FLR
- **Render's free tier has no cron and no background worker** — those are paid-only. Static Sites are free and never sleep; free Web Services sleep after 15 min idle. Resolved by having no backend at all: **GitHub Actions cron** drives publisher cadence, a **Render static site** serves the UI
- **DA Layer proof route:** `POST /api/v1/fdc/proof-by-request-round` (and `-raw`). `GET` returns 405; malformed bytes return 400 `attestation request not found` — both confirm the route exists

**The one thing replay does not buy.** Replaying a proof lets you *verify* an existing attestation for free. It does not let you *create* one — a new mainnet attestation still costs 20 FLR. The proven $0 path therefore replays attestations **FAssets itself already paid for**, of the real Core Vault. Say it that way; do not imply free attestation requests.

## Addresses (verify at runtime via registry — these are for checking, not hardcoding)

- FlareContractsRegistry `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`
- AssetManager FXRP `0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8`
- FXRP `0xAd552A648C74D49E10027AB8a618A3ad4901c5bE` (6 dp)
- CoreVaultManager `0x6c8d96defe4cbee05fa969fc0ac436d94fc21784`
- XRPL Core Vault multisig `rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj`
- cFXRP `0xD1b7A5eFa9bd88F291F7A4563a8f6185c0249CB3` → comptroller `0x15f69897e6aebe0463401345543c26d1fd994abb` → oracle `0x61f77ef0064736ffa68c31d960e55baf67f79a4b`
- FXRP OFT Adapter (Flare) `0xd70659a6396285BF7214d7Ea9673184e7C72E07E`
- FdcHub (mainnet) `0xc25c749dc27efb1864cb3dada8845b7687eb2d44`
- FdcRequestFeeConfigurations (mainnet) `0x259852ae6d5085bdc0650d3887825f7b76f0c4fe` · (Coston2) `0x191a1282ac700ede65c5b0aaf313bacc3ea7fc7e`
- FdcVerification (mainnet) proxy `0x5c14fe9d73ab763f4d4a76f334bf7029ddd20ecc` → impl `0xf7f0057b4c6564f56479fdbb2e934c78ec4e094b` (ERC-1967 slot `0x360894a1…bbc`)
- Relay (mainnet) `0xccf30790a93f15e24eb909548a2c58a9b0a7fbd4` · AddressUpdater `0xf0de0df69d63c1f5e841f4964550c3dabad6d24e` · `fdcProtocolId()` = 200
- AssetManagerController (mainnet) `0x097b93eebe9b76f2611e1e7d9665a9d7ff5280b3` — registry → controller → `getAssetManagers()` → AssetManager
- Deployment block 47,098,178 · pinned research head 66,957,523
- **Demo fork pinned at block 67,013,823** (2026-08-09T14:16:54Z), recorded in `fork.json` — committed, because the pinned block is a decision. Held sticky by `phase0.js`; only `REPIN=true` moves it. Five fingerprints read at that block are re-verified on every run
- `lotSize()` 10 XRP · CV min redeem 1000 lots · CV redemption fee 0 BIPS · min amount left 1500 BIPS

**Coston2 (the free public-artifact venue)**
- RPC `https://coston2-api.flare.network/ext/C/rpc` · chain ID 114 · head 33,799,324 at time of measurement
- AssetManager FXRP `0xc1ca88b937d0b528842f95d5731ffb586f4fbdfa`
- FXRP `0x0b6a3645c240605887a5532109323a3e12273dc7`
- Faucet `https://faucet.flare.network/coston2` — 100 C2FLR + 10 USDT0 + 10 FXRP per address / 24 h
- Same `FlareContractsRegistry` address as mainnet — resolve, do not hardcode

## Rejected Directions

Five ideas killed. Each was killed by evidence, not taste. Do not resurrect without new evidence.

1. **Herkos v1 — agent-side operator tooling.** Dashboards and one-click collateral actions for FAssets agents. Killed: 6 agents exist, they are professional operators with their own tooling, and the product knew nothing the user didn't already know.

2. **Herkos v2 — trust / TEE verification layer.** Killed by direct user judgement: *"it just seems like another trust layer or another wrapped ChatGPT verification layer."* Correct. The TEE solved a problem that was invented to justify it, and the "policy engine" was `if CR > x: free capital; if CR < y: top up`. **This established the standing quality bar: added apparatus reads as wrapper padding.**

3. **Direction C — mint routing optimizer.** Killed: minting is now a single XRPL payment to the Core Vault. There is no routing decision left to optimize.

4. **Redemption counterparty-risk insurance.** Killed by measurement: 8 defaults in 23,988 requests (0.0334%), every redeemer made whole plus 5%, zero pool collateral drawn. There is no loss to insure.

5. **The per-transaction ceiling argument.** The claim that `maxRedeemedTickets = 20` caps exits at 613,810 FXRP per tx. Killed by measurement: **zero** of 23,988 requests ever approached it; the largest ever was 521,540. All 29 `RedemptionRequestIncomplete` events had zero remainder. The ceiling has never bound. *The cross-chain measurement replaced it with a stronger argument — claims vs. capacity, not per-tx mechanics.*

Also abandoned, but as a design correction rather than a dead idea:

- **Web2Json for XRPL Core Vault state.** Replaced by native XRP attestation types after probing the fee config. Strictly better: proves ledger facts instead of a JSON API's response shape.
- **"Deploy on mainnet, not Coston2" as an either/or.** Superseded, not reversed in spirit. Mainnet is still where the evidence and the real economy live — but it is read for free, and the demo runs on a fork of it. Coston2 returned as the free venue for a public artifact once the cost constraint became binding. See the zero-cost build path above.

## Docs Bugs Found (unreported)

Deployed reality disagrees with documentation in four places, and one entry that looked like a fifth turned out to be our own tooling failure. Worth a GitHub issue; the Flare MCP has no feedback channel.

**The diamond — the lesson that cost us a false entry.** The FXRP `AssetManager` (`0x2a3fe068…`) is an **EIP-2535 diamond**. Asking the explorer for the ABI at that address returns the proxy shell only: 71 items, 54 events, 14 errors, `fallback`, `receive`, and **zero functions**. The event set it returns is also incomplete, which is what produced the retracted `DirectMintingDelayed` claim — a function or event missing from that pull means nothing at all. The authority is the on-chain loupe: `facets()` → 33 facets / 216 selectors, each facet verified separately on the explorer, merged → 219 functions, 82 events, 214 errors, 216/216 selectors named. **A selector present in the loupe is dispatchable regardless of what any explorer returns.** "Verify against deployed contracts, not the docs" was not enough on its own; the explorer is not the contract either. `npm run phase0` does this assembly and writes `abi/AssetManager.json` + `abi/AssetManagerFacets.json`.

- `RedemptionPerformed` documented as `uint64 indexed requestId`; deployed emits `uint256`
- Event is `RedemptionRequestIncomplete`; FAssets skill doc calls it `RedemptionAmountIncomplete`
- ~~`DirectMintingDelayed` / `LargeDirectMintingDelayed` documented but **absent from the deployed mainnet ABI** — those rate limits are not live~~ **RETRACTED 2026-08-09 — this was our bug, not a docs bug.** See "The diamond" below. Both events are in the deployed ABI, and the limits are live: hourly 4,000,000 XRP, daily 40,000,000 XRP, large-mint threshold 4,000,000 XRP with a 7,200 s delay, fee 10 bips, `getDirectMintingsUnblockUntilTimestamp() = 0`. The docs were right here
- `RedemptionAmountIncomplete` **also** exists in the deployed ABI (topic0 `0x904705a8`) alongside `RedemptionRequestIncomplete` (`0xffb29516`). The doc name is not phantom — it is the wrong one to scan for. The 29 observed events were `RedemptionRequestIncomplete`; that log evidence stands
- API Resources page lists a Flare Mainnet **Web2Json verifier** which serves 200, but no `Web2Json` fee is configured on mainnet `FdcRequestFeeConfigurations`, so the type cannot actually be requested there
- **`FdcVerification`'s deployed verify-function struct shapes differ from the documented interfaces**, so selectors derived from the docs miss. Five of seven guessed selectors looked "absent" until the verified implementation ABI was pulled. Related: `XRPPayment` / `XRPPaymentNonexistence` are fee-configured on mainnet but missing from the attestation-type reference.

## Current State

- Thesis measured and holding; all supporting numbers independently verified on two chains
- Product shape settled and approved: drop-in oracle, three loops (publisher / poke / consumer), FDC-proved off-Flare inputs
- **Cost settled: $0.** Venue split — mainnet for evidence (read-only), an Anvil fork of mainnet for the demo, Coston2 for the optional public artifact. Proven end-to-end, not projected: a real mainnet FDC proof re-verified on a free local fork
- **Blocker pass complete, twice.** Design blockers: hot-path gas (→ `poke()` split) and attestation selection bias (→ one-directional rule). Cost blockers: archival access, CORS, fork gas fidelity, funding, faucet gating, Coston2 emptiness — all cleared by measurement. The one real obstacle, Render's paid-only cron and workers, was routed around by removing the always-on backend entirely
- All six markdown files rewritten to match, including the $0 architecture (this pass)
- Research scripts pruned to the reusable set; ~49 MB of event caches and superseded one-offs deleted
- **Phase 0 closed 2026-08-09.** Dependency-free scaffold (`scripts/lib/k.js` keccak + `scripts/lib/rpc.js` JSON-RPC/ABI codec, still no `node_modules`) and `npm run phase0` — 44/44 read-only checks against mainnet: registry resolution, deployed queue/CoreVault shapes, gas, the merged diamond ABI, and the held fork pin
- **Phase 1 closed 2026-08-09 — `npm run phase1`, 54/54 after a 52/54 first pass.** `scripts/phase1.js` closes all eight reader items — queue walk, the four-event scan with a pin-keyed cache, the liveness model, XRPL Core Vault, OFT adapter + six remote chains, DEX classification, backing reconciliation — and asserts each result against a number already recorded here or in `phase2-results.json`, so drift surfaces as a named FAIL rather than a silent difference. It writes `readers.json` for the Phase 3 publisher. Everything checkable by reading was checked first: the exit model against `_clearingPPM`/`_timeToExit`/`_recompute` line by line, every constant against the deployed constructor, all four event topic0s and value-word indices against the merged facet ABI, and the block-parameter behaviour of `client.call`/`probe` (they do *not* hex-convert a numeric block the way `getStorageAt` does — every Flare call site passes a pre-hexed `at`, **the six resolution reads included**; those had been left at `latest`, which is a contradiction of the pin discipline even though the `EXPECT` assertions would have caught a swapped AssetManager loudly. Identity is state). That reading pass caught eight runtime defects a syntax check would have missed, including `Math.abs` on a BigInt, an unguarded `BigInt()` on explorer log fields, and — found last — a `timeToExit` port that had dropped the contract's `rate == 0 ? 3650 : …` guard at `src/ExitCapacityOracle.sol:508`, so a governance setter taking the escrow rate to zero would divide by zero in the reader while the contract answered 3,650 days. Unreachable at the deployed rate, which is exactly why reading found it and a run would not have.

  **Execution then found the two that reading structurally could not, both in the OFT section.** (1) The reconciliation compared the adapter at the *pin* against remote chains at their *heads* and reported a −11,851 FXRP (0.0917%) gap. Reading the adapter at the head as well closes it to **0 UBA exactly**. The invariant held; the comparison was malformed, and `setup1.md` had pre-registered the artifact in prose without the code acting on it — a warning in a comment is not a fix. It is now asserted as a 1-bip band, not exact equality: seven reads at seven instants, and one bridge tx landing mid-sweep moves the sum honestly. (2) Katana was reported `UNREACHABLE` when the RPC answers fine (chainId `0xb67d2`) and simply has no FXRP at the OFT address. A `try/catch` around `totalSupply` cannot tell an outage from an absent deployment — only an explicit `eth_getCode` can, and the reader now asserts reachability while treating deployment as data. Both are errors about the world rather than errors in the code, which is the class reading cannot reach. Eight found cold, two found hot; the ratio is the argument for doing both, in that order.

  Every recorded number reproduced on the run: 80 tickets / 1,860,950 FXRP / 6 unique agents · 24,010 requests / 23,988 settlements / 259,044,318 FXRP / 8 defaults (0.0333%) / 766,223 FXRP/day / max 521,540 · XRPL 7,063,789 vs Flare 7,050,810 (18.4 bips) · DEX 1,684,853,279,972 counted against 2,319,350,567,176 excluded · haircut 999,992 ppm at 1M and 997,526 at 50M · capacity 8,911,760,428,154 → 10,596,613,708,126 with pools · backing −0.000004%. The docs-signature bug is now confirmed live rather than inferred: the deployed topic0 finds 23,988 settlements where the documented `uint64` signature finds zero
- **Phase 3 closed 2026-08-10 — `npm run phase3`, 32/32.** `scripts/phase3.js` closes the submit half of the publisher against a live anvil fork: collection pass, divergence gate, `poke()`, harvest, real proof verification, both rejections, the Coston2 request half, and provenance. Dry-run by default; mainnet is `eth_call`-only throughout and nothing broadcasts.

  **The result that mattered:** the **deployed** `FdcVerification` (registry-resolved) returns **true** on the fork for mainnet proof `0x1df2dda233160bc9d82e127bb8de73d7dca1e5bf491c7ae904f73114f0ef254c` — block 67,012,947, voting round 1,420,598, root `0x539e514f77d7791a…`. Phase 0's replay was an `eth_call` against mainnet's own transaction; this is the oracle's own submission path judged by the real verifier. Eight proofs harvested from below the pin and **8/8 re-encode byte-identical** to the original mainnet calldata, including the variable-length trailing `bytes` of `executeDirectMintingWithData`. That round-trip is the check that makes a hand-rolled ABI coder trustworthy, and it is the reason to keep it: a coder that agrees with itself proves nothing.

  **Both rejections fire for the right reason, which is the actual test.** A proof FDC *itself accepts* is refused with `WrongSubject(string,string)` — the Core Vault is that payment's **destination, not its source**, so it is an inflow, and crediting it would raise capacity. That is the one-directional rule enforced against real data rather than a fixture. A post-pin proof (round 1,421,530, block 67,086,229) is refused with `ProofRejected()`, checked against an empty-root control so the refusal cannot be a false negative from something else. Revert ordering in `submitCoreVaultOutflow` is `ProofAlreadyUsed` → `verifyXRPPayment`/`ProofRejected` → `PaymentUnsuccessful` → `WrongSubject` → `BadParam`, which is why a post-pin proof stops at `ProofRejected` and never reaches the subject check.

  **The gate declined to attest, and that is the normal outcome.** XRPL 7,063,788.996 vs Flare 7,050,810.428 FXRP — +12,978.568 (18 bips), under the 100,000 threshold *and* in the direction that would raise capacity. Either alone is disqualifying. **0 FLR spent on attestation fees.** `poke()` reproduced at **1,852,899 gas** (Phase 2: 1,836,816 — 0.9% apart), and Herkos priced **$1.039342** against the incumbent's **$1.039350**: 0.08 bips, which is the 999,992 ppm haircut and nothing else.

  **Four things execution found that reading did not, all about the venue rather than the contract:**
  1. **The fork's clock versus a frozen feed.** Anvil's clock advances with wall time; the forked FTSO feed is frozen at the pinned timestamp. A run outliving `maxFeedAge` (420s, the incumbent's own `maxStalePeriod`) is refused by `StaleFeed(uint64,uint64)`. The fix warps the clock back to the pin — never the windows, which stay exactly as deployed. `anvil_setTime` + `evm_mine` works; **both** `setNextBlockTimestamp` variants reject a backwards move ("lower than previous block's timestamp"). Measured against this fork, not assumed.
  2. **`pokedAt` is a hard floor on that warp.** Winding the clock back *behind* the poke makes `block.timestamp - at` underflow at `src/ExitCapacityOracle.sol:239` — an unchecked-arithmetic **0x11 panic**, not a clean revert. The staleness guard is correct; the venue was being rewound underneath it. `forge create` is a compile plus a deploy and burns enough wall-clock that re-pinning immediately *before* the poke is also required.
  3. **Coston2's source ids are `testXRP` / `testETH`, never `XRP` / `ETH`.** Probing mainnet's ids there reads back "not configured" for types that are in fact enabled at **1000 wei** — a self-inflicted false negative that briefly looked like a Coston2 gap. Worth stating precisely: 1000 wei is effectively free and the faucet covers it, but it is not literally 0 FLR and the writeup should not round in its own favour.
  4. **`forge create` needs `--legacy` against an anvil fork of Flare.** The fork does not serve `eth_feeHistory`, so EIP-1559 estimation fails outright. Flare mainnet is legacy-priced anyway.

  **Three checks in the first draft were vacuous, and finding them is the transferable lesson.** (a) The round-trip compared `encodeProof(p)` against a value *derived from* `encodeProof(p)` — it could not fail; fixed by keeping the original mainnet calldata as the witness. (b) The fee check's condition was `!attestable || PUBLISH`, always true. (c) The DA Layer check could never have passed: it sent a `transactionId` where request bytes were required, and request bytes carry a MIC not recoverable from a proof. That last one is now **explicitly informational**, with the binding check named — `FdcVerification` validating a Merkle path against a root the fork already holds, which trusts no off-chain API. A check that cannot fail is worse than no check, because it reads as evidence. Two more of the same family were caught later: a price rendered at `1e18` when Compound scaling is `1e30` (printed $1,039,341,685,200 for a $1.04 asset — the exact error `_scale`'s comment warns about, reappearing in the reporting layer), and the incumbent-agreement invariant being *printed* rather than *asserted*. It is now asserted, and fails if Herkos ever prices above the incumbent.

- **Phase 4 closed 2026-08-10 — `npm run phase4`, 42/42.** `scripts/phase4.js` points the **real deployed Compound market** at Herkos on the fork and reads what the market does about it. All nine checklist items in one pass, writing `phase4-results.json`. The measurements live in *Key Facts* above; what belongs here is what the phase changed.

  **It closed the DEX-routing question rather than deferring it**, because a demo that registers real pools cannot leave the number ambiguous. See the *DEX slice* entry under Hard Decisions — the fix is `dx* = dex × (1 − √k)/√k`, the justification is that an exit venue is optional, and the Phase 2 suite grew 51 → 54 to pin it.

  **It corrected a claim that appeared in four documents.** "The forked market visibly tightens its collateral factor" is false: `collateralFactorMantissa` is a governance constant and reads 0.70 at every rung. An oracle moves collateral *value*. Effective CF and `getAccountLiquidity` deltas replaced it everywhere.

  **Two things execution found that reading did not, both about anvil rather than the contract:**
  1. **Anvil's implicit gas estimate has no headroom, and an out-of-gas receipt looks exactly like a revert.** A `poke()` that newly writes `dexExitUBA`/`dexQuoteUBA` pays two SSTOREs the estimate did not price, and died at *precisely* its own estimate. It surfaced three steps from the cause as "registering pools did not change capacity." `sendTx` now estimates explicitly with a 3/2 buffer capped at the block gas limit, and **throws on a status `0x0` receipt** after re-simulating for the reason. The first diagnosis was wrong — I blamed the fork clock and said so — and the loud receipt is what made the real cause findable. A silent failed transaction is the worst failure mode available on a fork.
  2. **Compound signals authorisation by return value, not by reverting.** An unprivileged `_setPriceOracle` returns error code **1** and changes nothing. A check that only looked for a revert would have recorded a silent no-op as a passing negative test. Assert on the returned code *and* re-read `comptroller.oracle()`.

  **Boot anvil fresh at the pin for each run.** The run repoints the live comptroller at its own Herkos, so a second run against a dirty fork fails its "starts on the incumbent" check — the check working, not a flake.
- **Phase 5 closed 2026-08-10 — `npm run phase5`, 97/97. All six phases are closed.** `Writeup1.md` and the static `demo/` page are the presentation; `scripts/phase5.js` is what makes them trustworthy. It re-reads every figure the writeup and the demo assert and compares it against the file a run actually wrote — `fork.json`, `readers.json`, `phase3-results.json`, `phase4-results.json` — so corrupting a digit in any results file turns the run red. **The verifier is the deliverable here, not the prose:** a document that claims traceability and a document that mechanically demonstrates it are different artifacts, and only the second survives a judge picking a number at random. Needs no fork, no key and no account — 97 read-only checks over the repo's own files.

  **Two lessons about checking prose, both general.** (1) **A check that fires on its own disclaimer is worse than no check.** The rules banning "the publisher cannot lie" and "FXRP is broken" fired on the exact lines that exist to *reject* those phrasings — `Writeup1.md` and the demo both print the wrong sentence in order to walk it back. A run that cries wolf trains someone to stop reading it, which is the same failure as a check that cannot fail, arriving from the opposite side. Fixed by matching a negation window around each hit rather than the phrase alone, on a whitespace-flattened copy, because prose wraps and `.` does not match `\n`. (2) **Retired figures are paired, not banned.** The first draft failed every document that named the ~600k `poke()` estimate, the 91,042 "at parity" figure or the `1e30 / 1e18` scaling error — but naming the retired number is how a reader learns it moved. What is forbidden is carrying the old figure *without* the one that replaced it. Pairing is decidable; classifying the surrounding prose as record-or-assertion is not, and picking the decidable test is what makes the check fail for the right reason at document scale.

  **Three outside-the-repo facts were re-verified live rather than quoted**, since they are what a judge can check with none of our files: Flare mainnet RPC preflight 200 with `Access-Control-Allow-Origin: *`, `xrplcluster.com` 204 with the same (`s1.ripple.com:51234` answers curl but sends no ACAO — it fails in a browser, which is why the demo uses xrplcluster), and mainnet `Relay` still holding root `0x539e514f77d7791a…` for round 1,420,598. Head had moved ~100k blocks past the pin at the time of writing and keeps moving, which is why no document quotes that gap as a figure — the verifier reads it live and the demo labels pinned-versus-live, so drift is disclosed rather than discovered.

  **`npm run measure` was cut from the judge-facing reproduction steps.** It lives in the external research toolkit under a temp directory, so a judge following the writeup would hit a dead command; `phase0` and `phase1` are in this repo, need neither Foundry nor a key, and re-derive the same signals.
- No funding prerequisite. The publisher needs no FLR to demo; the Coston2 faucet covers the optional public deploy. Plan the demo as a **forked** lending market — the live market needs its own governance to switch oracles