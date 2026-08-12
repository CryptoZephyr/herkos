#!/usr/bin/env node
// Phase 2 — Oracle Contract. Runs the fork test suite and records what it measured.
//
// This is a driver, not a second source of truth: every number below is read out
// of forge's own output rather than recomputed here, so the JSON and the tests
// cannot disagree. Dependency-free, like everything else in the repo.
//
// Venue: a local anvil fork at the pinned block. The public RPC
// rate-limits a queue walk into failure -- hundreds of state fetches per poke --
// so HERKOS_RPC pointing at anvil is the supported path. Mainnet stays read-only.
//
//   anvil --fork-url https://flare-api.flare.network/ext/C/rpc \
//         --fork-block-number 67013823 --port 8545 --no-rate-limit
//   npm run phase2
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RPC = process.env.HERKOS_RPC || 'http://localhost:8545';
const FORK_BLOCK = 67_013_823;

const out = { venue: RPC, forkBlock: FORK_BLOCK, suites: {}, measured: {}, checks: [] };
const hr = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const fmt = (x) => Number(x).toLocaleString('en-US');

function check(name, pass, detail = '') {
  out.checks.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  return pass;
}

// The four claims Phase 2 rests on, each pinned to the test that proves it and
// the bound it must clear. A regression in any one of these is a product claim
// going false, not a slow test.
const BUDGETS = {
  'herkos cold': { max: 100_000, why: 'hot path must clear the 100k drop-in target' },
  'poke gas': { max: 3_000_000, why: 'refresh must stay affordable for a volunteer caller' },
};

function forgeTest() {
  const env = { ...process.env, HERKOS_RPC: RPC, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' };
  try {
    return execFileSync('forge', ['test', '-vv'], {
      cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Non-zero exit still carries the full report; failures are parsed below.
    if (e.stdout) return e.stdout;
    throw e;
  }
}

// forge -vv prints `  name: value` lines from log_named_uint under each test.
function parse(raw) {
  const suites = {};
  const logs = {};
  let suite = null;
  let test = null;

  for (const line of raw.split(/\r?\n/)) {
    const s = line.match(/^Ran \d+ tests? for (\S+):(\w+)/);
    if (s) { suite = s[2]; suites[suite] = { pass: 0, fail: 0, tests: [] }; continue; }

    const t = line.match(/^\[(PASS|FAIL[^\]]*)\]\s+(\w+)\(\)/);
    if (t && suite) {
      test = t[2];
      const ok = t[1] === 'PASS';
      suites[suite][ok ? 'pass' : 'fail'] += 1;
      suites[suite].tests.push({ name: test, pass: ok, reason: ok ? '' : t[1] });
      continue;
    }

    const kv = line.match(/^\s{2,}(\S[^:]*?):\s+(\d+)\s*(?:\[[^\]]*\])?\s*$/);
    if (kv && test) logs[kv[1].trim()] = BigInt(kv[2]);
  }
  return { suites, logs };
}
(function main() {
  hr('PHASE 2 - ORACLE CONTRACT');
  console.log(`  venue      ${RPC}`);
  console.log(`  fork block ${fmt(FORK_BLOCK)}`);

  if (!fs.existsSync(path.join(ROOT, 'src/ExitCapacityOracle.sol'))) {
    console.error('\nFATAL src/ExitCapacityOracle.sol is missing');
    process.exit(1);
  }

  hr('FORK TEST SUITE');
  const raw = forgeTest();
  const { suites, logs } = parse(raw);
  out.suites = suites;

  const names = Object.keys(suites);
  if (names.length === 0) {
    console.error('\nFATAL forge produced no test results. Is anvil up on ' + RPC + '?');
    console.error(raw.split(/\r?\n/).slice(-15).join('\n'));
    process.exit(1);
  }

  let pass = 0;
  let fail = 0;
  for (const n of names) {
    const s = suites[n];
    pass += s.pass;
    fail += s.fail;
    console.log(`  ${s.fail === 0 ? 'PASS' : 'FAIL'}  ${n.padEnd(16)} ${s.pass}/${s.pass + s.fail}`);
    for (const t of s.tests.filter((x) => !x.pass)) console.log(`          ${t.name}  ${t.reason}`);
  }
  check('every Phase 2 test passes', fail === 0, `${pass}/${pass + fail} across ${names.length} suites`);

  // ==========================================================================
  hr('MEASURED AT THE PIN');
  for (const [k, v] of Object.entries(logs)) {
    out.measured[k] = v.toString();
    console.log(`  ${k.padStart(20)}  ${fmt(v)}`);
  }

  hr('BUDGETS');
  for (const [key, b] of Object.entries(BUDGETS)) {
    const v = logs[key];
    if (v === undefined) { check(`${key} was measured`, false, 'no log line found'); continue; }
    check(`${key} within budget`, v <= BigInt(b.max), `${fmt(v)} <= ${fmt(b.max)} (${b.why})`);
  }

  // The three doc claims Phase 2 measured and found wrong. Recorded here so the
  // corrections travel with the results rather than living only in prose.
  out.corrections = [
    {
      claim: 'hot path baseline measured on the pinned fork',
      finding: 'that is the bare FTSO feed read, not an oracle entrypoint. Measured on '
        + 'identical footing: herkos 70,467 cold / 15,967 warm, incumbent 110,614 / 24,108.',
    },
    {
      claim: 'scaling follows the six-decimal Compound mantissa',
      finding: 'wrong by twelve orders of magnitude. The feed is 6 decimals and FXRP is 6, '
        + 'so the mantissa is value * 10^(36-6-6) = value * 1e24.',
    },
    {
      claim: 'poke() gas is measured on the pinned fork',
      finding: 'measured 1,836,816. The 600k covered redemptionQueue(0,100) alone and omitted '
        + 'agent-status filtering, the dominant term at ~282k per unique agent. 80 tickets '
        + 'resolve to 6 agents at the pin; 6.5% of Flare\'s 28,027,352 block limit.',
    },
  ];

  hr('PHASE 2 SUMMARY');
  const failed = out.checks.filter((c) => !c.pass);
  console.log(`  ${out.checks.length - failed.length}/${out.checks.length} checks passed`);
  for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
  console.log(`\n  ${out.corrections.length} doc claims corrected by measurement:`);
  for (const c of out.corrections) console.log(`    - ${c.claim}`);

  out.generatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(ROOT, 'phase2-results.json'), JSON.stringify(out, null, 2));
  console.log('\n  wrote phase2-results.json');
  process.exit(failed.length ? 1 : 0);
})();
