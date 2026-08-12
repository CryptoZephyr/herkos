# Herkos

Herkos is an exit-capacity oracle for FXRP lending on Flare.

It answers one practical question: if many lending positions need to exit at
once, how much FXRP can the system settle? The oracle measures that capacity
and applies a conservative haircut to the existing XRP/USD price. Lending
markets can keep using the familiar `getUnderlyingPrice(address)` interface.

The measurement uses three inputs:

- open redemption demand;
- liquid Core Vault funds; and
- eligible DEX depth that can move FXRP into a stable asset.

The result is intended for Compound-style lending markets. It does not need a
wallet connection or a new market interface.

## Live demo

[Open the Herkos demo](https://herkos.vercel.app/)

The demo is a static, read-only browser app. It reads public Flare and XRP
Ledger data from the browser. It has no Herkos backend, account system, API
key, or transaction flow.

The page separates live network readings from the pinned lending-market
snapshot. Live readings show their Flare block. The pinned result uses one
mainnet fork block for its comparisons.

## Official documentation

[Read the Herkos docs](https://herkos.vercel.app/docs/index.html)

The docs cover the measurement model, data sources, contract interface,
verification boundaries, privacy, and terms of use.

## Run locally

The demo needs Node 20 or newer. It has no package dependencies.

```bash
npm run demo
```

Open <http://localhost:8080/>.

## Test the contract

The contract tests use Foundry and a Flare fork:

```bash
forge test -vv
```

The repository also includes the scripts used to collect readings and run the
forked integration. Generated reports and local research caches are intentionally
excluded from the public repo.

## Repository map

- `demo/`: the judge-facing web app
- `docs/`: official product documentation
- `src/ExitCapacityOracle.sol`: the oracle contract
- `test/`: contract tests
- `abi/`: verified external contract interfaces used by the scripts
- `scripts/`: local readers, fork checks, and the static demo server
- `fork.json`: the pinned fork block and deployment references
- `Writeup1.md`: the technical submission narrative

## Scope

Herkos is a measured research prototype and hackathon integration. It does not
claim that FXRP is currently insolvent or that a live production market has
adopted the oracle.

The pinned result replays deployed state on a mainnet fork and uses a finalized
FDC proof. It does not create a new mainnet attestation. The public docs explain
the data sources, contract behavior, and limits in more detail.
