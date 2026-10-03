#!/usr/bin/env node

// Run one small real Coston2 position and record public chain evidence. The
// local key is read from the environment and is never written to the record.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RPC = process.env.C2_RPC || 'https://coston2-api.flare.network/ext/C/rpc';
const EXPECTED_CHAIN_ID = 114;
const EXPLORER = 'https://coston2-explorer.flare.network';

function getKey() {
  const key = process.env.C2_VERIFIER_KEY || process.env.PUBLISHER_KEY;
  if (!key) throw new Error('C2_VERIFIER_KEY or PUBLISHER_KEY is required in the ignored local environment');
  return key;
}

function cast(args) {
  return execFileSync('cast', [...args, '--rpc-url', RPC], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
  }).trim();
}

function walletAddress(key) {
  return execFileSync('cast', ['wallet', 'address', key], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
  }).trim();
}

function send(to, signature, args = []) {
  const gasLimit = signature === 'poke()' ? '1500000' : '500000';
  const output = execFileSync('cast', ['send', to, signature, ...args, '--rpc-url', RPC, '--private-key', getKey(), '--legacy', '--gas-limit', gasLimit, '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
  });
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`No receipt returned for ${signature}`);
  const receipt = JSON.parse(output.slice(start, end + 1));
  if (receipt.status !== '0x1') throw new Error(`${signature} was mined unsuccessfully`);
  return { hash: receipt.transactionHash, block: Number(BigInt(receipt.blockNumber)), gasUsed: Number(BigInt(receipt.gasUsed)) };
}

function call(address, signature, args = []) {
  return cast(['call', address, signature, ...args]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const recordPath = path.join(ROOT, 'deployments', 'coston2.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert(Number(cast(['chain-id'])) === EXPECTED_CHAIN_ID, 'refusing verification on a non-Coston2 RPC');
  const wallet = walletAddress(getKey());
  for (const [label, address] of Object.entries({ spotOracle: record.spotOracle, herkos: record.herkos, lendingMarket: record.lendingMarket })) {
    assert(cast(['code', address]).length > 2, `${label} has no bytecode`);
  }
  assert(call(record.herkos, 'isFXRPMarket(address)(bool)', [record.lendingMarket]) === 'true', 'market is not registered with Herkos');
  const flow = {};
  // Nobody pokes the public deployment on a schedule, so refresh it first.
  if (call(record.herkos, 'isPokeStale()(bool)') === 'true') flow.poke = send(record.herkos, 'poke()');
  assert(call(record.herkos, 'isPokeStale()(bool)') === 'false', 'Herkos is stale before the flow');
  assert(BigInt(call(record.herkos, 'getUnderlyingPrice(address)(uint256)', [record.lendingMarket]).split(' ')[0]) > 0n, 'Herkos returned no price');
  assert(call(record.lendingMarket, 'underlying()(address)').toLowerCase() === record.fTestXrp.toLowerCase(), 'market underlying is not FTestXRP');

  const debtDecimals = Number(call(record.testUsdt0, 'decimals()(uint8)'));
  const collateralDecimals = Number(call(record.fTestXrp, 'decimals()(uint8)'));
  const debtUnit = 10n ** BigInt(debtDecimals);
  const collateralUnit = 10n ** BigInt(collateralDecimals);
  const USDT_AMOUNT = (10n * debtUnit).toString();
  const XRP_AMOUNT = (10n * collateralUnit).toString();
  const BORROW_AMOUNT = (7n * debtUnit).toString();

  flow.approveUsdt = send(record.testUsdt0, 'approve(address,uint256)', [record.lendingMarket, USDT_AMOUNT]);
  flow.supplyLiquidity = send(record.lendingMarket, 'supplyLiquidity(uint256)', [USDT_AMOUNT]);
  flow.approveFxrp = send(record.fTestXrp, 'approve(address,uint256)', [record.lendingMarket, XRP_AMOUNT]);
  flow.depositCollateral = send(record.lendingMarket, 'depositCollateral(uint256)', [XRP_AMOUNT]);
  flow.borrow = send(record.lendingMarket, 'borrow(uint256)', [BORROW_AMOUNT]);
  flow.approveRepay = send(record.testUsdt0, 'approve(address,uint256)', [record.lendingMarket, BORROW_AMOUNT]);
  flow.repay = send(record.lendingMarket, 'repay(uint256)', [BORROW_AMOUNT]);
  flow.withdrawCollateral = send(record.lendingMarket, 'withdrawCollateral(uint256)', [XRP_AMOUNT]);
  flow.withdrawLiquidity = send(record.lendingMarket, 'withdrawLiquidity(uint256)', [USDT_AMOUNT]);
  flow.approveSeed = send(record.testUsdt0, 'approve(address,uint256)', [record.lendingMarket, USDT_AMOUNT]);
  flow.seedLiquidity = send(record.lendingMarket, 'supplyLiquidity(uint256)', [USDT_AMOUNT]);
  const finalPosition = call(record.lendingMarket, 'position(address)((uint256,uint256))', [wallet]);
  const finalLiquidity = call(record.lendingMarket, 'availableLiquidity()(uint256)');
  record.verification = {
    checkedAtBlock: flow.withdrawLiquidity.block, wallet,
    seededLiquidity: '10 USDT0', collateralTested: '10 FTestXRP', borrowed: '7 USDT0',
    finalPosition, finalAvailableLiquidity: finalLiquidity,
    transactions: Object.fromEntries(Object.entries(flow).map(([name, tx]) => [name, {
      hash: tx.hash, block: tx.block, gasUsed: tx.gasUsed, explorer: `${EXPLORER}/tx/${tx.hash}`,
    }])),
  };
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Coston2 flow confirmed at block ${record.verification.checkedAtBlock}`);
  for (const [name, tx] of Object.entries(flow)) console.log(`PASS  ${name}  ${tx.hash}`);
}

try { main(); } catch (error) { console.error(`Coston2 verification stopped: ${error.message}`); process.exitCode = 1; }
