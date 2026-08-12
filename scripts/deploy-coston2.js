#!/usr/bin/env node

// Deploy the public Coston2 test market. This script refuses to run without an
// explicit key and chain check. It never writes a key, prints a key, or talks
// to Mainnet.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RPC = process.env.C2_RPC || 'https://coston2-api.flare.network/ext/C/rpc';
const EXPECTED_CHAIN_ID = 114;
const REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';
const FTEST_XRP = '0x0b6A3645c240605887a5532109323A3E12273dc7';
const TEST_USDT0 = process.env.C2_USDT0 || '0xC1A5B41512496B80903D1f32d6dEa3a73212E71F';
const XRP_USD = '0x015852502f55534400000000000000000000000000';
const ASSET_MANAGER = '0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA';
const MAX_FEED_AGE = process.env.C2_MAX_FEED_AGE || '420';
const EXPLORER = 'https://coston2-explorer.flare.network';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required and must stay in an ignored local environment file`);
  return value;
}

function cast(args, options = {}) {
  return execFileSync('cast', [...args, '--rpc-url', RPC], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
    ...options,
  }).trim();
}

function walletAddress(key) {
  return execFileSync('cast', ['wallet', 'address', key], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
  }).trim();
}

function deploy(contract, args, key) {
  const output = execFileSync('forge', [
    'create', contract,
    '--rpc-url', RPC,
    '--private-key', key,
    '--legacy',
    '--broadcast',
    '--json',
    '--constructor-args', ...args,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
  });
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`forge create returned no JSON for ${contract}`);
  const result = JSON.parse(output.slice(start, end + 1));
  if (!result.deployedTo || !result.transactionHash) throw new Error(`deployment result incomplete for ${contract}`);
  return { address: result.deployedTo, tx: result.transactionHash };
}

function send(to, signature, args, key) {
  const output = execFileSync('cast', [
    'send', to, signature, ...args,
    '--rpc-url', RPC,
    '--private-key', key,
    '--legacy',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
  });
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`cast send returned no JSON for ${signature}`);
  const result = JSON.parse(output.slice(start, end + 1));
  if (!result.transactionHash) throw new Error(`transaction result incomplete for ${signature}`);
  return result.transactionHash;
}

function main() {
  const key = required('PUBLISHER_KEY');
  const chainId = Number(cast(['chain-id']));
  if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`refusing deployment: RPC chain id is ${chainId}, expected ${EXPECTED_CHAIN_ID}`);
  const deployer = walletAddress(key);
  console.log(`Coston2 chain confirmed · deployer ${deployer}`);
  console.log(`Checking verified token dependencies · FXRP ${FTEST_XRP} · USDT0 ${TEST_USDT0}`);
  if (cast(['code', FTEST_XRP]).length <= 2) throw new Error('FTestXRP has no deployed bytecode');
  if (cast(['code', TEST_USDT0]).length <= 2) throw new Error('test USDT0 has no deployed bytecode');

  const spot = deploy('src/Coston2SpotOracle.sol:Coston2SpotOracle', [
    REGISTRY, FTEST_XRP, TEST_USDT0, XRP_USD, MAX_FEED_AGE,
  ], key);
  console.log(`Spot oracle deployed ${spot.address}`);

  const herkos = deploy('src/ExitCapacityOracle.sol:ExitCapacityOracle', [
    REGISTRY, ASSET_MANAGER, spot.address, XRP_USD, deployer,
  ], key);
  console.log(`Herkos deployed ${herkos.address}`);

  const market = deploy('src/Coston2LendingMarket.sol:Coston2LendingMarket', [
    FTEST_XRP, TEST_USDT0, herkos.address,
  ], key);
  console.log(`Lending market deployed ${market.address}`);

  const registrationTx = send(herkos.address, 'registerFXRPMarket(address)', [market.address], key);
  const pokeTx = send(herkos.address, 'poke()', [], key);
  const refreshTx = send(market.address, 'refreshOraclePrice()', [], key);
  const block = Number(cast(['block-number']));
  const record = {
    network: 'coston2',
    chainId: EXPECTED_CHAIN_ID,
    deployedAtBlock: block,
    deployer,
    fTestXrp: FTEST_XRP,
    testUsdt0: TEST_USDT0,
    spotOracle: spot.address,
    herkos: herkos.address,
    lendingMarket: market.address,
    constructorArgs: {
      spotOracle: [REGISTRY, FTEST_XRP, TEST_USDT0, XRP_USD, MAX_FEED_AGE],
      herkos: [REGISTRY, ASSET_MANAGER, spot.address, XRP_USD, deployer],
      lendingMarket: [FTEST_XRP, TEST_USDT0, herkos.address],
    },
    parameters: {
      maxLtvBps: 7000,
      liquidationThresholdBps: 7500,
      liquidationBonusBps: 500,
      interest: 'none',
      referenceSizeUBA: '1000000000000',
    },
    transactions: {
      spotOracleDeployment: spot.tx,
      herkosDeployment: herkos.tx,
      marketDeployment: market.tx,
      marketRegistration: registrationTx,
      firstPoke: pokeTx,
      firstPriceRefresh: refreshTx,
    },
    explorer: {
      spotOracle: `${EXPLORER}/address/${spot.address}`,
      herkos: `${EXPLORER}/address/${herkos.address}`,
      lendingMarket: `${EXPLORER}/address/${market.address}`,
    },
  };
  const deploymentsDir = path.join(ROOT, 'deployments');
  fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(path.join(deploymentsDir, 'coston2.json'), `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(path.join(ROOT, 'testnet', 'contracts.json'), `${JSON.stringify({
    network: record.network,
    chainId: record.chainId,
    deploymentPending: false,
    rpcUrl: RPC,
    explorerUrl: EXPLORER,
    faucetUrl: 'https://faucet.flare.network/coston2',
    registry: REGISTRY,
    fTestXrp: FTEST_XRP,
    testUsdt0: TEST_USDT0,
    spotOracle: spot.address,
    herkos: herkos.address,
    lendingMarket: market.address,
    deploymentBlock: block,
  }, null, 2)}\n`);
  console.log(`Deployment record written at block ${block}`);
}

try {
  main();
} catch (error) {
  console.error(`Deployment stopped: ${error.message}`);
  process.exitCode = 1;
}
