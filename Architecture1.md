# Architecture: Herkos

## Purpose
Publish a verifiable on-chain measure of FXRP exit capacity, exposed through the exact price-oracle interface Flare lending markets already consume.

**Deployment model: three venues, $0.** Flare mainnet supplies the evidence
through read-only calls. An Anvil fork of Flare mainnet is where the oracle
deploys and the demo runs. Coston2 carries an optional public artifact. The
cost claim is backed by the measurements in *Zero-cost deployment*.

## High-level flow

Three loops run at different speeds and costs. That separation is the
architecture, and the gas measurements explain why it is necessary.

```
┌─ LOOP 1 — PUBLISHER (off-chain, event-driven, rare) ────────────────┐
│                                                                     │
│  1  read Flare      queue · agents · CoreVaultManager · OFT         │
│                     adapter · DEX pools · event history             │
│  2  read XRPL       Core Vault balance + escrow objects             │
│  3  read 5 chains   OFT totalSupply  (presentation detail only —    │
│                     the adapter balance on Flare is the truth)      │
│         │                                                           │
│  4  IF XRPL state diverges from Flare-side CV accounting:           │
│       request FDC attestation — native XRP types, no JSON API       │
│         XRPPayment / BalanceDecreasingTransaction → CV flows        │
│         XRPPaymentNonexistence            → prove an absence        │
│         ConfirmedBlockHeightExists        → freshness anchor        │
│         │                                                           │
│  5  wait for the voting round to finalize                           │
│  6  fetch Merkle proof from the DA Layer                            │
│  7  submit  (data + proof)  →  oracle                               │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─ LOOP 2 — POKE (on-chain, permissionless, 1.84M gas measured) ──────┐
│                                                                     │
│  anyone calls  oracle.poke()   — no privilege, no arguments,        │
│                                  no submitted values                │
│     walks  AssetManager.redemptionQueue()                           │
│     reads  CoreVaultManager · OFT Adapter · DEX reserves            │
│     writes the aggregate to storage, stamped with block + time      │
│                                                                     │
│  Expensive, but off the hot path and paid by whoever wants a        │
│  fresh number. Trustless: it only reads on-chain state.             │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                 ┌────────────────────────────────┐
                 │   ExitCapacityOracle.sol       │
                 │                                │
                 │  verifies proofs vs FDC        │
                 │  stores aggregate + timestamp  │
                 │  recomputes haircut ON-CHAIN   │
                 └────────────────┬───────────────┘
                                  ▲
┌─ LOOP 3 — CONSUMER (on-chain, hot path, every liquidation) ─────────┐
│                                                                     │
│  Compound fork / Morpho / Liquity fork                              │
│     → getUnderlyingPrice(cFXRP)                                     │
│         reads cached aggregate from storage    (cheap)              │
│         reads FTSO XRP/USD                     (~70k, unavoidable)  │
│         applies haircut                                             │
│     → returns  ftsoPrice × haircut                                  │
│                                                                     │
│  Same order of gas as the oracle they call today.                   │
└─────────────────────────────────────────────────────────────────────┘
```

Most of what Herkos needs is already on Flare and readable for free. FDC is
used where it earns its cost: **proving XRPL reality against Flare's own
bookkeeping.**

## Gas budget: measured, not assumed

`getUnderlyingPrice` runs inside Compound's
`getHypotheticalAccountLiquidityInternal` during every borrow, redeem, and
liquidation. It runs once for each market the account has entered, inside a
real transaction's gas budget.

Measured on Flare mainnet via `eth_estimateGas` (includes the 21,000 transaction base):

| Call | estimateGas | internal |
|---|---|---|
| FTSO XRP/USD read: the incumbent oracle's feed | 91,042 | ~70k |
| `redemptionQueue(0, 20)` | 141,687 | ~121k |
| `redemptionQueue(0, 100)`: the full 92-ticket queue | **540,601** | ~520k |
| `redemptionQueue(0, 1000)` | 720,842 | ~700k |

Returned data was capped at 8,928 bytes for 92 tickets, but **gas kept
climbing** because the loop still runs.

Re-measured 2026-08-09 at 80 tickets: `(0,20)` unchanged at 141,687, `(0,100)` down to **476,592**. The cost tracks the ticket count, and the ticket count moves both ways. `maxRedeemedTickets = 20` bounds a single redemption, not the queue, so nothing caps this walk.

**Consequence:** reading the queue inside `getUnderlyingPrice` would add about
600k gas to every liquidation, with the cost growing with the queue. No
lending market would accept that, so the drop-in claim would be false.

**Measured for real in Phase 2**, once both oracles existed side by side on the fork. Two corrections, both in Herkos's favour, and the second large:

| Call | cold | warm |
|---|---|---|
| Herkos `getUnderlyingPrice(cFXRP)` | **70,467** | 15,967 |
| Incumbent `getUnderlyingPrice(cFXRP)` | **110,614** | 24,108 |

The 91,042 figure above is the *bare FTSO feed read*, not an oracle
entrypoint. The incumbent's own entrypoint costs half again as much. Herkos is
cheaper than the oracle it replaces, both cold and warm. Cold reads are
measured in separate transactions with fresh access lists. Otherwise the
second oracle benefits from the FTSO slots warmed by the first.

`poke()` measures **1,836,816**, not the roughly 600k stated in the first
draft. That first figure covered `redemptionQueue(0,100)` and omitted
agent-status filtering. Filtering is the dominant term at **about 282k per
unique agent** through `getAgentInfo`. The walk caches each vault, so 80
tickets resolve to **6 unique agents** and a warm re-poke costs 13,055 per
ticket. The full cost is 6.5% of Flare's 28,027,352 block limit, or about 1.19
FLR at 650 gwei. At about 282k per agent, a walk reaching 97 *distinct* agents
would fill a block. `setQueueWalkBounds` controls that limit, and truncation
sets a flag instead of returning a short result as complete. Cheaper
substitutes were checked in the merged diamond ABI and rejected:
`getAgentLiquidationFactorsAndMaxAmount` (151,714) returns zeros for a healthy
agent, while `maxRedemptionFromAgent` (132,775) answers a different question.

**Resolution: separate refresh from read.** `poke()` pays for the walk and
writes the aggregate to storage. `getUnderlyingPrice` reads storage and the
FTSO feed. The hot path stays in the same gas range as the incumbent oracle.
`poke()` is permissionless and reads only on-chain state, so anyone can refresh
it and nobody can submit the value. The staleness guard covers a stale poke in
the same way it covers stale attested state.

## FDC attestation types: measured, not assumed

Probed `FdcRequestFeeConfigurations.getRequestFee(bytes)` across every type/source pair. A pair with no configured fee cannot be requested.

**Flare mainnet:** `0x259852ae6d5085bdc0650d3887825f7b76f0c4fe`

| Type | Sources | Fee |
|---|---|---|
| `Payment` | XRP · BTC · DOGE | 20 FLR |
| `XRPPayment` | XRP | 20 FLR |
| `XRPPaymentNonexistence` | XRP | 20 FLR |
| `BalanceDecreasingTransaction` | XRP · BTC · DOGE | 20 FLR |
| `ReferencedPaymentNonexistence` | XRP · BTC · DOGE | 20 FLR |
| `AddressValidity` | XRP · BTC · DOGE | 20 FLR |
| `ConfirmedBlockHeightExists` | XRP · BTC · DOGE | 3 FLR |
| `EVMTransaction` | ETH · FLR · SGB | 20 FLR |
| `Web2Json` / `JsonApi` | **none** | n/a |

**Coston2:** `0x191a1282ac700ede65c5b0aaf313bacc3ea7fc7e`

| Type | Sources | Fee |
|---|---|---|
| `Web2Json` | PublicWeb2 | 1000 wei |
| `EVMTransaction` | **testETH** | 1000 wei |
| XRP/BTC/DOGE types, incl. `XRPPayment` | **testXRP** · testBTC · testDOGE | 1000 wei |

The source ids are `testXRP` and `testETH`, **not** `XRP` and `ETH`. Using the
mainnet ids on Coston2 returns "not configured" even when the type is enabled.
Phase 3 measured this again after the first probe exposed the mistake. The fee
is 1000 wei rather than zero. It is faucet-covered, but the exact value matters.

**Consequences, and they all improve the design:**

1. **Web2Json is unavailable on mainnet.** A mainnet Web2Json *verifier
   endpoint* exists and returns 200, but no fee is configured. `FdcHub` will
   not accept the request.

2. **XRPL Core Vault state does not need Web2Json.** Native XRP attestation
   types are enabled on mainnet. Herkos proves ledger facts directly instead of
   proving a JSON API response.

3. **Prefer `XRPPayment` over the generic `Payment`.** It is XRP-specific,
   fee-configured on mainnet, and returns the XRPL address as a `string` rather
   than a hashed `bytes32`. That makes it easier to bind to the Core Vault.

4. **`XRPPaymentNonexistence` closes the omission gap.** It proves a payment did *not* occur, which is what makes the trust model below hold.

5. **Per-chain OFT proofs are unnecessary.** `EVMTransaction` covers ETH,
   FLR, and SGB, not Monad, HyperEVM, Base, BNB, or Katana. The **OFT
   Adapter's locked FXRP balance on Flare is the aggregate of all remote
   claims**. It is readable on-chain and reconciles against the five remote
   chains with a gap of **exactly 0**: 12,941,706,148,299 UBA on both sides,
   verified by `npm run phase1`. Reading the adapter at the pin and remotes at
   their heads gives a 0.0917% gap because bridging happened between those
   reads. Katana has no FXRP deployment at the OFT address. The per-chain
   breakdown is for presentation, not trust.

**Request path is permissionless.** `FdcHub.requestAttestation(bytes)` is
`payable` with no access control. Anyone who pays the fee can request an
attestation.

**Verification path exists on-chain.** `FdcVerification` (`0x5c14fe9d`) is an
ERC-1967 proxy over implementation `0xf7f0057b`. The implementation carries
the proof verification methods used by the publisher. **Take the struct shapes
from that verified implementation ABI, not from the interface docs.** They
differ.

## Zero-cost deployment: measured, not assumed

The build has a hard constraint: it must cost **$0**. That constraint shaped the deployment model rather than being bolted on afterwards, and every claim here was verified live.

### Three venues

| Venue | Role | Why it is free |
|---|---|---|
| **Flare mainnet** | Evidence — every number in PRD1.md | Read-only `eth_call`. Confirmed archival **1M blocks deep** on the free public RPC |
| **Anvil fork of Flare mainnet** | The demo — oracle deploy, forked lending market, FDC verification under stress | Anvil prefunds account 0 with 10,000 units; forked state, addresses and gas are real |
| **Coston2** | Optional public artifact | Faucet: 100 C2FLR + 10 USDT0 + 10 FXRP per address / 24 h, ungated. Deploy ≈2 C2FLR |

Mainnet remains the network the product is *about*. It is simply read rather than written to.

### Why the fork is representative

A fork would be a weak demo if it only simulated Flare. This one uses Flare
state, fetched per storage slot from the upstream node at a pinned block.

- **Real gas.** `redemptionQueue(0,100)` used **535,964 gas on the fork and
  540,601 on mainnet**, a 0.9% difference. That supports the measured split
  between `poke()` and the hot path.
- **Real finalized FDC roots.** `Relay.merkleRoots(200, round)` matched
  mainnet for 5 of 5 rounds finalized before the fork point. A control round
  finalized after the fork returned empty. Without that control, the test
  would prove little.
- **Real proof verification.** Mainnet transaction
  `0x615c03f28c743a5b2b7580c632d95bd7c8bb9ec4e03cd99405c51b1646665c70` was
  replayed on a fork pinned one block before it and succeeded. It carried
  selector `0xa7556da6`, 1,764 bytes of calldata, status `0x1`, and 728,630 gas.

`FdcVerification` checks a Merkle proof against a root the Relay stored for a
finalized voting round. The fork preserves those roots, so **a proof valid on
mainnet at the fork block re-verifies on the fork for free**. The demo uses a
genuine mainnet attestation for real XRPL Core Vault state. It does not use
testXRP or weaken the proof.

### The boundary of that result

Replay lets you **verify** an existing attestation for nothing. It does not
**create** one. A new mainnet attestation still costs 20 FLR. The $0 path uses
attestations **FAssets already paid for**. Those transactions carry finalized
proofs about the same Core Vault Herkos measures.

"We verified a real mainnet FDC proof at zero cost" is accurate. "FDC
attestations are free" is not.

### No always-on component

Both Flare RPCs return `access-control-allow-origin: *`, so the frontend reads
chain state directly from the browser. There is no backend to host. Render's
free tier has no cron jobs or background workers, and free Web Services sleep
after 15 minutes of inactivity. Static Sites are free and do not sleep.

- **Publisher cadence** → GitHub Actions cron (free)
- **Frontend** → Render Static Site (free, never sleeps)
- **State** → the chain

## Components

### 1. ExitCapacityOracle.sol
This is the product. Everything else feeds it. It is deployed to the Anvil
fork for the demo and can be deployed to Coston2 as a public artifact. It is
written for mainnet; its behavior does not depend on a fork.

**Hot path: keep it cheap**
- `getUnderlyingPrice(address cToken)`: Compound-compatible, scaled
  `1e(36 - underlyingDecimals)` = `1e30` for 6-decimal FXRP
- Reads the cached aggregate from storage and FTSO XRP/USD, then applies the haircut
- Never walks the queue

**Refresh path: permissionless, expensive, and off the hot path**
- `poke()`: walks `AssetManager.redemptionQueue()`, reads Core Vault funds, the OFT Adapter FXRP balance, and DEX pool reserves, then writes the aggregate with a block and timestamp
- No arguments, no privilege, and no submitted values. Anyone can call it, including the publisher, a liquidator, or a judge

**Proof path**
- Accepts `(data, proof)` for XRPL Core Vault flows and optional Ethereum OFT supply
- Validates against `FdcVerification` before storage
- Rejects proofs whose attested subject is not the Core Vault address / expected OFT contract

**Public interface**
- `exitCapacity()`, `clearingPrice(uint256)`, `timeToExit(uint256)`
- `clearingPricePPM()` returns the **raw** curve. The stored `haircutPPM` used by
  `getUnderlyingPrice` is floored at `minHaircutPPM` and capped at par. The
  values match while the floor is inactive, as it is at the pin. They differ
  at larger sizes, so a reader must model both.

**Routing: closed in Phase 4**
- The old `_clearingPPM` sent `min(amount, dexExitUBA)` through the DEX even
  when redemption was cheaper. Registering the exit pools raised
  `exitCapacity` from 8,911,760,428,154 to 10,596,613,708,126 while tightening
  the reference haircut from 999,992 ppm to **627,540 ppm**. Capacity and
  price moved in opposite directions.
- **An exit venue is optional.** If constant-product execution is worse than
  waiting for redemption at par, the correct answer is to wait. That makes
  `_clearingPPM(n) >= _redeemPPM(n)` an invariant. A pool can never make the
  exit price worse than it was without the pool.
- Constant product pays an average of `x/(x+dx)` and a **marginal**
  `x²/(x+dx)²`. The two legs match at `dx* = dex × (1 − √k)/√k`, where `k` is
  the redemption ratio. The slice is capped there. `k` is evaluated once
  against the full amount, which errs toward routing *more* to the DEX.
- After the fix, the three pools raise capacity from **8,911,760.428 to
  10,596,613.708 FXRP** while the haircut stays at **999,992 ppm**. The
  invariant is covered by `test_dexCanOnlyImprove`,
  `test_registeringPoolsWidensCapacityWithoutTighteningTheHaircut`, and
  `test_clearingPriceStaysMonotonicWithPoolsRegistered`.
- `referenceSize` asks what exit size the market wants to remain solvent at.
  A larger size must not produce a better price. The old fixed DEX slice broke
  that rule by averaging a 1.68M slice against a growing near-par remainder.
- `_sqrt` stays off the hot path. `_clearingPPM` is reached through
  `_recompute()` and public views; `getUnderlyingPrice` reads the stored result.

**Guards and governance**
- Staleness guard on the poked aggregate and attested state. Report stale data rather than a confident number
- Governance: `referenceSize`, liveness decay constants, discount rate `r`, divergence threshold, staleness windows

### 2. Publisher (off-chain, stateless)
A relayer, deliberately without authority over the value.

The reader is `scripts/phase1.js` (`npm run phase1`). It is read-only and
dependency-free. Flare reads use the pinned block, and addresses resolve
through the registry at runtime. It writes `readers.json`, which the Phase 3
publisher consumes.

- Readers: Flare contracts, XRPL JSON-RPC, remote-chain RPCs, DEX pools, Flare event history
- Builds the agent-liveness model from `RedemptionRequested` / `RedemptionPerformed` / `RedemptionDefault`
- Calls `poke()` on its own cadence and requests attestations only on divergence
- **Event-driven rather than fixed interval.** At 20 FLR per attestation, a
  15-minute cadence costs about 1,920 FLR per day, or **$11.74 per day**, for
  no new information. The publisher requests an attestation only when XRPL
  state passes the divergence threshold, with a low-frequency heartbeat.
- **Cadence comes from a GitHub Actions cron.** The publisher is stateless and
  short-lived, which keeps it free to run.
- Requests attestations, waits for finalization, fetches Merkle proofs from the DA Layer (`POST /api/v1/fdc/proof-by-request-round`), submits `(data, proof)`

### 3. Liveness model
This part comes from settlement history rather than a single contract read.

- Per-agent settlement history over the full deployment window (block 47,098,178 → head)
- `liveness(agent) ∈ [0,1]`, decaying with time since last successful settlement
- Hard penalty on recent `RedemptionDefault`
- Queue tickets weighted by their agent's liveness → `effectiveQueue`

**The split is structural.** `poke()` can apply only a *binary* on-chain filter:
`getAgentInfo(agent).status <= 1`, meaning NORMAL or CCB. Per-agent settlement
history is too expensive to read on-chain, so the decay model lives in the
publisher. It can only reduce a ticket's weight. It cannot lift a ticket above
what the on-chain filter permits. This is the same one-directional rule used
for attested state.

The constants are a judgement call, not a derivation: a 48-hour settlement
horizon, a 30-day default window, each recent default halves the score, and
there is no floor. `npm run phase1` prints them at runtime so they can be
reviewed rather than hidden in a constant.

**The scan depends on reading topic0 from the deployed ABI.** The documented
`RedemptionPerformed` signature declares `uint64 requestId`; the deployed event emits
`uint256`, hashing to `0xd5150395`. A scan keyed to the documented signature
finds **zero** settlements and reports a dead system. That is what the earlier
research pass did. Recompute from `phase0-results.json`'s
`redemptionEventTopics`, never from the docs.

### 4. Demo consumer
**Complete: `npm run phase4`, 42/42, writing `phase4-results.json`.** The
forked Compound-style market is wired to Herkos so the effect is visible. A
live market would need its own governance process to make the same switch.

The Anvil fork keeps the real deployed Compound market at `0x15f69897`, its
real address, and its real FXRP collateral. Anvil can impersonate the admin,
which makes `_setPriceOracle` callable on the fork. The behavior is measured
against genuine positions rather than seeded ones: **8 real borrowers**,
`getAccountLiquidity` from real storage, and **7 of 7** fork and mainnet reads
matching at the pinned block before the switch.

The run establishes three things. First, agreement: Herkos returns **$1.039342**
against the incumbent's **$1.039350**, a difference of 0.08 bips. The
999,992 ppm haircut accounts for the difference, and `spotUnderlyingPrice()`
is byte-identical. Second, the switch works. The admin is a **contract**,
and an unprivileged `_setPriceOracle` returns **error code 1** rather than
reverting. The impersonated call costs 35,577 gas and 0 FLR. Third, increasing
`referenceSize` produces the measured divergence below.

**Divergence changes borrowing power, not the collateral factor.**
`collateralFactorMantissa` is a **governance constant** at 0.70 for every rung.
Herkos changes the USD value of the collateral, which changes borrowing power:

| referenceSize | haircut | effective CF | time to exit | total borrow capacity |
|---|---|---|---|---|
| 1M FXRP | 999,992 | 0.7000 | 0.0d | $2,662,798.48 |
| 10M | 999,170 | 0.6994 | 2.0d | $2,658,632.54 |
| 50M | 997,526 | 0.6983 | 6.0d | $2,650,300.65 |
| 150M | 992,184 | 0.6945 | 19.0d | $2,623,227.07 |
| 300M | 984,786 | 0.6894 | 37.0d | $2,585,733.56 |

The curve is monotone, the 500,000 ppm floor holds, and **zero accounts entered
shortfall at any rung**. cUSDT0 is a market Herkos does not measure. It
delegates to the fallback and prices byte-identically at $0.999210, which keeps
Herkos drop-in rather than FXRP-only.

### 5. Presentation
**Complete: `npm run phase5`, 81/81 in the current build, writing
`phase5-results.json`.** `Writeup1.md` explains the result. `demo/` is a
static page served by a dependency-free Node server (`npm run demo`, then
`http://localhost:8080/`). The page loads no CDN, connects no wallet, and sends
no transaction. Every live figure is an `eth_call` to the public Flare RPC or
a JSON-RPC read of the XRP Ledger from the browser. Both endpoints answer CORS
preflight with `Access-Control-Allow-Origin: *`; `s1.ripple.com:51234` does not,
so XRPL reads use `xrplcluster.com`. The page re-derives the correlated-pair
exclusion and labels pinned and live figures separately.

The verifier protects the presentation. `scripts/phase5.js` re-reads every
figure in the write-up and demo and compares it with `fork.json`, `readers.json`,
`phase3-results.json`, and `phase4-results.json`. Change a source digit and the
run fails. It also checks the important wording: borrowing power rather than
the collateral factor, permissionless rather than free, and replayed rather
than freshly requested. It keeps retired figures paired with their replacements.
The current run needs no fork, key, or account.

## Trust Model

**The publisher cannot move the number in the dangerous direction.** This is
the load-bearing property. "The publisher cannot lie" would be too strong.

| Data | Where it comes from | Why it can't be forged |
|---|---|---|
| Queue depth | `poke()` reads `AssetManager` | On-chain, no submitted value |
| Core Vault accounting | `poke()` reads `CoreVaultManager` | On-chain, no submitted value |
| Total off-Flare claims | `poke()` reads OFT Adapter balance | On-chain, no submitted value |
| FTSO price | Read in the hot path | On-chain, publisher not involved |
| DEX reserves | `poke()` reads pools | On-chain, no submitted value |
| XRPL CV flows | Publisher submits | FDC `XRPPayment` / `BalanceDecreasingTransaction` proof, verified vs `FdcVerification` |
| Ethereum OFT supply | Publisher submits | FDC `EVMTransaction` proof, verified vs `FdcVerification` |
| Haircut | Computed on-chain from the above | Never submitted at all |

### The omission rule

FDC proves a *specific transaction*, and the publisher chooses which
transactions to submit. A publisher that attests inflows and skips outflows
could make the Core Vault look healthier than it is. Forged data is
impossible; **selective silence is not.**

Three things close it:

1. **Attested state is one-directional.** It may only *reduce* measured capacity, never raise it: `capacity = min(FlareAccounting, XRPLProved)`. Selective attestation can then only make the haircut more conservative.
2. **Omission degrades to the on-chain baseline.** A publisher that submits
   nothing leaves the oracle on Flare's own `CoreVaultManager` accounting,
   which is the baseline every consumer has today.
3. **`XRPPaymentNonexistence` proves an absence** when a specific claim needs closing rather than inferring.

If the publisher goes offline, the oracle becomes **stale and visibly so**. It
cannot produce a number that is wrong in the optimistic direction.

No TEE. No signing key holding up the trust model. No LLM anywhere in the valuation path. The publisher key pays gas and attestation fees; it grants no authority over values.

## Data Sources

| Source | Endpoint / contract | Purpose |
|---|---|---|
| AssetManager FXRP | `0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8` | queue, settings, events |
| FXRP token | `0xAd552A648C74D49E10027AB8a618A3ad4901c5bE` (6 dp) | supply |
| CoreVaultManager | `0x6c8d96defe4cbee05fa969fc0ac436d94fc21784` | `availableFunds()`, `escrowedFunds()` |
| FXRP OFT Adapter | `0xd70659a6396285BF7214d7Ea9673184e7C72E07E` | aggregate off-Flare claims |
| Incumbent oracle | `0x61f77ef0064736ffa68c31d960e55baf67f79a4b` | baseline to match / diverge from |
| FtsoV2 | `0x7bde3df0624114edb3a67dfe6753e62f4e7c1d20` | XRP/USD — same address the incumbent uses |
| FdcHub | `0xc25c749dc27efb1864cb3dada8845b7687eb2d44` | attestation requests (permissionless) |
| FdcRequestFeeConfigurations | `0x259852ae6d5085bdc0650d3887825f7b76f0c4fe` | fee lookup / availability test |
| FdcVerification | `0x5c14fe9d73ab763f4d4a76f334bf7029ddd20ecc` → impl `0xf7f0057b…` | on-chain proof verification |
| Relay | `0xccf30790a93f15e24eb909548a2c58a9b0a7fbd4` | Merkle roots |
| XRPL Core Vault | `rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj` | `account_info`, `account_objects` |
| FlareContractsRegistry | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` | resolve everything at runtime |
| DA Layer | `POST https://flr-data-availability.flare.network/api/v1/fdc/proof-by-request-round` | Merkle proof retrieval (`GET` returns 405) |
| Coston2 AssetManager FXRP | `0xc1ca88b937d0b528842f95d5731ffb586f4fbdfa` | optional public artifact venue |
| Coston2 FXRP | `0x0b6a3645c240605887a5532109323a3e12273dc7` | 4,134,805 supply · 4 available agents |

Addresses above are for **verification only**. Resolve at runtime through the registry — see setup1.md.

## Design Principles

- The consumed interface must be the one they already call, or adoption is zero
- **The hot path must cost what the incumbent costs.** Expensive work belongs in a permissionless refresh, not in `getUnderlyingPrice`
- Anything the contract can read itself, it reads itself — and most of it can
- Anything it can't read, it demands a proof for
- **Submitted data may only make the number more conservative, never less**
- Spend FDC fees on divergence, not on heartbeat
- Under normal conditions Herkos must agree with the incumbent oracle — divergence has to be earned
- Stale beats confidently wrong
- Every published number traces to a source a judge can independently check
- **Free is a design constraint, not a compromise.** The fork carries real state, real gas and real proofs, so nothing about the evidence is weakened by refusing to spend

## Explicit Non-Goals

- No new protocol contracts in the FAssets system
- No custody, no capital movement, no execution
- No off-chain component that holds authority over a value
- No agent-side operator tooling
- No retail interface
