// throne. King Drop payouts, step 1 of 2: compute.
//
// Reads the frozen, hashed result for a week from the arena Worker, re-derives the hash to prove the file was not edited,
// applies the published split, and writes payouts/week-N.json for a human to review. It never sends anything.
//
//   node scripts/payouts.mjs 1            -> payouts/week-1.json
//   RESULT_FILE=path.json node ...        -> use a local result file (tests)
//
// Rules (docs.throne.network/points.html):
//   72% of the pot -> every qualified wallet on the winning side, pro rata by that week's points
//   18%            -> the winning side's sixteen pieces, weighted king 16 .. pawn 1, re-weighted over the QUALIFIED seats
//   10%            -> the losing side's king (7%) and queen (3%), if qualified
//   qualified = weekVol >= claimFloorUsd. Every share of the pot is paid to qualified wallets: a piece seat that misses the
//   floor (or is empty) passes its weight to the other qualified pieces; an unqualified losing king/queen's share, and the
//   piece pool when no piece qualifies, roll into the winning side pool. Only a week with no qualified winning wallet at all
//   leaves anything unallocated (reported, stays in treasury).
//   draw          -> nothing is paid; the pot carries to the next week (reported, handled by POT_BY_WEEK in the Worker).
import fs from 'node:fs';
import crypto from 'node:crypto';

const API = process.env.ARENA_API || 'https://throne.network/api/arena';
const week = parseInt(process.argv[2] || process.env.WEEK || '', 10);
if (!week) { console.error('usage: node scripts/payouts.mjs <week>'); process.exit(2); }

const DECIMALS = 18n;
const toWei = (tokens) => BigInt(Math.round(tokens * 1e6)) * 10n ** (DECIMALS - 6n); // 6 dp of token precision, exact integer wei

function canonicalHash(result) {
  // exactly what the Worker does: JSON.stringify(result, sortedTopLevelKeys) over the result WITHOUT hash/finalizedAt,
  // then sha256. The replacer array applies at every depth, so nested objects only keep keys that also exist top-level;
  // that quirk is part of the published hash, so we reproduce it rather than fix it.
  const r = { ...result }; delete r.hash; delete r.finalizedAt;
  const canon = JSON.stringify(r, Object.keys(r).sort());
  return crypto.createHash('sha256').update(canon).digest('hex');
}

async function loadResult() {
  if (process.env.RESULT_FILE) return JSON.parse(fs.readFileSync(process.env.RESULT_FILE, 'utf8'));
  const r = await fetch(`${API}/results?week=${week}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`results?week=${week} -> ${r.status}`);
  const j = await r.json();
  const res = j.result || j; // endpoint may wrap
  if (!res || res.week !== week) throw new Error(`no finalized result for week ${week} yet`);
  return res;
}

const res = await loadResult();
const recomputed = canonicalHash(res);
if (res.hash && recomputed !== res.hash) { console.error(`HASH MISMATCH: result says ${res.hash}, recomputed ${recomputed}. Refusing.`); process.exit(1); }

const pot = +res.pot || 0;
const split = res.split || { trailingKQ: 0.10, kqWeights: [0.7, 0.3], sideShare: 0.72, pieceShare: 0.18 };
const floor = +res.claimFloorUsd || 20000;
const wallets = res.wallets || {};
const W = res.winner;
const entries = new Map(); // addr -> { amount, parts: {side, piece, kq} }
const add = (addr, amt, part) => { if (!(amt > 0)) return; const e = entries.get(addr) || { wallet: addr, amount: 0, parts: {} }; e.amount += amt; e.parts[part] = (e.parts[part] || 0) + amt; entries.set(addr, e); };
const qualified = (addr) => { const w = wallets[addr]; return !!(w && (w.qualified || (w.weekVol || 0) >= floor)); };
let unallocated = { side: 0 };

if (!pot) { console.error('result has no pot; nothing to pay'); process.exit(1); }
if (W === 'draw') {
  const out = { week, season: res.season, pot, winner: 'draw', hash: res.hash, computedAt: new Date().toISOString(), entries: [], totals: { paid: 0, unallocated: pot }, note: 'draw: no payout, the pot carries to the next week' };
  fs.mkdirSync('payouts', { recursive: true }); fs.writeFileSync(`payouts/week-${week}.json`, JSON.stringify(out, null, 2)); console.log('draw, nothing to pay'); process.exit(0);
}
const L = W === 'white' ? 'black' : 'white';

// Order: K/Q first and pieces second, because anything they cannot pay rolls into the side pool, which is paid last.
let rollover = 0; // $THRONE that moves from the K/Q and piece pools into the winning side pool

// 10%: losing king and queen, 7/3, qualified only; an unqualified (or missing) seat's share rolls into the side pool
const kqPool = pot * split.trailingKQ;
const lp = (res.pieces && res.pieces[L]) || [];
[[0, split.kqWeights[0]], [1, split.kqWeights[1]]].forEach(([i, wgt]) => { const p = lp[i]; const amt = kqPool * wgt; if (p && qualified(p.addr)) add(p.addr, amt, 'kq'); else rollover += amt; });

// 18%: winning pieces weighted king 16 .. pawn 1, re-weighted over the qualified seats only (empty and unqualified seats
// pass their weight to the rest). No qualified piece at all -> the whole piece pool rolls into the side pool.
const piecePool = pot * split.pieceShare;
const pieces = ((res.pieces && res.pieces[W]) || []).filter(p => qualified(p.addr));
const totalW = pieces.reduce((s, p) => s + (17 - p.rank), 0);
if (totalW > 0) for (const p of pieces) add(p.addr, piecePool * ((17 - p.rank) / totalW), 'piece'); else rollover += piecePool;

// 72% (+ rollover): winning side by week points, qualified only
const sidePool = pot * split.sideShare + rollover;
const winners = Object.entries(wallets).filter(([a, w]) => w.side === W && w.week > 0 && qualified(a));
const denom = winners.reduce((s, [, w]) => s + w.week, 0);
if (denom > 0) for (const [a, w] of winners) add(a, sidePool * (w.week / denom), 'side'); else unallocated.side += sidePool;

const list = [...entries.values()].map(e => ({ ...e, amount: Math.round(e.amount * 1e6) / 1e6, wei: toWei(e.amount).toString(), name: (res.names && res.names[e.wallet] && (res.names[e.wallet].name || null)) || null })).sort((a, b) => b.amount - a.amount);
const paid = list.reduce((s, e) => s + e.amount, 0);
const out = {
  week, season: res.season, start: res.start, end: res.end, closes: res.closes, winner: W, pot, split, claimFloorUsd: floor,
  hash: res.hash, hashVerified: recomputed === res.hash, computedAt: new Date().toISOString(),
  token: '0x72dc556fff14115c077a540921e5F35499a4DCa7', decimals: 18,
  counts: { entries: list.length, winningSideQualified: winners.length, winningSideTotal: Object.values(wallets).filter(w => w.side === W && w.week > 0).length },
  totals: { paid: Math.round(paid * 1e6) / 1e6, unallocated: Math.round(unallocated.side * 1e6) / 1e6, rolledIntoSidePool: Math.round(rollover * 1e6) / 1e6 },
  entries: list,
};
fs.mkdirSync('payouts', { recursive: true });
fs.writeFileSync(`payouts/week-${week}.json`, JSON.stringify(out, null, 2));
console.log(`week ${week}: ${W} wins. ${list.length} wallets, ${out.totals.paid.toLocaleString()} $THRONE to pay, ${out.totals.unallocated.toLocaleString()} unallocated, ${out.totals.rolledIntoSidePool.toLocaleString()} rolled into the side pool. hash ${recomputed.slice(0, 12)}… verified=${out.hashVerified}`);
for (const e of list.slice(0, 20)) console.log(`  ${e.wallet}  ${e.amount.toLocaleString().padStart(12)}  ${Object.entries(e.parts).map(([k, v]) => k + ':' + Math.round(v)).join(' ')}`);
