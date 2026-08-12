# Herkos Coston2 lending rebuild

## Purpose

Build a public Coston2 testnet version of Herkos that powers a real on-chain
lending market for FTestXRP collateral and test USDT0 debt.

The current site must remain available as the Mainnet research view. It shows
live, read-only Flare data and a pinned fork result against an existing lending
market. The rebuild adds a separate testnet product where a judge can connect a
wallet, get faucet assets, refresh Herkos, deposit collateral, borrow, repay,
withdraw, and inspect every transaction on Coston2 Explorer.

This is a testnet lending market. It is not a production deployment, does not
hold real-value assets, and must never be described as an integration adopted by
an existing lending protocol.

## Current implementation status

This rebuild is implemented in the current working tree. The public Coston2
deployment is live, the test market has a 10 USDT0 judge reserve, and the
production site is deployed at `https://herkos.vercel.app/testnet`.

The checklist below remains a handoff record for Luna. Items that are complete
in this working tree are marked `[x]`. The Coston2 fork tests use the recorded
deployment block and the public RPC alias; the full wallet transaction path is
also recorded separately in `deployments/coston2.json`.

## Product statement

Use this wording consistently:

> Herkos is deployed on Coston2 and powers a public testnet lending market for
> FTestXRP collateral. The Mainnet view remains read-only and the existing
> lending-market integration remains a pinned fork result.

Do not use these claims:

- live Mainnet lending integration;
- production lending market;
- audited protocol;
- guaranteed liquidity;
- risk-free borrowing;
- real yield or APY;
- adoption by Kinetic, SparkDEX, Mystic, or another external protocol;
- Mainnet contract deployment unless a Mainnet transaction is actually made.

## What must remain unchanged

- Keep the white visual direction and the current Herkos logo.
- Keep `/` as the Mainnet research and risk view.
- Keep the pinned Mainnet fork result and its labels.
- Keep `/docs`, `/docs/technical.html`, `/docs/privacy.html`, and
  `/docs/terms.html` working.
- Keep the current Mainnet contract and fork tests passing.
- Keep the site static. Wallet calls go directly from the browser to Coston2.
- Do not add a database, account system, analytics, or server-side wallet.
- Do not put a private key, seed phrase, RPC secret, or API key in the repo,
  browser bundle, deployment file, GitHub Actions, or Vercel configuration.

## Current repository warning

The public cleanup deliberately removed the internal planning documents and all
`phase*-results.json` files. They must stay removed and ignored.

The current `scripts/phase5.js` still expects several of those deleted files.
Do not restore private files just to make that script pass. Replace or revise the
public presentation checker so it validates only tracked public sources such as
`demo/snapshot.json`, `fork.json`, deployment records, contracts, docs, and the
browser routes. Update `package.json` so every advertised command works from a
fresh public clone.

## Coston2 facts to verify before coding

Use the official Flare registry and explorer as the source of truth. Addresses
can change on testnet, so verify bytecode and contract responses before using
them.

Known values at the time this plan was written:

| Item | Value |
| --- | --- |
| Network | Flare Testnet Coston2 |
| Chain ID | `114` (`0x72`) |
| RPC | `https://coston2-api.flare.network/ext/C/rpc` |
| Explorer | `https://coston2-explorer.flare.network` |
| Faucet | `https://faucet.flare.network/coston2` |
| Flare contract registry | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` |
| FAssets AssetManagerController | `0x1C772F700308aF4c13897cc7b9c41EFfB82c50C0` |
| FTestXRP AssetManager | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |
| FTestXRP token | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| Faucet USDT0 token | `0xC1A5B41512496B80903D1f32d6dEa3a73212E71F` |
| FDC verifier | `0x906507E0B64bcD494Db73bd0459d1C667e14B933` |
| XRP/USD feed ID | `0x015852502f55534400000000000000000000000000` |

Official references:

- Coston2 network and faucet:
  `https://dev.flare.network/network/overview`
- FAssets deployments:
  `https://dev.flare.network/fassets/reference`
- FDC deployments:
  `https://dev.flare.network/fdc/reference`
- FXRP operational parameters:
  `https://dev.flare.network/fxrp/parameters`

The following values must be resolved and recorded before deployment:

- the current test USDT0 token distributed by the Coston2 faucet;
- its symbol, decimals, bytecode, and faucet transfer evidence;
- the current `FtsoV2` address from the registry;
- the current Core Vault manager from the FTestXRP AssetManager;
- the current testnet fallback oracle address, if an existing compatible one is
  used;
- eligible Coston2 FTestXRP exit pools, if any;
- the deployment wallet address;
- final Herkos, spot oracle, and lending market addresses.

The faucet token was verified on Coston2 as `USDT0` with six decimals and
deployed bytecode. The first candidate token was not used because the faucet
did not credit it. The public deployment uses the faucet-linked token above.

Never copy a Mainnet dependency into the Coston2 configuration just because the
interface looks the same.

## User flow

The full judge flow must fit on one testnet page at `/testnet`:

1. Read a short explanation of what is real and what is testnet-only.
2. Connect an injected browser wallet.
3. Switch to Coston2 or add it to the wallet.
4. Open the official faucet in a new tab.
5. Return with C2FLR, FTestXRP, and test USDT0.
6. See wallet balances read from Coston2.
7. See the deployed Herkos address, last refresh block, exit capacity, haircut,
   and oracle price.
8. Refresh Herkos with `poke()` if the reading is stale.
9. Approve and deposit FTestXRP as collateral.
10. Approve and supply test USDT0 to market liquidity, if the user wants to act
    as a lender.
11. Borrow test USDT0 within the displayed limit.
12. See the position update from confirmed on-chain state.
13. Repay debt and withdraw collateral.
14. Open each confirmed transaction or contract in Coston2 Explorer.

The primary demo path is faucet, connect, refresh, deposit, borrow, repay. It
must work without editing source files or entering contract addresses manually.

## Contract architecture

### Existing Herkos oracle

Use `src/ExitCapacityOracle.sol` as the oracle. Do not fork a second copy with
different risk logic unless Coston2 exposes a genuine interface incompatibility.

Before deployment, prove on a Coston2 fork that the constructor and `poke()` work
with the current testnet AssetManager, Core Vault manager, FTSO, and FDC verifier.

Deploy Herkos with:

- registry: the shared Flare registry;
- AssetManager: the current Coston2 FTestXRP AssetManager;
- fallback oracle: the deployed Coston2 spot oracle described below;
- feed ID: XRP/USD;
- governance: the dedicated testnet deployment wallet.

After deployment:

- register the Coston2 lending market with `registerFXRPMarket`;
- call `poke()` and confirm `isPokeStale()` is false;
- read `inputs()`, `exitCapacity()`, `clearingPricePPM()`, and
  `getUnderlyingPrice()` directly from Coston2;
- set a testnet reference size only after measuring Coston2 liquidity and queue
  state;
- document the chosen reference size and why it is reasonable;
- do not tune the reference size only to produce a dramatic screenshot;
- leave DEX depth at zero if no verified eligible Coston2 exit pool exists.

### Coston2 spot oracle

Add a small `Coston2SpotOracle.sol` only if no compatible deployed fallback
oracle is available.

It must:

- implement `isPriceOracle()` and `getUnderlyingPrice(address)`;
- read XRP/USD from the registry-resolved FTSO feed;
- return the correct Compound scaling for the FTestXRP market;
- return a fixed one-dollar value only for the verified faucet USDT0 market;
- reject unknown markets instead of returning a made-up price;
- enforce a documented feed staleness window;
- contain no owner-controlled price setter.

The fallback oracle exists for interface completeness. The registered FTestXRP
market must use Herkos pricing.

### Coston2 lending market

Add a compact `Coston2LendingMarket.sol`. This is a real testnet contract, not a
calculator behind the UI.

Required assets:

- collateral: official Coston2 FTestXRP;
- debt and supplied liquidity: verified faucet test USDT0.

Required public actions:

- `supplyLiquidity(uint256 amount)`;
- `withdrawLiquidity(uint256 amount)`;
- `depositCollateral(uint256 amount)`;
- `withdrawCollateral(uint256 amount)`;
- `borrow(uint256 amount)`;
- `repay(uint256 amount)`;
- `liquidate(address borrower, uint256 repayAmount)`;
- `underlying()` returning the official FTestXRP address so Herkos can verify
  and register the market;
- position, liquidity, borrowing-limit, and health-factor views needed by the
  browser.

Use simple testnet parameters and publish them in the UI:

- maximum loan-to-value: 70%;
- liquidation threshold: 75%;
- liquidation bonus: 5%;
- no interest accrual for this hackathon test market;
- no APY display;
- no protocol fee unless a real fee path is implemented and documented.

Accounting requirements:

- Track each lender's supplied USDT0.
- Track each borrower's FTestXRP collateral and USDT0 debt.
- A lender cannot withdraw more than their supplied balance or the market's
  currently available USDT0.
- A borrower cannot borrow or withdraw collateral if the resulting position is
  above the maximum LTV.
- Borrow and collateral withdrawal must revert when the Herkos price is stale
  or unavailable.
- Repayment and collateral deposits must remain possible when the oracle is
  stale.
- Liquidation must require an unhealthy position and cap repayment to the debt.
- Liquidation collateral transfer must include only the documented bonus.
- Every token movement must check the ERC-20 return value.
- Apply checks, effects, and interactions and add a reentrancy guard.
- Use custom errors and emit events for every state-changing user action.
- Do not add upgradeability for this testnet build.
- Do not add admin withdrawal of user funds.
- If an emergency pause exists, it may stop new borrowing and withdrawals but
  must not block repayment.

The market is intentionally small. Do not import a full Compound deployment or
add interest-rate machinery just to make the repository look larger.

## Contract tests

Add unit and Coston2 fork tests for at least these cases:

- constructor rejects zero and mismatched asset addresses;
- Herkos deploys against current Coston2 registry contracts;
- `poke()` succeeds on a pinned Coston2 fork;
- Herkos registers the lending market because `underlying()` is FTestXRP;
- Herkos rejects a fake market with the wrong underlying;
- spot oracle scaling is correct for six-decimal FTestXRP and USDT0;
- unknown spot-oracle markets revert;
- lender supply and withdrawal accounting is exact;
- collateral deposit and withdrawal accounting is exact;
- borrowing succeeds below maximum LTV;
- borrowing at or above the limit reverts;
- withdrawing collateral into an unsafe position reverts;
- repayment reduces debt and works while the oracle is stale;
- stale Herkos pricing blocks borrowing and collateral withdrawal;
- a healthy position cannot be liquidated;
- an unhealthy position can be liquidated with the correct collateral bonus;
- a liquidator cannot repay more than the borrower's debt;
- reentrancy attempts fail;
- failed ERC-20 transfers do not corrupt accounting;
- multiple users cannot withdraw the same liquidity;
- existing Mainnet fork tests still pass.

Pin the Coston2 fork block in a tracked deployment or test configuration file.
Do not reuse the Mainnet pin in `fork.json`.

## Deployment records

Create `deployments/coston2.json` after deployment. It is public evidence and
must contain only public chain data:

```json
{
  "network": "coston2",
  "chainId": 114,
  "deployedAtBlock": 0,
  "deployer": "0x...",
  "fTestXrp": "0x...",
  "testUsdt0": "0x...",
  "spotOracle": "0x...",
  "herkos": "0x...",
  "lendingMarket": "0x...",
  "transactions": {
    "spotOracleDeployment": "0x...",
    "herkosDeployment": "0x...",
    "marketDeployment": "0x...",
    "marketRegistration": "0x...",
    "firstPoke": "0x..."
  }
}
```

Replace every placeholder with verified data before committing the file. Add an
explorer link for each address and transaction in the README or testnet docs.

Deployment rules:

- Use a dedicated throwaway Coston2 wallet.
- Fund it only through the official faucet.
- Keep its private key in an ignored local environment file.
- Confirm the RPC chain ID is `114` before every broadcast.
- Estimate gas before broadcasting.
- Never reuse a wallet that holds Mainnet funds.
- Never print the private key in logs or command history.
- Verify deployed bytecode and constructor arguments on Coston2 Explorer.
- Run one small end-to-end position with faucet assets after deployment.

## Testnet web app

Add these static files:

- `testnet/index.html`;
- `testnet/app.js`;
- `testnet/style.css`;
- `testnet/contracts.json` generated from the verified deployment record.

Add a Vercel route for `/testnet` and a clear homepage call to action labelled
`Try the Coston2 test market`.

Use the browser's injected EIP-1193 provider directly. Keep the project free of
runtime package dependencies unless a wallet library is genuinely necessary.

Wallet behavior:

- Detect the absence of a wallet and explain how to install one.
- Request accounts only after the user presses Connect.
- Display a shortened connected address and the Coston2 network label.
- Support `wallet_switchEthereumChain` for chain ID `0x72`.
- Support `wallet_addEthereumChain` with the official RPC and explorer.
- Listen for account and chain changes.
- Disable transaction buttons on the wrong network.
- Never request a signature on page load.
- Never ask the user to paste a private key.
- Show the contract method, amount, and asset before wallet confirmation.

The page must show:

- a visible `Coston2 testnet` badge;
- an explanation that faucet assets have no real value;
- official faucet link;
- wallet C2FLR, FTestXRP, and test USDT0 balances;
- Herkos contract address and explorer link;
- lending market address and explorer link;
- Herkos last refresh block and time;
- fresh or stale status;
- exit capacity and haircut from the deployed contract;
- current Herkos collateral price;
- market USDT0 liquidity from the deployed contract balance;
- the user's supplied liquidity, collateral, debt, borrowing limit, and health
  factor;
- approve, deposit, supply, borrow, repay, withdraw, and refresh actions;
- pending, confirmed, rejected, and failed transaction states;
- transaction hash with an explorer link after confirmation.

Transaction errors must be translated into useful language. Do not show raw RPC
objects, hex revert payloads, stack traces, or `[object Object]`.

## UI structure

Keep the page consumer-friendly and compact:

1. Header with Herkos logo, `Coston2 testnet` badge, and wallet control.
2. Intro with one sentence explaining the test market.
3. Three-step start card: connect, faucet, begin testing.
4. Oracle status card with refresh action and explorer evidence.
5. Position card with collateral, debt, borrowing limit, and health factor.
6. Action tabs for deposit, borrow, repay, withdraw, and supply liquidity.
7. Market status card showing real on-chain liquidity and parameters.
8. Testnet limitations and links to Mainnet research, docs, and source.

Do not add:

- fake charts;
- placeholder balances;
- invented TVL, users, volume, APY, or transaction counts;
- disabled controls that look actionable;
- ghost buttons;
- sample wallet addresses shown as user data;
- development phases or internal audit language;
- a dark theme;
- claims that a transaction succeeded before its receipt is confirmed.

Empty states should tell the user what to do next. Loading states should name
the data being loaded. Failed network reads should preserve the last confirmed
value only when it is clearly marked with its block and timestamp.

## Documentation updates

Update the public writing after the contracts and browser flow work.

README requirements:

- link to `/testnet`;
- list the verified Coston2 contract addresses;
- explain the faucet flow;
- explain the Mainnet view versus Coston2 test market;
- include local test commands;
- state that generated phase reports remain ignored;
- avoid references to removed internal planning files.

Official docs requirements:

- add a Coston2 test market section;
- explain the lending parameters and lack of interest accrual;
- explain which actions are real Coston2 transactions;
- explain what Herkos reads from FAssets;
- link all deployment transactions and contracts;
- describe the stale-oracle behavior;
- keep the Mainnet fork result clearly separate.

Privacy requirements:

- state that wallet connection is optional and user-initiated;
- explain that wallet address and public transaction data are visible on-chain;
- state that Herkos does not store wallet data in a database;
- list the public Coston2 RPC and explorer as third-party services;
- mention that rejected wallet requests remain inside the wallet provider.

Terms requirements:

- state that all testnet assets have no monetary value;
- state that the market is experimental and unaudited;
- prohibit using the testnet figures as financial advice;
- state that testnet contracts may be reset, replaced, or stop working.

Use direct human language. Remove internal phase language, AI filler, vague
claims, and unnecessary punctuation from every public page.

## Submission impact

After this rebuild, the submission should state:

- selected bounty: Interoperable Asset Products;
- public app: `https://herkos.vercel.app/`;
- interactive test market: `https://herkos.vercel.app/testnet`;
- Mainnet work: read-only measurements and a pinned fork integration against an
  existing deployed lending market;
- Coston2 work: public Herkos deployment and a live testnet lending market using
  FTestXRP collateral and test USDT0 debt;
- new work: exit-capacity oracle, FAssets measurements, FDC proof path, lending
  integration, testnet contracts, wallet flow, and public documentation;
- next step: work with an established lending protocol to adopt Herkos through
  governance on Mainnet.

Do not claim external protocol adoption or Mainnet market control.

## Verification gates

The rebuild is not complete until all of these pass:

- clean Solidity build;
- all existing Foundry tests pass;
- all new unit tests pass;
- all new Coston2 fork tests pass at the recorded block;
- every command documented in README or `package.json` works from a fresh public
  clone, or is removed from the public instructions;
- the public presentation checker no longer depends on deleted internal files or
  ignored phase reports;
- `forge fmt --check` passes;
- `git diff --check` passes;
- no private key or secret appears in tracked files or Git history added by this
  rebuild;
- Coston2 Explorer shows bytecode at every recorded deployment address;
- recorded constructor arguments match the deployment plan;
- `poke()` succeeds on public Coston2;
- Herkos recognizes the market as an FTestXRP market;
- a fresh wallet can follow the faucet onboarding;
- approve, deposit, borrow, repay, withdraw, and liquidity supply work in the
  deployed app;
- stale-oracle behavior is visible and blocks only the risk-increasing actions;
- every confirmed action links to its explorer transaction;
- wallet rejection produces a calm recoverable state;
- wrong-network state disables transactions and offers a Coston2 switch;
- refresh and reload preserve the position because state lives on-chain;
- desktop and 390-pixel mobile layouts have no horizontal overflow;
- keyboard focus, labels, contrast, and status announcements are usable;
- homepage, Mainnet view, testnet page, docs, privacy, terms, README, source, and
  explorer links all open;
- browser console has no uncaught errors during the full flow;
- Vercel production deployment serves the same commit that was tested;
- public repository contains no internal planning documents or generated phase
  result JSON files.

## Execution checklist

### Research and pinning

- [x] Resolve every Coston2 dependency from official sources or the on-chain
  registry.
- [x] Verify chain ID, bytecode, token symbols, and token decimals.
- [x] Resolve and verify the faucet test USDT0 address.
- [x] Measure the current FTestXRP queue and Core Vault state.
- [x] Check for eligible FTestXRP exit pools and record evidence.
- [x] Choose and explain the testnet reference size.
- [x] Pin a Coston2 fork block for deterministic tests.

### Contracts

- [x] Prove the existing Herkos constructor works on a Coston2 fork.
- [x] Prove `poke()` works on the pinned Coston2 fork.
- [x] Implement the Coston2 spot fallback oracle if needed.
- [x] Implement the Coston2 lending market.
- [x] Add events, errors, transfer checks, and reentrancy protection.
- [x] Add stale-oracle safety rules.
- [x] Add unit tests.
- [x] Add Coston2 fork tests.
- [x] Run the existing Mainnet fork suite for regressions.
- [x] Replace the stale public presentation checker dependencies without
  restoring removed internal documents or phase reports.
- [x] Test every `package.json` command from the clean public file set.

### Deployment

- [x] Create a dedicated testnet deployment wallet.
- [x] Fund it through the official Coston2 faucet.
- [x] Deploy and verify the spot oracle.
- [x] Deploy and verify Herkos.
- [x] Deploy and verify the lending market.
- [x] Register the market in Herkos.
- [x] Call the first `poke()`.
- [x] Seed a small amount of faucet USDT0 as borrowable liquidity.
- [x] Record addresses, blocks, and transaction hashes in
  `deployments/coston2.json`.
- [x] Run a complete on-chain test position.

### Web app

- [x] Add `/testnet` and its static assets.
- [x] Add wallet connect and Coston2 network switching.
- [x] Add faucet onboarding.
- [x] Read balances, oracle state, market state, and position state on-chain.
- [x] Add refresh, approve, deposit, supply, borrow, repay, withdraw, and
  liquidation controls as appropriate.
- [x] Add receipt confirmation and explorer links.
- [x] Add clear loading, empty, rejection, stale, and failure states.
- [x] Add a homepage link to the test market.
- [x] Keep the Mainnet view unchanged and clearly separate.

### Public writing

- [x] Update README.
- [x] Update official docs.
- [x] Update privacy notice.
- [x] Update terms.
- [x] Update the submission writeup.
- [x] Remove fake, stale, internal, or unsupported claims.
- [x] Check all public copy for plain human wording.

### Final QA and release

- [x] Run every verification gate above.
- [x] Audit the exact Git publish set before staging.
- [x] Confirm no internal notes or generated reports are staged.
- [x] Commit and push the tested build.
- [x] Deploy the tested commit to Vercel production.
- [x] Verify the production flow in the built-in browser.
- [ ] Record the final demo only after production verification passes.
- [ ] Prepare the final DoraHacks answers with the verified addresses and links.

## Definition of done

A first-time judge can open `/testnet`, understand that it is Coston2, get free
assets, connect a wallet, refresh Herkos, deposit FTestXRP, borrow test USDT0,
repay, withdraw, and verify every action on Coston2 Explorer. The Mainnet page
still presents its read-only and pinned-fork evidence accurately. The repo stays
clean, the contracts pass their tests, and no public wording implies production
adoption that has not happened.
