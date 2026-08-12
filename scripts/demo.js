#!/usr/bin/env node
/**
 * npm run demo — serve demo/ over http.
 *
 * A static file server and nothing else. It exists because a browser will
 * not fetch ../phase4-results.json from a file:// page, not because the
 * demo needs a backend: every number on the page is read by the browser
 * straight from Flare mainnet and the XRP Ledger.
 *
 * Dependency-free, like everything else here. No node_modules, ever.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

/* Only these are reachable. The repo holds no secrets — there is no funded
   key anywhere in this build — but a server that will hand out any file
   under its root is a bad habit regardless of what is in the directory. */
const ALLOW = new Set([
  'demo/index.html', 'demo/app.js', 'demo/style.css', 'demo/snapshot.json', 'demo/favicon.svg', 'demo/herkos-mark.svg', 'demo/flare-mark.svg',
  'testnet/index.html', 'testnet/app.js', 'testnet/style.css', 'testnet/contracts.json',
  'docs/index.html', 'docs/technical.html', 'docs/privacy.html', 'docs/terms.html', 'docs/docs.css',
  'README.md', 'Writeup1.md', 'src/ExitCapacityOracle.sol', 'src/Coston2SpotOracle.sol',
  'src/Coston2LendingMarket.sol', 'deployments/coston2.json', 'scripts/verify-coston2.js',
]);

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  if (rel === '' || rel === 'demo' || rel === 'demo/') rel = 'demo/index.html';
  if (rel === 'testnet' || rel === 'testnet/') rel = 'testnet/index.html';
  if (rel === 'docs' || rel === 'docs/') rel = 'docs/index.html';

  // The root URL is a convenience alias for demo/index.html. Its relative
  // stylesheet and script requests arrive as /style.css and /app.js, so map
  // those two safe assets back into demo/ as well.
  const servedRel = /^(app\.js|style\.css|snapshot\.json|favicon\.svg|herkos-mark\.svg|flare-mark\.svg)$/.test(rel) ? `demo/${rel}` : rel;
  const full = path.resolve(ROOT, servedRel);
  const norm = path.relative(ROOT, full).split(path.sep).join('/');

  if (norm.startsWith('..') || path.isAbsolute(norm) || !ALLOW.has(norm)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`
  Herkos public preview   →  http://localhost:${PORT}/

  Reads live from Flare mainnet and the XRP Ledger, in the browser.
  Read-only: the page never sends a transaction and never asks for a wallet.
`);
});
