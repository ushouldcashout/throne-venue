# throne-venue

Public, timestamped snapshots of the venue's daily broker leaderboard for `broker_id=throne`. One file per UTC day in `data/`, refreshed every 10 minutes by GitHub Actions; a day is frozen once it is two full UTC days old.

This is the input to King Drop scoring. Anyone can recompute a week's result and hash from these files. The venue's endpoint blocks requests from Cloudflare Workers, so the arena Worker reads from here and falls back to the venue directly if a day is missing.

`data/index.json` lists the days available and the last update time.


## King Drop payouts

Two-step, human in the middle.

1. **compute** (`payouts.yml`, Monday 02:30 UTC or by hand with a week number): `scripts/payouts.mjs` fetches the frozen result from `throne.network/api/arena/results?week=N`, recomputes its SHA-256 to prove it is untouched, applies the published split (72% winning side by week points, 18% winning pieces king 16 to pawn 1, 10% losing king/queen 7/3, all gated by the $20,000 floor) and commits `payouts/week-N.json`. Nothing is sent. Read the file.
2. **send** (`send.yml`, manual only): with the week number and the word `SEND`, `scripts/send.mjs` transfers $THRONE from the payout wallet (secret `PAYOUT_KEY`) to each entry and commits `payouts/week-N.sent.json` with every tx hash. Anything other than `SEND` is a dry run. Re-running skips wallets already paid.

The payout wallet holds about one week's drop, funded on Monday. Unpaid shares (wallets under the floor, empty seats) stay in the treasury and are listed under `totals.unallocated`.
