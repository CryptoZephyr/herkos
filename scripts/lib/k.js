// Minimal keccak-256 (Ethereum variant, 0x01 padding, rate 136) — no dependencies.
// This file is why there is no `ethers` in this repo, and no node_modules at all.
// Verbatim copy of the research toolkit's k.js so both agree on every topic hash.
const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const PI  = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const RHO = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];

const rotl = (x, n) => ((x << n) | (x >> (64n - n))) & MASK;

function keccakf(s) {
  for (let round = 0; round < 24; round++) {
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= D;
    }
    let t = s[1];
    for (let i = 0; i < 24; i++) {
      const j = PI[i];
      const tmp = s[j];
      s[j] = rotl(t, BigInt(RHO[i]));
      t = tmp;
    }
    for (let y = 0; y < 25; y += 5) {
      const a = [s[y], s[y + 1], s[y + 2], s[y + 3], s[y + 4]];
      for (let x = 0; x < 5; x++) s[y + x] = a[x] ^ ((~a[(x + 1) % 5] & MASK) & a[(x + 2) % 5]);
    }
    s[0] ^= RC[round];
  }
}

function keccak256(buf) {
  const rate = 136;
  const padded = Buffer.alloc(Math.ceil((buf.length + 1) / rate) * rate);
  buf.copy(padded);
  padded[buf.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakf(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return '0x' + out.toString('hex');
}

const topic = (sig) => keccak256(Buffer.from(sig, 'utf8'));

module.exports = { keccak256, topic, sel: (sig) => topic(sig).slice(0, 10) };

if (require.main === module) {
  // Self-test against known values before trusting any output.
  const t = (s) => keccak256(Buffer.from(s, 'utf8'));
  const checks = [
    ['', '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['Transfer(address,address,uint256)', '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
  ];
  let ok = true;
  for (const [inp, want] of checks) {
    const got = t(inp);
    const pass = got === want;
    if (!pass) ok = false;
    console.log(`${pass ? 'PASS' : 'FAIL'}  keccak256("${inp}")\n      got  ${got}\n      want ${want}`);
  }
  console.log(ok ? '\n=== keccak self-test PASSED ===\n' : '\n=== keccak self-test FAILED — do not trust topics ===\n');
  if (!ok) process.exit(1);
}
