# Herkos

Herkos is an exit-capacity oracle for FXRP lending on Flare.

It answers one practical question: if many lending positions need to exit at
once, how much FXRP can the system settle? The oracle measures that capacity,
then applies a conservative haircut to the existing XRP/USD price. Lending
markets keep using the familiar `getUnderlyingPrice(address)` interface.

The measurement uses three inputs:

- open redemption demand;
- liquid Core Vault funds; and
- eligible DEX depth that can move FXRP into a stable asset.

The result is designed for Compound-style lending markets. The Mainnet demo
does not need a wallet connection or a new market interface.

## Live demo

[Open the Herkos demo](https://herkos.vercel.app/)

The demo is a static, read-only browser app. It reads public Flare and XRP
Ledger data in the browser. It has no Herkos backend, account system, API key,
or transaction flow.

The page separates live network readings from the pinned lending-market
snapshot. Live readings show their Flare block. The pinned result uses one
mainnet fork block for its comparisons.

## Official documentation

[Read the Herkos docs](https://herkos.vercel.app/docs/index.html)

The docs cover the measurement model, data sources, contract interface,
verification boundaries, privacy, and terms of use.

## Coston2 test market

[Try the Coston2 test market](https://herkos.vercel.app/testnet)

The testnet page is separate from the Mainnet research view. It is a small
on-chain lending market on Flare Testnet Coston2. Faucet FTestXRP is the
collateral. Faucet USDT0 is the liquidity and debt asset. The market has a 70%
maximum loan-to-value ratio, a 75% liquidation threshold, a 5% liquidation
bonus, and no interest accrual.

Connect a browser wallet and use the [official Coston2
faucet](https://faucet.flare.network/coston2) for free test assets. If Coston2
is not already in the wallet, Herkos asks the wallet to add the official
network and then switch to it. Deposits, borrows, repayments, withdrawals, and
oracle refreshes are real testnet transactions. The assets have no monetary
value.

The Mainnet page does not send transactions. Its market integration is a
pinned fork result against an existing deployed market. The Coston2 page is
the public test market. Neither page claims production adoption by an external
lending protocol.

### Verified Coston2 contracts

The deployment and end-to-end position flow were checked through block
`33973920`. A separate transaction at block `33974273` left a fresh 10 USDT0
reserve for the next judge.

| Contract | Address |
| --- | --- |
| Herkos spot oracle | [`0x45A25862a31530197a3a7C1CA7a426959BD3dc8a`](https://coston2-explorer.flare.network/address/0x45A25862a31530197a3a7C1CA7a426959BD3dc8a) |
| Herkos exit-capacity oracle | [`0xdbE3207e6b6e25417FdC24B99932f554718C0972`](https://coston2-explorer.flare.network/address/0xdbE3207e6b6e25417FdC24B99932f554718C0972) |
| Coston2 lending market | [`0xb482A2FA8ec63F76B711813e685C4b4568a1c255`](https://coston2-explorer.flare.network/address/0xb482A2FA8ec63F76B711813e685C4b4568a1c255) |
| Faucet FTestXRP | [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7) |
| Faucet USDT0 | [`0xC1A5B41512496B80903D1f32d6dEa3a73212E71F`](https://coston2-explorer.flare.network/address/0xC1A5B41512496B80903D1f32d6dEa3a73212E71F) |

The recorded flow supplied 10 USDT0, deposited 10 FTestXRP, borrowed 7 USDT0,
repaid the debt, withdrew the collateral, and withdrew the supplied liquidity.
The later reserve transaction left 10 USDT0 available for the next judge. The
public transaction evidence is in
[`deployments/coston2.json`](deployments/coston2.json).

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

The suite covers the Mainnet fork behavior, the Coston2 lending market, and a
pinned Coston2 deployment check. Generated reports and local research caches
stay out of the public repo.

The public release check is:

```bash
npm run public-check
```

It checks the public routes and source set. Generated research reports remain
ignored because they are local output, not app dependencies.

To deploy a new Coston2 instance, keep the throwaway key in an ignored local
environment file and run `npm run deploy:coston2`. To run the funded flow
against the recorded deployment, set `C2_VERIFIER_KEY` or `PUBLISHER_KEY` in
that local environment and run `npm run verify:coston2`.

## Automation

The public site has no server-side publisher or scheduled chain writer. The
Mainnet view is read-only. Coston2 transactions begin when a visitor connects
a wallet and signs them. Vercel serves the static site and the browser talks
directly to the public Flare endpoints.

## Repository map

- `demo/`: the judge-facing web app
- `docs/`: official product documentation
- `src/ExitCapacityOracle.sol`: the oracle contract
- `test/`: contract tests
- `abi/`: verified external contract interfaces used by the scripts
- `scripts/`: local readers, fork checks, deployment helpers, and the static demo server
- `fork.json`: the pinned fork block and deployment references
- `Writeup1.md`: the technical submission narrative

## Scope

Herkos is a measured research prototype and hackathon integration. It does not
claim that FXRP is currently insolvent or that a live production market has
adopted the oracle.

The pinned result replays deployed state on a mainnet fork and uses a finalized
FDC proof. It does not create a new mainnet attestation. The public docs explain
the data sources, contract behavior, and limits in more detail.
