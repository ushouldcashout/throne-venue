// throne. venue snapshot. Pulls the venue's public daily broker leaderboard for broker_id=throne and writes one JSON file per UTC day.
// Past days are written once and never touched again; today and yesterday are refreshed every run.
import fs from 'node:fs';
const BROKER = 'throne';
const START = process.env.START || '2026-09-25';
const LB = `https://api.orderly.org/v1/broker/leaderboard/daily?broker_id=${BROKER}&sort=descending_perp_volume`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const ymd = t => new Date(t).toISOString().slice(0, 10);
const today = ymd(Date.now()), yesterday = ymd(Date.now() - 864e5);

async function day(d) {
  let page = 1, rows = [], total = null;
  for (;;) {
    const r = await fetch(`${LB}&start_date=${d}&end_date=${d}&page=${page}&size=500`, { headers: { accept: 'application/json', 'user-agent': UA } });
    if (!r.ok) throw new Error(`venue ${r.status} for ${d}`);
    const j = await r.json();
    if (!j.success) throw new Error(`venue success=false for ${d}: ${JSON.stringify(j).slice(0, 200)}`);
    const rs = (j.data && j.data.rows) || [];
    total = j.data && j.data.meta ? j.data.meta.total : rs.length;
    rows.push(...rs.map(x => ({ date: String(x.date).slice(0, 10), address: String(x.address || '').toLowerCase(), account_id: x.account_id, perp_volume: +x.perp_volume || 0, perp_taker_volume: +x.perp_taker_volume || 0, perp_maker_volume: +x.perp_maker_volume || 0, realized_pnl: +x.realized_pnl || 0, total_fee: +x.total_fee || 0, broker_fee: +x.broker_fee || 0 })));
    if (!rs.length || rows.length >= total || page > 40) break;
    page++;
  }
  return { date: d, broker: BROKER, total, rows, snapshot_at: new Date().toISOString() };
}

fs.mkdirSync('data', { recursive: true });
const days = [];
for (let t = Date.parse(START + 'T00:00:00Z'); ymd(t) <= today; t += 864e5) days.push(ymd(t));
let changed = 0;
for (const d of days) {
  const f = `data/${d}.json`;
  const complete = d < yesterday; // two full UTC days behind: never refetch
  if (complete && fs.existsSync(f)) continue;
  const out = await day(d);
  const next = JSON.stringify(out);
  const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  // compare without the timestamp so quiet periods do not produce commits
  const strip = s => s && s.replace(/,"snapshot_at":"[^"]+"/, '');
  if (strip(prev) !== strip(next)) { fs.writeFileSync(f, next); changed++; console.log('wrote', f, out.rows.length, 'rows'); }
}
const index = { broker: BROKER, start: START, days: fs.readdirSync('data').filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).map(x => x.slice(0, 10)).sort(), updated: new Date().toISOString() };
const idxPrev = fs.existsSync('data/index.json') ? JSON.parse(fs.readFileSync('data/index.json', 'utf8')) : null;
if (changed || !idxPrev || JSON.stringify(idxPrev.days) !== JSON.stringify(index.days)) fs.writeFileSync('data/index.json', JSON.stringify(index));
console.log('changed files:', changed);
