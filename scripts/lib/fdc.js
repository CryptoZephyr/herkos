// FDC (Flare Data Connector) helpers for Phase 3. Dependency-free.
//
// Struct shapes are pinned to the verified FdcVerification implementation (0xf7f0057b…)
// via src/interfaces/IFdcVerification.sol — the proxy has no ABI and the documented
// shapes differ, so the interface file is the authority, not the docs.
//
// The harvest lifts a whole IXRPPayment.Proof out of somebody else's mainnet calldata and
// puts it back into ours. That has to be byte-identical or the Merkle leaf changes and a
// real proof stops verifying, so decode keeps the raw nested arrays and encode replays
// those — the named view is for logging and gating, never for re-encoding.

const { encode, decode } = require('./abi.js');
const { sel, u } = require('./rpc.js');

const CHAIN_XRPL = 200;                 // FDC sourceId index for XRPL in Relay.merkleRoots
const RELAY = '0xccf30790a93f15e24eb909548a2c58a9b0a7fbd4';

// ---------- canonical type strings ----------
const T_REQUEST_BODY = '(bytes32,address)';                          // transactionId, proofOwner
const T_RESPONSE_BODY = '(uint64,uint64,string,bytes32,bytes32,bytes32,'
  + 'int256,int256,int256,int256,bool,bytes,bool,uint256,uint8)';
const T_RESPONSE = `(bytes32,bytes32,uint64,uint64,${T_REQUEST_BODY},${T_RESPONSE_BODY})`;
const T_PROOF = `(bytes32[],${T_RESPONSE})`;

const b32str = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex').padEnd(64, '0');

// Attestation type and source ids are left-aligned ASCII in a bytes32.
const attType = b32str;
const sourceId = b32str;

// ---------- proof decode / encode ----------
// Field order matches IXRPPayment exactly; positions are load-bearing.
function nameProof(raw) {
  const [merkleProof, resp] = raw;
  const [attestationType, srcId, votingRound, lowestUsedTimestamp, rb, b] = resp;
  return {
    raw,
    merkleProof,
    attestationType, sourceId: srcId,
    votingRound: Number(votingRound),
    lowestUsedTimestamp: Number(lowestUsedTimestamp),
    requestBody: { transactionId: rb[0], proofOwner: rb[1] },
    responseBody: {
      blockNumber: Number(b[0]), blockTimestamp: Number(b[1]), sourceAddress: b[2],
      sourceAddressHash: b[3], receivingAddressHash: b[4], intendedReceivingAddressHash: b[5],
      spentAmount: b[6], intendedSpentAmount: b[7],
      receivedAmount: b[8], intendedReceivedAmount: b[9],
      hasMemoData: b[10], firstMemoData: b[11],
      hasDestinationTag: b[12], destinationTag: b[13], status: Number(b[14]),
    },
  };
}

// Decode the leading IXRPPayment.Proof argument of a call. Every proof-carrying
// AssetManager function takes it first, so trailing args are simply ignored.
function proofFromCalldata(hex, extraTypes = []) {
  const body = '0x' + hex.replace(/^0x/, '').slice(8);
  const [raw, ...rest] = decode([T_PROOF, ...extraTypes], body);
  return { ...nameProof(raw), extra: rest };
}

// Re-encode from the raw arrays decode produced — guarantees the same bytes back.
const encodeProof = (p) => encode([T_PROOF], [p.raw ?? p]);

// Calldata for ExitCapacityOracle.submitCoreVaultOutflow(IXRPPayment.Proof).
const submitOutflowCalldata = (p) =>
  sel('submitCoreVaultOutflow((bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,address),'
    + '(uint64,uint64,string,bytes32,bytes32,bytes32,int256,int256,int256,int256,bool,bytes,'
    + 'bool,uint256,uint8))))') + encodeProof(p).slice(2);

// Ask the deployed FdcVerification whether it accepts this proof. Returns a bool, or
// null when the call reverts — a revert is not a "no", it is a shape mismatch.
async function verifyXRPPayment(rpc, fdcVerification, p, at = 'latest') {
  const data = sel(`verifyXRPPayment(${T_PROOF})`) + encodeProof(p).slice(2);
  const r = await rpc.probe(fdcVerification, data, at);
  return r === null ? null : BigInt(r) !== 0n;
}

// ---------- request side (Coston2 dry-run) ----------
// getRequestFee(bytes) payload, measured from FdcRequestFeeConfigurations: bytes32 type,
// bytes32 source, then an empty word. A pair with no configured fee cannot be requested,
// whatever a live verifier endpoint returns.
function requestFeePayload(type, source) {
  return attType(type).slice(2) + sourceId(source).slice(2) + '0'.repeat(64);
}

async function getRequestFee(rpc, feeConfig, type, source) {
  const payload = requestFeePayload(type, source);
  const data = sel('getRequestFee(bytes)')
    + (32).toString(16).padStart(64, '0')
    + (payload.length / 2).toString(16).padStart(64, '0')
    + payload;
  const r = await rpc.probe(feeConfig, data);
  return r === null ? null : u(r, 0);
}

const requestAttestationCalldata = (requestBytes) =>
  sel('requestAttestation(bytes)') + encode(['bytes'], [requestBytes]).slice(2);

// ---------- DA Layer ----------
// POST-only: GET returns 405, there is no openapi.json and no round listing. Proofs come
// back only for a (votingRoundId, requestBytes) already known — which is exactly the
// independent cross-check against harvested calldata, not a way to discover proofs.
async function daProof(url, votingRoundId, requestBytes, ms = 30000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ votingRoundId, requestBytes }),
      signal: c.signal,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { error: (j && (j.error || j.detail)) || `HTTP ${r.status}`, status: r.status };
    return j;
  } catch (e) {
    return { error: e.message };
  } finally { clearTimeout(t); }
}

// Relay.merkleRoots(chain, votingRound). The voting round comes from the response body;
// it is not a block number, and using a block number silently returns an empty root.
async function relayMerkleRoot(rpc, round, chain = CHAIN_XRPL, at = 'latest') {
  const data = sel('merkleRoots(uint256,uint256)')
    + BigInt(chain).toString(16).padStart(64, '0')
    + BigInt(round).toString(16).padStart(64, '0');
  const r = await rpc.probe(RELAY, data, at);
  if (r === null) return null;
  return BigInt(r) === 0n ? null : r.slice(0, 66);
}

module.exports = {
  CHAIN_XRPL, RELAY,
  T_REQUEST_BODY, T_RESPONSE_BODY, T_RESPONSE, T_PROOF,
  attType, sourceId, nameProof, proofFromCalldata, encodeProof,
  submitOutflowCalldata, verifyXRPPayment,
  requestFeePayload, getRequestFee, requestAttestationCalldata,
  daProof, relayMerkleRoot,
};
