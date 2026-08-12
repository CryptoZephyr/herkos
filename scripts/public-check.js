#!/usr/bin/env node

// Checks only public source and public routes. Research phase runners remain
// available for a clean checkout, but this release gate does not depend on
// their ignored reports or on removed private planning notes.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const requiredFiles = [
  'README.md', 'Writeup1.md', 'demo/index.html', 'demo/app.js', 'demo/style.css',
  'demo/snapshot.json', 'demo/flare-mark.svg', 'docs/index.html', 'docs/technical.html', 'docs/privacy.html',
  'docs/terms.html', 'docs/docs.css', 'src/ExitCapacityOracle.sol',
  'src/Coston2SpotOracle.sol', 'src/Coston2LendingMarket.sol',
  'test/Coston2LendingMarket.t.sol', 'test/Coston2Fork.t.sol', 'testnet/index.html', 'testnet/app.js',
  'testnet/style.css', 'testnet/contracts.json', 'scripts/demo.js',
  'scripts/deploy-coston2.js', 'scripts/verify-coston2.js', 'scripts/public-check.js', 'deployments/coston2.json', 'vercel.json',
];
const privateNames = [
  'CLAUDE.md', 'Handoff1.md', 'Memory1.md', 'LUNA_FRONTEND_AUDIT.md', 'PRD1.md',
  'Tasks1.md', 'Architecture1.md', 'setup1.md', 'COSTON2_LENDING_REBUILD.md',
];
const privateNamePattern = new RegExp(privateNames.map((name) => name.replace('.', '\\.')).join('|'));
// Transaction hashes and Solidity constants are public 32-byte values, so do
// not treat every 64-hex string as a secret. Look for formats that identify a
// key or token rather than normal chain evidence.
const secretPattern = /(?:-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----|(?:sk|pk)-[A-Za-z0-9_-]{20,}|(?:private[ _-]?key|secret)\s*[:=]\s*0x[a-f0-9]{64})/i;
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` · ${detail}` : ''}`);
  return pass;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'out', 'cache', 'node_modules', '.vercel'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return files;
}

function main() {
  for (const file of requiredFiles) check(`public file exists: ${file}`, fs.existsSync(path.join(ROOT, file)));

  const allFiles = walk(ROOT);
  for (const name of privateNames) check(`private planning file absent: ${name}`, !allFiles.includes(name));
  const resultFiles = allFiles.filter((file) => /^phase\d+-results\.json$/i.test(file));
  check('generated phase reports are absent', resultFiles.length === 0, resultFiles.join(', '));

  const publicFiles = allFiles.filter((file) => /\.(html|css|js|json|md|sol)$/.test(file));
  const forbiddenMentions = [];
  const secrets = [];
  for (const file of publicFiles) {
    const content = read(file);
    if (file !== 'scripts/public-check.js' && privateNamePattern.test(content)) forbiddenMentions.push(`${file} mentions removed private planning material`);
    if (!file.endsWith('.example') && secretPattern.test(content)) {
      const allowed = file === 'scripts/deploy-coston2.js' || file === 'scripts/public-check.js';
      if (!allowed) secrets.push(file);
    }
  }
  check('public sources do not mention removed planning files', forbiddenMentions.length === 0, forbiddenMentions.join('; '));
  check('public sources contain no private keys or obvious secrets', secrets.length === 0, secrets.join(', '));

  const packageJson = JSON.parse(read('package.json'));
  check('phase5 points to the public checker', packageJson.scripts?.phase5 === 'node scripts/public-check.js');
  check('testnet route is present in Vercel config', /testnet/.test(read('vercel.json')));
  const testnetConfig = JSON.parse(read('testnet/contracts.json'));
  check('testnet config uses chain 114', testnetConfig.chainId === 114);
  check('testnet config has no deployment placeholders presented as addresses',
    testnetConfig.deploymentPending === true || [testnetConfig.spotOracle, testnetConfig.herkos, testnetConfig.lendingMarket].every((value) => /^0x[a-f\d]{40}$/i.test(value)));
  check('README explains the Coston2 test market', /Coston2/i.test(read('README.md')) && /testnet/i.test(read('README.md')));
  check('official docs have privacy and terms links', /privacy\.html/.test(read('docs/index.html')) && /terms\.html/.test(read('docs/index.html')));
  check('homepage has a factual Flare sponsor lockup', /sponsor-strip/.test(read('demo/index.html')) && /flare-mark\.svg/.test(read('demo/index.html')) && /resources\/developer-hub/.test(read('demo/index.html')));
  check('testnet page has no phase or audit language', !/(Phase 0|Phase 1|audit language|development phase)/i.test(read('testnet/index.html')));

  const linkTargets = [
    ['homepage testnet link', read('demo/index.html'), /testnet/],
    ['testnet official docs link', read('testnet/index.html'), /\.\.\/docs\/index\.html/],
    ['technical docs README link', read('docs/technical.html'), /github\.com\/CryptoZephyr\/herkos\/blob\/main\/README\.md/],
  ];
  for (const [name, content, pattern] of linkTargets) check(name, pattern.test(content));

  const failed = results.filter((item) => !item.pass);
  console.log(`\n${results.length - failed.length}/${results.length} public checks passed`);
  if (failed.length) {
    for (const item of failed) console.log(`FAIL  ${item.name}${item.detail ? ` · ${item.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main();
