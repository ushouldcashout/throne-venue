// throne. Fables pool snapshot. Reads Fables' own indexer for the THRONE/USDG market (Uniswap v4 pool
// 0x3428…82fe, FablesRamp hook) and writes data/fables.json: fees paid to LPs and volume per UTC day since the
// pool opened, plus the live stats (tvl, 24h volume/fees, Fables' pool APR figure). Protocol-owned liquidity
// (the Court's share of the pool) is applied on the site, not here. No secrets.
import fs from 'node:fs';

const POOL = '0x3428910987af3506702305be9869f3320b55d7f280af90804bf376786f6082fe';
const BASE = 'https://www.fables.fi/api/gw/';
const F = 'data/fables.json';
const UA = { headers: { accept: 'application/json', 'user-agent': 'throne-ledger/1.0 (+https://throne.network)' } };

async function get(path) {
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(BASE + path, UA); if (r.ok) return await r.json(); } catch {}
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw new Error('fables fetch failed: ' + path);
}

const hist = await get('PoolVolumeHistoryBatch?addressOrId=' + POOL + '&durations=MAX');
const buckets = ((hist.windows || {}).MAX || {}).buckets || [];
const days = {};
for (const b of buckets) {
  const d = new Date(Number(b.timestamp) * 1000).toISOString().slice(0, 10);
  const e = (days[d] = days[d] || { volumeUsd: 0, feeUsd: 0 });
  e.volumeUsd += Number(b.volumeUsd) || 0; e.feeUsd += Number(b.feeUsd) || 0;
}
for (const d in days) { days[d].volumeUsd = +days[d].volumeUsd.toFixed(6); days[d].feeUsd = +days[d].feeUsd.toFixed(6); }

let stats = null;
try { const s = await get('PoolStats'); stats = (s.pools || {})[POOL] || null; } catch {}

const prev = fs.existsSync(F) ? JSON.parse(fs.readFileSync(F, 'utf8')) : null;
const out = { pool: POOL, market: 'THRONE / USDG', source: 'fables.fi indexer (PoolVolumeHistoryBatch MAX, PoolStats)', days: Object.fromEntries(Object.entries(days).sort()), stats, updated: new Date().toISOString() };
// keep history if Fables ever trims the MAX window
if (prev && prev.days) for (const d in prev.days) if (!out.days[d]) out.days[d] = prev.days[d];
out.days = Object.fromEntries(Object.entries(out.days).sort());
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(F, JSON.stringify(out, null, 1));
const tf = Object.values(out.days).reduce((a, x) => a + x.feeUsd, 0);
console.log(`fables: ${Object.keys(out.days).length} days, fees to LPs $${tf.toFixed(2)}, tvl ${stats ? '$' + Math.round(stats.tvlUsd) : 'n/a'}`);
