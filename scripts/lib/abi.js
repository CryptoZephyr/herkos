// Minimal ABI encoder/decoder. No dependencies — see scripts/lib/k.js for why.
//
// Phase 0 and Phase 1 only ever read flat return values, so scripts/lib/rpc.js gets by
// with word-indexed helpers (u/ad/strAt). Phase 3 cannot: it has to take an
// IXRPPayment.Proof out of somebody else's calldata and put the same struct back into
// its own, byte-identical, or the Merkle leaf changes and a real proof stops verifying.
// That needs a real head/tail coder with nested dynamic types, so here is one.
//
// Supported: uintN, intN, bool, address, bytesN, bytes, string, T[], T[k], and tuples
// written as (a,b,c). That is everything the FDC structs use and nothing more.

const pad = (h) => h.padStart(64, '0');
const W = (d, off) => d.slice(off * 2, off * 2 + 64);      // 32-byte word at a byte offset
const big = (h) => BigInt('0x' + h);

// ---------- type parsing ----------
// Split on top-level commas only: "(a,b),c[2]" is two types, not three.
function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}

function parseType(t) {
  t = t.trim();
  const arr = /^(.*)\[(\d*)\]$/.exec(t);
  if (arr) return { k: 'array', of: parseType(arr[1]), len: arr[2] ? Number(arr[2]) : -1 };
  if (t.startsWith('(')) return { k: 'tuple', of: splitTop(t.slice(1, -1)).map(parseType) };
  return { k: 'elem', t };
}

// Dynamic-ness decides head-vs-tail placement, and getting it wrong shifts every
// following field by one word — which decodes as plausible garbage rather than an error.
function isDyn(n) {
  if (n.k === 'array') return n.len < 0 || isDyn(n.of);
  if (n.k === 'tuple') return n.of.some(isDyn);
  return n.t === 'bytes' || n.t === 'string';
}

function staticSize(n) {
  if (isDyn(n)) return 32;                                  // an offset word stands in
  if (n.k === 'array') return n.len * staticSize(n.of);
  if (n.k === 'tuple') return n.of.reduce((a, c) => a + staticSize(c), 0);
  return 32;
}

// ---------- encode ----------
function encElem(t, v) {
  if (t === 'bool') return pad(v ? '1' : '0');
  if (t === 'address') return pad(String(v).replace(/^0x/, '').toLowerCase());
  if (/^bytes\d+$/.test(t)) return String(v).replace(/^0x/, '').toLowerCase().padEnd(64, '0');
  if (/^u?int\d*$/.test(t)) {
    let b = BigInt(v);
    if (b < 0n) b += 1n << 256n;                            // two's complement, int256 spentAmount
    return pad(b.toString(16));
  }
  throw new Error(`abi: unsupported elem type ${t}`);
}

function encNode(n, v) {
  if (n.k === 'elem') {
    if (n.t === 'bytes' || n.t === 'string') {
      const h = n.t === 'string'
        ? Buffer.from(String(v), 'utf8').toString('hex')
        : String(v).replace(/^0x/, '').toLowerCase();
      const len = h.length / 2;
      return { dyn: true, body: pad(len.toString(16)) + h.padEnd(Math.ceil(len / 32) * 64, '0') };
    }
    return { dyn: false, body: encElem(n.t, v) };
  }
  if (n.k === 'array') {
    const inner = packSeq(v.map((x) => encNode(n.of, x)));
    return n.len < 0
      ? { dyn: true, body: pad(v.length.toString(16)) + inner }
      : { dyn: isDyn(n), body: inner };
  }
  return { dyn: isDyn(n), body: packSeq(n.of.map((c, i) => encNode(c, v[i]))) };
}

// Heads first, then tails; a dynamic head holds the byte offset of its tail measured
// from the start of this block, not from the start of the message.
function packSeq(items) {
  let headLen = 0;
  for (const it of items) headLen += it.dyn ? 32 : it.body.length / 2;
  let head = '', tail = '';
  for (const it of items) {
    if (it.dyn) { head += pad((headLen + tail.length / 2).toString(16)); tail += it.body; }
    else head += it.body;
  }
  return head + tail;
}

function encode(types, values) {
  return '0x' + packSeq(types.map(parseType).map((n, i) => encNode(n, values[i])));
}

// ---------- decode ----------
function read(n, d, base, off) {
  if (n.k === 'elem') {
    const t = n.t;
    if (t === 'bytes' || t === 'string') {
      const p = base + Number(big(W(d, off)));
      const len = Number(big(W(d, p)));
      const raw = d.slice((p + 32) * 2, (p + 32) * 2 + len * 2);
      return t === 'string' ? Buffer.from(raw, 'hex').toString('utf8') : '0x' + raw;
    }
    const w = W(d, off);
    if (t === 'address') return '0x' + w.slice(24);
    if (t === 'bool') return big(w) !== 0n;
    if (/^bytes\d+$/.test(t)) return '0x' + w.slice(0, Number(t.slice(5)) * 2);
    if (/^uint\d*$/.test(t)) return big(w);
    if (/^int\d*$/.test(t)) { const x = big(w); return x >= 1n << 255n ? x - (1n << 256n) : x; }
    throw new Error(`abi: unsupported elem type ${t}`);
  }
  if (n.k === 'array') {
    if (n.len < 0) {
      const p = base + Number(big(W(d, off)));
      return readSeq(Array(Number(big(W(d, p)))).fill(n.of), d, p + 32);
    }
    const start = isDyn(n) ? base + Number(big(W(d, off))) : off;
    return readSeq(Array(n.len).fill(n.of), d, start);
  }
  const start = isDyn(n) ? base + Number(big(W(d, off))) : off;
  return readSeq(n.of, d, start);
}

// Offsets inside a block are relative to that block's own start, which is why `start`
// is threaded through as the base rather than reusing the caller's.
function readSeq(nodes, d, start) {
  const out = [];
  let off = start;
  for (const n of nodes) { out.push(read(n, d, start, off)); off += staticSize(n); }
  return out;
}

function decode(types, hex) {
  const d = (hex || '').replace(/^0x/, '');
  return readSeq(types.map(parseType), d, 0);
}

// Calldata is a 4-byte selector then a plain tuple encoding.
const decodeCalldata = (types, hex) => decode(types, '0x' + hex.replace(/^0x/, '').slice(8));

module.exports = { encode, decode, decodeCalldata, parseType, isDyn, staticSize, splitTop };
