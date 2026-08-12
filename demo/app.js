'use strict';

/* The public page has two deliberately separate data surfaces:
   - live signals, all read at one Flare block;
   - a pinned lending-market snapshot, loaded from snapshot.json.
   They are never numerically compared across time. */

const FLARE_RPC = 'https://flare-api.flare.network/ext/C/rpc';
const XRPL_RPC = 'https://xrplcluster.com/';
const REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';
const OFT_ADAPTER = '0xd70659a6396285BF7214d7Ea9673184e7C72E07E';
const CFXRP = '0xD1b7A5eFa9bd88F291F7A4563a8f6185c0249CB3';
const POOLS = [
  '0x2a91D9296ee2fe4139b49c7071b2f29f59a9f9aE',
  '0x927485d88a66253c63Af9163dca5f21c25A57393',
  '0x686f53F0950Ef193C887527eC027E6A574A4DbE1',
  '0x88D46717b16619B37fa2DfD2F038DEFB4459F1F7',
];
const STXRP = '0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3';
const XRP_CORRELATED = /^(stXRP|wXRP|XRP|FXRP|rlusdXRP)$/i;
const EXPECT = {
  assetManager: '0x2a3fe068cd92178554cabcf7c95adf49b4b0b6a8',
  fxrp: '0xad552a648c74d49e10027ab8a618a3ad4901c5be',
  coreVaultManager: '0x6c8d96defe4cbee05fa969fc0ac436d94fc21784',
};
const S = {
  getAllContracts: '0x18d3ce96', getAssetManagers: '0xb87b82f0', fAsset: '0x7c7db1a5',
  redemptionQueue: '0x91a76c40', getAgentInfo: '0x152052b0', getCoreVaultManager: '0xa2785a71',
  coreVaultAddress: '0x7a1077ea', availableFunds: '0x46fcff4c', escrowedFunds: '0xf0ec77fa',
  balanceOf: '0x70a08231', totalSupply: '0x18160ddd', token0: '0x0dfe1681', token1: '0xd21220a7',
  decimals: '0x313ce567', symbol: '0x95d89b41', comptroller: '0x5fe3b567', oracle: '0x7dc0d1d0',
  getUnderlyingPrice: '0xfc57d4df', exchangeRateStored: '0x182df0f5',
};

let rpcId = 0;
let liveBlock = 0;
let liveTag = 'latest';
const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const money6 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 6, maximumFractionDigits: 6 });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error('network read unavailable');
  const json = await res.json();
  if (json.error) throw new Error('network read unavailable');
  return json.result;
}

function pad(value) { return BigInt(value).toString(16).padStart(64, '0'); }
function encU(value) { return pad(value); }
function encA(address) { return address.toLowerCase().replace(/^0x/, '').padStart(64, '0'); }
function word(hex, index) {
  const body = String(hex || '').replace(/^0x/, '');
  const start = index * 64;
  const part = body.slice(start, start + 64);
  if (part.length < 64) throw new Error('network response unavailable');
  return BigInt(`0x${part}`);
}
function addr(hex, index) { return `0x${word(hex, index).toString(16).padStart(40, '0')}`; }
function strAtWord(hex, index) {
  const body = String(hex || '').replace(/^0x/, '');
  const length = Number(word(hex, index));
  const data = body.slice((index + 1) * 64, (index + 1) * 64 + Math.ceil(length / 32) * 64);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}
function str(hex, index) { return strAtWord(hex, Number(word(hex, index)) / 32); }
function strElem(hex, base, index) {
  return strAtWord(hex, base + 1 + Number(word(hex, base + 1 + index)) / 32);
}
function symbolOf(raw) {
  try { return str(raw, 0); } catch {
    const body = String(raw || '').replace(/^0x/, '').slice(0, 64).replace(/(00)+$/, '');
    let out = '';
    for (let i = 0; i < body.length; i += 2) out += String.fromCharCode(parseInt(body.slice(i, i + 2), 16));
    return out;
  }
}
function fxrp(value, decimals = 0) {
  const number = Number(BigInt(value)) / 1e6;
  return number.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function units(value, decimals = 0) {
  return (Number(BigInt(value)) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function formatSize(value) {
  const number = Number(value);
  if (number >= 1e6) return `${(number / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })}M`;
  if (number >= 1e3) return `${(number / 1e3).toLocaleString('en-US', { maximumFractionDigits: 0 })}K`;
  return nf.format(number);
}
function formatTime(seconds) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setStatus(id, state, text) {
  const node = $(id);
  if (!node) return;
  node.className = `status ${state}`;
  node.textContent = text;
}
function setText(id, text) { if ($(id)) $(id).textContent = text; }

async function atCurrentBlock() {
  const raw = await rpc(FLARE_RPC, 'eth_blockNumber', []);
  liveBlock = Number(BigInt(raw));
  liveTag = `0x${liveBlock.toString(16)}`;
}
function call(to, data) { return rpc(FLARE_RPC, 'eth_call', [{ to, data }, liveTag]); }

async function resolveContracts() {
  const raw = await call(REGISTRY, S.getAllContracts);
  const namesBase = Number(word(raw, 0)) / 32;
  const addressesBase = Number(word(raw, 1)) / 32;
  const names = [];
  const addresses = [];
  for (let i = 0; i < Number(word(raw, namesBase)); i++) names.push(strElem(raw, namesBase, i));
  for (let i = 0; i < Number(word(raw, addressesBase)); i++) addresses.push(addr(raw, addressesBase + 1 + i));
  const find = (name) => {
    const index = names.findIndex((item) => item.toLowerCase() === name.toLowerCase());
    return index < 0 ? null : addresses[index];
  };
  const controller = find('AssetManagerController');
  if (!controller) throw new Error('registry unavailable');
  const managers = await call(controller, S.getAssetManagers);
  const count = Number(word(managers, 1));
  let assetManager;
  let fxrpAddress;
  for (let i = 0; i < count; i++) {
    const candidate = addr(managers, 2 + i);
    const candidateFxrp = addr(await call(candidate, S.fAsset), 0);
    if (symbolOf(await call(candidateFxrp, S.symbol)).toUpperCase() === 'FXRP') {
      assetManager = candidate;
      fxrpAddress = candidateFxrp;
      break;
    }
  }
  if (!assetManager) throw new Error('FXRP market unavailable');
  const coreVaultManager = addr(await call(assetManager, S.getCoreVaultManager), 0);
  if (assetManager.toLowerCase() !== EXPECT.assetManager || fxrpAddress.toLowerCase() !== EXPECT.fxrp || coreVaultManager.toLowerCase() !== EXPECT.coreVaultManager) {
    throw new Error('market identity changed');
  }
  return { assetManager, fxrp: fxrpAddress, coreVaultManager, relay: find('Relay') };
}

async function walkQueue(assetManager) {
  let cursor = 0n;
  let pages = 0;
  const tickets = [];
  while (pages < 40) {
    const raw = await call(assetManager, `${S.redemptionQueue}${encU(cursor)}${encU(100)}`);
    const base = Number(word(raw, 0)) / 32;
    const length = Number(word(raw, base));
    for (let i = 0; i < length; i++) {
      const offset = base + 1 + i * 3;
      tickets.push({ agent: addr(raw, offset + 1), uba: word(raw, offset + 2) });
    }
    cursor = word(raw, 1);
    pages++;
    if (cursor === 0n || length === 0) break;
  }
  const agents = [...new Set(tickets.map((item) => item.agent.toLowerCase()))];
  return { tickets, agents, pages, totalUBA: tickets.reduce((sum, item) => sum + item.uba, 0n) };
}
async function agentIsLive(assetManager, agent) {
  try { return word(await call(assetManager, `${S.getAgentInfo}${encA(agent)}`), 1) <= 1n; } catch { return false; }
}
async function readPools(fxrpAddress) {
  const pools = [];
  for (const pool of POOLS) {
    try {
      const [token0Raw, token1Raw] = await Promise.all([call(pool, S.token0), call(pool, S.token1)]);
      const token0 = addr(token0Raw, 0).toLowerCase();
      const token1 = addr(token1Raw, 0).toLowerCase();
      const fxrpIs0 = token0 === fxrpAddress.toLowerCase();
      if (!fxrpIs0 && token1 !== fxrpAddress.toLowerCase()) continue;
      const quote = fxrpIs0 ? token1 : token0;
      const [fxrpRaw, quoteRaw, decimalsRaw, symbolRaw] = await Promise.all([
        call(fxrpAddress, `${S.balanceOf}${encA(pool)}`),
        call(quote, `${S.balanceOf}${encA(pool)}`),
        call(quote, S.decimals),
        call(quote, S.symbol),
      ]);
      const quoteSymbol = symbolOf(symbolRaw);
      pools.push({
        fxrpSide: word(fxrpRaw, 0),
        quoteSide: word(quoteRaw, 0),
        quoteDecimals: Number(word(decimalsRaw, 0)),
        quoteSymbol,
        correlated: quote.toLowerCase() === STXRP.toLowerCase() || XRP_CORRELATED.test(quoteSymbol),
      });
    } catch { /* one unavailable venue does not erase the rest of the read */ }
  }
  return pools;
}

async function readLiveData(contracts) {
  const [queue, supplyRaw, remoteRaw, cSupplyRaw, rateRaw, coreAvailableRaw, coreEscrowedRaw, pools] = await Promise.all([
    walkQueue(contracts.assetManager),
    call(contracts.fxrp, S.totalSupply),
    call(contracts.fxrp, `${S.balanceOf}${encA(OFT_ADAPTER)}`),
    call(CFXRP, S.totalSupply),
    call(CFXRP, S.exchangeRateStored),
    call(contracts.coreVaultManager, S.availableFunds),
    call(contracts.coreVaultManager, S.escrowedFunds),
    readPools(contracts.fxrp),
  ]);
  const supplyUBA = word(supplyRaw, 0);
  const remoteUBA = word(remoteRaw, 0);
  const collateralUBA = (word(cSupplyRaw, 0) * word(rateRaw, 0)) / 10n ** 18n;
  const liveFlags = await Promise.all(queue.agents.map((agent) => agentIsLive(contracts.assetManager, agent)));
  const liveSet = new Set(queue.agents.filter((_, index) => liveFlags[index]));
  const effectiveQueueUBA = queue.tickets.filter((item) => liveSet.has(item.agent.toLowerCase())).reduce((sum, item) => sum + item.uba, 0n);
  const coreAvailableUBA = word(coreAvailableRaw, 0);
  const coreEscrowedUBA = word(coreEscrowedRaw, 0);
  const dexExitUBA = pools.filter((pool) => !pool.correlated).reduce((sum, pool) => sum + pool.fxrpSide, 0n);
  const correlatedUBA = pools.filter((pool) => pool.correlated).reduce((sum, pool) => sum + pool.fxrpSide, 0n);
  return {
    block: liveBlock,
    supplyUBA,
    remoteUBA,
    collateralUBA,
    queue,
    liveAgents: liveFlags.filter(Boolean).length,
    effectiveQueueUBA,
    coreAvailableUBA,
    coreEscrowedUBA,
    dexExitUBA,
    correlatedUBA,
  };
}

async function readXrpl(coreVaultManager) {
  try {
    const address = str(await call(coreVaultManager, S.coreVaultAddress), 0);
    const ledgerCall = async (method, params) => {
      const response = await fetch(XRPL_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params: [params] }),
      });
      if (!response.ok) throw new Error('ledger unavailable');
      const json = await response.json();
      if (json.result?.status === 'error') throw new Error('ledger unavailable');
      return json.result;
    };
    const [info, objects] = await Promise.all([
      ledgerCall('account_info', { account: address, ledger_index: 'validated' }),
      ledgerCall('account_objects', { account: address, ledger_index: 'validated', type: 'escrow', limit: 400 }),
    ]);
    const escrows = (objects.account_objects || []).filter((item) => item.LedgerEntryType === 'Escrow');
    const conditionGated = escrows.filter((item) => Boolean(item.Condition)).length;
    return { address, ledger: info.ledger_index || info.ledger_current_index, escrowCount: escrows.length, conditionGated };
  } catch { return null; }
}
function setTrustStatus(id, ok, text) {
  const node = $(id);
  if (!node) return;
  node.className = `trust-status ${ok ? '' : 'unavailable'}`.trim();
  node.textContent = text;
}

function renderMetric(label, value, note) {
  return `<article class="metric-card"><span class="metric-label">${label}</span><strong class="metric-value">${value}</strong><span class="metric-note">${note}</span></article>`;
}
function renderSignal(label, value, percent, tone, detail) {
  return `<div class="signal-row"><div class="signal-label"><strong>${label}</strong><span>${value}, ${percent.toFixed(1)}% of collateral</span></div><div class="signal-track"><div class="signal-fill ${tone}" style="width:${Math.min(100, Math.max(0, percent))}%"></div></div><span class="metric-note">${detail}</span></div>`;
}
function renderLive(data, contracts, xrpl) {
  const collateral = Number(data.collateralUBA) || 1;
  const pct = (value) => Number(value) / collateral * 100;
  $('live-metrics').innerHTML = [
    renderMetric('FXRP waiting to exit', `${fxrp(data.queue.totalUBA)}`, 'open redemption requests'),
    renderMetric('Posted as lending collateral', `${fxrp(data.collateralUBA)}`, 'current cFXRP market'),
    renderMetric('Uncorrelated trading depth', `${fxrp(data.dexExitUBA)}`, 'FXRP to stable asset liquidity'),
    renderMetric('XRP available in Core Vault', `${fxrp(data.coreAvailableUBA)}`, 'available at this block'),
  ].join('');
  $('signal-bars').innerHTML = [
    renderSignal('Open redemption queue', fxrp(data.queue.totalUBA), pct(data.queue.totalUBA), 'slate', `${data.queue.tickets.length} open requests from ${data.queue.agents.length} agent vaults`),
    renderSignal('Active redemption queue', fxrp(data.effectiveQueueUBA), pct(data.effectiveQueueUBA), 'accent', `${data.liveAgents} of ${data.queue.agents.length} agent vaults responding`),
    renderSignal('Uncorrelated trading depth', fxrp(data.dexExitUBA), pct(data.dexExitUBA), 'amber', `${fxrp(data.correlatedUBA)} FXRP paired with XRP is excluded because it does not leave the XRP ecosystem`),
    renderSignal('Liquid Core Vault', fxrp(data.coreAvailableUBA), pct(data.coreAvailableUBA), 'slate', `${fxrp(data.coreEscrowedUBA)} XRP remains in escrow and is not immediately available`),
    renderSignal('FXRP held on other chains', fxrp(data.remoteUBA), pct(data.remoteUBA), 'red', 'held on Flare for users on other chains'),
  ].join('');
  $('live-summary').className = 'callout';
  $('live-summary').innerHTML = `At <strong>Flare block ${nf.format(data.block)}</strong>, the queue equals <strong>${pct(data.queue.totalUBA).toFixed(1)}%</strong> of current lending exposure. Uncorrelated trading depth equals <strong>${pct(data.dexExitUBA).toFixed(1)}%</strong>. This is a measured risk signal, not a prediction that FXRP will fail.`;
  $('live-freshness').textContent = `Flare block ${nf.format(data.block)}`;
  setStatus('live-status', 'success', `Live block ${nf.format(data.block)}`);
  setTrustStatus('flare-proof', true, `Read at block ${nf.format(data.block)}`);
  setTrustStatus('xrpl-proof', Boolean(xrpl), xrpl ? `Validated ledger ${nf.format(xrpl.ledger)}; ${xrpl.conditionGated} of ${xrpl.escrowCount} escrows gated` : 'Validated ledger unavailable');
}
function renderLiveUnavailable() {
  $('live-metrics').innerHTML = '<article class="metric-card unavailable"><span class="metric-label">Live network data</span><strong class="metric-value">Temporarily unavailable</strong><span class="metric-note">The pinned result below is still available.</span></article>';
  $('signal-bars').innerHTML = '';
  $('live-summary').className = 'callout warning';
  $('live-summary').textContent = 'Live Flare data is unavailable right now. No old values are being shown.';
  $('live-freshness').textContent = 'No live block available';
  $('retry-live').hidden = false;
  setStatus('live-status', 'warning', 'Live data unavailable');
  setTrustStatus('flare-proof', false, 'Live data unavailable');
  setTrustStatus('xrpl-proof', false, 'Live data unavailable');
}
async function loadLive() {
  $('retry-live').hidden = true;
  setStatus('live-status', 'neutral', 'Reading Flare network');
  try {
    await atCurrentBlock();
    const contracts = await resolveContracts();
    const [data, xrpl] = await Promise.all([readLiveData(contracts), readXrpl(contracts.coreVaultManager)]);
    renderLive(data, contracts, xrpl);
  } catch (error) {
    console.warn('Live data unavailable');
    renderLiveUnavailable();
  }
}

function renderSnapshot(snapshot) {
  const market = snapshot.market;
  const differenceBips = Math.abs(market.herkosPriceUSD - market.incumbentPriceUSD) / market.incumbentPriceUSD * 10000;
  const capacityDropPct = (1 - market.borrowCapacityAtStressUSD / market.borrowCapacityAtReferenceUSD) * 100;
  const snapshotDate = dateTime.format(new Date(snapshot.snapshotTimestamp));
  setText('hero-delta', `−${capacityDropPct.toFixed(1)}%`);
  setText('hero-accounts', `${nf.format(market.accountsMeasured)} measured`);
  setText('hero-shortfalls', `${nf.format(market.shortfallsAtStress)} accounts below limit`);
  setStatus('snapshot-label', 'snapshot-status', `Pinned block ${nf.format(snapshot.snapshotBlock)}`);
  $('stress-content').innerHTML = `
    <div class="comparison-grid">
      <article class="comparison-card"><p class="card-label">Existing oracle</p><strong>${money6.format(market.incumbentPriceUSD)}</strong><span>Same block: ${nf.format(snapshot.snapshotBlock)}</span></article>
      <article class="comparison-card featured"><p class="card-label">Herkos at ${formatSize(market.referenceSizeFXRP)} FXRP</p><strong>${money6.format(market.herkosPriceUSD)}</strong><span>Same block: ${nf.format(snapshot.snapshotBlock)}; haircut ${nf.format(market.haircutPPM)} ppm</span></article>
    </div>
    <div class="stress-result">
      <article class="stress-result-card"><h3>Larger exits reduce borrowing power</h3><span class="big-result">−${money.format(market.borrowCapacityAtReferenceUSD - market.borrowCapacityAtStressUSD)}</span><span class="small-result">Across ${nf.format(market.accountsMeasured)} measured accounts at ${formatSize(market.stressReferenceSizeFXRP)} FXRP</span><p class="callout">At a ${formatSize(market.referenceSizeFXRP)} FXRP exit size, Herkos is ${differenceBips.toFixed(2)} bips below the existing oracle. Both prices come from the same block.</p></article>
      <article class="stress-result-card capacity-compare"><h3>Borrowing capacity left</h3><div class="capacity-line"><span>At default size</span><div class="capacity-track"><span style="width:100%"></span></div><strong>${money.format(market.borrowCapacityAtReferenceUSD)}</strong></div><div class="capacity-line"><span>At ${formatSize(market.stressReferenceSizeFXRP)} exit size</span><div class="capacity-track stress"><span style="width:${(market.borrowCapacityAtStressUSD / market.borrowCapacityAtReferenceUSD * 100).toFixed(2)}%"></span></div><strong>${money.format(market.borrowCapacityAtStressUSD)}</strong></div><p class="metric-note">No measured account entered shortfall at this size.</p></article>
    </div>
    <p class="snapshot-note">${esc(snapshot.network)}. Block ${nf.format(snapshot.snapshotBlock)}. Captured ${snapshotDate}. This is an integration result, not a live protocol change.</p>`;
  $('ladder-body').innerHTML = snapshot.ladder.map((row) => `<tr><td>${formatSize(row.referenceSizeFXRP)} FXRP</td><td class="num">${money6.format(row.priceUSD)}</td><td class="num">${nf.format(row.haircutPPM)} ppm</td><td class="num">${formatTime(row.timeToExitSeconds)}</td><td class="num">${money.format(row.borrowCapacityUSD)}</td><td class="num">${row.shortfalls === 0 ? '0' : row.shortfalls}</td></tr>`).join('');
  setText('proof-reference', `Verified on the pinned fork. Transaction starts ${snapshot.proof.transaction.slice(0, 10)} and ends ${snapshot.proof.transaction.slice(-8)}. Block ${nf.format(snapshot.proof.block)}. Voting round ${nf.format(snapshot.proof.votingRound)}.`);
  const proofLink = $('proof-link');
  proofLink.href = `https://flare-explorer.flare.network/tx/${snapshot.proof.transaction}`;
  proofLink.hidden = false;
  setText('proof-status', 'Verified on pinned snapshot');
}
async function loadSnapshot() {
  try {
    const response = await fetch('snapshot.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('snapshot unavailable');
    renderSnapshot(await response.json());
  } catch (error) {
    console.warn('Snapshot unavailable');
    setStatus('snapshot-label', 'warning', 'Snapshot unavailable');
    $('stress-content').innerHTML = '<div class="callout warning">The pinned result is temporarily unavailable. The technical docs contain the evidence.</div>';
    $('ladder-body').innerHTML = '<tr><td colspan="6">Stress ladder unavailable.</td></tr>';
    setText('proof-reference', 'Proof details are unavailable in this build.');
  }
}

async function main() {
  $('retry-live').addEventListener('click', loadLive);
  await Promise.all([loadSnapshot(), loadLive()]);
}
main();
