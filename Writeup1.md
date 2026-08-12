# Herkos: the writeup

*Flare Summer Signal, Bounty 1. An exit capacity oracle for FXRP.*

**Herkos is a drop-in Compound price oracle.** It uses the same
`getUnderlyingPrice(address cToken)` interface. The difference is the number it
returns: the FTSO XRP/USD price multiplied by a haircut derived on-chain from
how much FXRP could leave the system and how long the exit would take.

Adoption takes one governance call: `comptroller._setPriceOracle(herkos)`. It
needs no new interface, no off-chain price feed, and no new token.

Every number below was measured. Live readings are labelled as live. Recorded
figures name the file that produced them. Section 6 shows how to reproduce the
figures for $0.

## Coston2 test market

The repository now includes a separate public deployment on Flare Testnet
Coston2. It gives a judge a real transaction path without pretending that
Herkos has been adopted by a Mainnet lending protocol.

The [Coston2 test market](https://herkos.vercel.app/testnet) uses faucet
FTestXRP as collateral and faucet USDT0 as liquidity and debt. It has a 70%
maximum loan-to-value ratio, a 75% liquidation threshold, a 5% liquidation
bonus, and no interest accrual. A visitor can connect a browser wallet, get
assets from the [official faucet](https://faucet.flare.network/coston2),
refresh Herkos, supply liquidity, deposit collateral, borrow, repay, and
withdraw. If the wallet does not know Coston2 yet, the app asks it to add the
official network and switch to it. The assets have no monetary value.

The deployment was checked with 10 USDT0 and 10 FTestXRP. The flow borrowed 7
USDT0, repaid it, withdrew the collateral, and withdrew the supplied
liquidity. The final position was zero. A later transaction left a fresh 10
USDT0 reserve for the next judge. Every step is recorded in
[`deployments/coston2.json`](deployments/coston2.json) with a Coston2 Explorer
link.

| Contract | Address |
|---|---|
| Spot oracle | [`0x45A25862a31530197a3a7C1CA7a426959BD3dc8a`](https://coston2-explorer.flare.network/address/0x45A25862a31530197a3a7C1CA7a426959BD3dc8a) |
| Herkos oracle | [`0xdbE3207e6b6e25417FdC24B99932f554718C0972`](https://coston2-explorer.flare.network/address/0xdbE3207e6b6e25417FdC24B99932f554718C0972) |
| Lending market | [`0xb482A2FA8ec63F76B711813e685C4b4568a1c255`](https://coston2-explorer.flare.network/address/0xb482A2FA8ec63F76B711813e685C4b4568a1c255) |

This path is deliberately separate from the Mainnet evidence below. The
Mainnet app remains read-only and its lending integration remains a pinned
fork result against an existing deployed market.

---

## 1. The gap

A lending market holding FXRP as collateral prices it at the XRP/USD spot rate. That price is correct
about what one FXRP is worth. It is silent about whether the market could get out.

Measured on Flare mainnet at the pinned block **67,013,823**:

| Signal | Measured | Relative to the redemption queue |
|---|---:|---:|
| Redemption queue, first page (80 tickets) | 1,860,950 FXRP | 1× |
| Uncorrelated DEX depth (3 FXRP/USD₮0 pools) | 1,684,853 FXRP | 0.91× |
| Cross-chain claims (OFT Adapter locked) | 12,929,855 FXRP | **7×** |
| FXRP posted as lending collateral | ~113,600,000 FXRP | **61×** |
| FXRP total supply | 148,911,767 FXRP | 80× |

The top row is the amount a liquidation engine must handle. The bottom row is
the amount the market is exposed to. The incumbent oracle cannot see this gap.
It reads a price feed and returns it.

**FXRP is not broken.** 23,988 redemptions have settled. Eight defaulted
(0.0334%), and every defaulted redeemer was made whole plus 5%. The system
works. The point is a *missing measurement*, not a hidden crisis.

Two more numbers that belong in the same paragraph, because a judge will ask:

- **766,000 FXRP/day is demonstrated throughput, not capacity.** It reflects demand, not a limit. Real
  capacity is probably higher. How much higher is unknown, and that unknown is the product.
- **6 agents.** It is a small system today. The debt built on top of it is large.

### Why the deepest pool counts for zero

The deepest FXRP pool on Flare is **FXRP/stXRP, 2,319,350 FXRP** at the pin.
Herkos counts none of it. stXRP is XRP, so trading FXRP for stXRP is a
rotation within the same underlying asset, not an exit from it. If XRP exit
liquidity is under stress, both sides of that pool are under stress together.
Counting it would inflate capacity, which the design forbids.

The three uncorrelated **FXRP/USD₮0** pools contain 1,684,853 FXRP at the pin.
Those are the pools Herkos counts.

The flag is per-pool and governance-settable, so a mislabelling is correctable without redeploying.
`test_correlationFlagIsTheWholeDifference` in the Phase 2 suite proves the flag alone is the difference
between the two capacity figures.

---

## 2. The XRPL leg, with its FDC proof

FXRP's Core Vault holds XRP on the XRP Ledger. Flare's own accounting reports
the amount. Herkos checks the XRP Ledger directly and stores
**`min(FlareAccounting, XRPLProved)`**.

At the pin:

| Source | Value |
|---|---:|
| Flare accounting: `CoreVaultManager.availableFunds()` | 7,050,810.428154 FXRP |
| XRP Ledger: account balance minus escrowed objects | 7,063,788.996353 XRP |
| Divergence | 12,978.568199 (**18 bips**) |

The Core Vault account is **`rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj`**. The
demo reads its live escrow records and reports how many are condition-gated.

### What the FDC proof is

Phase 3 found a genuine, finalized mainnet FDC attestation in the calldata
of a transaction **FAssets itself paid for**. It was an
`executeDirectMinting` transaction starting with `0x1df2dda2`, at block
67,012,947, voting round **1,420,598**, with 1,120 bytes of proof.

On the fork, the **deployed** `FdcVerification` at `0x5c14fe9d` resolves
through the registry and returns **true** for this proof. The fork holds the
finalized Merkle root beginning `0x539e514f` for that round. Eight harvested
proofs re-encode **8/8 byte-identical** to the original mainnet calldata.

The important boundary is simple: **real proof, real Core Vault, replayed rather
than freshly requested.** Replay verifies an existing attestation for free. It
does not create one. A new attestation costs 20 FLR on mainnet. The replayed
attestations concern the same XRPL account Herkos measures.

### Two rejections, which are the actual test

Accepting a valid proof is only the first check. The important checks are:

1. **Wrong subject.** `FdcVerification` accepts the proof as authentic, but
   Herkos refuses it with `WrongSubject(string,string)`. The address
   `rwerD4SoJ8sHPKqXWTf93n7QgQfAJy4HEo` is the payment's *source*. The vault
   is its *destination*. It is an inflow, and crediting it would **raise**
   capacity.
2. **Post-pin round.** A proof from round 1,421,530, finalized after the
   pin, is refused with `ProofRejected()`. The fork holds no root for that
   round. An empty-root control confirms that the rejection is caused by the
   unknown root, not by a verifier that rejects every proof.

**`FdcVerification` judges authenticity. Herkos judges direction.** Both have to pass.

### Why lying by omission does not work

FDC proves specific transactions, so a publisher could attest inflows and skip
outflows. Forging data was never possible. Selective silence was. The bound is
that **attested state is one-directional**. Submitted data may only make the
number *more conservative*, never less. Silence therefore makes Herkos more
cautious, and total silence falls back to Flare's own on-chain accounting.

The correct sentence is **"the publisher cannot move the number in the dangerous direction."**
"The publisher cannot lie" is too strong. A judge can break that claim with one question.

In the Phase 3 run, the divergence gate **declined to attest**. The difference
was 18 bips, under the threshold and in the capacity-*raising* direction. A
run that attests nothing is a normal outcome. It cost 0 FLR because the gate
only requests an attestation when divergence requires one.

---

## 3. Side by side on the deployed market

Phase 4 pointed the **real deployed Compound market** on Flare at Herkos. On
the fork it kept its mainnet storage: comptroller `0x15f69897`, cFXRP
`0xD1b7A5eF`, and incumbent oracle `0x61f77ef0`. The fork was pinned at
67,013,823. The market's **own admin** made the switch. Anvil impersonated
that admin, and the call cost **0 FLR**.

### Agreement comes first

| | Value |
|---|---:|
| Incumbent oracle | $1.039350 |
| Herkos | $1.039342 |
| Difference | **0.08 bips** |
| Haircut | 999,992 ppm |

`spotUnderlyingPrice()` is **byte-identical** to the incumbent. The difference
comes entirely from the haircut, not from a different feed. A calm market
should produce a near-identical price. A disagreement needs a measured reason.

cUSDT0 is a market Herkos does *not* measure. It delegates to the fallback
and prices byte-identically at **$0.999210**. Herkos can therefore sit in a
Compound market without changing prices for assets it does not cover.

### The price changes as the exit gets larger

`referenceSize` is the exit size the market is asking the oracle to price. The
measured curve is:

| referenceSize | Haircut (ppm) | Price | Time to exit | Effective CF | Borrow capacity, 8 real borrowers | Shortfalls |
|---:|---:|---:|---:|---:|---:|---:|
| 1M FXRP | 999,992 | $1.0393417 | 0.0 d | 0.6999944 | $2,662,798.48 | 0 |
| 10M | 999,170 | $1.0384873 | 2.0 d | 0.6994190 | $2,658,632.54 | 0 |
| 50M | 997,526 | $1.0367786 | 6.0 d | 0.6982682 | $2,650,300.65 | 0 |
| 150M | 992,184 | $1.0312264 | 19.0 d | 0.6945288 | $2,623,227.07 | 0 |
| 300M | 984,786 | $1.0235373 | 37.0 d | 0.6893502 | $2,585,733.56 | 0 |

An oracle cannot change a collateral factor. `collateralFactorMantissa` is a
governance constant and reads **0.70 at every rung**. The oracle changes the
*USD value of the collateral*, and therefore the market's **borrowing power**.
The table reports **effective CF = CF × haircut** alongside real
`getAccountLiquidity` deltas for 8 borrowers with real FXRP collateral.

The haircut decreases at every rung, the 500,000 ppm floor holds, and **zero**
accounts entered shortfall.

### The inputs behind the number

`inputs()` returns the twelve derived values in one call. A consumer can
**re-derive** the haircut instead of trusting a submitted number:

| Input | Value at the pin |
|---|---:|
| Effective queue (liveness-filtered) | 1,860,950 FXRP |
| Core Vault | 7,050,810.428 FXRP |
| Uncorrelated DEX exit depth | 1,684,853.280 FXRP |
| Remote claims | 0 |
| **Total exit capacity** | **10,596,613.708 FXRP** |
| Queue tickets read | 80, untruncated |
| Poked at | block 67,013,852 |

**The haircut is computed on-chain from these stored inputs. It is never submitted.**

### Registering a venue can only improve capacity

Registering the three uncorrelated pools increases capacity from
**8,911,760.428 to 10,596,613.708 FXRP** while the haircut stays at
**999,992 ppm**.

This follows from the invariant `_clearingPPM(n) >= _redeemPPM(n)`. Nobody is
forced to use an AMM, so an *optional* exit venue cannot make the price worse.
Before Phase 4, the DEX slice filled at `min(n, dexExitUBA)` unconditionally.
That raised capacity while producing a worse price: the reference haircut
tightened to 627,540 ppm, which meant more capacity and a worse price. The fill
is now capped at

```
dx* = dex × (1 − √k) / √k
```

the depth at which the marginal DEX unit stops beating redemption. `k` is
evaluated once against the whole amount. That errs toward routing *more* to
the DEX rather than less. Three tests pin the invariant. `_sqrt` stays off the
hot path and is reached only from `_recompute()` and public views.

---

## 4. What a refresh costs

Three loops run at different speeds and costs. The separation follows from the
measured gas.

| Loop | Where | Cost | Trigger |
|---|---|---:|---|
| **Publisher** | Off-chain, stateless | 0 FLR when the gate is closed; 20 FLR per attestation when open | GitHub Actions cron every 30 minutes; attests **only** on divergence |
| **`poke()`** | On-chain, permissionless | **1,836,816 gas** measured, about 1.19 FLR at 650 gwei | Anyone, any time, with no arguments or privilege |
| **`getUnderlyingPrice()`** | On-chain, hot path | **70,467 cold / 15,967 warm** | Every borrow, redeem, and liquidation |

**The hot path never walks the queue.** `getUnderlyingPrice` runs inside
Compound's `getHypotheticalAccountLiquidityInternal` during every borrow,
redeem, and liquidation. A full queue walk costs 540,601 gas and grows with
the queue. It belongs in `poke()`. The hot path reads a cached aggregate and
the FTSO feed.

Measured on the fork against the incumbent's own entrypoint:
**70,467 / 15,967 versus 110,614 / 24,108.** Herkos is *cheaper* than the
oracle it replaces. Cold reads must be measured in separate transactions, or
the second oracle benefits from storage warmed by the first.

`poke()` is **permissionless, not free**. Someone pays 1.84M gas, or 6.5% of
a Flare block. Cost scales with *unique agents*, not tickets: 80 tickets
resolve to 6 agents at about 282k each. A walk reaching about 97 distinct
agents would fill a block. The page budget controls that limit. Production
needs an incentive for whoever pays the refresh cost. The demo publisher pays
it.

If an input is stale, the oracle refuses to price it. It does not extrapolate
from old data.

---

## 5. Honest weaknesses

These are the limits a judge should know before relying on the result.

1. **Nothing has broken yet.** "Before it breaks" is harder to demonstrate
   than "after." There have been 23,988 redemptions and 8 defaults. Every
   defaulted redeemer was made whole plus 5%.

2. **766,000 FXRP/day is demonstrated throughput, not capacity.** It shows
   demand, not the maximum the system can settle.

3. **The counterargument is real.** FXRP redeems 1:1 eventually, so a lender
   can say timing does not matter. Liquidation engines still depend on
   *immediacy*. A liquidator who cannot exit within the liquidation window may
   not bid, and a market with no bidders is where bad debt comes from.

4. **6 agents.** It is a small system. The debt built on top is large.

5. **FDC attestation fees are 20 FLR per request on mainnet.** A 15-minute
   heartbeat costs about $11.74 per day for no new information. The publisher
   is event-driven for that reason. This is a design cost, not a blocker.

6. **The demo runs on a fork, and the FDC proofs it verifies are ones FAssets
   already paid for.** The fork carries real addresses, real state, gas within
   0.9% of mainnet, and real finalized Merkle roots. It does not let Herkos
   create a new attestation for free.

7. **Not every remote chain is FDC-provable.** `EVMTransaction` covers
   ETH, FLR, and SGB only, so mainnet cannot prove OFT supply per remote chain.
   Herkos reads the OFT Adapter's locked balance on Flare instead. It is the
   aggregate of remote claims and matches with a gap of **exactly 0 when both
   sides are read at the same block**. The pin versus head comparison reads
   0.0917%, which reflects elapsed bridging rather than a discrepancy.

8. **The publisher can lie by omission.** FDC proves specific transactions,
   so a publisher could attest inflows and skip outflows. The one-directional
   attested state limits the damage, but it is still important to state this
   rather than claim the publisher "cannot lie."

9. **A fresh number costs someone gas.** `poke()` costs 1.84M gas, three times
   the first estimate of about 600k. Agent liveness filtering dominates; the
   early figure counted only the queue read. The refresh is *permissionless*,
   not free.

10. **The Mainnet integration is a forked market, not a live integration.** The
    real deployed market was repointed by its own admin on the fork. The admin
    is a contract, so Anvil had to **impersonate** it. The separate Coston2
    deployment is a public test market and does not imply a Mainnet governance
    decision.

11. **`referenceSize` is a governance parameter, and it sets the shape of the
    curve.** Herkos does not decide how large an exit a market should be priced
    against. Whoever sets `referenceSize` does. At 1M, Herkos agrees with the
    incumbent to 0.08 bips. The market keeps the risk decision. Herkos measures
    capacity; it does not set policy.

12. **One publisher today.** The relayer is a single off-chain process. It
    cannot move the number in the dangerous direction, and the on-chain
    measurement does not depend on it because `poke()` is permissionless.
    Decentralizing the attestation half is future work.

**Two earlier questions are resolved.** `Web2Json` is unavailable on Flare
mainnet, as measured in the live configuration, and the design no longer
needs it. The $0 build still has real evidence: mainnet is read for free, the
fork carries 0.9% gas fidelity, and a real mainnet FDC proof re-verifies on it.

---

## 6. Reproduce every number

**Mainnet reproduction prerequisites:** Node 20+ and Foundry (`anvil`, `forge`,
`cast`). The read-only research and fork reproduction need no funded account,
API key, or `npm install`. Nothing in this repo imports a package, and there is
no `node_modules`. The project is dependency-free by design. The optional
Coston2 deployment commands use a separate throwaway faucet-funded wallet.

### The three venues

| Venue | Role | Rule |
|---|---|---|
| Flare mainnet | Evidence | **Read-only forever.** `eth_call` only |
| Anvil fork of mainnet | The demo: deploy, stress, and FDC verification | Where every write goes |
| Coston2 | Public test market | Free faucet |

Confusing them is the only way this build costs money. Never point `forge create --broadcast` at the
mainnet RPC.

### Boot the fork

```bash
anvil --fork-url https://flare-api.flare.network/ext/C/rpc \
      --fork-block-number 67013823 --port 8545 --no-rate-limit
```

`--no-rate-limit` is required: a `poke()` is hundreds of state fetches and the public RPC will otherwise
rate-limit the queue walk into transport failures.

### Run the phases

| Command | What it proves | Checks |
|---|---|---:|
| `npm run phase0` | Registry resolution, deployed shapes, the diamond's real ABI, the fork pin | 44 |
| `npm run phase1` | Off-chain readers: queue walk, ~20M-block event scan, liveness, XRPL, OFT, DEX, reconciliation | 54 |
| `npm run phase2` | The oracle contract on a fork, plus 2 gas budgets | 54 |
| `npm run phase3` | Publisher: divergence gate, `poke()`, harvest, real proof verification, both rejections | 32 |
| `npm run phase4` | The real deployed market repointed at Herkos by its own admin | 42 |
| `npm run phase5` | Public release check for routes, source hygiene, and deployment records | n/a |
| `npm run demo` | The demo page, reading live from Flare mainnet and the XRP Ledger in your browser | n/a |

The research phases write local `phaseN-results.json` files so their evidence
can be inspected after a run. Those generated files remain ignored. `npm run
phase5` checks the public source set, deployment records, routes, and release
hygiene without depending on generated reports.

### Two ordering constraints that are checks doing their job, not flakes

- **Phase 2 needs a fresh anvil.** `ForkBase` forks anvil's HEAD and asserts `block.number == 67,013,823`,
  so a fork dirtied by a Phase 4 run fails the pin assertion.
- **Phase 4 leaves the market live behind Herkos.** It repoints the real comptroller, so a second run
  against the same fork fails its "starts on the incumbent" check. Reboot anvil at the pin between runs.

### The demo page

```bash
npm run demo        # → http://localhost:8080/
```

The page reads **live from Flare mainnet and the XRP Ledger in the browser**.
It sends no transaction and never asks for a wallet. It loads no external
script, framework, or bundler. Each selector is kept next to its signature.

`scripts/demo.js` is a static file server and nothing else. It exists only because a browser will not
`fetch` a local JSON file from a `file://` page.

Live values will differ from the pinned figures in this document as the network
moves. The page labels live readings and pinned results separately. The stress
section always uses the recorded fork result; it does not connect to a local
fork or ask for a wallet.

### Read-only checks with no fork

`phase0` and `phase1` need only Node and an internet connection. They need no
Foundry, fork, or key. Together they re-derive every signal in section 1 from
mainnet and the XRP Ledger:

```bash
npm run phase0      # registry resolution, deployed shapes, diamond ABI, 44 checks
npm run phase1      # queue, event scan, liveness, XRPL, OFT, DEX, reconciliation
                    # 54 checks, writes readers.json
```

`phase1` is the slow one: the event scan is ~20M blocks on the first run and is cached against the pin
afterwards. `RESCAN=true` forces a refetch.

### The Coston2 test market

```bash
npm run deploy:coston2   # requires PUBLISHER_KEY in an ignored local environment
npm run verify:coston2   # uses C2_VERIFIER_KEY or PUBLISHER_KEY
```

The deployment script refuses a non-Coston2 chain and writes only public
addresses and transaction hashes. The verification script runs one small
position and checks every receipt before recording the explorer links. A
fresh visitor can use the already published deployment from
<https://herkos.vercel.app/testnet> without running either command.

---

## What would make this wrong

These are the conditions that would make the result too conservative or less
useful:

- If exit capacity is materially larger than the four measured venues suggest,
  Herkos under-reports capacity and the haircut is too harsh. A large agent
  minting on demand or an OTC desk that never touches a pool could cause this.
  The 500,000 ppm floor limits the effect, and `referenceSize` limits it again.
- If liquidators can always wait, time to exit is not a risk input for them and
  the correct haircut is 1.0. At a 1M reference size, Herkos returns $1.039342
  against the incumbent's $1.039350. That is the default case.
- If FXRP redemption never comes under stress, the measurement never becomes
  load-bearing. That is the honest version of weakness 1.

---

*Herkos measures exit capacity. It does not predict a failure.*
