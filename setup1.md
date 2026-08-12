# Setup: Herkos

## Prerequisites

**Total cost: $0.** Everything below is free, and each claim was checked live.
See Memory1.md, *The zero-cost build path*, for the measurement record.

- Node.js 20+ and Foundry (`anvil`, `forge`, `cast`)
- **Flare mainnet RPC:** `https://flare-api.flare.network/ext/C/rpc`, free and public. It is archival to **1M blocks deep**, which makes pinned forking possible without a paid node
- **Coston2 RPC:** `https://coston2-api.flare.network/ext/C/rpc`, for the optional public artifact
- Ethereum, Monad, HyperEVM, Base, BNB, and Katana RPCs are read-only presentation inputs. The OFT Adapter balance on Flare is the number that matters. Katana has no FXRP deployment at the shared address, so the default is enough
- **XRPL JSON-RPC:** `https://s1.ripple.com:51234/`, free
- **No funded account required.** Anvil prefunds its own test accounts; the Coston2 faucet gives 100 C2FLR + 10 USDT0 + 10 FXRP per address per 24 h with no social login, and a deploy costs ~2 C2FLR
- Hosting: **GitHub Actions** for the free cron and **Render Static Site** for the frontend. Render's free tier has no cron jobs or background workers, but Herkos does not need either because the browser reads the public RPCs directly

No agent vault, no operator permissions, no custody, no purchased FLR. Herkos reads and publishes; it never moves capital.

## 0. The three venues

The three environments have different jobs:

| Venue | What it is for | Why it is free |
|---|---|---|
| **Flare mainnet** | Evidence. Every number in PRD1.md | Read-only `eth_call` costs nothing |
| **Anvil fork of Flare mainnet** | The demo: oracle deploy, forked lending market, FDC proof verification under stress | Anvil prefunds accounts; forked state is real; finalized FDC roots carry over |
| **Coston2** | Optional public artifact: a clickable deployed address | Free faucet, live FAssets (4,134,805 FXRP, 4 agents) |

The fork carries **real mainnet addresses, real state, real gas**
(`redemptionQueue(0,100)`: 535,964 forked versus 540,601 live, 0.9% apart)
and **real finalized FDC Merkle roots**. A mainnet transaction beginning
`0x615c03f2` was replayed successfully on a fork pinned one block before it.

Replay *verifies* an existing proof for free. It does not *create* one. A new
mainnet attestation still costs 20 FLR. The demo replays attestations that
FAssets already paid for, concerning the real Core Vault.

## 1. Project setup
```bash
git clone <repo>
cd herkos
npm install
forge install     # or: npx hardhat compile
```

## 2. Configuration
Create a `.env` file:

```env
# --- Flare mainnet (evidence: read-only, free, archival to 1M blocks) ---
RPC_URL=https://flare-api.flare.network/ext/C/rpc
CHAIN_ID=14
REGISTRY=0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019   # resolve everything else through this

# --- Anvil fork of mainnet (the demo venue) ---
FORK_RPC=http://localhost:8545
FORK_BLOCK=67013823          # pinned 2026-08-09, recorded in fork.json. Sticky: REPIN=true to move it
# anvil --fork-url $RPC_URL --fork-block-number $FORK_BLOCK --port 8545
# prefunded account 0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (10,000 ether-equivalent)

# --- Coston2 (optional public artifact) ---
C2_RPC=https://coston2-api.flare.network/ext/C/rpc
C2_CHAIN_ID=114
C2_ASSET_MANAGER=0xc1ca88b937d0b528842f95d5731ffb586f4fbdfa   # verify via registry, do not trust this line
C2_FXRP=0x0b6a3645c240605887a5532109323a3e12273dc7
# faucet: https://faucet.flare.network/coston2
# 100 C2FLR + 10 USDT0 + 10 FXRP per address every 24 hours

# --- XRP Ledger ---
XRPL_RPC=https://s1.ripple.com:51234/

# --- FDC ---
FDC_VERIFIER_XRP=https://fdc-verifiers-mainnet.flare.network/verifier/xrp/
FDC_VERIFIER_API_KEY=00000000-0000-0000-0000-000000000000   # public verifier key
DA_LAYER=https://flr-data-availability.flare.network
DA_PROOF_ROUTE=/api/v1/fdc/proof-by-request-round           # POST. GET returns 405
RELAY=0xccf30790a93f15e24eb909548a2c58a9b0a7fbd4            # merkleRoots(uint256,uint256), fdcProtocolId 200

# --- Remote chains (read-only, presentation; each falls back to a public endpoint) ---
ETH_RPC=
MONAD_RPC=
HYPEREVM_RPC=
BASE_RPC=
BNB_RPC=
KATANA_RPC=
KATANA_FXRP=                 # unset: the shared OFT address has no FXRP on Katana

# --- Publisher ---
PUBLISHER_KEY=0x...          # relayer only: pays gas, holds NO authority over values.
                             # On the fork this is an Anvil test key. Never a funded mainnet key.
ORACLE_ADDRESS=0x...         # ExitCapacityOracle, after deployment
DIVERGENCE_THRESHOLD_BIPS=25 # attest only when XRPL vs CoreVaultManager diverge past this
HEARTBEAT_HOURS=24           # floor, so the feed cannot silently rot
POKE_INTERVAL_MIN=15         # cheap-ish on-chain refresh; permissionless, anyone may also call it
PORT=3001
```

**Do not hardcode contract addresses.** Resolve `AssetManagerFXRP` → `fAsset()`
→ `CoreVaultManager` through the registry at runtime. The addresses in
Architecture1.md let you check the resolver. They are not a shortcut around it.

**`PUBLISHER_KEY` is not a trust boundary.** It signs transactions carrying
FDC-proved data. The oracle verifies every proof against `FdcVerification` and
computes the haircut itself. A compromised publisher can stop updates or
choose *not* to attest something, but attested state can only reduce capacity.
Silence therefore makes Herkos conservative, never optimistic. The key belongs
on the backend.

## 3. Core pieces

**Contract: `ExitCapacityOracle.sol`** (deployed to the Anvil fork for the demo; optionally to Coston2 as a public artifact)
- `getUnderlyingPrice(address cToken)`: Compound-compatible, `1e30` output scaling for 6-decimal FXRP. The feed multiplier is `1e24`. It reads the cached aggregate and FTSO XRP/USD, then applies the haircut. Measured **70,467 cold / 15,967 warm** against the incumbent entrypoint's **110,614 / 24,108**. The 91,042 in earlier drafts was the bare feed read
- `poke()`: permissionless, with no arguments or submitted values. It walks `AssetManager.redemptionQueue()`, reads Core Vault funds, the OFT Adapter FXRP balance, and DEX reserves, then stores the aggregate with a block and timestamp. Measured **1,836,816** gas. Agent-liveness filtering is about 282k per unique agent, so this stays off the hot path
- `exitCapacity()`, `clearingPrice(uint256)`, `timeToExit(uint256)`
- FDC proof verification against `FdcVerification`, with subject validation (the attested account must be the Core Vault address)
- **One-directional storage:** attested XRPL state may only reduce measured capacity. Store `min(FlareAccounting, XRPLProved)`
- Haircut computed on-chain from stored inputs
- Staleness guard on both the poked aggregate and attested state, and governance setters for `referenceSize` / liveness decay / discount rate

**Publisher (off-chain, stateless):** the reader is `scripts/phase1.js` and the submitter is `scripts/phase3.js`. Both are complete.
- Readers for Flare contracts, XRPL `account_info` + `account_objects`, remote-chain OFT supply, DEX pools
- Agent-liveness model built from `RedemptionRequested` / `RedemptionWithTagRequested` / `RedemptionPerformed` / `RedemptionDefault` over block 47,098,178 to head. **Recompute topic0 from `phase0-results.json`, never from a docs signature.** The documented `RedemptionPerformed` declares `uint64 requestId`, while the deployed event emits `uint256`. A scan keyed to the documented hash finds zero settlements and reports a dead system
- Calls `poke()` on its own cadence — and anyone else can too
- Divergence check, then FDC request (`XRPPayment`, `BalanceDecreasingTransaction`, `XRPPaymentNonexistence`, `ConfirmedBlockHeightExists`) → finalization poll → DA Layer proof fetch → `(data, proof)` submission
- **Event-driven scheduler with a heartbeat floor.** A 15-minute attestation loop is about 96 requests per day, or 1,920 FLR and **$11.74 per day**, for no new information. The publisher requests attestations only when the divergence gate requires one
- **Cadence comes from GitHub Actions cron**, not a long-lived process. Render's free tier has no cron or background worker, and the design does not need one
- FLR spend tracking per published update

**Demo consumer**
- Forked Compound-style market, switchable between the incumbent oracle and Herkos via `_setPriceOracle`
- Side-by-side view of both prices and the inputs that separate them

## 4. Run

```bash
# 0. Phase 0 verification: resolve the registry, confirm deployed shapes,
#    assemble the diamond ABI, and hold the pinned fork block. 44 read-only checks.
npm run phase0             # REPIN=true npm run phase0  to move the pinned block

# 1. Phase 1 readers: the off-chain half of the publisher. Read-only eth_call at
#    the pinned block, explorer getLogs, XRPL JSON-RPC, and remote-chain RPCs.
#    No keys, writes, or cost. Writes readers.json and phase1-results.json.
#    The first run is slow because the event scan covers about 20M blocks across
#    four event types. It caches to cache-redemption-events.json at the pin, so
#    the next run is faster. RESCAN=true forces a fresh scan. 54 checks.
npm run phase1

# 1b. Read-only research pass against mainnet. No keys, writes, or cost.
npm run measure

# 2. Boot the demo venue: a fork of Flare mainnet at a pinned block.
#    --no-rate-limit matters because poke() makes hundreds of state fetches and
#    the public RPC can otherwise rate-limit the queue walk.
anvil --fork-url https://flare-api.flare.network/ext/C/rpc \
      --fork-block-number $FORK_BLOCK --port 8545 --no-rate-limit

# 2b. Phase 2 contract tests: 54 fork tests against Anvil. Mainnet stays
#     read-only. ForkBase asserts the pin, so a mis-booted Anvil cannot move the
#     block behind the measured numbers. Boot Anvil fresh at the pin because
#     ForkBase forks Anvil's *head* and Phase 4 leaves the fork changed.
npm run phase2             # HERKOS_RPC=http://localhost:8545 forge test -vv

# 3. Deploy the oracle to the fork. Anvil account 0 is prefunded, so no faucet
#    or FLR is needed. --legacy is required because Anvil's Flare fork does not
#    serve eth_feeHistory. Flare mainnet is legacy-priced too.
forge create src/ExitCapacityOracle.sol:ExitCapacityOracle \
      --rpc-url http://localhost:8545 \
      --private-key <ANVIL_ACCOUNT_0_PRIVATE_KEY> \
      --legacy --broadcast

# 4. Phase 3 publisher: the submit half. It deploys its own oracle on the fork,
#    calls poke() from an unrelated account, harvests a real finalized mainnet
#    FDC proof, replays it through deployed FdcVerification, and proves the two
#    rejections. It needs readers.json and Anvil. 32 checks. Dry-run by default;
#    mainnet remains eth_call-only. It moves Anvil's clock back to the pin because
#    the forked FTSO feed is frozen there while Anvil follows wall time.
npm run phase3             # PUBLISH=true to actually submit — needs a funded key, which
                           # this repo does not have and does not want
npm run publisher          # the same publisher on the GitHub Actions cadence

# 4b. Phase 4 demo consumer: the real deployed Compound market at 0x15f69897
#     consumes the price. The run deploys its oracle, impersonates the market
#     admin to call _setPriceOracle, checks agreement at a small referenceSize,
#     then walks to 300M FXRP and reports the borrow-capacity change across 8
#     real borrowers. 42 checks. Boot Anvil fresh at the pin because the run
#     repoints the comptroller on the fork.
npm run phase4             # writes phase4-results.json

# 5. Demo UI: static, reads the RPCs from the browser
npm run demo               # then open http://localhost:8080/

# 5b. Phase 5 presentation verification: re-check that Writeup1.md and demo/
#     still match the measured results. No fork, key, or account. It reads the
#     results files and makes two read-only live probes. 81 checks in this build.
npm run phase5             # writes phase5-results.json

# Optional: public artifact on Coston2, funded by the faucet
forge create ... --rpc-url $C2_RPC --private-key $C2_KEY --broadcast
```

**Never point `forge create --broadcast` at `RPC_URL`.** That is mainnet. It
costs real FLR, and nothing in this build needs it.

## 5. Verification Checklist

**Cost discipline**
- [ ] No step in the whole build requires buying FLR. If one appears, it is a design error, not a budget line
- [ ] `anvil --fork-url` at a pinned block returns real FXRP storage — confirms the public RPC is still archival at that depth
- [ ] Forked gas is within ~1% of mainnet for the same call (measured: 535,964 vs 540,601 on `redemptionQueue(0,100)`)
- [ ] `Relay.merkleRoots(200, round)` for a **pre-fork** round matches mainnet, and a **post-fork** round is empty. Both halves matter — without the empty control the test proves nothing
- [x] A real mainnet FDC-proof transaction replays successfully on a fork pinned one block before it — *and Phase 3 does it through the **deployed** `FdcVerification` rather than an `eth_call` replay: `verifyXRPPayment` → true for round 1,420,598. Eight proofs harvested, **8/8 re-encoding byte-identical** to the original mainnet calldata*

**Correctness**
- [ ] Registry resolves AssetManager FXRP → `0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8` and FXRP → `0xAd552A648C74D49E10027AB8a618A3ad4901c5bE` on mainnet, and to the Coston2 pair on Coston2
- [x] Queue walk totals reconcile against `RedemptionRequested` history — *`npm run phase1`, 54/54: 24,010 requested, 23,988 performed, 8 defaulted, 80 open now*
- [x] Reconciliation closes: queue + CV available + CV escrowed vs FXRP total supply, under 0.02% drift — *closes at **−0.000004%**, three orders inside the bound*
- [x] OFT Adapter locked balance equals the sum of remote OFT supply (gap should be 0) — ***gap 0 UBA, exact to the last digit*** — 12,941,706,148,299 on both sides. It only closes when both sides are read at the same moment: the adapter at the **pin** against remotes at their **heads** reads −11,851 FXRP (0.0917%), which is the bridging that happened in the 26,119 blocks between them rather than a discrepancy. The script reports both and asserts the matched-time one. Katana answers but has no FXRP at the OFT address (`eth_getCode` → `0x`), so its zero is proven rather than assumed
- [x] XRPL `account_info` on `rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj` agrees with `availableFunds()` — *7,063,789 XRP vs 7,050,810 on Flare = +12,979 XRP (18.4 bips), inside the divergence threshold, and in the direction that is not attestable*
- [x] `getRequestFee` returns a fee for every type/source pair the publisher intends to use — **if it reverts, the request will not be accepted** — *`npm run phase3` §8: all five configured on both networks. Mainnet 20 FLR (`ConfirmedBlockHeightExists` 3), Coston2 1000 wei — but only against source id **`testXRP`** / **`testETH`**. Probing mainnet's `XRP` there reads back "not configured" for types that are in fact enabled*
- [x] An FDC proof verifies on-chain against `FdcVerification`, and a proof for the wrong subject is rejected — *both, for real, in Phase 3: the **deployed** `FdcVerification` returns true for mainnet proof `0x1df2dda2…` replayed on the fork; a proof FDC itself accepts is refused with `WrongSubject(string,string)` because the vault is its destination not its source; a post-pin proof is refused with `ProofRejected()` against an empty-root control. Phase 2 proved the same shape at a mocked boundary*
- [x] An omitted outflow cannot inflate capacity — test the one-directional rule directly — *`test_omittedOutflowCannotInflateCapacity`*
- [x] `getUnderlyingPrice(cFXRP)` on Herkos matches the incumbent oracle with `referenceSize` small — *agrees to 8 ppm at the pin, and asserted exactly: `mine == theirs × haircut ÷ 1e6`*
- [x] **`getUnderlyingPrice` gas is within a small margin of the incumbent's** — *cheaper outright: 70,467 vs 110,614 cold. The 91,042 was the bare feed read, not the incumbent's entrypoint*
- [x] `poke()` succeeds from an address with no relationship to the publisher — *Phase 3 re-confirmed it live: **1,852,899 gas** from Anvil account 1, calldata 4 bytes — the selector and nothing else, so there is no submitted value to trust*
- [x] Raising `referenceSize` to 10M FXRP visibly reduces the forked market's borrowing power — *`npm run phase4`, 42/42, against the **real** deployed market at `0x15f69897…`. Note the wording: `collateralFactorMantissa` is a **governance constant** and reads 0.70 at every rung — an oracle cannot move it, and the earlier "tightens its collateral factor" phrasing was wrong. What moves is collateral **value**. At 10M the haircut is 999,170 ppm, effective CF 0.6994, and total borrow capacity across 8 real borrowers $2,662,798.48 → $2,658,632.54; carried to 300M it reaches 984,786 ppm / 0.6894 / $2,585,733.56 with **zero** accounts in shortfall*
- [x] The **real deployed Compound market** switches to Herkos and keeps working — *its own admin (`0x37c6c7c7…`, a **contract**, hence the impersonation) calls `_setPriceOracle` for 35,577 gas and 0 FLR. Unprivileged, the same call returns **error code 1** rather than reverting — Compound signals by return value, so a revert-only check would score a silent no-op as a pass. Fork and mainnet agree on 7/7 market reads at the pin before anything is touched, and cUSDT0 — which Herkos does not measure — delegates byte-identically at $0.999210*
- [x] Registering real exit depth widens capacity **without** tightening the haircut — *the invariant the old unconditional DEX fill violated. Three uncorrelated FXRP/USD₮0 pools move capacity 8,911,760.428 → 10,596,613.708 FXRP with the haircut unchanged at 999,992 ppm; the old code dropped it to 627,540. The correlated FXRP/stXRP pool, the deepest on Flare, is deliberately not registered — a rotation is not an exit. `addExitPool` from an unrelated account reverts `NotGovernance()`*
- [x] Staleness guard trips when the publisher is stopped — the feed reports stale, not a stale-but-confident number — *an unpoked oracle refuses to price rather than falling back or pricing at par. Phase 3 also found the guard's sharp edge on a fork: anvil's clock runs on wall time while the forked FTSO feed is frozen at the pin, so a long run trips `StaleFeed(uint64,uint64)` at the 420s window. The run warps the clock back to the pin rather than widening the window*
- [x] FLR spend per update is logged (zero on the fork — log it anyway, so the production number is honest) — *Phase 3 §9: fork 0 FLR, mainnet-equivalent poke 1.20 FLR at 650 gwei, **0 attestations requested** because the divergence gate was closed*
- [x] Herkos agrees with the incumbent when nothing is wrong — *$1.039342 vs $1.039350, **0.08 bips**, which is the 999,992 ppm haircut and nothing else. Asserted rather than printed: the run fails if Herkos ever prices **above** the incumbent, which would mean the haircut had inverted*

**Presentation**
- [x] Every figure quoted in `Writeup1.md` traces back to the results file a run wrote — *`npm run phase5`, 81/81 in this build. Traced against `fork.json`, `readers.json`, `phase3-results.json` and `phase4-results.json`; corrupt a digit in any of them and the run goes red*
- [x] No document has restored a retired figure — *the rule is pairing rather than banning: a document may name the ~600k `poke()` estimate, the 91,042 "parity" figure or the `1e30 / 1e18` scaling only if the figure that replaced it appears in the same document. That is decidable; classifying prose as assertion-or-record is not*
- [x] The forbidden phrasings are absent from both the writeup and the demo page — *checked negation-aware, because both files deliberately quote "the publisher cannot lie" and "FXRP is broken" in the act of rejecting them, and a check that fires on its own disclaimer trains people to ignore it*
- [x] The demo page loads no external script, sends no transaction and never asks for a wallet — *no CDN, no bundler, no `window.ethereum`, no `eth_send*` anywhere in `demo/app.js`; the untrusted strings it renders (an ERC-20 `symbol()`, an XRPL object field) all route through `esc()`*
- [x] The three facts that live outside this repo still hold — *Flare mainnet RPC and `xrplcluster.com` both answer a browser preflight with `access-control-allow-origin: *` (200 / 204); `FlareContractsRegistry.getAllContracts()` decodes to 67 contracts; and mainnet Relay still holds root `0x539e514f77d7791a…` for voting round 1,420,598 — the one line a judge can check with none of our files*

## Notes
- Read everything before writing anything — the measurement pass needs no keys and answers most design questions
- **Pin the fork block.** An unpinned fork drifts, gas numbers move, and the event cache never hits. `npm run phase0` holds the pin in `fork.json` and re-verifies five fingerprints at that block on every run
- **Keep the three venues straight.** Mainnet is read-only forever; the fork is where you deploy and stress; Coston2 is the optional public link. Confusing them is the only way this build starts costing money
- Pull the deployed ABI from the explorer; docs signatures have been wrong four times (see Memory1.md) — including the FDC verify-function struct shapes, so take those from the verified `FdcVerification` implementation. **The AssetManager is an EIP-2535 diamond**: its explorer ABI has zero functions, so read the dispatch table from `facets()` and merge the facet ABIs. `npm run phase0` does this; the result is `abi/AssetManager.json`
- Probe `getRequestFee` before assuming an attestation type is available on a network — a live verifier endpoint does not mean the type is enabled
- Cache event scans against a pinned head block, or the cache never hits
- FXRP is 6 decimals, and so are the vault collateral stablecoins — an 18-decimal assumption silently prints zeros
- Spend attestation fees on divergence, never on a timer
- Publisher key stays on the backend, out of the browser. On the fork it is an Anvil test key — never a funded mainnet key
- The frontend reads chain state directly from the browser (both RPCs send `access-control-allow-origin: *`), so there is no backend to keep awake and no free-tier sleep problem to solve
