// throne. King Drop payouts, step 2 of 2: send.
//
// Reads payouts/week-N.json (reviewed by a human), and transfers $THRONE from the payout wallet to each entry.
// Idempotent: progress is written to payouts/week-N.sent.json after every transfer, so a re-run skips wallets already paid.
// Runs only by hand (workflow_dispatch) with the PAYOUT_KEY secret and a typed confirmation.
//
//   PAYOUT_KEY=0x... node scripts/send.mjs 1 [--dry]
//
// The payout wallet should hold about one week's drop, never the whole pool. Fund it Monday, let this drain it.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const week = parseInt(process.argv[2] || process.env.WEEK || '', 10);
const DRY = process.argv.includes('--dry') || process.env.DRY === '1';
if (!week) { console.error('usage: node scripts/send.mjs <week> [--dry]'); process.exit(2); }
const RPC = process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com';
const TOKEN = getAddress(process.env.TOKEN || '0x72dc556fff14115c077a540921e5F35499a4DCa7');
const abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);

const plan = JSON.parse(fs.readFileSync(`payouts/week-${week}.json`, 'utf8'));
if (!plan.hashVerified) { console.error('plan was computed from an unverified result; refusing'); process.exit(1); }
if (plan.winner === 'draw' || !plan.entries.length) { console.log('nothing to send'); process.exit(0); }
const sentPath = `payouts/week-${week}.sent.json`;
const sent = fs.existsSync(sentPath) ? JSON.parse(fs.readFileSync(sentPath, 'utf8')) : { week, token: TOKEN, transfers: {} };
const save = () => fs.writeFileSync(sentPath, JSON.stringify(sent, null, 2));

const pub = createPublicClient({ transport: http(RPC) });
const chainId = await pub.getChainId();
const chain = { id: chainId, name: 'robinhood', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const dec = Number(await pub.readContract({ address: TOKEN, abi, functionName: 'decimals' }));
if (dec !== plan.decimals) { console.error(`token decimals ${dec} != plan ${plan.decimals}`); process.exit(1); }

const todo = plan.entries.filter(e => !(sent.transfers[e.wallet] && sent.transfers[e.wallet].status === 'ok'));
const total = todo.reduce((s, e) => s + BigInt(e.wei), 0n);
console.log(`week ${week} · chain ${chainId} · ${todo.length} of ${plan.entries.length} wallets left · ${formatUnits(total, dec)} $THRONE to send${DRY ? ' (dry run)' : ''}`);

if (DRY) { for (const e of todo) console.log(`  would send ${formatUnits(BigInt(e.wei), dec)} -> ${e.wallet}`); process.exit(0); }

const key = process.env.PAYOUT_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) { console.error('PAYOUT_KEY missing or malformed'); process.exit(1); }
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http(RPC) });
const bal = await pub.readContract({ address: TOKEN, abi, functionName: 'balanceOf', args: [account.address] });
console.log(`payout wallet ${account.address} holds ${formatUnits(bal, dec)} $THRONE`);
if (bal < total) { console.error(`insufficient: need ${formatUnits(total, dec)}. Fund the payout wallet and re-run; already-paid wallets are skipped.`); process.exit(1); }

let ok = 0, failed = 0;
for (const e of todo) {
  const to = getAddress(e.wallet); const amount = BigInt(e.wei);
  try {
    const hash = await wallet.writeContract({ address: TOKEN, abi, functionName: 'transfer', args: [to, amount] });
    const rc = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    sent.transfers[e.wallet] = { status: rc.status === 'success' ? 'ok' : 'reverted', tx: hash, amount: e.amount, wei: e.wei, at: new Date().toISOString() };
    if (rc.status === 'success') ok++; else failed++;
    console.log(`  ${rc.status === 'success' ? 'ok ' : 'REV'} ${to} ${e.amount} ${hash}`);
  } catch (err) {
    failed++; sent.transfers[e.wallet] = { status: 'error', error: String(err.shortMessage || err.message || err).slice(0, 200), amount: e.amount, wei: e.wei, at: new Date().toISOString() };
    console.log(`  ERR ${to} ${String(err.shortMessage || err.message).slice(0, 120)}`);
  }
  save();
}
sent.summary = { ok, failed, total: plan.entries.length, finishedAt: new Date().toISOString() };
save();
console.log(`done: ${ok} paid, ${failed} failed. ${sentPath} updated.`);
process.exit(failed ? 1 : 0);
