// throne. King Drop holder minimums. Reads $THRONE balances for every wallet active in the current week (from the venue
// snapshots in data/<date>.json) over the public RPC, and keeps the LOWEST balance seen per wallet per week in
// data/holds.json. The Worker reads this file for the holder multiplier (500k -> 1.5x, 100k -> 1.25x) instead of calling
// the RPC itself, which fails from Cloudflare egress. A failed read never writes anything: a wallet with no good sample yet
// is simply absent, and the Worker treats absent as "no multiplier yet", not as zero forever.
//
// Weeks: week 1 = 2026-09-25 .. 2026-10-18 (pre-season folded in); week n>=2 = Monday 00:00 UTC boundaries from 2026-10-19.
import fs from 'node:fs';
const RPC = process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com';
const THRONE = '0x72dc556fff14115c077a540921e5F35499a4DCa7';
const PRESEASON_START = '2026-09-25';
const FIRST_CLOSE = Date.UTC(2026, 9, 19); // Mon 19 Oct 2026 00:00 UTC closes week 1
const WEEK_MS = 7 * 864e5;
const WEEKS = 9;
const ymd = t => new Date(t).toISOString().slice(0, 10);
const ADDR = /^0x[0-9a-f]{40}$/;

function weekDates(n) {
  const close = FIRST_CLOSE + (n - 1) * WEEK_MS;
  return { start: n === 1 ? PRESEASON_START : ymd(close - WEEK_MS), end: ymd(close - 1), close };
}
function currentWeek(now) {
  for (let n = 1; n <= WEEKS; n++) { const w = weekDates(n); if (now < w.close) return n; }
  return 0;
}

const now = Date.now();
const week = currentWeek(now);
if (!week) { console.log('season over; nothing to sample'); process.exit(0); }
const wd = weekDates(week);

// active wallets this week, from the day files
const addrs = new Set();
for (let t = Date.parse(wd.start + 'T00:00:00Z'); ymd(t) <= wd.end && t <= now; t += 864e5) {
  const f = `data/${ymd(t)}.json`;
  if (!fs.existsSync(f)) continue;
  try { for (const r of JSON.parse(fs.readFileSync(f, 'utf8')).rows || []) { const a = String(r.address || '').toLowerCase(); if (ADDR.test(a)) addrs.add(a); } } catch (e) {}
}
const list = [...addrs];
console.log(`week ${week} (${wd.start} .. ${wd.end}) · ${list.length} active wallets`);

async function balances(list) {
  const out = new Map();
  const CH = 40;
  for (let i = 0; i < list.length; i += CH) {
    const chunk = list.slice(i, i + CH);
    const body = chunk.map((a, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: THRONE, data: '0x70a08231' + a.slice(2).padStart(64, '0') }, 'latest'] }));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error('rpc ' + r.status);
        const j = await r.json();
        for (const res of (Array.isArray(j) ? j : [])) { const a = chunk[res.id]; if (a && typeof res.result === 'string' && res.result.startsWith('0x') && res.result.length > 2) out.set(a, Number(BigInt(res.result)) / 1e18); }
        break;
      } catch (e) { if (attempt === 2) console.log('chunk failed, skipped:', e.message); else await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
    }
  }
  return out;
}

const path = 'data/holds.json';
const prev = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : { token: THRONE, weeks: {} };
const wk = prev.weeks[week] || { start: wd.start, end: wd.end, samples: 0, min: {}, last: {} };
const bal = await balances(list);
let changed = false;
for (const [a, v] of bal) {
  const cur = Math.floor(v);
  if (!(a in wk.min) || cur < wk.min[a]) { wk.min[a] = cur; changed = true; }
  if (wk.last[a] !== cur) { wk.last[a] = cur; changed = true; }
}
if (bal.size) { wk.samples = (wk.samples || 0) + 1; wk.sampledAt = new Date().toISOString(); changed = true; }
prev.weeks[week] = wk;
prev.updated = new Date().toISOString();
if (changed) { fs.writeFileSync(path, JSON.stringify(prev)); console.log(`wrote ${path}: ${bal.size} balances read, ${Object.keys(wk.min).length} wallets with a minimum`); }
else console.log('no balances read; holds.json untouched');
