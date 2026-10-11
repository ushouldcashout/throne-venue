// throne. Pons creator-fee ledger. Reads the Pons v2 fee escrow's Credited / Claimed events for THRONE's creator
// fee recipient and keeps data/pons.json: ETH credited per UTC day (realized swap fees), total credited, total
// claimed, last scanned block. Incremental: only blocks after `lastBlock` are scanned, so each run is cheap.
// The site's ledger reads this file from the relay. No secrets; public RPC only.
import fs from 'node:fs';

const RPC = process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
const RECIPIENT = '0xe8e60885b967aafd7f99f1f45e535481d53ee14c'; // THRONE creatorFeeRecipient (PonsV2LaunchFactory.getLaunchedToken)
const T_CREDITED = '0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5'; // Credited(address,address,uint256)
const T_CLAIMED = '0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a'; // Claimed(address,uint256)
const REC_TOPIC = '0x' + RECIPIENT.slice(2).padStart(64, '0');
const F = 'data/pons.json';
const MAX_SPAN = 9_000_000; // RPC allows 10M blocks per single-topic query

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(body) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(1000 * (i + 1));
  }
  throw new Error('rpc failed');
}
const call = async (method, params) => { const j = await rpc({ jsonrpc: '2.0', id: 1, method, params }); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result; };
const hex = (n) => '0x' + n.toString(16);

const prev = fs.existsSync(F) ? JSON.parse(fs.readFileSync(F, 'utf8')) : { days: {}, creditedWei: '0', claimedWei: '0', lastBlock: 0 };
const latest = parseInt(await call('eth_blockNumber', []), 16);
const from = (prev.lastBlock || 0) + 1;
if (from > latest) { console.log('pons: nothing new'); process.exit(0); }

let logs = [];
for (const t of [T_CREDITED, T_CLAIMED]) {
  for (let f = from; f <= latest; f += MAX_SPAN) {
    const to = Math.min(f + MAX_SPAN - 1, latest);
    logs = logs.concat(await call('eth_getLogs', [{ address: ESCROW, fromBlock: hex(f), toBlock: hex(to), topics: [t, REC_TOPIC] }]));
    await sleep(200);
  }
}
const blocks = [...new Set(logs.map((x) => x.blockNumber))];
const ts = {};
for (let i = 0; i < blocks.length; i += 50) {
  const batch = blocks.slice(i, i + 50).map((b, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_getBlockByNumber', params: [b, false] }));
  const res = await rpc(batch);
  for (const r of res) if (r.result) ts[r.result.number] = parseInt(r.result.timestamp, 16);
  await sleep(200);
}
let cred = BigInt(prev.creditedWei || '0'), claim = BigInt(prev.claimedWei || '0');
const days = { ...(prev.days || {}) };
for (const x of logs) {
  const v = BigInt(x.data.slice(0, 66));
  if (x.topics[0] === T_CREDITED) {
    cred += v;
    const d = new Date(ts[x.blockNumber] * 1000).toISOString().slice(0, 10);
    days[d] = (BigInt(days[d] || '0') + v).toString();
  } else claim += v;
}
// claimable now (escrow.balanceOf(recipient)) is a live read, stored for convenience
const bal = await call('eth_call', [{ to: ESCROW, data: '0x70a08231' + RECIPIENT.slice(2).padStart(64, '0') }, 'latest']);
const out = {
  recipient: RECIPIENT, escrow: ESCROW, token: '0x72dc556fff14115c077a540921e5F35499a4DCa7',
  lastBlock: latest, creditedWei: cred.toString(), claimedWei: claim.toString(), claimableWei: BigInt(bal).toString(),
  days: Object.fromEntries(Object.entries(days).sort()), updated: new Date().toISOString(),
};
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(F, JSON.stringify(out, null, 1));
console.log(`pons: +${logs.length} events, scanned ${from}..${latest}, credited ${(Number(cred) / 1e18).toFixed(4)} ETH`);
