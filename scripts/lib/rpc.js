// Minimal JSON-RPC + ABI codec. No dependencies — see scripts/lib/k.js for why.
// Every call here is eth_call / eth_getLogs / plain HTTPS. Nothing signs, nothing broadcasts.
const { topic, sel } = require('./k.js');

const RPC_MAINNET = process.env.RPC_URL || 'https://flare-api.flare.network/ext/C/rpc';
const RPC_C2      = process.env.C2_RPC  || 'https://coston2-api.flare.network/ext/C/rpc';

// ---------- encoders ----------
// One 32-byte word. Accepts a bigint/number, or a hex string (address, bytes32).
const enc = (v) => (typeof v === 'string' ? v.replace(/^0x/, '').toLowerCase() : v.toString(16)).padStart(64, '0');

// ---------- decoders ----------
// `d` is return data as an 0x-prefixed hex string; `i` is a word index.
const word = (d, i) => d.slice(2 + i * 64, 2 + (i + 1) * 64);
const u    = (d, i) => BigInt('0x' + word(d, i));
const ad   = (d, i) => '0x' + word(d, i).slice(24);

// Dynamic `string` / `bytes` whose head slot is `i`. Offsets are byte counts from `base`.
function strAt(d, i, base = 0) {
  const p = base + Number(u(d, i)) / 32;
  const len = Number(u(d, p));
  return Buffer.from(d.slice(2 + (p + 1) * 64, 2 + (p + 1) * 64 + len * 2), 'hex').toString('utf8');
}
// `address[]` at head slot `i`.
function addrArrayAt(d, i, base = 0) {
  const p = base + Number(u(d, i)) / 32;
  return Array.from({ length: Number(u(d, p)) }, (_, k) => ad(d, p + 1 + k));
}
// `string[]` at head slot `i`. Element offsets are relative to the array's first element slot.
function strArrayAt(d, i, base = 0) {
  const p = base + Number(u(d, i)) / 32;
  const len = Number(u(d, p));
  return Array.from({ length: len }, (_, k) => strAt(d, p + 1 + k, p + 1));
}

// ---------- client ----------
function client(url = RPC_MAINNET) {
  let n = 0;
  async function rpc(method, params, ms = 25000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
        signal: c.signal,
      });
      const j = await res.json();
      if (j.error) {
        const e = new Error(`${method}: ${j.error.message}`);
        // Revert data carries the custom-error selector. Dropping it turns a precise
        // WrongSubject into an opaque "execution reverted", so keep it on the Error.
        e.code = j.error.code;
        e.data = typeof j.error.data === 'string' ? j.error.data : j.error.data?.data ?? null;
        throw e;
      }
      return j.result;
    } finally { clearTimeout(t); }
  }
  return {
    url, rpc,
    call: (to, data, block = 'latest') => rpc('eth_call', [{ to, data }, block]),
    estimateGas: (to, data, from) => rpc('eth_estimateGas', [{ to, data, ...(from ? { from } : {}) }]),
    blockNumber: async () => Number(await rpc('eth_blockNumber', [])),
    getBlock: (b, full = false) =>
      rpc('eth_getBlockByNumber', [typeof b === 'number' ? '0x' + b.toString(16) : b, full]),
    getStorageAt: (addr, slot, block = 'latest') =>
      rpc('eth_getStorageAt', [addr, slot, typeof block === 'number' ? '0x' + block.toString(16) : block]),
    getCode: (addr, block = 'latest') =>
      rpc('eth_getCode', [addr, typeof block === 'number' ? '0x' + block.toString(16) : block]),
    // A probe that returns null instead of throwing. Docs have been wrong five times;
    // an absent function is a result, not a crash.
    probe: async (to, data, block = 'latest') => {
      try {
        const r = await rpc('eth_call', [{ to, data }, block]);
        return r && r !== '0x' ? r : null;
      } catch { return null; }
    },
  };
}

// ---------- plain HTTPS (explorer, DA Layer) ----------
async function jget(url, ms = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: c.signal });
    return r.status === 404 ? null : await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// Canonical event/function signature from an ABI item, so topic0 can be recomputed
// and compared against what the deployed contract actually emits.
const canon = (it) => {
  const t = (i) => (i.components ? '(' + i.components.map(t).join(',') + ')' + i.type.slice(5) : i.type);
  return `${it.name}(${(it.inputs || []).map(t).join(',')})`;
};

const fmt = (x, dp = 0) => Number(x).toLocaleString('en-US', { maximumFractionDigits: dp });
// FXRP and the vault collateral stablecoins are 6 decimals. An 18-decimal
// assumption silently prints zeros — keep the asset precision explicit.
const ubaToUnits = (v) => Number(v) / 1e6;

module.exports = {
  RPC_MAINNET, RPC_C2, client, topic, sel, enc,
  word, u, ad, strAt, addrArrayAt, strArrayAt,
  jget, canon, fmt, ubaToUnits,
};
