// throne. referee relay. Reads the venue's private "referee info" for ONE referrer account (the Throne account that owns
// the partner referral codes, e.g. VOLTRADE) and writes data/referees.json: { addr -> code }. The arena Worker reads that
// file and exposes it as `refCode` on /quest and /board. Runs inside the snapshot Action every 10 minutes.
//
// Secrets (GitHub Actions secrets, never in the repo):
//   ORDERLY_ACCOUNT_ID  the referrer account id (0x... 32 bytes)
//   ORDERLY_KEY         the account's orderly key public part, "ed25519:<base58>" or bare base58
//   ORDERLY_SECRET      the matching ed25519 seed, 32 bytes, base58 or hex   (a READ-scope key is enough)
// With no secrets set the script exits 0 and writes nothing, so the snapshot job keeps working without it.
import fs from 'node:fs';
import crypto from 'node:crypto';

const API = 'https://api.orderly.org';
const ACC = process.env.ORDERLY_ACCOUNT_ID, PUB = process.env.ORDERLY_KEY, SEC = process.env.ORDERLY_SECRET;
if (!ACC || !PUB || !SEC) { console.log('referees: no ORDERLY_* secrets, skipping'); process.exit(0); }

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') out.unshift(0); else break; }
  return Buffer.from(out);
}
const bytes = (s) => /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : b58decode(s.replace(/^ed25519:/, ''));
const pubB58 = PUB.replace(/^ed25519:/, '');
const pub = bytes(pubB58), seed = bytes(SEC);
if (pub.length !== 32 || seed.length !== 32) throw new Error(`key lengths pub=${pub.length} seed=${seed.length}, expected 32/32`);
const b64u = (b) => Buffer.from(b).toString('base64url');
const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', d: b64u(seed), x: b64u(pub) } });

async function signed(path) {
  const ts = String(Date.now());
  const sig = crypto.sign(null, Buffer.from(ts + 'GET' + path), key);
  const r = await fetch(API + path, { headers: { 'orderly-account-id': ACC, 'orderly-key': 'ed25519:' + pubB58, 'orderly-timestamp': ts, 'orderly-signature': b64u(sig), accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(`venue ${r.status} ${path}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data;
}

const codes = {}; let page = 1, total = 0;
for (;;) {
  const d = await signed(`/v1/referral/referee_info?page=${page}&size=100&sort=ascending_code_binding_time`);
  const rows = (d && d.rows) || [];
  for (const x of rows) { const a = String(x.user_address || '').toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(a) && x.referral_code) codes[a] = { code: String(x.referral_code).toUpperCase(), boundAt: x.code_binding_time || null }; }
  total = (d && d.meta && d.meta.total) || rows.length;
  if (!rows.length || page * 100 >= total || page > 50) break;
  page++;
}
fs.mkdirSync('data', { recursive: true });
const out = { referrer: ACC.slice(0, 10) + '…', total, codes, updated: new Date().toISOString() };
const f = 'data/referees.json';
const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
const strip = s => s && s.replace(/,"updated":"[^"]+"/, '');
const next = JSON.stringify(out);
if (strip(prev) !== strip(next)) { fs.writeFileSync(f, next); console.log('referees: wrote', Object.keys(codes).length, 'wallets'); } else console.log('referees: no change,', Object.keys(codes).length, 'wallets');
