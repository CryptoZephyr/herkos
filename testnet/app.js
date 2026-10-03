/* Coston2 test market client. No account or server is involved. */
'use strict';

const ZERO = '0x0000000000000000000000000000000000000000';
const C2_CHAIN_ID = '0x72';
const SELECTOR = {
  balanceOf: '0x70a08231',
  decimals: '0x313ce567',
  allowance: '0xdd62ed3e',
  approve: '0x095ea7b3',
  availableLiquidity: '0x74375359',
  position: '0xb7648fb9',
  oracleFresh: '0x8398640e',
  lastOraclePrice: '0x349f7173',
  lastOracleAt: '0x11ef9cf0',
  lastOracleBlock: '0x2ad1f9f3',
  suppliedLiquidity: '0x873d60cf',
  borrowingLimit: '0xa6a58df4',
  healthFactorBps: '0xd10d7f21',
  supplyLiquidity: '0x3ea1025f',
  withdrawLiquidity: '0x0a861f2a',
  depositCollateral: '0xbad4a01f',
  withdrawCollateral: '0x6112fe2e',
  borrow: '0xc5ebeaec',
  repay: '0x371fd8e6',
  refreshOraclePrice: '0x88a15cfd',
  poke: '0x18178358',
  inputs: '0x8c7a91ed',
  getUnderlyingPrice: '0xfc57d4df',
};

const state = {
  config: null,
  provider: null,
  account: null,
  chainId: null,
  action: 'deposit',
  balances: { flr: 0n, xrp: 0n, usdt: 0n },
  position: { collateral: 0n, debt: 0n, supplied: 0n, available: 0n, limit: 0n, health: 0n },
  lastReads: {},
  decimals: { xrp: 6, usdt: 6 },
};

const $ = (id) => document.getElementById(id);
const configAddress = (name) => state.config?.[name] || null;
const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const deployed = () => Boolean(state.config && isAddress(state.config.spotOracle) && isAddress(state.config.herkos) && isAddress(state.config.lendingMarket));

function encWord(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function encAddress(address) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function callData(selector, ...args) {
  return selector + args.map((arg) => typeof arg === 'string' && isAddress(arg) ? encAddress(arg) : encWord(arg)).join('');
}

function readWord(data, index = 0) {
  const start = 2 + index * 64;
  return BigInt(`0x${(data || '0x').slice(start, start + 64).padEnd(64, '0')}`);
}

function shorten(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUnits(value, decimals = 6, max = 4) {
  const negative = value < 0n;
  const raw = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = raw % base;
  if (fraction === 0n) return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}`;
  const fractionText = fraction.toString().padStart(decimals, '0').slice(0, max).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}.${fractionText}`;
}

function formatPrice(value) {
  if (!value) return 'Not available';
  return `$${formatUnits(value, 30, 6)}`;
}

function formatPercentPpm(value) {
  return `${(Number(value) / 10000).toFixed(2)}%`;
}

function formatHealth(value) {
  if (!value || value >= 10n ** 30n) return 'No debt';
  return `${(Number(value) / 100).toFixed(2)}%`;
}

function parseUnits(input, decimals = 6) {
  const text = String(input || '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('Enter a positive amount using numbers only.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals));
  if (value <= 0n) throw new Error('Enter an amount greater than zero.');
  return value;
}

async function rpc(method, params) {
  const response = await fetch(state.config.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || 'The Coston2 read failed.');
  return body.result;
}

async function read(address, data) {
  if (!isAddress(address)) throw new Error('This contract is not deployed yet.');
  return rpc('eth_call', [{ to: address, data }, 'latest']);
}

async function readNumber(address, data) {
  return readWord(await read(address, data));
}

async function readWords(address, data, count) {
  const result = await read(address, data);
  return Array.from({ length: count }, (_, index) => readWord(result, index));
}

function setText(id, text) {
  const element = $(id);
  if (element) element.textContent = text;
}

function setHidden(id, hidden) {
  const element = $(id);
  if (element) element.hidden = hidden;
}

function setChip(id, text, tone = '') {
  const element = $(id);
  if (!element) return;
  element.textContent = text;
  element.className = `status-chip${tone ? ` ${tone}` : ''}`;
}

function setStatus(message, tone = '') {
  const element = $('status');
  element.textContent = message;
  element.className = `status-line${tone ? ` ${tone}` : ''}`;
}

function explorerAddress(address) {
  return `${state.config.explorerUrl}/address/${address}`;
}

function explorerTransaction(hash) {
  return `${state.config.explorerUrl}/tx/${hash}`;
}

function showNotice(message, warning = false) {
  const notice = $('deployment-notice');
  notice.hidden = false;
  notice.className = `notice ${warning ? 'notice-warn' : 'notice-info'}`;
  notice.textContent = message;
}

function clearNotice() {
  $('deployment-notice').hidden = true;
}

function updateContractLinks() {
  for (const [id, key] of [['herkos-link', 'herkos'], ['market-link', 'lendingMarket']]) {
    const element = $(id);
    const address = configAddress(key);
    if (isAddress(address)) {
      element.href = explorerAddress(address);
      element.hidden = false;
    } else {
      element.hidden = true;
    }
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    setStatus('No browser wallet found. Install a wallet, then try again.', 'warning');
    showNotice('Connect a browser wallet such as MetaMask or Rabby to sign Coston2 test transactions.', true);
    return;
  }
  state.provider = window.ethereum;
  try {
    const accounts = await state.provider.request({ method: 'eth_requestAccounts' });
    if (!accounts?.[0]) throw new Error('No wallet account was returned.');
    state.account = accounts[0];
    setText('connect', shorten(state.account));
    setText('wallet-hint', `Connected ${shorten(state.account)}. Add Coston2 in your wallet to continue.`);
    state.chainId = await state.provider.request({ method: 'eth_chainId' });
    if (state.chainId !== C2_CHAIN_ID) await switchToCoston2();
    setText('wallet-hint', `Connected ${shorten(state.account)}. The address and transactions remain public on Coston2.`);
    setStatus('Wallet connected on Coston2.', 'success');
    clearNotice();
    await loadAll();
  } catch (error) {
    setStatus(explainError(error), 'warning');
    updateActionControls();
  }
}

function isMissingChainError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === 4902 || /unknown chain|unrecognized chain|chain.*not added|does not exist/.test(message);
}

async function addCoston2() {
  await state.provider.request({
    method: 'wallet_addEthereumChain',
    params: [{
      chainId: C2_CHAIN_ID,
      chainName: 'Flare Testnet Coston2',
      nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
      rpcUrls: [state.config.rpcUrl],
      blockExplorerUrls: [state.config.explorerUrl],
    }],
  });
}

async function switchToCoston2() {
  try {
    await state.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: C2_CHAIN_ID }] });
  } catch (error) {
    if (!isMissingChainError(error)) throw error;
    setStatus('Coston2 is not in this wallet. Add it in the next wallet prompt.', '');
    await addCoston2();
    await state.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: C2_CHAIN_ID }] });
  }
  state.chainId = await state.provider.request({ method: 'eth_chainId' });
  if (state.chainId !== C2_CHAIN_ID) throw new Error('Switch to Coston2 in your wallet before signing.');
}

async function readBalances() {
  if (!state.account) {
    setText('balance-flr', 'Not connected');
    setText('balance-xrp', 'Not connected');
    setText('balance-usdt', 'Not connected');
    return;
  }
  const [flr, xrp, usdt] = await Promise.all([
    rpc('eth_getBalance', [state.account, 'latest']).then((value) => BigInt(value)),
    readNumber(state.config.fTestXrp, callData(SELECTOR.balanceOf, state.account)),
    readNumber(state.config.testUsdt0, callData(SELECTOR.balanceOf, state.account)),
  ]);
  state.balances = { flr, xrp, usdt };
  setText('balance-flr', `${formatUnits(flr, 18, 4)} C2FLR`);
  setText('balance-xrp', `${formatUnits(xrp, state.decimals.xrp)} FTestXRP`);
  setText('balance-usdt', `${formatUnits(usdt, state.decimals.usdt)} USDT0`);
}

async function readTokenDecimals() {
  if (!deployed()) return;
  const [xrp, usdt] = await Promise.all([
    readNumber(state.config.fTestXrp, SELECTOR.decimals),
    readNumber(state.config.testUsdt0, SELECTOR.decimals),
  ]);
  state.decimals = { xrp: Number(xrp), usdt: Number(usdt) };
}

async function readOracle() {
  if (!deployed()) return;
  try {
    const values = await readWords(state.config.herkos, SELECTOR.inputs, 12);
    // `isPokeStale()` is read separately below. The inputs read gives the
    // evidence block and timestamp displayed to the user.
    const isStale = await readNumber(state.config.herkos, '0x3eecbebb');
    // getUnderlyingPrice reverts with StalePoke while the aggregate is stale,
    // so only ask for a price when there is one to give.
    const price = isStale === 0n
      ? await readNumber(state.config.herkos, callData(SELECTOR.getUnderlyingPrice, state.config.lendingMarket))
      : 0n;
    state.lastReads.oracle = { values, price, stale: isStale !== 0n };
    setText('oracle-price', isStale === 0n ? formatPrice(price) : 'Refresh required');
    setText('exit-capacity', `${formatUnits(values[6], state.decimals.xrp)} FXRP`);
    setText('haircut', formatPercentPpm(values[7]));
    const timestamp = Number(values[8]);
    const block = values[9].toString();
    setText('last-refresh', timestamp ? `Block ${block} · ${new Date(timestamp * 1000).toLocaleString()}` : 'Not refreshed');
    setChip('oracle-status', isStale === 0n ? 'Fresh' : 'Stale · refresh needed', isStale === 0n ? 'good' : 'warn');
  } catch (error) {
    const message = explainError(error);
    setChip('oracle-status', /stale|refresh/i.test(message) ? 'Stale · refresh needed' : 'Read unavailable', 'warn');
    if (!state.lastReads.oracle) setText('oracle-price', 'Not available');
    setStatus(message, 'warning');
  }
}

async function readMarket() {
  if (!deployed()) return;
  const market = state.config.lendingMarket;
  const values = await Promise.all([
    readNumber(market, SELECTOR.availableLiquidity),
    state.account ? readWords(market, callData(SELECTOR.position, state.account), 2) : [0n, 0n],
    state.account ? readNumber(market, callData(SELECTOR.borrowingLimit, state.account)) : 0n,
    state.account ? readNumber(market, callData(SELECTOR.healthFactorBps, state.account)) : 0n,
    state.account ? readNumber(market, callData(SELECTOR.suppliedLiquidity, state.account)) : 0n,
    readNumber(market, SELECTOR.oracleFresh),
  ]);
  const [available, position, limit, health, supplied, fresh] = values;
  setText('market-liquidity', `${formatUnits(available, state.decimals.usdt)} USDT0`);
  setChip('market-status', fresh !== 0n ? 'Oracle ready' : 'Refresh required', fresh !== 0n ? 'good' : 'warn');
  if (!state.account) {
    state.position = { collateral: 0n, debt: 0n, supplied: 0n, available, limit: 0n, health: 0n };
    setChip('position-status', 'No wallet');
    setText('position-collateral', 'Not connected');
    setText('position-debt', 'Not connected');
    setText('position-supplied', 'Not connected');
    setText('position-limit', 'Not connected');
    setText('position-health', 'Not connected');
    setText('position-note', 'Connect a wallet to read your position.');
    return;
  }
  state.position = { collateral: position[0], debt: position[1], supplied, available, limit, health };
  setText('position-collateral', `${formatUnits(position[0], state.decimals.xrp)} FTestXRP`);
  setText('position-debt', `${formatUnits(position[1], state.decimals.usdt)} USDT0`);
  setText('position-supplied', `${formatUnits(supplied, state.decimals.usdt)} USDT0`);
  setText('position-limit', `${formatUnits(limit, state.decimals.usdt)} USDT0`);
  setText('position-health', formatHealth(health));
  setText('position-note', available > 0n ? 'Deposit FTestXRP after the oracle has a fresh price.' : 'Supply test USDT0 first to create borrowable liquidity.');
  setChip('position-status', state.account ? (position[1] === 0n ? 'No debt' : 'On chain') : 'No wallet', state.account ? 'good' : '');
}

async function loadAll() {
  if (!state.config) return;
  updateContractLinks();
  if (!deployed()) {
    showNotice('The public Coston2 contracts are not deployed yet. You can inspect the market design and use the official faucet, but transaction controls will stay closed until verified addresses are published.', true);
    setChip('oracle-status', 'Deployment pending', 'warn');
    setChip('market-status', 'Deployment pending', 'warn');
    setChip('position-status', 'Deployment pending', 'warn');
    setText('action-state', 'Deployment pending');
    setStatus(state.account ? 'Wallet connected. Waiting for the verified Coston2 deployment.' : 'Connect a wallet to begin.');
    await readBalances().catch((error) => setStatus(explainError(error), 'warning'));
    updateActionControls();
    return;
  }
  try {
    await readTokenDecimals();
    await readBalances();
    await readOracle();
    await readMarket();
    updateActionControls();
  } catch (error) {
    setStatus(explainError(error), 'warning');
  }
}

async function sendTransaction(to, data, label) {
  if (!state.provider || !state.account) throw new Error('Connect a browser wallet first.');
  if (state.chainId !== C2_CHAIN_ID) {
    await switchToCoston2();
  }
  setStatus(`${label} · confirm it in your wallet.`, '');
  const gas = to.toLowerCase() === state.config.herkos.toLowerCase() && data.startsWith(SELECTOR.poke) ? '0x16e360' : '0x7a120';
  const hash = await state.provider.request({ method: 'eth_sendTransaction', params: [{ from: state.account, to, data, gas }] });
  renderTransaction(`${label} submitted. Waiting for Coston2 confirmation.`, hash);
  await waitForReceipt(hash);
  renderTransaction(`${label} confirmed on Coston2.`, hash);
  return hash;
}

async function waitForReceipt(hash) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error('The transaction was mined but did not complete. No balance was changed by this action.');
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('The transaction is still pending. Check its hash in Coston2 Explorer.');
}

function renderTransaction(message, hash = '') {
  const element = $('transaction');
  element.hidden = false;
  element.className = 'transaction';
  element.textContent = '';
  const text = document.createElement('span');
  text.textContent = message;
  element.appendChild(text);
  if (hash) {
    const link = document.createElement('a');
    link.href = explorerTransaction(hash);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = ` Open transaction ${shorten(hash)} ↗`;
    element.appendChild(link);
  }
}

function explainError(error) {
  const code = error?.code;
  if (code === 4001) return 'The wallet request was cancelled. Nothing was sent.';
  if (code === 4100) return 'The wallet did not grant this site access. Connect again if you want to continue.';
  if (code === -32002) return 'Your wallet already has a request open. Finish it there, then try again.';
  const raw = String(error?.message || error || 'The request failed.');
  if (/insufficient funds/i.test(raw)) return 'The wallet needs more C2FLR for gas. Use the official faucet, then try again.';
  if (/user rejected|denied|rejected/i.test(raw)) return 'The wallet request was cancelled. Nothing was sent.';
  if (/oracle stale|stale/i.test(raw)) return 'Herkos is stale. Refresh the oracle before borrowing or withdrawing collateral.';
  if (/borrowlimit|borrow limit/i.test(raw)) return 'That borrow amount is above the current 70% limit.';
  if (/insufficientliquidity|liquidity/i.test(raw)) return 'The market does not have enough supplied USDT0 for that amount.';
  if (/healthyposition|healthy position/i.test(raw)) return 'This position is healthy, so it cannot be liquidated.';
  if (/allowance|transferfrom|token/i.test(raw)) return 'The token approval or transfer did not complete. Check the amount and try again.';
  if (/wrong network|chain/i.test(raw)) return 'Switch the wallet to Coston2 before signing.';
  return raw.length > 180 ? 'The request failed. Check the wallet and try again.' : raw;
}

const ACTIONS = {
  deposit: { label: 'Deposit collateral', unit: 'FTestXRP', token: 'xrp', method: 'depositCollateral', help: 'Approve FTestXRP, then deposit it as collateral.' },
  borrow: { label: 'Borrow', unit: 'USDT0', token: null, method: 'borrow', help: 'Borrow up to the displayed limit after the oracle is fresh.' },
  repay: { label: 'Repay', unit: 'USDT0', token: 'usdt', method: 'repay', help: 'Repay debt. Repayment remains available even if the oracle is stale.' },
  withdrawCollateral: { label: 'Withdraw collateral', unit: 'FTestXRP', token: null, method: 'withdrawCollateral', help: 'Withdraw only the amount that keeps the position below 70% LTV.' },
  supply: { label: 'Supply liquidity', unit: 'USDT0', token: 'usdt', method: 'supplyLiquidity', help: 'Approve test USDT0, then make it available for borrowers.' },
  withdrawLiquidity: { label: 'Withdraw liquidity', unit: 'USDT0', token: null, method: 'withdrawLiquidity', help: 'Withdraw supplied USDT0 that is not currently borrowed.' },
};

function updateActionControls() {
  const action = ACTIONS[state.action];
  setText('amount-unit', action.unit);
  setText('action-help', action.help);
  const ready = Boolean(state.account && state.chainId === C2_CHAIN_ID && deployed());
  const submit = $('submit-action');
  submit.disabled = !ready;
  submit.textContent = !state.account ? 'Connect wallet first' : !deployed() ? 'Deployment pending' : state.chainId !== C2_CHAIN_ID ? 'Switch to Coston2' : action.label;
  $('max-amount').disabled = !ready || currentMax() === 0n;
  $('refresh-balances').disabled = !state.account;
  $('refresh-oracle').disabled = !ready;
  setText('action-state', ready ? 'Ready for a test transaction' : !deployed() ? 'Deployment pending' : 'Connect to enable actions');
}

function currentMax() {
  const action = state.action;
  if (action === 'deposit') return state.balances.xrp;
  if (action === 'repay') return state.balances.usdt < state.position.debt ? state.balances.usdt : state.position.debt;
  if (action === 'borrow') return state.position.limit > state.position.debt ? state.position.limit - state.position.debt : 0n;
  if (action === 'withdrawCollateral') {
    const { collateral, debt } = state.position;
    if (debt === 0n) return collateral;
    // Keep the remaining collateral at or under the market's 70% LTV.
    const price = state.lastReads.oracle?.price || 0n;
    if (!price) return 0n;
    const locked = (debt * 10_000n * 10n ** 30n + 7_000n * price - 1n) / (7_000n * price);
    return collateral > locked ? collateral - locked : 0n;
  }
  if (action === 'supply') return state.balances.usdt;
  if (action === 'withdrawLiquidity') return state.position.supplied < state.position.available ? state.position.supplied : state.position.available;
  return 0n;
}

function setMaxAmount() {
  const max = currentMax();
  const decimals = state.action === 'deposit' || state.action === 'withdrawCollateral' ? state.decimals.xrp : state.decimals.usdt;
  $('amount').value = max ? formatUnits(max, decimals, 6).replace(/,/g, '') : '';
}

async function approveIfNeeded(token, spender, amount) {
  const allowance = await readNumber(token, callData(SELECTOR.allowance, state.account, spender));
  if (allowance >= amount) return;
  await sendTransaction(token, callData(SELECTOR.approve, spender, amount), `Approve ${token.toLowerCase() === state.config.fTestXrp.toLowerCase() ? 'FTestXRP' : 'test USDT0'}`);
}

async function submitAction(event) {
  event.preventDefault();
  const action = ACTIONS[state.action];
  let amount;
  try {
    const decimals = action.unit === 'FTestXRP' ? state.decimals.xrp : state.decimals.usdt;
    amount = parseUnits($('amount').value, decimals);
    if (!deployed()) throw new Error('The verified Coston2 deployment is not available yet.');
    const target = state.config.lendingMarket;
    if (action.token) {
      const token = action.token === 'xrp' ? state.config.fTestXrp : state.config.testUsdt0;
      await approveIfNeeded(token, target, amount);
    }
    await sendTransaction(target, callData(SELECTOR[action.method], amount), action.label);
    $('amount').value = '';
    await loadAll();
  } catch (error) {
    renderTransaction(explainError(error));
    $('transaction').classList.add('bad');
    setStatus(explainError(error), 'warning');
    updateActionControls();
  }
}

async function refreshOracle() {
  try {
    $('refresh-oracle').disabled = true;
    await sendTransaction(state.config.herkos, SELECTOR.poke, 'Refresh Herkos');
    await sendTransaction(state.config.lendingMarket, SELECTOR.refreshOraclePrice, 'Cache the market price');
    await loadAll();
  } catch (error) {
    renderTransaction(explainError(error));
    $('transaction').classList.add('bad');
    setStatus(explainError(error), 'warning');
  } finally {
    updateActionControls();
    $('refresh-oracle').disabled = !(state.account && deployed() && state.chainId === C2_CHAIN_ID);
  }
}

function bindEvents() {
  $('connect').addEventListener('click', connectWallet);
  $('refresh-balances').addEventListener('click', () => readBalances().catch((error) => setStatus(explainError(error), 'warning')));
  $('refresh-oracle').addEventListener('click', refreshOracle);
  $('max-amount').addEventListener('click', setMaxAmount);
  $('action-form').addEventListener('submit', submitAction);
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    state.action = tab.dataset.action;
    document.querySelectorAll('.tab').forEach((other) => {
      const active = other === tab;
      other.classList.toggle('active', active);
      other.setAttribute('aria-selected', String(active));
    });
    $('amount').value = '';
    updateActionControls();
  }));
  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', (accounts) => {
      state.account = accounts?.[0] || null;
      if (!state.account) {
        setText('connect', 'Connect wallet');
        setStatus('Wallet disconnected.');
      }
      loadAll();
    });
    window.ethereum.on?.('chainChanged', (chainId) => {
      state.chainId = chainId;
      setStatus(chainId === C2_CHAIN_ID ? 'Coston2 selected.' : 'Switch the wallet to Coston2 before signing.', chainId === C2_CHAIN_ID ? 'success' : 'warning');
      updateActionControls();
      loadAll();
    });
  }
}

async function init() {
  try {
    state.config = await fetch('/testnet/contracts.json', { cache: 'no-store' }).then((response) => response.json());
    bindEvents();
    updateContractLinks();
    if (state.config.deploymentPending || !deployed()) showNotice('The public Coston2 contracts are not deployed yet. The transaction controls are intentionally closed until the verified deployment record is published.', true);
    updateActionControls();
    if (window.ethereum?.selectedAddress) {
      state.provider = window.ethereum;
      state.account = window.ethereum.selectedAddress;
      state.chainId = await window.ethereum.request({ method: 'eth_chainId' });
      setText('connect', shorten(state.account));
    }
    await loadAll();
  } catch (error) {
    setStatus('The test market configuration could not be loaded.', 'warning');
    showNotice('Reload the page to try again.', true);
  }
}

init();
