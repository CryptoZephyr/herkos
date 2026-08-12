#!/usr/bin/env node
// Phase 1 — Readers. Off-chain and read-only: eth_call, explorer getLogs, plain HTTPS.
// Nothing here signs, broadcasts, or writes to a chain. Closes the eight Phase 1 items in
// Collects the read-only mainnet evidence and writes ignored local reports.
//
// Two rules the whole file obeys:
//   - Everything on Flare resolves through FlareContractsRegistry at runtime. The recorded
//     addresses below check the resolver returned the right thing; they are not shortcuts.
//   - Everything on Flare is read AT THE PINNED BLOCK from fork.json. Phase 2 measured its
//     numbers there, so a reader at `latest` would not be comparable, and an event cache
//     keyed to a moving head never hits.
const fs = require('fs');
const path = require('path');
const {
  client, topic, sel, enc, u, ad, strAt, addrArrayAt, strArrayAt,
  jget, fmt, ubaToUnits,
} = require('./lib/rpc.js');

const REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';
const DEPLOY_BLOCK = 47_098_178;         // AssetManager FXRP deployment
const XRPL_RPC = process.env.XRPL_RPC || 'https://s1.ripple.com:51234/';
const RIPPLE_EPOCH = 946684800;          // XRPL times are seconds since 2000-01-01

const EXPECT = {
  assetManager:  '0x2a3fe068cd92178554cabcf7c95adf49b4b0b6a8',
  fxrp:          '0xad552a648c74d49e10027ab8a618a3ad4901c5be',
  coreVaultMgr:  '0x6c8d96defe4cbee05fa969fc0ac436d94fc21784',
  xrplCoreVault: 'rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj',
  oftAdapter:    '0xd70659a6396285bf7214d7ea9673184e7c72e07e',
};

// Recorded exit venues. Candidates only — every one is verified by calling token0()/token1()
// below, because the correlation flag is what separates real depth from a rotation.
const POOL_CANDIDATES = [
  '0x2a91D9296ee2fe4139b49c7071b2f29f59a9f9aE',   // FXRP/stXRP — correlated, contributes 0
  '0x927485d88a66253c63Af9163dca5f21c25A57393',   // FXRP/USDT0
  '0x686f53F0950Ef193C887527eC027E6A574A4DbE1',   // FXRP/USDT0
  '0x88D46717b16619B37fa2DfD2F038DEFB4459F1F7',   // FXRP/USDT0
];
// Correlated to XRP: selling FXRP into these is a rotation, not an exit.
const XRP_CORRELATED = /^(stXRP|wXRP|XRP|FXRP|rlusdXRP)$/i;

// Remote OFT venues. Per-chain supply is presentation only — the adapter's locked balance
// on Flare is the aggregate of every remote claim, and it is the number that reconciles.
// Katana is listed and deliberately has no token address: rpc.katana.network answers
// (chainId 0xb67d2) but eth_getCode at the shared OFT address is 0x, so FXRP is not deployed
// there. Dropping the row would hide that; carrying it with token:null names it.
const REMOTE_CHAINS = [
  ['Ethereum', process.env.ETH_RPC      || 'https://ethereum-rpc.publicnode.com', '0xce6170ea245dc8d1f275a710a062b70f125f0110'],
  ['Monad',    process.env.MONAD_RPC    || 'https://rpc.monad.xyz',               '0xCE6170EA245dC8D1f275A710a062b70f125F0110'],
  ['HyperEVM', process.env.HYPEREVM_RPC || 'https://rpc.hyperliquid.xyz/evm',     '0xd70659a6396285BF7214d7Ea9673184e7C72E07E'],
  ['Base',     process.env.BASE_RPC     || 'https://mainnet.base.org',            '0xCE6170EA245dC8D1f275A710a062b70f125F0110'],
  ['BNB Chain',process.env.BNB_RPC      || 'https://bsc-rpc.publicnode.com',      '0xCE6170EA245dC8D1f275A710a062b70f125F0110'],
  ['Katana',   process.env.KATANA_RPC   || 'https://rpc.katana.network',          process.env.KATANA_FXRP || null],
];

// ---------- liveness constants ----------
// A judgement call, not a derivation. Published here so they can be
// argued with rather than hidden in a constant.
const LIVENESS = {
  settlementHorizonHours: 48,   // no settlement in 48h is not exit capacity
  defaultWindowDays: 30,        // a default older than this no longer penalises
  defaultHalving: 0.5,          // each default in the window halves liveness
  floorPPM: 0,                  // no floor: a silent agent contributes nothing
};

const ROOT = path.join(__dirname, '..');
const M = client();
const out = {
  network: 'flare-mainnet', rpc: M.url, readOnly: true,
  checks: [], resolved: {}, facts: {}, model: { liveness: LIVENESS },
};

const lc = (s) => (s || '').toLowerCase();
function check(name, pass, detail = '') {
  out.checks.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  return pass;
}
const hr = (t) => console.log(`\n${'='.repeat(80)}\n${t}\n${'='.repeat(80)}`);
const pct = (a, b) => (Number(b) === 0 ? 0 : (Number(a - b) / Number(b)) * 100);
// Math.abs cannot take a BigInt — it throws rather than coercing.
const babs = (v) => (v < 0n ? -v : v);

// ---------- event transport ----------
// The public Flare RPC range-limits eth_getLogs, and the scan window is ~20M blocks. Blockscout
// does not, and it returns `timeStamp` per log — which is exactly what liveness recency needs,
// so no per-log eth_getBlockByNumber. A page at the cap means it truncated silently, so bisect
// rather than trust the length. This is the transport count.js proved out.
const EXPLORERS = [
  'https://flare-explorer.flare.network/api',
  'https://api.routescan.io/v2/network/mainnet/evm/14/etherscan/api',
];
const LOG_CAP = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Explorers return block/time as hex on one and decimal on the other, and omit them on a
// malformed row. BigInt(undefined) throws, which would abort a scan an hour in.
const hexNum = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  try { return Number(BigInt(typeof v === 'string' ? v : String(v))); } catch { return 0; }
};

async function getLogsRange(address, topic0, lo, hi) {
  const found = [];
  const stack = [[lo, hi]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let page = null;
    // A 20M-block scan will meet a rate limit. Backing off is the difference between a slow
    // pass and a failed one; giving up on the first 429 would throw away an hour of work.
    for (let attempt = 0; attempt < 4 && page === null; attempt++) {
      if (attempt) await sleep(1500 * attempt);
      for (const base of EXPLORERS) {
        const j = await jget(
          `${base}?module=logs&action=getLogs&fromBlock=${a}&toBlock=${b}` +
          `&address=${address}&topic0=${topic0}`, 60000);
        if (!j) continue;
        if (j.status === '1' && Array.isArray(j.result)) { page = j.result; break; }
        // "No logs found" is an empty range, not a transport failure. Treating it as an error
        // would abort a scan that is simply quiet in that window.
        const msg = `${j.message || ''} ${typeof j.result === 'string' ? j.result : ''}`;
        if (j.status === '0' && /no logs|not found|no records/i.test(msg)) { page = []; break; }
      }
    }
    if (page === null) throw new Error(`getLogs failed ${a}-${b} topic0 ${topic0}`);
    if (page.length >= LOG_CAP) {
      if (b > a) {
        const mid = Math.floor((a + b) / 2);
        stack.push([mid + 1, b], [a, mid]);
        continue;
      }
      // A single block at the cap cannot be bisected further. Say so rather than returning a
      // short number as though it were complete — the same discipline poke() applies to pages.
      console.warn(`\n        WARN block ${a} returned ${page.length} logs at the cap — may be truncated`);
    }
    found.push(...page);
  }
  return found;
}

// Scan in fixed windows so a 20M-block pass reports progress, bisecting inside each.
async function scanEvent(address, topic0, from, to, label) {
  const WINDOW = 2_000_000;
  const logs = [];
  for (let a = from; a <= to; a += WINDOW) {
    const b = Math.min(a + WINDOW - 1, to);
    const part = await getLogsRange(address, topic0, a, b);
    logs.push(...part);
    process.stdout.write(`\r        ${label}  ${fmt(a)}-${fmt(b)}  +${part.length}  total ${fmt(logs.length)}   `);
  }
  process.stdout.write('\n');
  return logs.sort((x, y) => hexNum(x.blockNumber) - hexNum(y.blockNumber));
}

// ---------- XRPL JSON-RPC (plain HTTPS POST) ----------
async function xrpl(method, params) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(XRPL_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params: [params] }),
      signal: c.signal,
    });
    const j = await r.json();
    if (j?.result?.status === 'error') return { error: j.result.error_message || j.result.error };
    return j?.result ?? null;
  } catch (e) { return { error: e.message }; } finally { clearTimeout(t); }
}

// ---------- small ERC-20 / pool reads, ABI-free ----------
const SEL = {
  totalSupply: sel('totalSupply()'), balanceOf: sel('balanceOf(address)'),
  decimals: sel('decimals()'), symbol: sel('symbol()'),
  token0: sel('token0()'), token1: sel('token1()'),
};
const numAt = async (c, to, data, block) => {
  const r = await c.probe(to, data, block);
  return r ? u(r, 0) : null;
};
const symbolOf = async (c, to, block) => {
  const r = await c.probe(to, SEL.symbol, block);
  if (!r) return null;
  // Most tokens return string; a few return bytes32. Try the dynamic decode, then fall back.
  try { const s = strAt(r, 0); if (s) return s; } catch {}
  return Buffer.from(r.slice(2).replace(/(00)+$/, ''), 'hex').toString('utf8') || null;
};

// ---------- event cache ----------
// Gitignored and regenerable, but a full rescan is ~20M blocks. Keyed to the pinned head,
// so a re-run at the same pin is instant and a moved pin invalidates on its own.
const CACHE = path.join(ROOT, 'cache-redemption-events.json');
const loadCache = (pin) => {
  if (process.env.RESCAN === 'true' || !fs.existsSync(CACHE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    return j.toBlock === pin && j.fromBlock === DEPLOY_BLOCK ? j : null;
  } catch { return null; }
};

// ---------- exit model, mirroring ExitCapacityOracle exactly ----------
// Same constants as the deployed constructor, same integer arithmetic. If the reader and the
// contract ever disagree the reader is wrong, so this is written to be checkable against it
// rather than to be independently clever.
const MODEL = {
  queueSettleSeconds: 1800,
  coreVaultCycleSeconds: 86400,
  escrowReleasePerDayUBA: 8_235_294n * 1_000_000n,
  discountRatePPMPerYear: 150_000n,
  minHaircutPPM: 500_000n,
  referenceSizeUBA: 1_000_000n * 1_000_000n,
};
const YEAR = 31_536_000n;

function timeToExit(amountUBA, st) {
  if (amountUBA <= st.effectiveQueueUBA) return BigInt(MODEL.queueSettleSeconds);
  const base = BigInt(MODEL.queueSettleSeconds) + BigInt(MODEL.coreVaultCycleSeconds);
  if (amountUBA <= st.effectiveQueueUBA + st.coreVaultUBA) return base;
  const excess = amountUBA - st.effectiveQueueUBA - st.coreVaultUBA;
  const rate = MODEL.escrowReleasePerDayUBA;
  // The contract's zero-rate branch, carried over even though the deployed rate is nonzero.
  // A port that drops a branch because the current state never reaches it stops being a port.
  const extraDays = rate === 0n ? 3650n : (excess + rate - 1n) / rate;
  return base + extraDays * 86400n;
}

function clearingPPM(amountUBA, st) {
  if (amountUBA === 0n) return 1_000_000n;
  const dex = st.dexExitUBA;
  const dexPart = amountUBA < dex ? amountUBA : dex;
  const rest = amountUBA - dexPart;
  let dexPPM = 1_000_000n;
  if (dexPart !== 0n) dexPPM = (1_000_000n * dex) / (dex + dexPart);
  let restPPM = 1_000_000n;
  if (rest !== 0n) {
    const disc = (MODEL.discountRatePPMPerYear * timeToExit(rest, st)) / YEAR;
    restPPM = disc >= 1_000_000n ? 0n : 1_000_000n - disc;
  }
  return (dexPart * dexPPM + rest * restPPM) / amountUBA;
}

// _recompute stores the FLOORED and CAPPED value, and that — not the raw curve — is what
// getUnderlyingPrice multiplies by. clearingPricePPM() exposes the raw one. Both are modelled,
// because reporting only the raw number would misstate the price at a size deep enough to
// hit the floor (ExitCapacityOracle.sol:439-443).
const storedHaircutPPM = (st) => {
  let ppm = clearingPPM(MODEL.referenceSizeUBA, st);
  if (ppm < MODEL.minHaircutPPM) ppm = MODEL.minHaircutPPM;
  if (ppm > 1_000_000n) ppm = 1_000_000n;
  return ppm;
};

(async () => {
  // ============================================================================
  // 0. The venue: resolve at runtime, read at the pin
  // ============================================================================
  hr('0. RESOLUTION + PINNED BLOCK  (every read below is at this block)');

  const forkPath = path.join(ROOT, 'fork.json');
  if (!fs.existsSync(forkPath)) throw new Error('fork.json missing — run `npm run phase0` first');
  const fork = JSON.parse(fs.readFileSync(forkPath, 'utf8'));
  const PIN = fork.forkBlock;
  const at = '0x' + PIN.toString(16);
  const nowTs = fork.forkBlockTimestamp;
  console.log(`        pin ${fmt(PIN)}  ${fork.forkBlockISO}  (fork.json — a pin, not the head)`);

  const head = await M.blockNumber();
  check('pinned block is behind the head and still readable', PIN < head,
    `head ${fmt(head)}, ${fmt(head - PIN)} blocks ahead of the pin`);

  // Resolution reads at the pin too, not just the state reads. Identity is state: if the
  // controller ever swaps the FXRP AssetManager, resolving at `latest` and then reading the
  // queue `at` the pin would ask a post-pin address for pre-pin state. The EXPECT assertions
  // below would catch that — but catching it is worse than not committing it, and the header
  // of this file claims every Flare read is at the pin. Make the claim true.
  const all = await M.call(REGISTRY, sel('getAllContracts()'), at);
  const names = strArrayAt(all, 0);
  const addrs = addrArrayAt(all, 1);
  const byName = new Map(names.map((n, i) => [n, addrs[i]]));
  const controller = [...byName].find(([n]) => /AssetManagerController/i.test(n))?.[1] || null;
  check('registry -> AssetManagerController', !!controller, controller || 'NOT IN REGISTRY');

  let AM = null, FXRP = null, fxrpDecimals = null;
  if (controller) {
    const managers = addrArrayAt(await M.call(controller, sel('getAssetManagers()'), at), 0);
    for (const am of managers) {
      const fa = await M.probe(am, sel('fAsset()'), at);
      if (!fa) continue;
      const token = ad(fa, 0);
      if ((await symbolOf(M, token, at)) === 'FXRP') {
        AM = am; FXRP = token;
        fxrpDecimals = Number(await numAt(M, token, SEL.decimals, at));
      }
    }
  }
  check('resolved AssetManager FXRP at runtime', !!AM && lc(AM) === EXPECT.assetManager, AM || 'NOT FOUND');
  check('resolved FXRP token at runtime', !!FXRP && lc(FXRP) === EXPECT.fxrp, FXRP || 'NOT FOUND');
  check('FXRP is 6 decimals', fxrpDecimals === 6, `decimals() = ${fxrpDecimals}`);
  if (!AM || !FXRP) throw new Error('runtime resolution failed — cannot read at the pin');
  Object.assign(out.resolved, { assetManager: AM, fxrp: FXRP, fxrpDecimals, assetManagerController: controller });

  const CVM = ad(await M.call(AM, sel('getCoreVaultManager()'), at), 0);
  check('AssetManager -> CoreVaultManager', lc(CVM) === EXPECT.coreVaultMgr, CVM);
  out.resolved.coreVaultManager = CVM;

  const totalSupply = await numAt(M, FXRP, SEL.totalSupply, at);
  check('FXRP totalSupply at the pin matches the fork.json fingerprint',
    totalSupply?.toString() === fork.fingerprints.fxrpTotalSupplyUBA,
    `${fmt(ubaToUnits(totalSupply))} FXRP`);
  out.facts.pin = { block: PIN, timestamp: nowTs, iso: fork.forkBlockISO };
  out.facts.fxrpTotalSupplyUBA = totalSupply.toString();

  // ============================================================================
  // 1. Walk the full redemption queue, page through nextId, per-agent totals
  // ============================================================================
  hr('1. REDEMPTION QUEUE — full walk, per-agent totals');

  const QSEL = sel('redemptionQueue(uint256,uint256)');
  const PAGE = 100n;                       // the contract's queuePageSize
  let cursor = 0n, tickets = [], pages = 0, truncated = false;
  const MAX_PAGES = 40;                    // the contract's maxQueuePages
  while (true) {
    if (pages >= MAX_PAGES) { truncated = true; break; }
    const raw = await M.call(AM, QSEL + enc(cursor) + enc(PAGE), at);
    const o = Number(u(raw, 0)) / 32;
    const l = Number(u(raw, o));
    for (let i = 0; i < l; i++) {
      const b = o + 1 + i * 3;
      tickets.push({ id: u(raw, b).toString(), agent: ad(raw, b + 1), uba: u(raw, b + 2) });
    }
    cursor = u(raw, 1);
    pages++;
    if (cursor === 0n || l === 0) break;
  }
  const queueTotal = tickets.reduce((s, t) => s + t.uba, 0n);

  // Per-agent totals — the unit the liveness weighting and the gas model both work in.
  // poke() caches by vault, so cost scales with unique agents, not tickets.
  const perAgent = new Map();
  for (const t of tickets) {
    const a = lc(t.agent);
    const e = perAgent.get(a) || { agent: t.agent, tickets: 0, uba: 0n };
    e.tickets++; e.uba += t.uba;
    perAgent.set(a, e);
  }
  check('queue walk terminates on nextId', cursor === 0n && !truncated,
    `${pages} page(s) of ${PAGE}, cursor ended at ${cursor}`);
  check('queue walk is not truncated by the contract page budget', !truncated,
    truncated ? `hit maxQueuePages=${MAX_PAGES} — queueTruncated would be set` : `${pages}/${MAX_PAGES} pages used`);
  check('queue totals reproduce the fork.json fingerprint',
    tickets.length === fork.fingerprints.queueTicketsFirstPage &&
    queueTotal.toString() === fork.fingerprints.queueValueFirstPageUBA,
    `${tickets.length} tickets, ${fmt(ubaToUnits(queueTotal))} FXRP`);
  check('per-agent totals sum back to the queue total',
    [...perAgent.values()].reduce((s, e) => s + e.uba, 0n) === queueTotal,
    `${perAgent.size} unique agents across ${tickets.length} tickets`);

  console.log('\n        agent vault                                  tickets        FXRP');
  for (const e of [...perAgent.values()].sort((x, y) => Number(y.uba - x.uba))) {
    console.log(`        ${e.agent}  ${String(e.tickets).padStart(7)}  ${fmt(ubaToUnits(e.uba)).padStart(12)}`);
  }

  out.facts.queue = {
    tickets: tickets.length, pages, truncated,
    totalUBA: queueTotal.toString(), totalFXRP: ubaToUnits(queueTotal),
    uniqueAgents: perAgent.size,
    perAgent: [...perAgent.values()].map((e) => ({
      agent: e.agent, tickets: e.tickets, uba: e.uba.toString(), fxrp: ubaToUnits(e.uba),
    })),
  };

  // ============================================================================
  // 2. Scan the Redemption* events over the full deployment window, cached
  //    topic0 is recomputed from the signatures the merged facet ABI reported —
  //    NOT from docs signatures. That distinction is the whole point of the item.
  // ============================================================================
  hr('2. REDEMPTION EVENT SCAN — deployment block to the pin');

  const p0Path = path.join(ROOT, 'phase0-results.json');
  const p0 = fs.existsSync(p0Path) ? JSON.parse(fs.readFileSync(p0Path, 'utf8')) : null;
  const recorded = p0?.facts?.redemptionEventTopics || {};
  check('phase0-results.json carries the deployed Redemption* signatures',
    Object.keys(recorded).length >= 14, `${Object.keys(recorded).length} signatures`);

  const SCAN = [
    'RedemptionRequested', 'RedemptionWithTagRequested', 'RedemptionPerformed', 'RedemptionDefault',
  ];
  const sigOf = (name) => Object.keys(recorded).find((s) => s.startsWith(name + '('));
  const topics = {};
  for (const name of SCAN) {
    const sigStr = sigOf(name);
    topics[name] = sigStr ? topic(sigStr) : null;
    check(`topic0 recomputed for ${name}`, !!topics[name],
      sigStr ? `${topics[name]}  ${sigStr}` : 'SIGNATURE NOT IN phase0-results.json');
  }
  // The recorded docs bug, checked rather than recalled: the documented signature declares
  // uint64 requestId, the deployed event emits uint256. A scan keyed to the documented
  // topic0 finds zero settlements and looks like a dead system — which is what the earlier
  // research pass reported. Assert the deployed hash differs from the documented one.
  const DOC_PERFORMED = topic('RedemptionPerformed(address,address,uint64,bytes32,uint256,int256)');
  check('deployed RedemptionPerformed topic0 differs from the documented signature',
    topics.RedemptionPerformed !== DOC_PERFORMED,
    `deployed ${topics.RedemptionPerformed?.slice(0, 10)} vs documented ${DOC_PERFORMED.slice(0, 10)}`);

  // Field positions come from the merged facet ABI, not from a counted guess. Each
  // non-indexed input occupies one head word — dynamic ones hold an offset — so the head
  // index of a static field is its position among the non-indexed inputs.
  const amAbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'abi', 'AssetManager.json'), 'utf8'));
  const evAbi = (name) => amAbi.find((it) => it.type === 'event' && it.name === name);
  function dataWordOf(name, field) {
    const ins = (evAbi(name)?.inputs || []).filter((i) => !i.indexed);
    const k = ins.findIndex((i) => i.name === field);
    return k < 0 ? null : k;
  }
  const W = {
    reqValue: dataWordOf('RedemptionRequested', 'valueUBA'),
    tagValue: dataWordOf('RedemptionWithTagRequested', 'valueUBA'),
    perfValue: dataWordOf('RedemptionPerformed', 'redemptionAmountUBA'),
    defValue: dataWordOf('RedemptionDefault', 'redemptionAmountUBA'),
  };
  check('value field positions resolved from the merged facet ABI',
    Object.values(W).every((v) => v !== null),
    Object.entries(W).map(([k, v]) => `${k}=w${v}`).join(' '));

  let scan = loadCache(PIN);
  if (scan) {
    console.log(`        cache hit — cache-redemption-events.json at pin ${fmt(PIN)}`);
  } else {
    console.log(`        scanning ${fmt(DEPLOY_BLOCK)} -> ${fmt(PIN)} (${fmt(PIN - DEPLOY_BLOCK)} blocks) via explorer getLogs`);
    scan = { fromBlock: DEPLOY_BLOCK, toBlock: PIN, events: {} };
    for (const name of SCAN) {
      const logs = await scanEvent(AM, topics[name], DEPLOY_BLOCK, PIN, name);
      // Reduce to what liveness and the size distribution need. Full logs are not kept:
      // 24k records of calldata is not evidence, the aggregates are.
      const wordIdx = { RedemptionRequested: W.reqValue, RedemptionWithTagRequested: W.tagValue,
        RedemptionPerformed: W.perfValue, RedemptionDefault: W.defValue }[name];
      scan.events[name] = logs.map((l) => ({
        b: hexNum(l.blockNumber),
        t: hexNum(l.timeStamp),
        agent: '0x' + (l.topics[1] || '').slice(26),
        uba: (l.data && l.data.length >= 2 + (wordIdx + 1) * 64
          ? BigInt('0x' + l.data.slice(2 + wordIdx * 64, 2 + (wordIdx + 1) * 64)) : 0n).toString(),
      }));
      // Written after each type, so a mid-scan failure keeps the work already done.
      fs.writeFileSync(CACHE, JSON.stringify(scan));
    }
    console.log(`        wrote cache-redemption-events.json (gitignored, keyed to pin ${fmt(PIN)})`);
  }

  const ev = scan.events;
  const requests = [...(ev.RedemptionRequested || []), ...(ev.RedemptionWithTagRequested || [])];
  const performed = ev.RedemptionPerformed || [];
  const defaults = ev.RedemptionDefault || [];
  const settledUBA = performed.reduce((s, l) => s + BigInt(l.uba), 0n);
  // reduce, not Math.max(...arr) — the request set is ~24k elements and spreading that into
  // an argument list is a stack-size gamble for no benefit.
  const tsOf = (arr, pick) => arr.reduce((m, l) => (m === null ? l.t : pick(m, l.t)), null);
  const firstTs = tsOf(requests, Math.min);
  const lastTs = tsOf(requests, Math.max);
  const spanDays = requests.length ? (lastTs - firstTs) / 86400 : 0;

  check('the scan found the redemption request history', requests.length > 1000,
    `${fmt(requests.length)} requests over ${spanDays.toFixed(0)} days`);
  // The research pass reported 0 settlements here. That was the documented-signature topic0,
  // not an empty system — recomputing from the deployed ABI is what recovers them.
  check('the scan found settlements (the docs-signature topic0 finds none)', performed.length > 0,
    `${fmt(performed.length)} RedemptionPerformed, ${fmt(ubaToUnits(settledUBA))} FXRP settled`);
  const defaultRate = requests.length ? (defaults.length / requests.length) * 100 : 0;
  check('default rate stays in the recorded band (~0.03%)', defaultRate < 0.1,
    `${defaults.length} defaults / ${fmt(requests.length)} requests = ${defaultRate.toFixed(4)}%`);

  const sizes = requests.map((l) => Number(BigInt(l.uba)) / 1e6).sort((a, b) => a - b);
  const q = (p) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] : 0);
  const throughputPerDay = spanDays > 0 ? ubaToUnits(settledUBA) / spanDays : 0;
  console.log(`        sizes  p50 ${fmt(q(0.5))} · p75 ${fmt(q(0.75))} · p90 ${fmt(q(0.9))} · ` +
    `p99 ${fmt(q(0.99))} · max ${fmt(sizes[sizes.length - 1] || 0)} FXRP`);
  console.log(`        throughput ${fmt(throughputPerDay)} FXRP/day — demonstrated, not capacity`);

  out.facts.history = {
    fromBlock: DEPLOY_BLOCK, toBlock: PIN,
    requests: requests.length, performed: performed.length, defaults: defaults.length,
    defaultRatePct: defaultRate, spanDays,
    settledUBA: settledUBA.toString(), settledFXRP: ubaToUnits(settledUBA),
    throughputFXRPPerDay: throughputPerDay,
    sizesFXRP: { p50: q(0.5), p75: q(0.75), p90: q(0.9), p99: q(0.99), max: sizes[sizes.length - 1] || 0 },
    defaultDays: [...new Set(defaults.map((d) => new Date(d.t * 1000).toISOString().slice(0, 10)))],
  };

  // ============================================================================
  // 3. liveness(agent) from settlement recency + default history
  //    Two layers, and the difference between them is stated rather than blurred:
  //      statusFactor  — the binary NORMAL/CCB filter poke() applies on-chain
  //      recency/default — the decay model, which needs event history and so can
  //                        only live off-chain. It refines the weighting; it never
  //                        raises a ticket above what the on-chain filter allows.
  // ============================================================================
  hr('3. AGENT LIVENESS MODEL');

  console.log('        constants — a judgement call, published so it can be argued with:');
  for (const [k, v] of Object.entries(LIVENESS)) console.log(`          ${k} = ${v}`);

  // Mirror the contract byte-for-byte: getAgentInfo(address), copy 64 bytes, status is
  // word 1 after the tuple offset. status 0 NORMAL / 1 CCB settle; 2+ do not.
  const INFO = sel('getAgentInfo(address)');
  check('getAgentInfo(address) selector matches the one the contract staticcalls',
    INFO === '0x152052b0', `${INFO} (src/ExitCapacityOracle.sol _staticStatus)`);

  const agentStats = new Map();
  const touch = (a) => {
    const k = lc(a);
    if (!agentStats.has(k)) agentStats.set(k, {
      agent: a, requests: 0, performed: 0, defaults: 0,
      lastPerformedTs: 0, lastDefaultTs: 0, performedUBA: 0n,
    });
    return agentStats.get(k);
  };
  for (const l of requests) touch(l.agent).requests++;
  for (const l of performed) {
    const e = touch(l.agent);
    e.performed++; e.performedUBA += BigInt(l.uba);
    if (l.t > e.lastPerformedTs) e.lastPerformedTs = l.t;
  }
  for (const l of defaults) {
    const e = touch(l.agent);
    e.defaults++;
    if (l.t > e.lastDefaultTs) e.lastDefaultTs = l.t;
  }
  const recentDefaults = (a, tsList) => tsList.filter((t) => nowTs - t <= LIVENESS.defaultWindowDays * 86400).length;
  const defaultTsByAgent = new Map();
  for (const l of defaults) {
    const k = lc(l.agent);
    defaultTsByAgent.set(k, [...(defaultTsByAgent.get(k) || []), l.t]);
  }
  check('event history attributes to agent vaults', agentStats.size > 0,
    `${agentStats.size} agents seen across ${fmt(requests.length + performed.length + defaults.length)} events`);

  // Score only the agents that actually hold queue tickets — the rest cannot be exit capacity
  // at this block whatever their history says.
  const liveness = new Map();
  console.log('\n        agent vault                                  status  recency  dflt  liveness      weighted FXRP');
  let effectiveQueueUBA = 0n;
  for (const e of [...perAgent.values()].sort((x, y) => Number(y.uba - x.uba))) {
    const k = lc(e.agent);
    const st = agentStats.get(k) || { performed: 0, lastPerformedTs: 0 };
    const raw = await M.probe(AM, INFO + enc(e.agent), at);
    const status = raw ? Number(u(raw, 1)) : null;
    const statusFactor = status !== null && status <= 1 ? 1 : 0;

    const hours = st.lastPerformedTs ? (nowTs - st.lastPerformedTs) / 3600 : Infinity;
    let recency = st.lastPerformedTs ? 1 - hours / LIVENESS.settlementHorizonHours : 0;
    recency = Math.max(0, Math.min(1, recency));

    const nRecent = recentDefaults(k, defaultTsByAgent.get(k) || []);
    const defaultFactor = Math.pow(LIVENESS.defaultHalving, nRecent);

    const score = Math.max(LIVENESS.floorPPM / 1e6, statusFactor * recency * defaultFactor);
    const weighted = (e.uba * BigInt(Math.round(score * 1e6))) / 1_000_000n;
    effectiveQueueUBA += weighted;
    // null rather than Infinity: JSON.stringify turns Infinity into null regardless, and being
    // explicit means "never settled" reads as a fact, not a serialisation accident.
    liveness.set(k, { agent: e.agent, status, statusFactor,
      hoursSinceSettlement: Number.isFinite(hours) ? hours : null,
      recency, recentDefaults: nRecent, defaultFactor, liveness: score,
      ticketUBA: e.uba.toString(), weightedUBA: weighted.toString() });
    console.log(`        ${e.agent}  ${String(status).padStart(6)}  ${recency.toFixed(3).padStart(7)}  ` +
      `${String(nRecent).padStart(4)}  ${score.toFixed(4).padStart(8)}  ${fmt(ubaToUnits(weighted)).padStart(15)}`);
  }

  check('every queue agent resolves an on-chain status',
    [...liveness.values()].every((v) => v.status !== null),
    `${[...liveness.values()].filter((v) => v.statusFactor === 1).length}/${liveness.size} can settle (status <= 1)`);
  check('effectiveQueue never exceeds the raw queue — weighting only reduces',
    effectiveQueueUBA <= queueTotal,
    `${fmt(ubaToUnits(effectiveQueueUBA))} effective vs ${fmt(ubaToUnits(queueTotal))} raw FXRP`);
  // poke() applies the binary filter only, so the on-chain effectiveQueue at this pin is the
  // full ticket value of every agent with status <= 1. Record both, and say which is which.
  const onChainEffective = [...perAgent.values()]
    .filter((e) => liveness.get(lc(e.agent))?.statusFactor === 1)
    .reduce((s, e) => s + e.uba, 0n);
  check('on-chain effectiveQueue at the pin matches the Phase 2 recorded value',
    onChainEffective.toString() === '1860950000000',
    `${onChainEffective} UBA (poke() binary filter)`);
  console.log(`        off-chain decay model would weight that to ${fmt(ubaToUnits(effectiveQueueUBA))} FXRP`);

  out.facts.liveness = {
    constants: LIVENESS,
    onChainEffectiveQueueUBA: onChainEffective.toString(),
    offChainEffectiveQueueUBA: effectiveQueueUBA.toString(),
    agents: [...liveness.values()],
    note: 'statusFactor mirrors poke()\'s binary status<=1 filter. recency/default decay is off-chain only — per-agent event history is not on-chain readable. It refines the weight downward, never upward.',
  };

  // ============================================================================
  // 4. XRPL Core Vault: account_info balance, account_objects escrow list
  //    This is the divergence check, not a proved balance. FDC proves XRP
  //    *transactions*, never "the account held N at time T" — so what this reader
  //    produces is a discrepancy to attest against, not an attestation.
  // ============================================================================
  hr('4. XRPL CORE VAULT');

  const cvAvail = await numAt(M, CVM, sel('availableFunds()'), at);
  const cvEsc = await numAt(M, CVM, sel('escrowedFunds()'), at);
  const cvReq = await numAt(M, CVM, sel('totalRequestAmountWithFee()'), at);
  const cvAddrRaw = await M.probe(CVM, sel('coreVaultAddress()'), at);
  const cvAddr = cvAddrRaw ? strAt(cvAddrRaw, 0) : null;
  check('CoreVaultManager.coreVaultAddress() is the XRPL account attestations bind to',
    cvAddr === EXPECT.xrplCoreVault, cvAddr || 'ABSENT');
  check('Core Vault funds reproduce the fork.json fingerprints',
    cvAvail?.toString() === fork.fingerprints.coreVaultAvailableUBA &&
    cvEsc?.toString() === fork.fingerprints.coreVaultEscrowedUBA,
    `available ${fmt(ubaToUnits(cvAvail))} · escrowed ${fmt(ubaToUnits(cvEsc))} XRP`);

  const info = await xrpl('account_info', { account: cvAddr, ledger_index: 'validated' });
  const xrplDrops = info?.account_data?.Balance ? BigInt(info.account_data.Balance) : null;
  const xrplUBA = xrplDrops;   // XRP drops are 6 decimals, same scale as UBA
  check('XRPL account_info returns the Core Vault balance', xrplUBA !== null,
    xrplUBA !== null ? `${fmt(ubaToUnits(xrplUBA))} XRP (ledger ${info.ledger_index})` : `FAILED ${info?.error || ''}`);

  const objs = await xrpl('account_objects', { account: cvAddr, ledger_index: 'validated', limit: 400 });
  const escrows = (objs?.account_objects || []).filter((o) => o.LedgerEntryType === 'Escrow');
  const escrowDrops = escrows.reduce((s, e) => s + BigInt(e.Amount || 0), 0n);
  const conditioned = escrows.filter((e) => !!e.Condition).length;
  const withFinishAfter = escrows.filter((e) => e.FinishAfter !== undefined).length;
  check('XRPL account_objects returns the escrow list', escrows.length > 0,
    `${escrows.length} escrows, ${fmt(ubaToUnits(escrowDrops))} XRP`);
  // Condition-gated, not time-gated. Any "time until unlock" model has to reflect operator
  // cadence presenting a preimage, not a countdown — an earlier draft got this wrong.
  check('escrows are condition-gated rather than time-gated',
    conditioned === escrows.length && withFinishAfter < escrows.length,
    `${conditioned}/${escrows.length} carry Condition, ${withFinishAfter} carry FinishAfter`);
  const cancelAfters = escrows.map((e) => e.CancelAfter).filter((x) => x !== undefined)
    .map((x) => new Date((x + RIPPLE_EPOCH) * 1000).toISOString().slice(0, 10)).sort();
  if (cancelAfters.length) {
    console.log(`        CancelAfter window ${cancelAfters[0]} -> ${cancelAfters[cancelAfters.length - 1]}` +
      ` (rolling self-escrow cycle, operator-driven)`);
  }

  // The divergence the publisher attests on — Flare accounting vs XRPL reality.
  // Cross-time, and say so: the XRPL side is the *validated* ledger while the Flare side is the
  // pin. A small divergence is that gap before it is a discrepancy, which is exactly why the
  // publisher attests on a threshold rather than on any nonzero difference.
  const divergenceUBA = xrplUBA !== null ? xrplUBA - cvAvail : null;
  if (divergenceUBA !== null) {
    const bips = Math.abs(pct(xrplUBA, cvAvail)) * 100;
    check('XRPL balance agrees with availableFunds() inside the divergence threshold',
      babs(divergenceUBA) < 100_000n * 1_000_000n,
      `XRPL ${fmt(ubaToUnits(xrplUBA))} vs Flare ${fmt(ubaToUnits(cvAvail))} = ` +
      `${divergenceUBA > 0n ? '+' : ''}${fmt(ubaToUnits(divergenceUBA))} XRP (${bips.toFixed(1)} bips) ` +
      `— XRPL at the validated ledger, Flare at the pin`);
    console.log('        one-directional rule: only a divergence that LOWERS capacity is attestable');
  }

  out.facts.coreVault = {
    xrplAddress: cvAddr,
    availableUBA: cvAvail.toString(), escrowedUBA: cvEsc.toString(),
    totalRequestAmountWithFeeUBA: cvReq?.toString() ?? null,
    xrplBalanceUBA: xrplUBA?.toString() ?? null,
    xrplLedgerIndex: info?.ledger_index ?? null,
    divergenceUBA: divergenceUBA?.toString() ?? null,
    escrows: {
      count: escrows.length, totalUBA: escrowDrops.toString(), totalXRP: ubaToUnits(escrowDrops),
      conditionGated: conditioned, withFinishAfter,
      objects: escrows.map((e) => ({
        index: e.index, amountUBA: e.Amount,
        destination: e.Destination, condition: !!e.Condition,
        cancelAfter: e.CancelAfter ? new Date((e.CancelAfter + RIPPLE_EPOCH) * 1000).toISOString() : null,
        finishAfter: e.FinishAfter ? new Date((e.FinishAfter + RIPPLE_EPOCH) * 1000).toISOString() : null,
      })),
    },
  };

  // ============================================================================
  // 5. OFT Adapter locked balance — the aggregate of every remote claim
  // ============================================================================
  hr('5. OFT ADAPTER LOCKED BALANCE');

  const adapter = process.env.OFT_ADAPTER || '0xd70659a6396285BF7214d7Ea9673184e7C72E07E';
  check('OFT adapter address is the recorded one', lc(adapter) === EXPECT.oftAdapter, adapter);
  const lockedUBA = await numAt(M, FXRP, SEL.balanceOf + enc(adapter), at);
  check('OFT Adapter holds locked FXRP backing remote supply', lockedUBA > 0n,
    `${fmt(ubaToUnits(lockedUBA))} FXRP locked`);
  const shareOfSupply = (Number(lockedUBA) / Number(totalSupply)) * 100;
  // Phase 2 read the same balance through poke() and stored it as remoteClaimsUBA.
  check('locked balance matches the remoteClaimsUBA poke() recorded at the pin',
    lockedUBA.toString() === '12929855160693',
    `${lockedUBA} UBA (phase2-results.json records 12,929,855,160,693)`);
  console.log(`        ${shareOfSupply.toFixed(2)}% of supply is off Flare and must route back through it to exit`);
  console.log('        recorded as remote claims — never counted as exit capacity');

  // The same balance at the head. Section 6 reads the remote chains at THEIR heads, and the
  // only honest comparison is against Flare at its head — the pin reading above is what poke()
  // stored and what Phase 2 fingerprinted, so both are kept rather than one replacing the other.
  const lockedHeadUBA = await numAt(M, FXRP, SEL.balanceOf + enc(adapter));
  const bridgedSincePin = lockedHeadUBA - lockedUBA;
  console.log(`        at the head it is ${fmt(ubaToUnits(lockedHeadUBA))} FXRP — ` +
    `${bridgedSincePin >= 0n ? '+' : ''}${fmt(ubaToUnits(bridgedSincePin))} bridged out since the pin`);
  out.facts.oft = { adapter, lockedUBA: lockedUBA.toString(), lockedFXRP: ubaToUnits(lockedUBA),
    lockedHeadUBA: lockedHeadUBA.toString(), bridgedSincePinUBA: bridgedSincePin.toString(),
    shareOfSupplyPct: shareOfSupply };

  // ============================================================================
  // 6. Per-chain OFT supply — presentation, and it must reconcile to the adapter
  //    Per-chain supply is NOT FDC-provable on mainnet (EVMTransaction covers
  //    ETH/FLR/SGB only). The adapter balance is the aggregate that is provable,
  //    which is why the reconciliation below is the load-bearing check and the
  //    per-chain table is the decoration.
  // ============================================================================
  hr('6. PER-CHAIN OFT SUPPLY');

  const remotes = [];
  for (const [name, url, token] of REMOTE_CHAINS) {
    const c = client(url);
    let supply = null, err = null, deployed = null;
    if (token === null) {
      // No token address configured. Prove the chain answers before recording "not deployed",
      // so an outage cannot masquerade as an absent deployment.
      try { await c.rpc('eth_chainId', []); deployed = false; }
      catch (e) { err = e.message; }
    } else {
      try {
        const code = await c.getCode(token);
        deployed = !!code && code !== '0x';
        if (deployed) supply = await numAt(c, token, SEL.totalSupply);
      } catch (e) { err = e.message; }
    }
    remotes.push({ chain: name, rpc: url, token, deployed, supplyUBA: supply?.toString() ?? null,
      supplyFXRP: supply !== null ? ubaToUnits(supply) : null, error: err });
    const cell = supply !== null ? fmt(ubaToUnits(supply)).padStart(12) + ' FXRP'
      : deployed === false ? '  no FXRP deployment at the OFT address'
      : `  UNREACHABLE — ${err ? err.slice(0, 60) : 'no answer'}`;
    console.log(`        ${name.padEnd(11)}${cell}`);
  }
  const unreachable = remotes.filter((r) => r.deployed === null);
  const reached = remotes.filter((r) => r.supplyUBA !== null);
  const remoteTotal = reached.reduce((s, r) => s + BigInt(r.supplyUBA), 0n);
  // Reachability is the assertion, not deployment. A chain that answers and has no FXRP
  // contributes a true zero; a chain that does not answer would understate the total silently.
  check('every remote OFT venue answers', unreachable.length === 0,
    `${remotes.length - unreachable.length}/${remotes.length} chains answered, ` +
    `${reached.length} carry an FXRP deployment` +
    (unreachable.length ? ` — unreachable: ${unreachable.map((r) => r.chain).join(', ')}` : ''));

  // The invariant is per-block: locked on Flare == the sum of remote supply at the SAME moment.
  // The remotes are read at their heads, so the head reading is the one that can close, and it
  // closes exactly. Comparing them to the pin instead produces a nonzero number that measures
  // elapsed bridging, not a discrepancy — so both are reported and only the matched-time one
  // is asserted.
  const gapHead = lockedHeadUBA - remoteTotal;
  const gapPin = lockedUBA - remoteTotal;
  const gapHeadPct = Math.abs(pct(remoteTotal, lockedHeadUBA));
  // Asserted as a tight band rather than exact equality: lockedHeadUBA and the five remote
  // supplies are seven separate reads at seven instants, so one bridge transaction landing
  // mid-sweep moves the sum honestly. A band survives that; exact equality would flake and
  // teach the reader to ignore a red check. When it does close exactly, say so.
  check('remote OFT supply reconciles to the adapter locked balance at matched time',
    unreachable.length === 0 && gapHeadPct < 0.01,
    `remote ${fmt(ubaToUnits(remoteTotal))} vs locked-at-head ${fmt(ubaToUnits(lockedHeadUBA))} = ` +
    `gap ${gapHead} UBA (${gapHeadPct.toFixed(4)}%)` +
    (gapHead === 0n ? ' — exact to the UBA' : ' — inside 1 bip, a mid-sweep bridge tx'));
  // Stated, not asserted: this is a cross-time estimate.
  console.log(`        against the pin instead: gap ${fmt(ubaToUnits(gapPin))} FXRP ` +
    `(${Math.abs(pct(remoteTotal, lockedUBA)).toFixed(4)}%) — ${fmt(ubaToUnits(bridgedSincePin))} FXRP ` +
    `bridged out in the ${fmt(head - PIN)} blocks since. A cross-time artifact, not a discrepancy.`);
  out.facts.oft.remotes = remotes;
  out.facts.oft.remoteTotalUBA = remoteTotal.toString();
  out.facts.oft.reconciliationGapHeadUBA = gapHead.toString();
  out.facts.oft.reconciliationGapPinUBA = gapPin.toString();

  // ============================================================================
  // 7. DEX pool reserves, exit vs correlated, slippage curve
  //    A rotation is not an exit. The pair is classified by reading token0/token1
  //    and asking whether both sides are XRP — not by trusting a constant's name.
  // ============================================================================
  hr('7. DEX DEPTH — exit venues vs rotations');

  const pools = [];
  for (const pool of POOL_CANDIDATES) {
    const t0r = await M.probe(pool, SEL.token0, at);
    const t1r = await M.probe(pool, SEL.token1, at);
    if (!t0r || !t1r) { console.log(`        ${pool}  not a pool at the pin — skipped`); continue; }
    const t0 = ad(t0r, 0), t1 = ad(t1r, 0);
    const isF = (t) => lc(t) === lc(FXRP);
    if (!isF(t0) && !isF(t1)) { console.log(`        ${pool}  holds no FXRP — skipped`); continue; }
    const quote = isF(t0) ? t1 : t0;
    const qSym = (await symbolOf(M, quote, at)) || '?';
    const qDecRaw = await numAt(M, quote, SEL.decimals, at);
    const correlated = XRP_CORRELATED.test(qSym);
    const fxrpSide = await numAt(M, FXRP, SEL.balanceOf + enc(pool), at);
    const qRaw = await numAt(M, quote, SEL.balanceOf + enc(pool), at);
    // A token that answers token0/token1 but not decimals/balanceOf is not readable depth.
    // Skipping it loudly beats decoding null into a zero that silently lowers the total.
    if (qDecRaw === null || fxrpSide === null || qRaw === null) {
      console.log(`        ${pool}  quote token unreadable at the pin — skipped`);
      continue;
    }
    const qDec = Number(qDecRaw);
    // Normalise the quote side to FXRP's 6 decimals, exactly as _readPools does.
    const qSide = qDec >= 6 ? qRaw / 10n ** BigInt(qDec - 6) : qRaw * 10n ** BigInt(6 - qDec);
    pools.push({ pool, quoteToken: quote, quoteSymbol: qSym, quoteDecimals: qDec, correlated,
      fxrpSideUBA: fxrpSide.toString(), quoteSideUBA: qSide.toString() });
    console.log(`        ${pool}  FXRP/${qSym.padEnd(6)} ${fmt(ubaToUnits(fxrpSide)).padStart(11)} FXRP` +
      `  ${correlated ? 'CORRELATED -> contributes 0' : 'exit venue'}`);
  }
  check('exit pools classified by reading token0/token1, not by name', pools.length >= 4,
    `${pools.length} FXRP pools, ${pools.filter((p) => p.correlated).length} correlated`);

  const dexExitUBA = pools.filter((p) => !p.correlated).reduce((s, p) => s + BigInt(p.fxrpSideUBA), 0n);
  const dexQuoteUBA = pools.filter((p) => !p.correlated).reduce((s, p) => s + BigInt(p.quoteSideUBA), 0n);
  const correlatedUBA = pools.filter((p) => p.correlated).reduce((s, p) => s + BigInt(p.fxrpSideUBA), 0n);
  // The deepest pool being excluded is the finding, not a rounding detail.
  check('the deepest FXRP pool is the correlated one and is excluded',
    correlatedUBA > dexExitUBA,
    `correlated ${fmt(ubaToUnits(correlatedUBA))} FXRP excluded vs ${fmt(ubaToUnits(dexExitUBA))} FXRP counted`);
  check('uncorrelated depth matches the Phase 2 recorded value',
    dexExitUBA.toString() === '1684853279972' || Math.abs(pct(dexExitUBA, 1684853279972n)) < 1,
    `${dexExitUBA} UBA (uncorrelated exit depth)`);
  // The quote side is what _readPools normalises to 6 decimals. Checking it separately catches
  // a decimals mistake that the FXRP side alone would not — an 18-decimal assumption here
  // prints a number 1e12 too large and nothing else notices.
  check('uncorrelated quote-side depth matches the Phase 2 recorded value',
    dexQuoteUBA.toString() === '1192547828650' || Math.abs(pct(dexQuoteUBA, 1192547828650n)) < 1,
    `${dexQuoteUBA} UBA normalised to 6 dp`);
  check('the correlated pool is the recorded FXRP/stXRP depth',
    correlatedUBA.toString() === '2319350567176' || Math.abs(pct(correlatedUBA, 2319350567176n)) < 1,
    `${correlatedUBA} UBA excluded as correlated depth`);
  out.facts.dex = { pools, dexExitUBA: dexExitUBA.toString(), dexQuoteUBA: dexQuoteUBA.toString(),
    correlatedExcludedUBA: correlatedUBA.toString() };

  // The slippage curve. Same integer arithmetic as _clearingPPM, so the reader can be
  // checked against the contract rather than merely resembling it.
  //
  // coreVaultUBA is availableFunds() ALONE, matching poke()'s `cvFlare`
  // (ExitCapacityOracle.sol:279). Escrowed funds are condition-gated on the XRPL: reachable
  // eventually, which _timeToExit prices as days, and not capacity available now. Folding
  // them in would inflate exitCapacity 16x — the one forbidden direction.
  //
  // TWO states, because Phase 2 measured two and they are not interchangeable:
  //   baseline — exitPools unregistered, dexExitUBA = 0. What a fresh poke() leaves, and the
  //              state the 999,992 ppm agreement was measured in (phase2-results.json
  //              "dexExitUBA": "0").
  //   withDex  — the pools above registered. Raises capacity to 10,596,613,708,126.
  const baseline = { effectiveQueueUBA: onChainEffective, coreVaultUBA: cvAvail, dexExitUBA: 0n };
  const withDex = { ...baseline, dexExitUBA };
  const capBaseline = baseline.effectiveQueueUBA + baseline.coreVaultUBA;
  const capWithDex = capBaseline + dexExitUBA;

  const SIZES = [10_000n, 100_000n, 500_000n, 1_000_000n, 5_000_000n, 10_000_000n, 50_000_000n];
  const curveFor = (st) => SIZES.map((n) => {
    const amt = n * 1_000_000n;
    return { sizeFXRP: Number(n), clearingPPM: Number(clearingPPM(amt, st)),
      timeToExitSeconds: Number(timeToExit(amt, st)) };
  });
  const curve = curveFor(baseline);
  const curveDex = curveFor(withDex);
  console.log('\n            size FXRP   clearing ppm   with DEX   time to exit');
  for (let i = 0; i < curve.length; i++) {
    console.log(`        ${fmt(curve[i].sizeFXRP).padStart(12)}   ${fmt(curve[i].clearingPPM).padStart(12)}` +
      `   ${fmt(curveDex[i].clearingPPM).padStart(8)}   ${fmt(curve[i].timeToExitSeconds).padStart(10)}s`);
  }

  const refPPM = Number(clearingPPM(MODEL.referenceSizeUBA, baseline));
  const refPPMDex = Number(clearingPPM(MODEL.referenceSizeUBA, withDex));
  const storedPPM = Number(storedHaircutPPM(baseline));
  check('the stored haircut is the floored value getUnderlyingPrice multiplies by',
    storedPPM === refPPM && storedPPM > Number(MODEL.minHaircutPPM),
    `${fmt(storedPPM)} ppm — above the ${fmt(Number(MODEL.minHaircutPPM))} floor, so the floor is inactive here`);
  check('clearing price falls monotonically with size',
    curve.every((p, i) => i === 0 || p.clearingPPM <= curve[i - 1].clearingPPM),
    `${curve[0].clearingPPM} ppm at 10k down to ${curve[curve.length - 1].clearingPPM} ppm at 50M`);
  check('no exit is instant — even the smallest size waits for agent settlement',
    curve[0].timeToExitSeconds >= MODEL.queueSettleSeconds,
    `${curve[0].timeToExitSeconds}s at 10k FXRP`);
  check('timeToExit reproduces the three recorded tiers',
    curve[0].timeToExitSeconds === 1800 &&
      Number(timeToExit(8_000_000n * 1_000_000n, baseline)) === 88_200 &&
      Number(timeToExit(500_000_000n * 1_000_000n, baseline)) === 5_272_200,
    '1,800s in queue / 88,200s reaching the vault / 5,272,200s beyond');
  check('haircut at the 1M reference size reproduces the Phase 2 measurement',
    refPPM === 999_992,
    `${fmt(refPPM)} ppm — measured at the pinned block`);
  check('clearing price at 50M reproduces the Phase 2 measurement',
    curve[curve.length - 1].clearingPPM === 997_526,
    `${fmt(curve[curve.length - 1].clearingPPM)} ppm — measured at the pinned block`);
  check('exitCapacity without DEX reproduces the Phase 2 measurement',
    capBaseline.toString() === '8911760428154',
    `${capBaseline} UBA (${fmt(ubaToUnits(capBaseline))} FXRP) — records 8,911,760,428,154`);
  check('exitCapacity with DEX reproduces the Phase 2 measurement',
    capWithDex.toString() === '10596613708126',
    `${capWithDex} UBA (${fmt(ubaToUnits(capWithDex))} FXRP) — records 10,596,613,708,126`);
  // Honest finding, surfaced rather than buried: _clearingPPM fills the DEX slice with
  // min(amount, dexExitUBA) unconditionally, so registering pools *raises* exitCapacity while
  // *lowering* the reference haircut — constant product charges x/(x+dx) for 1M against a
  // 1.68M reserve. The contract comment says "fill from the DEX until it stops being cheaper
  // than redeeming"; the code does not yet make that comparison. Phase 2 measured the haircut
  // at dexExitUBA = 0, so nothing recorded is wrong — but a market that registers pools gets
  // a different number, and choosing between them is a Phase 4 decision, not a reader's.
  check('registering pools raises capacity and tightens the reference haircut — flagged, not hidden',
    capWithDex > capBaseline && refPPMDex < refPPM,
    `capacity +${fmt(ubaToUnits(dexExitUBA))} FXRP, reference haircut ${fmt(refPPM)} -> ` +
    `${fmt(refPPMDex)} ppm (DEX slice filled unconditionally — Phase 4 decides)`);
  out.facts.exitModel = {
    constants: { ...MODEL, escrowReleasePerDayUBA: MODEL.escrowReleasePerDayUBA.toString(),
      discountRatePPMPerYear: Number(MODEL.discountRatePPMPerYear),
      minHaircutPPM: Number(MODEL.minHaircutPPM),
      referenceSizeUBA: MODEL.referenceSizeUBA.toString() },
    effectiveQueueUBA: baseline.effectiveQueueUBA.toString(),
    coreVaultUBA: baseline.coreVaultUBA.toString(),
    dexExitUBA: dexExitUBA.toString(),
    exitCapacityUBA: capBaseline.toString(),
    exitCapacityWithDexUBA: capWithDex.toString(),
    haircutPPMAtReference: refPPM,
    haircutPPMAtReferenceWithDex: refPPMDex,
    storedHaircutPPM: storedPPM,
    curve,
    curveWithDex: curveDex,
  };

  // ============================================================================
  // 8. Reconcile: queue + CV available + CV escrowed vs FXRP total supply
  // ============================================================================
  hr('8. BACKING RECONCILIATION');

  const backing = queueTotal + cvAvail + cvEsc;
  const drift = pct(backing, totalSupply);
  check('backing reconciles under 0.02% drift',
    Math.abs(drift) < 0.02,
    `queue ${fmt(ubaToUnits(queueTotal))} + available ${fmt(ubaToUnits(cvAvail))} + escrowed ` +
    `${fmt(ubaToUnits(cvEsc))} = ${fmt(ubaToUnits(backing))} vs supply ${fmt(ubaToUnits(totalSupply))} ` +
    `-> ${drift.toFixed(6)}%`);
  // Cross-chain is inside supply, not additional to it: the adapter's locked FXRP is part of
  // totalSupply already. Stating it here stops the OFT figure being double-counted downstream.
  check('remote claims are inside total supply, not additional to it', lockedUBA < totalSupply,
    `${fmt(ubaToUnits(lockedUBA))} locked is ${shareOfSupply.toFixed(2)}% of the ${fmt(ubaToUnits(totalSupply))} supply`);
  check('queue history reconciles with the live queue',
    requests.length > performed.length && performed.length + defaults.length <= requests.length,
    `${fmt(requests.length)} requested, ${fmt(performed.length)} performed, ${defaults.length} defaulted, ` +
    `${tickets.length} tickets open now`);
  out.facts.reconciliation = {
    backingUBA: backing.toString(), totalSupplyUBA: totalSupply.toString(), driftPct: drift,
  };

  // ============================================================================
  //  Collection pass output — what the Phase 3 publisher consumes
  // ============================================================================
  hr('PHASE 1 SUMMARY');

  const readers = {
    generatedAt: new Date().toISOString(),
    network: 'flare-mainnet', block: PIN, blockTimestamp: nowTs, blockISO: fork.forkBlockISO,
    readOnly: true,
    resolved: out.resolved,
    queue: out.facts.queue,
    liveness: out.facts.liveness,
    coreVault: out.facts.coreVault,
    oft: out.facts.oft,
    dex: out.facts.dex,
    exitModel: out.facts.exitModel,
    reconciliation: out.facts.reconciliation,
    history: out.facts.history,
    // The publisher's one decision, precomputed here: attest only when XRPL and Flare
    // disagree past the threshold, never on a timer. 20 FLR a request is real money.
    divergence: {
      thresholdUBA: '100000000000',
      observedUBA: out.facts.coreVault.divergenceUBA,
      attestable: out.facts.coreVault.divergenceUBA !== null &&
        BigInt(out.facts.coreVault.divergenceUBA) < -100_000n * 1_000_000n,
      note: 'Only a divergence that LOWERS capacity is attestable — attested state is one-directional.',
    },
  };
  fs.writeFileSync(path.join(ROOT, 'readers.json'), JSON.stringify(readers, null, 2));

  const failed = out.checks.filter((c) => !c.pass);
  console.log(`  ${out.checks.length - failed.length}/${out.checks.length} checks passed`);
  for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
  out.generatedAt = new Date().toISOString();
  out.forkBlock = PIN;
  fs.writeFileSync(path.join(ROOT, 'phase1-results.json'), JSON.stringify(out, null, 2));
  console.log('\n  wrote phase1-results.json, readers.json, cache-redemption-events.json');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('\nFATAL', e.message); process.exit(1); });





