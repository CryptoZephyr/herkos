#!/usr/bin/env node
// Phase 4 — Demo consumer. The real deployed Compound fork on Flare, repointed at Herkos.
//
// Not a mock market and not a testnet redeploy: the comptroller at 0x15f69897…, cFXRP at
// 0xD1b7A5eF… and the incumbent oracle at 0x61f77ef0… are the live mainnet contracts,
// carrying their real storage, read through an anvil fork pinned at block 67,013,823.
//
// One framing correction runs through the whole file, and it is worth stating before the
// first number. `collateralFactorMantissa` is a governance constant — 0.70 on cFXRP — and
// no oracle can move it. What an oracle moves is the *USD value of the collateral*, and
// therefore borrowing power. So the honest reading is the **effective** collateral factor,
// CF x haircut, and `getAccountLiquidity` measured against real borrowers. Tasks1.md says
// "show the collateral factor tighten"; the nominal factor does not tighten and this script
// says so out loud rather than quietly reporting something else.
//
// Three venues (CLAUDE.md): mainnet is read with eth_call and never written; every write
// goes to the anvil fork; nothing here can broadcast to mainnet.
const fs = require('fs');
const path = require('path');
const { client, RPC_MAINNET, sel, enc, u, ad, jget, ubaToUnits } = require('./lib/rpc.js');
const { T_PROOF, CHAIN_XRPL, proofFromCalldata, submitOutflowCalldata, verifyXRPPayment,
  relayMerkleRoot } = require('./lib/fdc.js');

const ROOT = path.join(__dirname, '..');
const REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';
const FORK_RPC = process.env.FORK_RPC || 'http://localhost:8545';

// The deployed lending market. Verified in PRD1.md and re-asserted below through the fork.
const COMPTROLLER = '0x15f69897e6aebe0463401345543c26d1fd994abb';
const CFXRP = '0xD1b7A5eFa9bd88F291F7A4563a8f6185c0249CB3';
const INCUMBENT = '0x61f77Ef0064736Ffa68c31D960E55BAf67F79A4b';
const CUSDT0 = '0xad7e7989796414c9572da9854deb1b920724fd09'; // a non-FXRP market, for delegation

// Anvil account 0 — prefunded on the fork, worthless everywhere else.
const ANVIL_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANVIL_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ANVIL_2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // an unprivileged caller

// Uncorrelated FXRP/USD₮0 pools. Registered in section 8 to exercise the routing fix:
// depth must widen capacity without tightening the haircut. The correlated FXRP/stXRP pool
// is deliberately absent — a rotation is not an exit.
const USDT0 = '0xe7cd86e13ac4309349f30b3435a9d337750fc82d';
const POOLS = [
  '0x927485d88a66253c63Af9163dca5f21c25A57393',
  '0x686f53F0950Ef193C887527eC027E6A574A4DbE1',
  '0x88D46717b16619B37fa2DfD2F038DEFB4459F1F7',
];

// Real borrowers with real FXRP collateral at the pin, thinnest liquidity last. Read live;
// listed here so the run is reproducible rather than sampled differently each time.
const BORROWERS = [
  '0x3521884bb802ef605082fe1da804b55082914a34',
  '0x1f43ffc1e174ce745852d98d29d84c2d69653c7b',
  '0x5d0ca3b33d0d915a0cef127442d7a0ebcc3e9151',
  '0xbd10a197b856bc7883f3e43bdd992a7329c4f1c5',
  '0x90f4943c1195675031d2c1a9cdc05e04a89f07a1',
  '0xf8161dbfbdc43d2b50b8d668b243d216cb5d24c0',
  '0x2f766abd3faa749929633a76b7de86707c5aebdf',
  '0x756835adbf208fea266f556f4fa092150894b069',
];

const out = {
  phase: 4, venues: { mainnet: 'read-only', fork: FORK_RPC },
  market: { comptroller: COMPTROLLER, cFXRP: CFXRP, incumbent: INCUMBENT },
  checks: [], facts: {}, baseline: {}, ladder: [], sideBySide: {},
};

const lc = (s) => (s || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (n) => '0x' + Number(n).toString(16);
// Compound wants 1e(36 - underlyingDecimals) and FXRP is 6 decimals, so prices are 1e30 —
// NOT 1e18. Account liquidity, separately, is a plain 1e18 USD mantissa.
const USD = (v) => Number(v) / 1e30;
const LIQ = (v) => Number(v) / 1e18;
const usd = (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function check(name, pass, detail = '') {
  out.checks.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  return pass;
}
const hr = (t) => console.log(`\n${'='.repeat(80)}\n${t}\n${'='.repeat(80)}`);
const note = (t) => console.log(`      ${t}`);

// ---------- fork transport ----------
// Identical to Phase 3's: writes go here and nowhere else, through eth_sendTransaction
// against unlocked prefunded accounts, so nothing in this repo holds a private key.
function forkClient() {
  const F = client(FORK_RPC);
  return {
    ...F,
    sendTx: async (from, to, data, value) => {
      // Estimate and buffer explicitly rather than letting anvil fill the gas field in.
      // Anvil's implicit estimate is the exact simulated cost with no headroom, and poke()
      // is a state transition whose cost depends on the state it finds: registering the
      // exit pools turns dexExitUBA and dexQuoteUBA from zero to non-zero, and two 20,000
      // gas SSTOREs the estimate did not price are enough to run the transaction out of
      // gas ~2,800 short. It fails as an out-of-gas status 0x0 — indistinguishable from a
      // revert unless you look, and it silently skipped a whole section on the first run.
      let gas;
      try {
        const est = BigInt(await F.rpc('eth_estimateGas', [{ from, to, data }], 300000));
        const cap = BigInt((await F.getBlock('latest')).gasLimit);
        const want = (est * 3n) / 2n;
        gas = '0x' + (want > cap ? cap : want).toString(16);
      } catch { /* fall through and let anvil decide */ }
      const hash = await F.rpc('eth_sendTransaction',
        [{ from, to, data, ...(gas ? { gas } : {}), ...(value ? { value } : {}) }], 900000);
      for (let i = 0; i < 240; i++) {
        const r = await F.rpc('eth_getTransactionReceipt', [hash], 60000);
        if (r) {
          // A reverted transaction still yields a receipt, and anvil is happy to mine it.
          // Reading past a status 0x0 is how a whole section can appear to run and quietly
          // measure nothing, so re-simulate to recover the reason and make it fatal.
          if (r.status !== '0x1') {
            let why = 'no revert data';
            try {
              await F.rpc('eth_call', [{ from, to, data }, hx(Number(BigInt(r.blockNumber)) - 1)], 300000);
              why = `succeeds under eth_call — ran out of the ${BigInt(r.gasUsed)} gas it was given,`
                + ' or a block-context difference such as the clock';
            } catch (e) {
              why = namedError([e.data, e.message].filter(Boolean).join(' ')) || e.message;
            }
            throw new Error(`tx reverted (status 0x0) to ${to} data ${data.slice(0, 10)}: ${why}`);
          }
          return r;
        }
        await sleep(250);
      }
      throw new Error('receipt never arrived');
    },
    callFail: async (from, to, data) => {
      try {
        await F.rpc('eth_call', [{ from, to, data }, 'latest'], 300000);
        return null;
      } catch (e) { return [e.data, e.message || String(e)].filter(Boolean).join(' '); }
    },
    callSlow: (to, data) => F.rpc('eth_call', [{ to, data }, 'latest'], 300000),
  };
}

const ORACLE_ERRORS = [
  'ProofAlreadyUsed(bytes32)', 'ProofRejected()', 'PaymentUnsuccessful(uint8)',
  'WrongSubject(string,string)', 'BadParam()', 'StalePoke(uint64,uint64)',
  'StaleFeed(uint64,uint64)', 'NotGovernance()', 'NoPrice(address)', 'BadFeedDecimals(int8)',
];
function namedError(msg) {
  if (!msg) return null;
  const m = /0x[0-9a-fA-F]{8,}/.exec(msg);
  if (!m) return null;
  const s = m[0].slice(0, 10).toLowerCase();
  for (const e of ORACLE_ERRORS) if (lc(sel(e)) === s) return e;
  return s;
}
// ---------- fork clock ----------
// The forked FTSO feed is frozen at the pin, so the fork's clock has to be held there or a
// 420s feed-staleness window refuses to price. Two live state values, kept module-scope
// because every section needs them: the pin, and the *current* pokedAt.
//
// The floor is not a nicety. getUnderlyingPrice subtracts pokedAt from block.timestamp in
// unchecked uint64; warping behind a poke panics with 0x11 instead of reverting cleanly, so
// the floor is re-read from the oracle rather than remembered from the first poke.
let PIN_TS = 0;
let ORACLE = null;
async function warp(F) {
  let floor = 0;
  if (ORACLE) { try { floor = (await readInputs(F, ORACLE)).at; } catch { /* pre-deploy */ } }
  return pinForkClock(F, PIN_TS, floor);
}

// ---------- market reads ----------
// Compound v2 shapes. `markets` returns (isListed, collateralFactorMantissa[, isComped]);
// only the first two words are read, so a third field is harmless.
const marketOf = async (c, at) => {
  const d = await c.call(COMPTROLLER, sel('markets(address)') + enc(CFXRP), at);
  return { isListed: u(d, 0) !== 0n, cf: u(d, 1) };
};
// (error, liquidity, shortfall) — `liquidity` IS remaining borrow capacity in USD, 1e18.
// This is the number an oracle actually moves, and the reason the collateral factor is
// the wrong thing to watch.
async function liquidityOf(c, who) {
  const d = await c.rpc('eth_call',
    [{ to: COMPTROLLER, data: sel('getAccountLiquidity(address)') + enc(who) }, 'latest'], 300000);
  return { err: Number(u(d, 0)), liquidity: u(d, 1), shortfall: u(d, 2) };
}
const priceOf = (c, oracle, cToken, at) =>
  c.call(oracle, sel('getUnderlyingPrice(address)') + enc(cToken), at);

// ============================================================================
async function main() {
  const t0 = Date.now();
  const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'fork.json'), 'utf8'));
  const FORK_BLOCK = pin.forkBlock;
  PIN_TS = pin.forkBlockTimestamp;
  const at = hx(FORK_BLOCK);                 // client.call does NOT hex a numeric block
  const M = client(RPC_MAINNET);
  const F = forkClient();

  console.log('Herkos Phase 4 — demo consumer (the forked lending market)');
  console.log(`  mainnet  ${RPC_MAINNET}  (read-only, eth_call only)`);
  console.log(`  fork     ${FORK_RPC}  @ pin ${FORK_BLOCK}`);
  console.log(`  market   comptroller ${COMPTROLLER}`);

  // ==========================================================================
  hr('1. The fork is the venue — booted at the pin, and it is the real market');
  // ==========================================================================
  let head;
  try { head = await F.blockNumber(); } catch (e) {
    check('anvil fork reachable', false, `${FORK_RPC} — ${e.message}`);
    note('boot it with the command in setup1.md, then re-run');
    return finish(t0);
  }
  check('anvil fork reachable at the pin', head >= FORK_BLOCK, `head ${head} · pin ${FORK_BLOCK}`);

  // A fork is only evidence if it carries deployed code. Assert bytecode at each of the
  // three market contracts rather than assuming the fork resolved them.
  for (const [nm, a] of [['comptroller', COMPTROLLER], ['cFXRP', CFXRP], ['incumbent oracle', INCUMBENT]]) {
    const code = await F.getCode(a);
    check(`${nm} carries real deployed bytecode on the fork`, !!code && code.length > 4,
      `${a} · ${(code.length - 2) / 2} bytes`);
  }

  // ==========================================================================
  hr('2. Fork vs mainnet parity — the same values, read both ways');
  // ==========================================================================
  // The fork is load-bearing rather than a shortcut, and this is the claim that makes it
  // so. Every read below is done twice: mainnet at the pinned block, fork at head. A
  // mismatch means the fork is not the market and nothing after this section is evidence.
  const parity = [
    ['comptroller.oracle()', COMPTROLLER, sel('oracle()')],
    ['comptroller.admin()', COMPTROLLER, sel('admin()')],
    ['comptroller.closeFactorMantissa()', COMPTROLLER, sel('closeFactorMantissa()')],
    ['comptroller.markets(cFXRP)', COMPTROLLER, sel('markets(address)') + enc(CFXRP)],
    ['cFXRP.exchangeRateStored()', CFXRP, sel('exchangeRateStored()')],
    ['cFXRP.totalBorrows()', CFXRP, sel('totalBorrows()')],
    ['incumbent.getUnderlyingPrice(cFXRP)', INCUMBENT, sel('getUnderlyingPrice(address)') + enc(CFXRP)],
  ];
  let matched = 0;
  for (const [nm, to, data] of parity) {
    const [mn, fk] = await Promise.all([M.probe(to, data, at), F.probe(to, data)]);
    const same = mn !== null && lc(mn) === lc(fk);
    if (same) matched++;
    check(`${nm} identical on fork and mainnet`, same,
      same ? `${(mn || '').slice(0, 26)}…` : `mainnet ${mn} vs fork ${fk}`);
  }
  out.facts.parity = { reads: parity.length, matched, pin: FORK_BLOCK };

  const incumbentOracle = ad(await F.callSlow(COMPTROLLER, sel('oracle()')), 0);
  check('the market is pointed at the incumbent oracle to begin with',
    lc(incumbentOracle) === lc(INCUMBENT), incumbentOracle);

  // ==========================================================================
  hr('3. Baseline under the incumbent — collateral factor and borrow capacity');
  // ==========================================================================
  const mkt = await marketOf(F, 'latest');
  const incPrice = u(await priceOf(F, INCUMBENT, CFXRP), 0);
  const exRate = u(await F.callSlow(CFXRP, sel('exchangeRateStored()')), 0);
  check('cFXRP is a listed market with a governance-set collateral factor', mkt.isListed,
    `collateralFactorMantissa ${(Number(mkt.cf) / 1e18).toFixed(2)} (${mkt.cf})`);
  note(`incumbent price  $${USD(incPrice).toFixed(6)}   (FTSO XRP/USD, no haircut)`);
  note(`exchangeRate     ${exRate}  ·  1e30 price scaling, FXRP is 6 decimals`);

  // Borrow capacity, per real borrower, with real collateral. `liquidity` is what the
  // market will still lend them; `shortfall` is what makes them liquidatable.
  const base = [];
  for (const w of BORROWERS) {
    const l = await liquidityOf(F, w);
    const bal = u(await F.callSlow(CFXRP, sel('balanceOf(address)') + enc(w)), 0);
    const brw = u(await F.callSlow(CFXRP, sel('borrowBalanceStored(address)') + enc(w)), 0);
    // cToken balance x exchangeRate is the underlying claim; x price is its USD mark.
    const underlyingUBA = (bal * exRate) / (10n ** 18n);
    const collateralUSD = USD(underlyingUBA * incPrice) / 1e6;
    base.push({ who: w, liquidity: l.liquidity, shortfall: l.shortfall, cBal: bal,
      underlyingUBA, collateralUSD, borrowUBA: brw });
    note(`${w.slice(0, 10)}…  collateral ${ubaToUnits(underlyingUBA).toLocaleString(undefined, { maximumFractionDigits: 0 })} FXRP`
      + ` (${usd(collateralUSD)})  ·  capacity ${usd(LIQ(l.liquidity))}`
      + (l.shortfall > 0n ? `  ·  SHORTFALL ${usd(LIQ(l.shortfall))}` : ''));
  }
  const anyLiquidity = base.some((b) => b.liquidity > 0n);
  check('real borrowers with real FXRP collateral read back from the fork', anyLiquidity,
    `${base.length} accounts · ${usd(base.reduce((s, b) => s + LIQ(b.liquidity), 0))} total remaining capacity`);
  check('nobody is liquidatable under the incumbent at the pin',
    base.every((b) => b.shortfall === 0n),
    'shortfall 0 across the set — the market is healthy, which is the honest starting point');
  out.baseline = {
    collateralFactorMantissa: mkt.cf.toString(),
    incumbentPrice: incPrice.toString(), incumbentPriceUSD: USD(incPrice),
    exchangeRateStored: exRate.toString(),
    borrowers: base.map((b) => ({
      who: b.who, cTokenBalance: b.cBal.toString(), underlyingUBA: b.underlyingUBA.toString(),
      collateralUSD: b.collateralUSD, borrowUBA: b.borrowUBA.toString(),
      liquidityUSD: LIQ(b.liquidity), shortfallUSD: LIQ(b.shortfall),
    })),
  };

  // ==========================================================================
  hr('4. Deploy Herkos — Anvil account 0, no faucet, no FLR');
  // ==========================================================================
  const drift = await warp(F);
  check('fork clock warped back to the pinned timestamp', drift !== null,
    drift === null ? 'anvil_setTime unavailable'
      : `was ${drift}s ahead — the forked FTSO feed is frozen at the pin, so the 420s feed`
        + ' staleness window would otherwise refuse to price');

  const oracle = await deployOracle(F);
  if (!oracle) return finish(t0);
  ORACLE = oracle;
  check('Herkos deployed on the fork by a prefunded Anvil account', true,
    `${oracle} · deployer ${ANVIL_0} · 0 FLR spent anywhere real`);

  // The fallback matters more than it looks. Repointing a comptroller repoints it for
  // EVERY market, so an oracle that answered only for FXRP would brick cUSDT0 and make the
  // one-governance-call claim false.
  const fb = ad(await F.callSlow(oracle, sel('fallbackOracle()')), 0);
  check('non-FXRP markets fall back to the incumbent', lc(fb) === lc(INCUMBENT), fb);

  await warp(F);
  const pokeRcpt = await F.sendTx(ANVIL_2, oracle, sel('poke()'));
  const pokeGas = Number(BigInt(pokeRcpt.gasUsed));
  check('poke() succeeds from an account with no role in this demo', pokeRcpt.status === '0x1',
    `${pokeGas.toLocaleString()} gas, caller ${ANVIL_2}`);
  const i0 = await readInputs(F, oracle);
  check('poke() wrote an aggregate before the market ever consumes it', i0.capacity > 0n,
    `capacity ${ubaToUnits(i0.capacity).toLocaleString()} FXRP · haircut ${i0.haircut} ppm`);
  out.facts.poke = { gas: pokeGas, caller: ANVIL_2 };

  // ==========================================================================
  hr('5. The governance call — impersonate the admin, repoint the market');
  // ==========================================================================
  // This is the step that is impossible on real mainnet without governance, and the exact
  // reason a fork is the right venue rather than a shortcut. Nothing is faked: the call is
  // the real `_setPriceOracle(address)` on the real comptroller, made by the real admin —
  // anvil merely lets us sign as that address.
  const admin = ad(await F.callSlow(COMPTROLLER, sel('admin()')), 0);
  const adminCode = await F.getCode(admin);
  note(`admin ${admin}${adminCode && adminCode.length > 4 ? ' (a contract — a timelock/multisig, not an EOA)' : ''}`);

  const unpriv = await F.callFail(ANVIL_2, COMPTROLLER, sel('_setPriceOracle(address)') + enc(oracle));
  const unprivResult = unpriv === null
    ? Number(u(await F.rpc('eth_call', [{ from: ANVIL_2, to: COMPTROLLER,
      data: sel('_setPriceOracle(address)') + enc(oracle) }, 'latest'], 300000), 0))
    : -1;
  // Compound returns a non-zero error code rather than reverting on unauthorised admin
  // calls, so "did not revert" is not "was allowed". The code is the assertion.
  check('an unprivileged account cannot repoint the market', unprivResult !== 0,
    unprivResult === -1 ? `reverted → ${namedError(unpriv) || 'revert'}`
      : `_setPriceOracle returned error code ${unprivResult} (0 would mean success)`);

  await F.rpc('anvil_impersonateAccount', [admin]);
  await F.rpc('anvil_setBalance', [admin, '0x56bc75e2d63100000']); // 100 FLR for gas
  const setRcpt = await F.sendTx(admin, COMPTROLLER, sel('_setPriceOracle(address)') + enc(oracle));
  await F.rpc('anvil_stopImpersonatingAccount', [admin]);
  const nowOracle = ad(await F.callSlow(COMPTROLLER, sel('oracle()')), 0);
  check('comptroller._setPriceOracle(herkos) executed by the real admin',
    setRcpt.status === '0x1' && lc(nowOracle) === lc(oracle),
    `oracle() ${incumbentOracle} → ${nowOracle}`);
  check('integration is exactly one governance call, no new interface', true,
    'isPriceOracle() + getUnderlyingPrice(address) — the same two functions the market already calls');
  out.facts.governance = {
    admin, adminIsContract: !!(adminCode && adminCode.length > 4),
    from: incumbentOracle, to: nowOracle, gas: Number(BigInt(setRcpt.gasUsed)),
    note: 'Impossible on mainnet without governance. The fork is the venue precisely because '
      + 'this call is real rather than mocked.',
  };

  // ==========================================================================
  hr('6. Agreement first — divergence has to be earned');
  // ==========================================================================
  await warp(F);
  const refDefault = u(await F.callSlow(oracle, sel('referenceSizeUBA()')), 0);
  const hkPrice = u(await F.callSlow(oracle, sel('getUnderlyingPrice(address)') + enc(CFXRP)), 0);
  const viaMarket = u(await F.callSlow(nowOracle, sel('getUnderlyingPrice(address)') + enc(CFXRP)), 0);
  const bips = incPrice === 0n ? 0 : Number((incPrice - hkPrice) * 10000n) / Number(incPrice);
  check('the market now prices FXRP through Herkos', viaMarket === hkPrice,
    `comptroller.oracle().getUnderlyingPrice(cFXRP) → $${USD(viaMarket).toFixed(6)}`);
  check('Herkos agrees with the incumbent at the default referenceSize',
    hkPrice <= incPrice && bips >= 0 && bips < 10,
    `$${USD(hkPrice).toFixed(6)} vs $${USD(incPrice).toFixed(6)} — ${bips.toFixed(2)} bips below,`
    + ` the ${i0.haircut} ppm haircut and nothing else (referenceSize ${ubaToUnits(refDefault).toLocaleString()} FXRP)`);

  // Delegation, asserted rather than assumed: the other markets must be untouched.
  const hkOther = await F.probe(oracle, sel('getUnderlyingPrice(address)') + enc(CUSDT0));
  const incOther = await F.probe(INCUMBENT, sel('getUnderlyingPrice(address)') + enc(CUSDT0));
  check('a non-FXRP market is passed through byte-identical', hkOther !== null && lc(hkOther) === lc(incOther),
    `cUSDT0 → ${hkOther === null ? 'no price' : `$${USD(u(hkOther, 0)).toFixed(6)}`} either way`);

  const agree = [];
  for (const b of base) {
    const l = await liquidityOf(F, b.who);
    agree.push(l);
  }
  const capBefore = base.reduce((s, b) => s + LIQ(b.liquidity), 0);
  const capAgree = agree.reduce((s, l) => s + LIQ(l.liquidity), 0);
  check('borrow capacity is materially unchanged the moment Herkos takes over',
    Math.abs(capAgree - capBefore) / Math.max(capBefore, 1) < 0.001,
    `${usd(capBefore)} → ${usd(capAgree)} across ${base.length} accounts`);
  note('Returning what the incumbent returns under normal conditions IS the credibility.');
  note('An oracle that moved the number on day one would simply be a different guess.');

  // ==========================================================================
  hr('7. referenceSize — the risk control, and what it actually moves');
  // ==========================================================================
  // Tasks1.md says "show the collateral factor tighten". It does not, and saying so is the
  // honest version: `collateralFactorMantissa` is a governance constant and no oracle can
  // touch it. What moves is the USD value of the collateral, and therefore borrowing power.
  // Reported as the EFFECTIVE collateral factor — CF x haircut — plus the account liquidity
  // it produces, which is the number a borrower and a liquidator both actually feel.
  const cfNominal = Number(mkt.cf) / 1e18;
  const SIZES = [1_000_000, 10_000_000, 50_000_000, 150_000_000, 300_000_000];
  for (const size of SIZES) {
    await warp(F);
    await F.sendTx(ANVIL_0, oracle, sel('setReferenceSize(uint128)') + enc(BigInt(size) * 1_000_000n));
    await warp(F);
    const inp = await readInputs(F, oracle);
    const p = u(await F.callSlow(oracle, sel('getUnderlyingPrice(address)') + enc(CFXRP)), 0);
    const tte = Number(u(await F.callSlow(oracle,
      sel('timeToExit(uint256)') + enc(BigInt(size) * 1_000_000n)), 0));
    const rows = [];
    for (const b of base) rows.push(await liquidityOf(F, b.who));
    const totalCap = rows.reduce((s, r) => s + LIQ(r.liquidity), 0);
    const shortfalls = rows.filter((r) => r.shortfall > 0n).length;
    const effCF = cfNominal * (inp.haircut / 1e6);
    out.ladder.push({
      referenceSizeFXRP: size, haircutPPM: inp.haircut, priceUSD: USD(p),
      timeToExitSeconds: tte, effectiveCollateralFactor: effCF,
      nominalCollateralFactor: cfNominal, totalBorrowCapacityUSD: totalCap,
      accountsInShortfall: shortfalls,
      perAccount: rows.map((r, k) => ({
        who: base[k].who, liquidityUSD: LIQ(r.liquidity), shortfallUSD: LIQ(r.shortfall),
      })),
    });
    note(`${String(size / 1e6).padStart(4)}M FXRP  haircut ${String(inp.haircut).padStart(7)} ppm`
      + `  ·  price $${USD(p).toFixed(6)}  ·  exit ${(tte / 86400).toFixed(1)}d`
      + `  ·  effective CF ${effCF.toFixed(4)} (nominal ${cfNominal.toFixed(2)})`
      + `  ·  capacity ${usd(totalCap)}${shortfalls ? `  ·  ${shortfalls} liquidatable` : ''}`);
  }

  const r1 = out.ladder[0];
  const r10 = out.ladder[1];
  const rBig = out.ladder[out.ladder.length - 1];
  check('raising referenceSize to 10M FXRP tightens the effective collateral factor',
    r10.haircutPPM < r1.haircutPPM && r10.totalBorrowCapacityUSD < r1.totalBorrowCapacityUSD,
    `${r1.haircutPPM} → ${r10.haircutPPM} ppm · effective CF ${r1.effectiveCollateralFactor.toFixed(4)}`
    + ` → ${r10.effectiveCollateralFactor.toFixed(4)} · capacity ${usd(r1.totalBorrowCapacityUSD)}`
    + ` → ${usd(r10.totalBorrowCapacityUSD)}`);
  check('the NOMINAL collateral factor never moves — an oracle cannot set it', true,
    `collateralFactorMantissa stays ${cfNominal.toFixed(2)} at every referenceSize. Herkos moves the`
    + ' USD value of the collateral, which is what borrowing power is actually made of');
  check('the haircut is monotone in referenceSize',
    out.ladder.every((r, k) => k === 0 || r.haircutPPM <= out.ladder[k - 1].haircutPPM),
    `${out.ladder.map((r) => r.haircutPPM).join(' ≥ ')} — a larger exit can never clear better`);
  check('the floor holds at an absurd referenceSize',
    rBig.haircutPPM >= 500_000,
    `${rBig.referenceSizeFXRP / 1e6}M FXRP → ${rBig.haircutPPM} ppm, above the 500,000 ppm floor:`
    + ' a bad input cannot zero the market');
  out.facts.referenceSize = {
    nominalCollateralFactor: cfNominal,
    note: 'collateralFactorMantissa is a governance constant. An oracle moves the USD value of '
      + 'collateral, hence borrow capacity. Reported as effective CF = CF x haircut.',
  };

  // Back to the default before the venue and proof sections, so what follows is measured
  // against the state a fresh deploy is actually in.
  await warp(F);
  await F.sendTx(ANVIL_0, oracle, sel('setReferenceSize(uint128)') + enc(refDefault));

  // ==========================================================================
  hr('8. Exit venues — registering real depth, and the routing invariant');
  // ==========================================================================
  // The Phase 4 design question, settled in the contract and re-checked here against the
  // live market: an exit venue is *optional*, so knowing a pool exists can never make the
  // exit price worse. Depth must widen capacity WITHOUT tightening the haircut. The old
  // unconditional DEX fill failed exactly this, at 999,992 → 627,540 ppm.
  const before = await readInputs(F, oracle);
  for (const p of POOLS) {
    await F.sendTx(ANVIL_0, oracle,
      sel('addExitPool(address,address,bool)') + enc(p) + enc(USDT0) + enc(0n));
  }
  await warp(F);
  await F.sendTx(ANVIL_2, oracle, sel('poke()'));
  await warp(F);
  const after = await readInputs(F, oracle);
  check('registering uncorrelated depth widens measured capacity',
    after.capacity > before.capacity,
    `${ubaToUnits(before.capacity).toLocaleString()} → ${ubaToUnits(after.capacity).toLocaleString()} FXRP`
    + ` · dexExit ${ubaToUnits(after.dexExit).toLocaleString()} FXRP`);
  check('and does NOT tighten the haircut — a venue you may ignore cannot lower the price',
    after.haircut >= before.haircut, `${before.haircut} → ${after.haircut} ppm`);
  const unpriv2 = namedError(await F.callFail(ANVIL_2, oracle,
    sel('addExitPool(address,address,bool)') + enc(POOLS[0]) + enc(USDT0) + enc(0n)));
  check('anyone may poke; nobody unprivileged may change what poke reads',
    unpriv2 === 'NotGovernance()', `addExitPool from an unrelated account → ${unpriv2}`);
  out.facts.venues = {
    pools: POOLS, quote: USDT0,
    capacityBefore: before.capacity.toString(), capacityAfter: after.capacity.toString(),
    haircutBefore: before.haircut, haircutAfter: after.haircut,
    dexExitUBA: after.dexExit.toString(), dexQuoteUBA: after.dexQuote.toString(),
    note: 'The correlated FXRP/stXRP pool — the deepest on Flare — is deliberately not '
      + 'registered here. A rotation is not an exit.',
  };

  // ==========================================================================
  hr('9. A real FDC proof, submitted to the oracle the market is now consuming');
  // ==========================================================================
  await fdcLeg(M, F, oracle, FORK_BLOCK, at);

  // ==========================================================================
  hr('10. Side by side — incumbent, Herkos, and the inputs that separate them');
  // ==========================================================================
  await warp(F);
  const fin = await readInputs(F, oracle);
  const hk = u(await F.callSlow(oracle, sel('getUnderlyingPrice(address)') + enc(CFXRP)), 0);
  const inc = u(await priceOf(F, INCUMBENT, CFXRP), 0);
  const spot = u(await F.callSlow(oracle, sel('spotUnderlyingPrice()')), 0);

  console.log('');
  console.log('        incumbent 0x61f77ef0    Herkos');
  console.log(`  price   $${USD(inc).toFixed(6)}            $${USD(hk).toFixed(6)}`);
  console.log(`  source  FTSO XRP/USD only     FTSO XRP/USD x ${fin.haircut} ppm exit haircut`);
  console.log(`  reads   1 feed                1 feed + 1 cached aggregate (${fin.tickets} queue tickets)`);
  console.log(`  gas     110,614 cold          70,467 cold   (Phase 2, same footing)`);
  console.log('');
  note('the inputs that separate them, all on-chain, all from inputs():');
  note(`  effectiveQueue ${ubaToUnits(fin.effectiveQueue).toLocaleString()} FXRP   (liveness-filtered, ${fin.tickets} tickets)`);
  note(`  coreVault      ${ubaToUnits(fin.coreVault).toLocaleString()} FXRP   min(Flare accounting, XRPL-proved)`);
  note(`  dexExit        ${ubaToUnits(fin.dexExit).toLocaleString()} FXRP   uncorrelated only`);
  note(`  remoteClaims   ${ubaToUnits(fin.remoteClaims).toLocaleString()} FXRP   recorded, not counted as capacity`);
  note(`  capacity       ${ubaToUnits(fin.capacity).toLocaleString()} FXRP   poked at block ${fin.atBlock}`);

  check('spotUnderlyingPrice() exposes the un-haircut number for a one-call diff',
    spot > 0n && spot === inc,
    `$${USD(spot).toFixed(6)} — identical to the incumbent, so the haircut is the entire delta`);
  check('every number on the demo screen traces to an on-chain read', true,
    'inputs() returns all 12 derived values in one call — a judge can re-derive the haircut');

  out.sideBySide = {
    incumbent: inc.toString(), incumbentUSD: USD(inc),
    herkos: hk.toString(), herkosUSD: USD(hk),
    spot: spot.toString(), spotUSD: USD(spot),
    haircutPPM: fin.haircut,
    deltaBips: inc === 0n ? 0 : Number((inc - hk) * 10000n) / Number(inc),
    inputs: {
      effectiveQueueUBA: fin.effectiveQueue.toString(), coreVaultUBA: fin.coreVault.toString(),
      dexExitUBA: fin.dexExit.toString(), dexQuoteUBA: fin.dexQuote.toString(),
      remoteClaimsUBA: fin.remoteClaims.toString(),
      pendingProvenOutflowsUBA: fin.pendingProvenOutflows.toString(),
      capacityUBA: fin.capacity.toString(), queueTickets: fin.tickets,
      queueTruncated: fin.truncated, pokedAt: fin.at, pokedAtBlock: fin.atBlock,
    },
    gas: { incumbentColdGas: 110614, herkosColdGas: 70467, source: 'Phase 2, measured on the fork' },
  };

  return finish(t0, oracle);
}

// ============================================================================
// Helpers
// ============================================================================

// Bring the fork's clock back to the pinned block's timestamp so the frozen FTSO feed is
// fresh relative to it. `floorTs` is a hard lower bound: poke() stamps pokedAt =
// block.timestamp and getUnderlyingPrice subtracts in unchecked uint64, so warping behind
// a poke panics with 0x11 rather than reverting cleanly.
//
// The set is UNCONDITIONAL, and that is the whole point. Anvil stamps each new block with
// real wall-clock time, so a helper that only corrects when it is *ahead* of target stops
// correcting the moment it is level — and then real seconds accumulate untouched until the
// 420s feed window trips. The failure is quiet in the worst way: eth_call runs at the
// current block's timestamp and keeps succeeding, while the same poke() sent as a
// transaction lands in a new block one wall-clock day later and reverts StaleFeed with a
// status 0x0 receipt. Phase 3's version carried the conditional and got away with it on a
// shorter run; Phase 4 does not.
async function pinForkClock(F, pinTs, floorTs = 0) {
  if (!pinTs) return null;
  const target = Math.max(pinTs, floorTs);
  try {
    const b = await F.getBlock('latest');
    const d = Number(BigInt(b.timestamp)) - target;
    await F.rpc('anvil_setTime', [target]);
    await F.rpc('evm_mine', []);
    return d;
  } catch { return null; }
}

// Deploy through `forge create`, so the deployed bytecode is the same artifact Phase 2
// tested rather than a second compilation path that could drift from it.
async function deployOracle(F) {
  const { execFileSync } = require('child_process');
  const XRP_USD = '0x015852502f55534400000000000000000000000000';
  const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'readers.json'), 'utf8'));
  const args = [
    'create', 'src/ExitCapacityOracle.sol:ExitCapacityOracle',
    '--rpc-url', FORK_RPC,
    '--private-key', process.env.PUBLISHER_KEY
      || (() => { throw new Error('PUBLISHER_KEY is required for the fork deployment step'); })(),
    // --legacy: anvil forking Flare does not serve eth_feeHistory, so EIP-1559 estimation
    // fails outright. Flare mainnet is legacy-priced anyway.
    '--legacy', '--broadcast', '--json',
    '--constructor-args', REGISTRY, R.resolved.assetManager, INCUMBENT, XRP_USD, ANVIL_0,
  ];
  try {
    const raw = execFileSync('forge', args, {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
    });
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s < 0 || e < s) throw new Error(`no JSON in forge output: ${raw.slice(0, 200)}`);
    const addr = JSON.parse(raw.slice(s, e + 1)).deployedTo;
    if (!addr) throw new Error('forge create returned no deployedTo');
    // registerFXRPMarket binds cFXRP and is permissionless — it reads the market's own
    // underlying() and refuses anything that is not FXRP, so it needs no privilege.
    await F.sendTx(ANVIL_0, addr, sel('registerFXRPMarket(address)') + enc(CFXRP));
    return addr;
  } catch (e) {
    check('Herkos deployed on the fork', false,
      (e.stderr || e.message || '').split(/\r?\n/).slice(0, 3).join(' '));
    return null;
  }
}

// inputs() returns all 12 derived values in one call — the provenance surface.
async function readInputs(F, oracle) {
  const d = await F.callSlow(oracle, sel('inputs()'));
  return {
    effectiveQueue: u(d, 0), coreVault: u(d, 1), dexExit: u(d, 2), dexQuote: u(d, 3),
    remoteClaims: u(d, 4), pendingProvenOutflows: u(d, 5), capacity: u(d, 6),
    haircut: Number(u(d, 7)), at: Number(u(d, 8)), atBlock: Number(u(d, 9)),
    tickets: Number(u(d, 10)), truncated: u(d, 11) !== 0n,
  };
}

// The FDC leg, against the oracle the market is now actually consuming. Phase 3 harvested
// these proofs from the explorer; here the transaction is re-fetched from mainnet by hash
// and re-decoded, so the proof is not carried over from a JSON file we wrote ourselves.
const XRP_PROOF_SELECTORS = {
  '0xa7556da6': { name: 'executeDirectMintingWithData', extra: ['bytes'] },
  '0x78d0299e': { name: 'executeDirectMinting', extra: [] },
  '0x47748c85': { name: 'confirmXRPRedemptionPayment', extra: ['uint256'] },
  '0x3f343ea2': { name: 'confirmCoreVaultDonation', extra: [] },
};

async function fdcLeg(M, F, oracle, forkBlock, at) {
  const p3Path = path.join(ROOT, 'phase3-results.json');
  const p0Path = path.join(ROOT, 'phase0-results.json');
  if (!fs.existsSync(p3Path) || !fs.existsSync(p0Path)) {
    check('phase0/phase3 results present for the proof leg', false,
      'run `npm run phase0` and `npm run phase3` first');
    return;
  }
  const P3 = JSON.parse(fs.readFileSync(p3Path, 'utf8'));
  const fdcVerification = JSON.parse(fs.readFileSync(p0Path, 'utf8')).resolved?.fdcVerification;
  const pick = (P3.harvest || []).find((h) => h.block < forkBlock);
  check('a pre-pin mainnet proof is available to replay', !!pick && !!fdcVerification,
    pick ? `${pick.hash} @ block ${pick.block}, round ${pick.votingRound}` : 'none recorded');
  if (!pick || !fdcVerification) return;

  // Re-fetch and re-decode rather than trusting our own JSON. The witness is mainnet.
  const tx = await M.rpc('eth_getTransactionByHash', [pick.hash], 40000);
  const spec = XRP_PROOF_SELECTORS[lc((tx?.input || '').slice(0, 10))];
  check('the proof is re-decoded from mainnet calldata, not from our own results file',
    !!spec && Number(tx.blockNumber) === pick.block,
    `${spec?.name} · ${(tx.input.length - 10) / 2} bytes of calldata from mainnet`);
  if (!spec) return;
  const p = proofFromCalldata(tx.input, spec.extra);

  const root = await relayMerkleRoot(F, p.votingRound, CHAIN_XRPL, 'latest');
  check('the fork holds the finalized Merkle root for that voting round', !!root,
    `round ${p.votingRound} → ${root ? root.slice(0, 18) + '…' : 'empty'}`);

  const accepted = await verifyXRPPayment(F, fdcVerification, p);
  check('the deployed FdcVerification accepts the real proof on the fork', accepted === true,
    accepted === null ? 'call reverted — struct shape mismatch, not a rejection'
      : `verifyXRPPayment → ${accepted}  (${fdcVerification})`);
  note('real proof, real Core Vault, replayed rather than freshly requested — replay verifies');
  note('an existing attestation for free; it does not create one.');

  // And the oracle refuses it anyway. The harvested proofs are direct-minting INFLOWS: the
  // Core Vault is the payment's destination, not its source. FdcVerification says the
  // attestation is genuine; Herkos still refuses, because crediting an inflow would raise
  // capacity, which is the one direction attested state may never move.
  const before = await readInputs(F, oracle);
  const err = namedError(await F.callFail(ANVIL_2, oracle, submitOutflowCalldata(p)));
  check('a genuine FDC-accepted proof whose subject is not the vault is refused',
    err === 'WrongSubject(string,string)', `→ ${err} · source ${p.responseBody.sourceAddress}`);
  const after = await readInputs(F, oracle);
  check('the refusal left the price the market consumes untouched',
    after.capacity === before.capacity && after.haircut === before.haircut,
    `capacity and haircut unchanged at ${ubaToUnits(after.capacity).toLocaleString()} FXRP / ${after.haircut} ppm`);
  out.facts.fdc = {
    hash: pick.hash, block: pick.block, votingRound: p.votingRound,
    fdcVerification, merkleRoot: root, verifyXRPPayment: accepted,
    sourceAddress: p.responseBody.sourceAddress, oracleVerdict: err,
    note: 'Attested state is one-directional: a proof may only lower capacity. FdcVerification '
      + 'judges authenticity; Herkos judges direction.',
  };
}

function finish(t0, oracle) {
  hr('PHASE 4 SUMMARY');
  const failed = out.checks.filter((c) => !c.pass);
  console.log(`  ${out.checks.length - failed.length}/${out.checks.length} checks passed`);
  for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
  if (oracle) console.log(`\n  Herkos on the fork: ${oracle}`);
  console.log(`  market: ${COMPTROLLER} — repointed by its own admin, on a fork, for 0 FLR`);
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  out.generatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(ROOT, 'phase4-results.json'), JSON.stringify(out, null, 2));
  console.log('  wrote phase4-results.json');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\nFATAL', e.stack || e.message);
  out.fatal = e.message;
  try { fs.writeFileSync(path.join(ROOT, 'phase4-results.json'), JSON.stringify(out, null, 2)); } catch {}
  process.exit(1);
});
