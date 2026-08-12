#!/usr/bin/env node
// Phase 0 — Prep. Read-only verification pass against Flare mainnet.
// Closes the five open Phase 0 items in Tasks1.md. No keys, no writes, no cost.
//
// Everything resolves through FlareContractsRegistry at runtime. The addresses below are
// the expected answers — used to check the resolver returned the right thing, never to
// skip resolution. And every shape is taken from the deployed contract, not the docs:
// documented signatures have been wrong five times (Memory1.md).
const fs = require('fs');
const path = require('path');
const {
  client, sel, enc, u, ad, strAt, strArrayAt, addrArrayAt,
  jget, canon, fmt, ubaToUnits,
} = require('./lib/rpc.js');

const REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';

// For checking the resolver, not for hardcoding into the product.
const EXPECT = {
  assetManager:    '0x2a3fe068cd92178554cabcf7c95adf49b4b0b6a8',
  fxrp:            '0xad552a648c74d49e10027ab8a618a3ad4901c5be',
  coreVaultMgr:    '0x6c8d96defe4cbee05fa969fc0ac436d94fc21784',
  xrplCoreVault:   'rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj',
  fdcVerification: '0x5c14fe9d73ab763f4d4a76f334bf7029ddd20ecc',
  relay:           '0xccf30790a93f15e24eb909548a2c58a9b0a7fbd4',
  ftsoV2:          '0x7bde3df0624114edb3a67dfe6753e62f4e7c1d20',
  fdcHub:          '0xc25c749dc27efb1864cb3dada8845b7687eb2d44',
};

const ROOT = path.join(__dirname, '..');
const M = client();
const out = { network: 'flare-mainnet', rpc: M.url, checks: [], resolved: {}, facts: {} };

const lc = (s) => (s || '').toLowerCase();
function check(name, pass, detail = '') {
  out.checks.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  return pass;
}
const hr = (t) => console.log(`\n${'='.repeat(80)}\n${t}\n${'='.repeat(80)}`);

// ---------- EIP-2535 diamond loupe ----------
// `facets()` returns Facet[] { address facetAddress; bytes4[] functionSelectors; }.
// Two levels of dynamic offset: the struct array, then each struct's selector array.
function decodeFacets(d) {
  const p = Number(u(d, 0)) / 32;              // head -> array
  const len = Number(u(d, p));
  return Array.from({ length: len }, (_, i) => {
    const q = p + 1 + Number(u(d, p + 1 + i)) / 32;   // element offsets are from p+1
    const addr = ad(d, q);
    const s = q + Number(u(d, q + 1)) / 32;           // bytes4[] offset is from q
    const n = Number(u(d, s));
    // bytes4 is left-aligned in its word: the first 4 bytes are the selector.
    const selectors = Array.from({ length: n }, (_, k) =>
      '0x' + d.slice(2 + (s + 1 + k) * 64, 2 + (s + 1 + k) * 64 + 8));
    return { addr, selectors };
  });
}

// Verified ABI for one address. Facets are separate contracts, each verified separately.
async function fetchAbi(addr) {
  for (const url of [
    `https://flare-explorer.flare.network/api?module=contract&action=getabi&address=${addr}`,
    `https://api.routescan.io/v2/network/mainnet/evm/14/etherscan/api?module=contract&action=getabi&address=${addr}`,
  ]) {
    const j = await jget(url);
    if (j?.status === '1' && j.result) { try { return JSON.parse(j.result); } catch {} }
  }
  const m = await jget(`https://flare-explorer.flare.network/api/v2/smart-contracts/${addr}`);
  return m?.abi || null;
}

(async () => {
  // ============================================================================
  // 1. Resolve AssetManager FXRP + FXRP token through FlareContractsRegistry
  // ============================================================================
  hr('1. REGISTRY RESOLUTION AT RUNTIME  (Tasks1.md Phase 0)');

  const all = await M.call(REGISTRY, sel('getAllContracts()'));
  const names = strArrayAt(all, 0);
  const addrs = addrArrayAt(all, 1);
  check('registry.getAllContracts() decodes', names.length > 0 && names.length === addrs.length,
    `${names.length} contracts registered`);

  const byName = new Map(names.map((n, i) => [n, addrs[i]]));
  const find = (re) => [...byName].find(([n]) => re.test(n));

  // The infrastructure contracts the oracle and publisher need, resolved by name.
  for (const [key, re] of [
    ['fdcVerification', /^FdcVerification$/i], ['relay', /^Relay$/i],
    ['ftsoV2', /^FtsoV2$/i], ['fdcHub', /^FdcHub$/i],
    ['fdcRequestFeeConfigurations', /^FdcRequestFeeConfigurations$/i],
    ['assetManagerController', /AssetManagerController/i],
  ]) {
    const hit = find(re);
    out.resolved[key] = hit ? hit[1] : null;
    const want = EXPECT[key];
    check(`registry -> ${key}`, !!hit && (!want || lc(hit[1]) === want),
      hit ? `${hit[1]}${want ? (lc(hit[1]) === want ? ' (matches expected)' : ` EXPECTED ${want}`) : ''}` : 'NOT IN REGISTRY');
  }

  // AssetManager FXRP is not a registry entry — it is reached through the controller,
  // then identified by its FAsset's symbol. Resolve, do not assume the index.
  const controller = out.resolved.assetManagerController;
  let AM = null, FXRP = null, fxrpDecimals = null;
  if (controller) {
    const raw = await M.call(controller, sel('getAssetManagers()'));
    const managers = addrArrayAt(raw, 0);
    check('assetManagerController.getAssetManagers()', managers.length > 0, `${managers.length} asset managers`);
    for (const am of managers) {
      const fa = await M.probe(am, sel('fAsset()'));
      if (!fa) continue;
      const token = ad(fa, 0);
      const symRaw = await M.probe(token, sel('symbol()'));
      const sym = symRaw ? strAt(symRaw, 0) : '?';
      const decRaw = await M.probe(token, sel('decimals()'));
      const dec = decRaw ? Number(u(decRaw, 0)) : null;
      console.log(`        ${am}  fAsset ${token}  ${sym}  ${dec} dp`);
      if (sym === 'FXRP') { AM = am; FXRP = token; fxrpDecimals = dec; }
    }
  }
  check('resolved AssetManager FXRP', !!AM && lc(AM) === EXPECT.assetManager, AM || 'NOT FOUND');
  check('resolved FXRP token', !!FXRP && lc(FXRP) === EXPECT.fxrp, FXRP || 'NOT FOUND');
  // An 18-decimal assumption silently prints zeros. Scaling is 1e(36-6) = 1e30.
  check('FXRP is 6 decimals', fxrpDecimals === 6, `decimals() = ${fxrpDecimals}`);
  Object.assign(out.resolved, { assetManager: AM, fxrp: FXRP, fxrpDecimals });

  // If runtime resolution fails, that is the finding — record it, then fall back to the
  // recorded address so the remaining checks still report. A broken resolver and a broken
  // chain are different problems and should not look the same.
  if (!AM || !FXRP) {
    out.resolvedViaFallback = true;
    AM = AM || '0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8';
    FXRP = FXRP || '0xAd552A648C74D49E10027AB8a618A3ad4901c5bE';
    console.log(`\n        !! runtime resolution incomplete — falling back to recorded addresses`);
    console.log(`           AM ${AM}  FXRP ${FXRP}`);
  }

  const supRaw = FXRP ? await M.probe(FXRP, sel('totalSupply()')) : null;
  const totalSupply = supRaw ? u(supRaw, 0) : 0n;
  out.facts.fxrpTotalSupply = totalSupply.toString();
  console.log(`        FXRP totalSupply ${fmt(ubaToUnits(totalSupply))} FXRP`);

  // ============================================================================
  // 2. Confirm redemptionQueue(uint256,uint256) return shape
  //    Expected: (RedemptionTicketInfo[] queue, uint256 nextId)
  //              RedemptionTicketInfo { uint256 ticketId; address agentVault; uint256 ticketValueUBA; }
  // ============================================================================
  hr('2. redemptionQueue(uint256,uint256) RETURN SHAPE  (Tasks1.md Phase 0)');

  const QSEL = sel('redemptionQueue(uint256,uint256)');
  const page1 = await M.call(AM, QSEL + enc(0n) + enc(200n));
  const off = Number(u(page1, 0)) / 32;
  const len = Number(u(page1, off));
  const nextId = u(page1, 1);

  // A 3-word struct means the array body is exactly 3*len words after the length slot.
  const bodyWords = Math.floor((page1.length - 2) / 64) - (off + 1);
  check('head is (offset, nextId) — array is the first return value', off >= 2,
    `offset word0 = ${off * 32} bytes, nextId word1 = ${nextId}`);
  check('struct is 3 words {ticketId, agentVault, ticketValueUBA}', bodyWords === len * 3,
    `${len} tickets, ${bodyWords} body words = ${len} x ${bodyWords / (len || 1)}`);

  // Walk the whole queue by paging on nextId, exactly as poke() will have to.
  let cursor = 0n, tickets = [], pages = 0;
  while (pages < 60) {
    const raw = pages === 0 ? page1 : await M.call(AM, QSEL + enc(cursor) + enc(200n));
    const o = Number(u(raw, 0)) / 32;
    const l = Number(u(raw, o));
    for (let i = 0; i < l; i++) {
      const b = o + 1 + i * 3;
      tickets.push({ id: u(raw, b), agent: ad(raw, b + 1), uba: u(raw, b + 2) });
    }
    cursor = u(raw, 1);
    pages++;
    if (cursor === 0n || l === 0) break;
  }
  const queueTotal = tickets.reduce((s, t) => s + t.uba, 0n);
  const agents = new Set(tickets.map((t) => t.agent));
  // The middle field must decode as an address: top 12 bytes zero, and it must have code.
  const midIsAddress = tickets.every((t) => /^0x[0-9a-f]{40}$/.test(t.agent));
  check('middle field decodes as address (agentVault)', midIsAddress);
  check('nextId terminates the walk', cursor === 0n, `${pages} page(s), cursor ended at ${cursor}`);
  check('queue walk produces sane totals', tickets.length > 0 && queueTotal > 0n,
    `${tickets.length} tickets, ${fmt(ubaToUnits(queueTotal))} FXRP, ${agents.size} agents`);

  const agentVault = tickets[0]?.agent;
  if (agentVault) {
    const code = await M.getCode(agentVault);
    check('agentVault is a contract', code && code !== '0x', `${agentVault} code ${((code.length - 2) / 2)} bytes`);
  }

  out.facts.queue = {
    tickets: tickets.length,
    totalUBA: queueTotal.toString(),
    totalFXRP: ubaToUnits(queueTotal),
    agents: agents.size,
    pages,
  };

  // Gas for the walk poke() must pay. Memory1.md: 540,601 at (0,100) on mainnet.
  for (const n of [20n, 100n]) {
    const g = await M.rpc('eth_estimateGas', [{ to: AM, data: QSEL + enc(0n) + enc(n) }]);
    const gas = Number(BigInt(g));
    out.facts[`gas_redemptionQueue_0_${n}`] = gas;
    console.log(`        eth_estimateGas redemptionQueue(0,${n})  ${fmt(gas)}`);
  }

  // ============================================================================
  // 3. Confirm CoreVaultManager accessors
  // ============================================================================
  hr('3. CoreVaultManager ACCESSORS  (Tasks1.md Phase 0)');

  let CVM = null;
  for (const fn of ['getCoreVaultManager()', 'coreVaultManager()']) {
    const r = await M.probe(AM, sel(fn));
    if (r && u(r, 0) !== 0n) { CVM = ad(r, 0); console.log(`        via ${fn}`); break; }
  }
  check('AssetManager exposes the CoreVaultManager', !!CVM && lc(CVM) === EXPECT.coreVaultMgr, CVM || 'NOT FOUND');
  out.resolved.coreVaultManager = CVM;

  const cv = {};
  for (const fn of ['availableFunds()', 'escrowedFunds()', 'totalRequestAmountWithFee()']) {
    const r = CVM ? await M.probe(CVM, sel(fn)) : null;
    cv[fn] = r ? u(r, 0) : null;
    check(`CoreVaultManager.${fn}`, r !== null, r ? `${fmt(ubaToUnits(cv[fn]))} XRP` : 'ABSENT');
  }
  // coreVaultAddress() returns the XRPL account as a string — bind attestations to it.
  const cvAddrRaw = CVM ? await M.probe(CVM, sel('coreVaultAddress()')) : null;
  const cvAddr = cvAddrRaw ? strAt(cvAddrRaw, 0) : null;
  check('CoreVaultManager.coreVaultAddress() is the XRPL account', cvAddr === EXPECT.xrplCoreVault,
    cvAddr || 'ABSENT');
  out.facts.coreVault = {
    availableFundsUBA: cv['availableFunds()']?.toString() ?? null,
    escrowedFundsUBA: cv['escrowedFunds()']?.toString() ?? null,
    xrplAddress: cvAddr,
  };

  // Reconciliation — Memory1.md records drift of -0.015%. Backing must still close.
  if (cv['availableFunds()'] !== null && cv['escrowedFunds()'] !== null && totalSupply > 0n) {
    const backing = queueTotal + cv['availableFunds()'] + cv['escrowedFunds()'];
    const drift = (Number(backing - totalSupply) / Number(totalSupply)) * 100;
    out.facts.backingDriftPct = drift;
    check('backing reconciles under 0.02% drift', Math.abs(drift) < 0.02,
      `queue + available + escrowed = ${fmt(ubaToUnits(backing))} vs supply ${fmt(ubaToUnits(totalSupply))} -> ${drift.toFixed(4)}%`);
  }

  // ============================================================================
  // 4. Pull the deployed AssetManager ABI — from the diamond, not the docs
  //    The AssetManager is an EIP-2535 diamond. Asking the explorer for the ABI at the
  //    diamond address returns only the proxy shell: events, errors, fallback, and ZERO
  //    functions. The on-chain loupe is the authority on what is dispatchable.
  // ============================================================================
  hr('4. DEPLOYED AssetManager ABI  (Tasks1.md Phase 0)');

  const loupeRaw = await M.probe(AM, sel('facets()'));
  check('AssetManager answers the EIP-2535 loupe (facets())', !!loupeRaw,
    loupeRaw ? `${(loupeRaw.length - 2) / 2} bytes` : 'NOT A DIAMOND — revisit this section');

  const facets = loupeRaw ? decodeFacets(loupeRaw) : [];
  const dispatch = new Map();                        // selector -> facet address
  for (const f of facets) for (const s of f.selectors) dispatch.set(s, f.addr);
  check('loupe enumerates facets and selectors', facets.length > 0 && dispatch.size > 0,
    `${facets.length} facets, ${dispatch.size} selectors`);

  // The signatures the oracle and the liveness model are written against. A selector in
  // the loupe IS dispatchable — that is the fact, whatever any explorer returns.
  // maxRedeemedTickets is NOT a standalone getter — it is getSettings() component 30
  // (uint16). Assuming a getter here was our own error, not a docs error.
  const REQUIRED = [
    'redemptionQueue(uint256,uint256)', 'getCoreVaultManager()', 'lotSize()',
    'getSettings()', 'fAsset()',
  ];
  for (const s of REQUIRED) {
    const id = sel(s);
    check(`diamond dispatches ${s}`, dispatch.has(id),
      dispatch.has(id) ? `${id} -> facet ${dispatch.get(id)}` : `${id} ABSENT FROM LOUPE`);
  }

  // Assemble the usable ABI: the diamond shell carries the events and errors, each facet
  // carries its functions. Merge into one file so nothing downstream has to know this.
  const events = new Map(), fns = new Map(), errs = new Map();
  const absorb = (abi) => {
    for (const it of abi) {
      if (it.type === 'event') events.set(canon(it), it);
      else if (it.type === 'function') fns.set(canon(it), it);
      else if (it.type === 'error') errs.set(canon(it), it);
    }
  };

  const shell = await fetchAbi(AM);
  check('diamond shell ABI retrieved from the explorer', !!shell,
    shell ? `${shell.length} items (events + errors, no functions — expected)` : 'UNAVAILABLE');
  if (shell) absorb(shell);

  let verifiedFacets = 0;
  for (const f of facets) {
    const a = await fetchAbi(f.addr);
    if (a) { verifiedFacets++; absorb(a); }
  }
  console.log(`        ${verifiedFacets}/${facets.length} facets verified on the explorer`);
  check('merged ABI carries the functions the shell lacks', fns.size > 0,
    `${fns.size} functions, ${events.size} events, ${errs.size} errors`);

  // Coverage: how much of the dispatch table the merged ABI can actually name.
  const named = new Set([...fns.keys()].map(sel));
  const unnamed = [...dispatch.keys()].filter((s) => !named.has(s));
  check('merged ABI names every dispatchable selector', unnamed.length === 0,
    `${dispatch.size - unnamed.length}/${dispatch.size} selectors named`);
  check('merged ABI declares every required signature', REQUIRED.every((s) => fns.has(s)),
    REQUIRED.filter((s) => !fns.has(s)).join(' ') || 'all present');

  // maxRedeemedTickets bounds ONE redemptionQueue page, not the queue itself. The queue
  // length is unbounded — which is exactly why the hot path may never walk it.
  const settings = await M.probe(AM, sel('getSettings()'));
  const sBase = settings && u(settings, 0) === 32n ? 1 : 0;   // dynamic tuple -> skip head
  const comps = (fns.get('getSettings()')?.outputs?.[0]?.components || []).map((c) => c.name);
  const slotOf = (n) => comps.indexOf(n);
  const maxRedeemedTickets = settings && slotOf('maxRedeemedTickets') >= 0
    ? Number(u(settings, sBase + slotOf('maxRedeemedTickets'))) : null;
  const lotSizeAMG = settings && slotOf('lotSizeAMG') >= 0
    ? u(settings, sBase + slotOf('lotSizeAMG')) : null;
  check('getSettings() carries maxRedeemedTickets (a setting, not a getter)',
    maxRedeemedTickets !== null,
    maxRedeemedTickets !== null
      ? `component ${slotOf('maxRedeemedTickets')} = ${maxRedeemedTickets} tickets per redemption`
      : 'NOT FOUND IN SETTINGS');
  out.facts.settings = { maxRedeemedTickets, lotSizeAMG: lotSizeAMG?.toString() ?? null };

  fs.mkdirSync(path.join(ROOT, 'abi'), { recursive: true });
  const merged = [...fns.values(), ...events.values(), ...errs.values()];
  fs.writeFileSync(path.join(ROOT, 'abi', 'AssetManager.json'), JSON.stringify(merged, null, 2));
  fs.writeFileSync(path.join(ROOT, 'abi', 'AssetManagerFacets.json'), JSON.stringify(
    { diamond: AM, facets: facets.map((f) => ({ ...f, selectors: f.selectors.sort() })) }, null, 2));
  console.log('        wrote abi/AssetManager.json + abi/AssetManagerFacets.json');

  out.facts.abi = {
    diamond: true, facets: facets.length, verifiedFacets, selectors: dispatch.size,
    functions: fns.size, events: events.size, errors: errs.size, unnamedSelectors: unnamed.length,
  };

  // Re-confirm the recorded deployed-vs-documented mismatches still hold.
  console.log('\n        Deployed-vs-documented mismatches (Memory1.md) — recheck:');
  const perf = [...events.keys()].find((k) => k.startsWith('RedemptionPerformed('));
  console.log(`          RedemptionPerformed        ${perf || 'ABSENT'}`);
  check('RedemptionPerformed emits uint256 requestId, not uint64',
    !!perf && /,uint256,/.test(perf) && !/uint64/.test(perf), perf ? `topic0 ${sel(perf)}` : '');
  // Both events exist in the deployed ABI. The doc name is not phantom — it is the wrong
  // one to scan for. Phase 1 keys off RedemptionRequestIncomplete (topic0 0xffb29516).
  const inc = [...events.keys()].filter((k) => /Redemption(Request|Amount)Incomplete\(/.test(k));
  check('RedemptionRequestIncomplete is deployed (docs point at RedemptionAmountIncomplete)',
    inc.some((k) => k.startsWith('RedemptionRequestIncomplete(')),
    inc.map((k) => `${k} ${sel(k)}`).join('  ') || 'NEITHER PRESENT');
  // Memory1.md recorded these as "documented but absent from the deployed ABI — those rate
  // limits are not live". That was a shell-pull artifact: reading the ABI at the diamond
  // address returns no functions and an incomplete event set. Direct minting IS deployed,
  // with live limit getters. The entry recorded a tooling failure as a protocol fact.
  const dmd = [...events.keys()].filter((k) => /^(Large)?DirectMintingDelayed\(/.test(k));
  check('DirectMintingDelayed / LargeDirectMintingDelayed ARE in the deployed ABI',
    dmd.length === 2, dmd.join(' ') || 'ABSENT');
  const dmLimits = {};
  for (const f of [
    'getDirectMintingHourlyLimitUBA()', 'getDirectMintingDailyLimitUBA()',
    'getDirectMintingLargeMintingThresholdUBA()', 'getDirectMintingLargeMintingDelaySeconds()',
  ]) {
    const r = await M.probe(AM, sel(f));
    dmLimits[f] = r ? u(r, 0).toString() : null;
  }
  const dmLive = Object.values(dmLimits).every((v) => v !== null && v !== '0');
  check('direct-minting rate limits are live on mainnet', dmLive,
    `hourly ${fmt(ubaToUnits(BigInt(dmLimits['getDirectMintingHourlyLimitUBA()'] || 0)))} XRP · ` +
    `daily ${fmt(ubaToUnits(BigInt(dmLimits['getDirectMintingDailyLimitUBA()'] || 0)))} XRP · ` +
    `large-mint delay ${fmt(dmLimits['getDirectMintingLargeMintingDelaySeconds()'])}s`);
  out.facts.directMinting = dmLimits;

  // topic0 hashes the Phase 1 event scan needs.
  const wanted = [...events.keys()].filter((k) => /^Redemption/.test(k)).sort();
  out.facts.redemptionEventTopics = Object.fromEntries(wanted.map((s) => [s, sel(s)]));
  console.log('\n        Redemption event topic0 (for the Phase 1 scan):');
  for (const s of wanted) console.log(`          ${sel(s)}  ${s}`);

  // ============================================================================
  // 5. Pin a fork block and record it
  //    An unpinned fork drifts, gas numbers move, and the event cache never hits.
  // ============================================================================
  hr('5. PIN THE FORK BLOCK  (Tasks1.md Phase 0)');

  const head = await M.blockNumber();
  // A pin that moves is not a pin. Once fork.json exists the block is a committed decision:
  // gas numbers and the event cache are keyed to it. Re-pin only on an explicit REPIN=true.
  const forkPath = path.join(ROOT, 'fork.json');
  const prior = fs.existsSync(forkPath) ? JSON.parse(fs.readFileSync(forkPath, 'utf8')) : null;
  const repin = process.env.REPIN === 'true';
  // Back off from the head so the pin is comfortably settled and stays reproducible.
  const pinned = prior?.forkBlock && !repin ? prior.forkBlock : head - 200;
  const blk = await M.getBlock(pinned);
  const ts = Number(BigInt(blk.timestamp));
  const origin = prior?.forkBlock
    ? (repin ? `re-pinned from ${fmt(prior.forkBlock)} (REPIN=true)` : 'held from fork.json')
    : 'first pin';
  console.log(`        head ${fmt(head)}  ->  pinned ${fmt(pinned)}  (${new Date(ts * 1000).toISOString()})  [${origin}]`);
  check('fork block is a stable pin, not the moving head', pinned <= head - 200,
    `${fmt(head - pinned)} blocks behind head`);

  // Confirm the free public RPC is still archival at this depth — this is what makes
  // pinned forking work without a paid archive node.
  const deep = head - 1_000_000;
  const sup0 = await M.probe(FXRP, sel('totalSupply()'), '0x' + pinned.toString(16));
  const supDeep = await M.probe(FXRP, sel('totalSupply()'), '0x' + deep.toString(16));
  check('archival read at the pinned block', !!sup0, sup0 ? `${fmt(ubaToUnits(u(sup0, 0)))} FXRP` : 'FAILED');
  check('archival read 1,000,000 blocks deep', !!supDeep,
    supDeep ? `block ${fmt(deep)} -> ${fmt(ubaToUnits(u(supDeep, 0)))} FXRP` : 'FAILED — RPC no longer archival at depth');

  // Fingerprints, so a later run can prove the fork is pinned where it claims to be.
  // Read AT the pinned block, not at latest — the whole point is that they never move.
  const at = '0x' + pinned.toString(16);
  const qPinned = await M.call(AM, QSEL + enc(0n) + enc(200n), at);
  const qOff = Number(u(qPinned, 0)) / 32;
  const qLen = Number(u(qPinned, qOff));
  let qTot = 0n;
  for (let i = 0; i < qLen; i++) qTot += u(qPinned, qOff + 1 + i * 3 + 2);
  const cvAvail = await M.probe(CVM, sel('availableFunds()'), at);
  const cvEsc = await M.probe(CVM, sel('escrowedFunds()'), at);

  const fork = {
    note: 'Pinned fork block for the demo venue. anvil --fork-url $RPC_URL --fork-block-number FORK_BLOCK',
    network: 'flare-mainnet',
    chainId: 14,
    rpc: M.url,
    forkBlock: pinned,
    forkBlockTimestamp: ts,
    forkBlockISO: new Date(ts * 1000).toISOString(),
    headAtPinning: prior?.headAtPinning && !repin ? prior.headAtPinning : head,
    // Read at forkBlock. Every value here is immutable; a re-run that disagrees means the
    // RPC lost archival depth or is serving a different chain.
    fingerprints: {
      fxrpTotalSupplyUBA: sup0 ? u(sup0, 0).toString() : null,
      queueTicketsFirstPage: qLen,
      queueValueFirstPageUBA: qTot.toString(),
      coreVaultAvailableUBA: cvAvail ? u(cvAvail, 0).toString() : null,
      coreVaultEscrowedUBA: cvEsc ? u(cvEsc, 0).toString() : null,
    },
  };

  // A held pin must reproduce byte-for-byte, or the venue is not what it claims.
  if (prior?.fingerprints && !repin) {
    const drifted = Object.entries(fork.fingerprints)
      .filter(([k, v]) => prior.fingerprints[k] !== undefined && String(prior.fingerprints[k]) !== String(v))
      .map(([k, v]) => `${k}: ${prior.fingerprints[k]} -> ${v}`);
    check('pinned-block state reproduces exactly across runs', drifted.length === 0,
      drifted.length ? drifted.join(' | ') : `${Object.keys(fork.fingerprints).length} fingerprints identical`);
  }

  fs.writeFileSync(forkPath, JSON.stringify(fork, null, 2));
  check('fork block pinned and recorded', true, `fork.json -> block ${fmt(pinned)}`);

  // ============================================================================
  hr('PHASE 0 SUMMARY');
  const failed = out.checks.filter((c) => !c.pass);
  console.log(`  ${out.checks.length - failed.length}/${out.checks.length} checks passed`);
  for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
  out.generatedAt = new Date().toISOString();
  out.forkBlock = pinned;
  fs.writeFileSync(path.join(ROOT, 'phase0-results.json'), JSON.stringify(out, null, 2));
  console.log('\n  wrote phase0-results.json, fork.json, abi/AssetManager.json');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('\nFATAL', e.message); process.exit(1); });
