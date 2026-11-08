# RABBOT backend (SpacetimeDB)

Everything stateful RABBOT keeps lives in its own SpacetimeDB database `rabbot`,
on a dedicated local SpacetimeDB server (`rabbot-stdb.service`, 127.0.0.1:3013). That
covers the mirrored public game history, the facts derived from it, the
module-maintained sums, the fitted bid models, and the live bot's telemetry.
RABBOT only reads ScrabbleBot's `scrabblebot` database on maincloud and never
calls reducers there. The server runs with its own port, data dir and JWT
keys, separate from any other SpacetimeDB instance on the host.

## What lives where

| Path | What |
|---|---|
| `backend/src/schema.ts` | Tables. |
| `backend/src/index.ts` | Reducers and the auth checks. |
| `backend/src/stats.ts` | `market_stat` / `opp_stat` / `seat_stat`, kept exact as `d_*` rows change. |
| `src/backend_bindings/` | Generated TypeScript client bindings. Don't edit; regenerate. |
| `src/backend/client.ts` | Node client: `connectBackend`, batch writers, `putDerived`, `sql`, `createEventSink`. |
| `src/backend/import-sqlite.ts` | One-shot SQLite → backend migration, also the real-data benchmark. |
| `src/backend/backend.test.ts` | Live tests against a throwaway `rabbot-test-<pid>` database. |
| `src/backend/testdb.ts` | Test harness: publish, allow-list, delete. |
| `src/backend/mint-writer.ts` | Mints a writer identity and saves its token. |
| `src/backend/mirror-sync.ts` | `MirrorSync`: the miner's SQLite working copy → backend, by diff (see "Miner"). |
| `src/backend/telemetry.ts` | `Telemetry`: the live bot's decision log → `rabbot_event` + typed tables + heartbeat. |
| `src/backend/model-source.ts` | Opponent model data from the backend (`loadOpponentModel("stdb:")`). |
| `src/backend/check-mirror.ts` | Mirror lag vs maincloud, row counts vs the miner's SQLite. |
| `src/backend/model-compare.ts` | Backend-loaded vs SQLite-loaded opponent model, timed. |
| `deploy/rabbot-miner.service` | The miner (`mine.ts --follow --db data/miner.sqlite`), Nice=10, logs to `logs/miner.log`. |
| `deploy/rabbot-stdb.service` | Server unit. Runs the pinned v2.13.0 `spacetimedb-standalone` directly. |
| `~/.local/share/rabbot/stdb/` | Server data dir (commitlog, snapshots). |
| `~/.local/share/rabbot/keys/id_ecdsa{,.pub}` | The server's own JWT keys, not the global `~/.config/spacetime` keys. |
| `~/.config/rabbot/local.toml` | CLI config: server `rabbot` (default) + the owner login (server-issued identity). |
| `~/.config/rabbot/writer.token` | Token of the allow-listed writer identity RABBOT's Node processes use (mode 600; `RABBOT_WRITER_TOKEN_PATH` overrides). |

The CLI rewrites its config files with mode 664. `~/.config/rabbot` has mode
700, so they stay private, but re-run `chmod 600 ~/.config/rabbot/*.toml` after
a CLI write anyway.

## Operating it

Always pass `--config-path`. Never run a bare `spacetime login` or
`spacetime logout`: those write the global CLI config, which other
SpacetimeDB projects on the host may rely on.

```sh
S=~/.local/bin/spacetime; C=~/.config/rabbot/local.toml

# Server (with `loginctl enable-linger` it starts at boot without a login session)
systemctl --user status rabbot-stdb        # start | stop | restart likewise
journalctl --user -u rabbot-stdb -f
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3013/v1/ping   # 200

# Publish the module. Keeps data; only additive changes (new tables, new
# columns appended with .default()). Anything else: --delete-data=always,
# then re-add the writer and reload the data (import-sqlite / miner).
cd backend && npm install
$S --config-path $C publish -s rabbot -p . -y rabbot
$S --config-path $C generate --lang typescript --out-dir ../src/backend_bindings -p . -y

# Look at data / logs (the owner also sees the private `writer` table)
$S --config-path $C sql -s rabbot rabbot "SELECT COUNT(*) AS n FROM g_auction"
$S --config-path $C logs -s rabbot rabbot

# Writers (owner only)
cd .. && npx tsx src/backend/mint-writer.ts [--out <path>] [--force]
$S --config-path $C call -s rabbot rabbot add_writer '{"__identity__":"0x<hex>"}' '"label"'
$S --config-path $C call -s rabbot rabbot remove_writer '{"__identity__":"0x<hex>"}'

# Recompute the sums from d_* (owner only)
$S --config-path $C call -s rabbot rabbot rebuild_stats

# Integration tests (opt-in) and the real-data import benchmark, both on
# throwaway databases
RABBOT_IT=1 node --import tsx --test src/backend/backend.test.ts
NODE_OPTIONS=--max-old-space-size=12000 npx tsx src/backend/import-sqlite.ts
# The real migration of data/history.sqlite into rabbot (idempotent; re-runnable)
NODE_OPTIONS=--max-old-space-size=12000 npx tsx src/backend/import-sqlite.ts --db rabbot
```

A database is loaded (its commitlog replayed) on the first request after a
server start. With the full history (3.7M rows) that takes ~20 s, until
SpacetimeDB writes a snapshot. The unit's `ExecStartPost` touches `rabbot`, so
`systemctl start` returns only once `rabbot` answers, and the client waits up
to 60 s to connect.

Disk: a deleted database's replica dir stays under `stdb/replicas/`. That is
~9 MB per test run and ~700 MB per throwaway import run. A killed test run
can also leave its `rabbot-test-<pid>` database behind (`$S --config-path $C
list`, then `delete -s rabbot -y <name>`).

## Miner (rabbot-miner.service)

`src/memory/mine.ts --follow` mirrors maincloud's public tables
(anonymous) into its SQLite working copy (`data/miner.sqlite`, started as
a copy of `data/history.sqlite`, which stays frozen for offline tools),
derives `d_*` rows there and refits bid models hourly in a niced child
process. `MirrorSync` (every 3 s, `--sync-every`) pushes every difference
to `rabbot`: per-match rows of each match whose `match_mined` stamp differs
from `g_match_mined`, plus every running match (live auctions reach the
backend within ~1-4 s); derived rows of each match whose `derived_us`
differs from `d_match_info.derived_at`; bid models whose `fitted_us`
differs; the small base tables whole; state-table deletes (every 60 s);
`meta.last_backfill_us`. Everything is an idempotent upsert, so a backend
outage or a failed pass is repaired by the next pass. `--no-backend` turns
it off.

The rabbot database holds the full mirror; `data/miner.sqlite` is the
miner's local working cache (subscription target, input of derive and the
hourly refit, and the opponent-model file the bot reads via
`RABBOT_MODEL_DB`). In a consistency check every `g_*`, `d_*` and `bid_model` count equals the
SQLite copy (478,332 `g_auction`, 2,821,660 `d_bid_obs`, ...), and the
backend's newest `auction_id` stayed 7-32 auctions (~1-3 s at ~10 live
matches) behind maincloud over 10 checks 30 s apart.

```sh
systemctl --user status rabbot-miner        # restart | stop likewise
tail -f logs/miner.log
npx tsx src/backend/check-mirror.ts --sqlite data/miner.sqlite   # counts + lag
npx tsx src/backend/check-mirror.ts --watch 20                   # lag vs maincloud
```

## Live telemetry

`src/live/session.ts` creates a `Telemetry` (live runs only;
`RABBOT_TELEMETRY=0` turns it off, `RABBOT_TELEMETRY=force` also in a dry run)
and taps `DecisionLog.write`: every record goes to `rabbot_event`, and
`auction` → `rabbot_decision`, `word` → `rabbot_word`, `match_end` → `rabbot_match`,
plus a `heartbeat` every 10 s. `record()` is synchronous and never throws;
typed writes are sent only on an open connection, at most 64 in flight;
the event queue is capped at 50,000 records; the sink reconnects with
backoff when the server is down. The JSONL file is still written first.
`npx tsx src/monitor/status.ts` reads it all back (rating, rank, last 10
matches, misses, think times, style vs the top 10, and the tournament:
the newest unfinished one, whether RABBOT is registered, its standing in the
server's order (Swiss points, total score, lower bot id), Swiss points,
its tournament matches, and in the final its running score difference).

For a bot that doesn't use session.ts's wiring, the one-line hook is
`attachTelemetry` (src/backend/telemetry.ts): it taps the `DecisionLog`,
heartbeats every 10 s from a status callback, never throws or blocks, and
returns a no-op handle with `RABBOT_TELEMETRY=0`:

```ts
import { attachTelemetry } from "../backend/telemetry.js";
const tel = attachTelemetry(log, () => ({ state, currentMatch, latencyMs, clockOffsetMs, version }));
// on stop:
await tel.close();
```

A bot build without telemetry leaves the live and last-6h lines of the
monitor empty.

## Opponent model from the backend

`loadOpponentModel("stdb:")` (or `RABBOT_MODEL_SOURCE=backend` for the
no-argument call) copies `g_bot`, `g_bot_version`, `g_bot_stats`,
`bid_model`, `d_match_info`, `d_match_seat`, `d_auction_ctx`, `d_play_obs`
into an in-memory SQLite and runs the unchanged model on it. Not the
default: it loads in ~3.3 s (vs ~0.25 s), skips `d_bid_obs` so it never
refits stale bots at load or on `refresh()`, and botSummary's bid counts
read 0. `RABBOT_MODEL_DB=<path>` points the default at another SQLite file
(e.g. the miner's fresh `data/miner.sqlite`).

Measured with `model-compare.ts`: backend load 3.5 s
(snapshot 4.2 s) vs SQLite 0.7 s; 119/119 bots; predictBid differs on
115 of 3000 samples, all on 4 bots the SQLite path refits at load (stale
fits), max mean diff 3.05; marketPrice max diff 4 over 130 cells. Not the
same predictions, and it would make the bot's start depend on
rabbot-stdb, so the default stays SQLite.

## Auth

The private `writer` table is an allow-list. `init` records the publisher as
`owner`; republishing does not rerun `init`. `add_writer`, `remove_writer`
and `rebuild_stats` are owner-only, and the owner can't be removed. Every
other reducer requires an allow-listed caller. A fresh connection gets a new
anonymous identity, which is never on the list. SQL DML (`INSERT`/`UPDATE`/
`DELETE` over `/sql`) is refused for anyone but the owner, and publish or
delete by another identity gets 403. Every table except `writer` is public
and read-only to everyone else. The test suite checks that every reducer in
the bindings refuses an anonymous caller.

Only the server's 127.0.0.1 listener is exposed. Public tables are readable
by anything on the host, so never put a game credential (the bot's
`.token-<BOT_NAME>`) or the writer token into a row or an event.

## Schema

SQL names are snake_case of the TS names. `pk` = primary key, `idx` =
btree index, `?` = option. Timestamps are SpacetimeDB `Timestamp`s (µs).

### Mirror (`g_*`, written by the miner): one table per public game table

Rows keep the server's primary keys, so every upsert is idempotent and
re-sending an unchanged row writes nothing. Enum-like columns are strings.
`deleted_at?` is the SQLite miner's `deleted_us` tombstone.

| Table | = server table | Columns |
|---|---|---|
| `g_bot` | `bot` | `id` pk, `name`, `team_id` idx, `is_simulated`, `strategy`, `created_at`, `deleted_at?` |
| `g_bot_stats` | `bot_stats` | `bot_id` pk, `rating` i32, `matches_played`, `wins`, `total_score`, `last_played?`, `openskill_mu`, `openskill_sigma` |
| `g_retired_bot_stats` | `retired_bot_stats` | `id` pk, `bot_id` idx, `version`, + the `g_bot_stats` columns |
| `g_bot_version` | `bot_version` | `id` pk, `bot_id` idx, `version`, `started_at` |
| `g_match` | `match_state` | `id` pk, `status` idx, `current_round`, `current_auction_id?`, `bag_total`, `auction_type`, `created_at`, `started_at?`, `ended_at?`, `auction_duration_ms`, `starting_rack_size`, `deleted_at?` |
| `g_participant` | `match_participant` | `id` pk, `match_id` idx, `bot_id` idx, `balance`, `score`, `deleted_at?` |
| `g_auction` | `auction_result` | `auction_id` pk, `match_id` idx, `letter`, `winner_bot_id?` idx, `paid`, `closed_at`, `deleted_at?` |
| `g_top_bid` | `auction_top_bid_archive` | `auction_id` pk, `match_id` idx, `top_bid`, `deleted_at?` |
| `g_word` | `word_play` | `id` pk, `match_id` idx, `bot_id` idx, `word`, `base_score`, `bonus`, `total_reward`, `played_at`, `deleted_at?` |
| `g_rating` | `rating_history` | `id` pk, `bot_id` idx, `match_id` idx, `at`, `openskill_mu`, `openskill_sigma` |
| `g_tournament`, `g_tournament_entry`, `g_tournament_match` | same names | the server's columns; enums as strings |
| `g_match_mined` | (miner bookkeeping) | `match_id` pk, `complete`, `mined_at` |

### Derived (`d_*`, written by derive.ts through `put_derived`)

Each call replaces whole matches. Rows are matched on their natural key:
unchanged rows are untouched, changed ones are updated in place, and missing
ones are deleted. So a re-derive leaves no stale rows and causes no churn.

| Table | Columns |
|---|---|
| `d_match_info` | `match_id` pk, `n_seats`, `n_real`, `n_auctions`, `expected_auctions`, `auction_type`, `created_at`, `ended_at` idx, `balance_ok`, `derived_at` |
| `d_match_seat` | `id` (module-assigned), `match_id` idx, `bot_id` idx, `is_sim`, `strategy`, `version`, `final_score`, `final_balance`, `place`, `won_tiles`, `paid_total`, `words`, `letters_played`, `tiles_left`, `ended_at`. Natural key (match, bot). |
| `d_auction_ctx` | `auction_id` pk, `match_id` idx, `round_idx`, `n_auctions`, `phase` f64, `letter` idx, `winner_bot_id?` idx, `winner_is_sim?`, `paid`, `top_bid?`, `closed_at`, `ended_at` idx, `sim_q?` |
| `d_bid_obs` | `id` (module-assigned), `auction_id`, `bot_id` idx, `match_id` idx, `letter`, `round_idx`, `phase`, `balance`, `cap`, `rack_size`, `kind` u8 (0 eq, 1 ≤, 2 ≥), `value`, `won`, `others_max?`, `version`, `ended_at`. Natural key (auction, bot). |
| `d_play_obs` | `word_id` pk, `match_id` idx, `bot_id` idx, `is_sim`, `word`, `len`, `reward`, `round_idx`, `phase`, `rack_before`, `balance_before`, `ended_at` |

### Sums (maintained by the module; SpacetimeDB SQL has no GROUP BY)

Phase bucket is fit.ts's `phaseBucket(phase)`: 0–3 are the quartiles of the
match and 4 is the last ~3%. The test imports fit.ts, so the two can't drift
apart silently. All sums are exact i64. A row whose counts return to zero is
deleted.

| Table | Over | Columns |
|---|---|---|
| `market_stat` | `d_auction_ctx` | `key` "L\|pb" pk, `letter`, `phase`, `n`, `n_sold`, `n_sim_win`, `sum_paid`, `sumsq_paid` (sold only), `n_top`, `sum_top`, `sumsq_top` |
| `opp_stat` | `d_bid_obs` | `key` "bot\|L\|pb" pk, `bot_id` idx, `letter`, `phase`, `n_obs`, `n_won`, `n_eq`, `n_zero`, `sum_eq`, `sumsq_eq`, `n_le`, `sum_le`, `sumsq_le`, `n_ge`, `sum_ge` |
| `seat_stat` | `d_match_seat` | `bot_id` pk, `matches`, `wins` (place 1), `sum_place`, `sum_score`, `sum_won_tiles`, `sum_paid`, `sum_words`, `sum_letters_played`, `sum_tiles_left` |

### Models and telemetry

| Table | Columns |
|---|---|
| `bid_model` | `bot_id` pk (0 = market), `fitted_at`, `data_at`, `n_obs`, `params` (model.ts JSON, ≤ 256 kB) |
| `rabbot_event` | `id` autoInc pk, `at` idx (client time), `type` idx, `match_id?` idx, `auction_id?`, `json`. Each row is one `logs/decisions-*.jsonl` record, losslessly (≤ 64 kB). |
| `rabbot_decision` | `auction_id` pk, `match_id` idx, `round`, `letter`, `balance`, `quick_bid`, `quick_ms`, `refined_bid?`, `refine_ms?`, `budget_ms`, `sent_bid`, `min_slack_ms`, `misses`, `refused`, `value_estimate?`, `won?`, `paid?`, `winner_bot_id?`, `reason`, `at`. `at` is the server time of the first log; a later log updates the row and keeps it. |
| `rabbot_word` | `id` autoInc pk, `match_id` idx, `round`, `word`, `reward`, `rack_before`, `think_ms`, `ack_ms?`, `ok`, `err?`, `at` |
| `rabbot_match` | `match_id` pk, `place?`, `seats`, `score?`, `balance?`, `coins_spent`, `auctions_won`, `auctions`, `words`, `word_points`, `unplayed_tiles`, `winner_score?`, `rating_after?`, `agent`, `started_at?`, `ended_at` |
| `rabbot_status` | singleton `id` = 0: `heartbeat_at` (server time), `state`, `current_match?`, `latency_ms`, `clock_offset_ms`, `version`, `rating?`, `rank?` |
| `meta` | `key` pk, `value` (≤ 1 MB), `updated_at` |
| `writer` (private) | `identity` pk, `role`, `label`, `added_at`, `added_by?` |

### Reducers (all refuse non-writers; † owner only)

| Reducer | Args | Notes |
|---|---|---|
| `upsert_bots`, `upsert_bot_stats`, `upsert_retired_bot_stats`, `upsert_bot_versions`, `upsert_matches`, `upsert_participants`, `upsert_auctions`, `upsert_top_bids`, `upsert_words`, `upsert_ratings`, `upsert_tournaments`, `upsert_tournament_entries`, `upsert_tournament_matches`, `upsert_match_mined` | `rows` (≤ 10,000) | Idempotent. An upsert clears `deleted_at`, as the SQLite miner does. |
| `replace_ratings` | `match_ids`, `rows` | Makes those matches' `g_rating` exactly `rows`. |
| `mirror_delete_rows` | `table` (SQL name), `ids`, `at` | Tombstones `g_bot/g_match/g_participant/g_auction/g_top_bid/g_word` (the first stamp wins). Deletes from the other `g_*` tables. |
| `put_derived` | `match_ids`, `infos`, `seats`, `auctions`, `bids`, `plays` (≤ 50,000 rows) | Replaces those matches' `d_*` rows. Refuses rows for other matches, duplicate keys, bad letters and bad kinds. |
| `rebuild_stats` † | none | Recomputes all three sum tables from `d_*`. |
| `put_bid_models` | `rows` (≤ 1,000) | Upsert by `bot_id`. |
| `delete_bid_models` | `bot_ids` | An empty list deletes all. |
| `log_events` | `rows` (≤ 2,000) | Appends to `rabbot_event`. |
| `prune_events` | `before` | Deletes up to 50,000 older events per call. |
| `log_decision`, `log_word`, `log_match`, `heartbeat` | the row's fields | |
| `set_meta`, `delete_meta` | `key`, `value` | |
| `add_writer` †, `remove_writer` † | `identity`, `label` | |

## Client (`src/backend/client.ts`)

```ts
import { connectBackend, createEventSink, sql } from "./backend/client.js";
const b = await connectBackend();             // writer token; throws if the file is missing
await b.upsertAuctions(rows);                 // 5000 rows/call, 4 in flight, 4 MB/call cap
await b.putDerived([{ matchId, info, seats, auctions, bids, plays }]);
await b.subscribeTables(["market_stat", "opp_stat", "seat_stat", "bid_model", "g_bot"]);
const obs = await b.sql("SELECT * FROM d_bid_obs WHERE bot_id = 9");   // no cache cost
const sink = createEventSink();               // live bot: sink.push(type, rec), never throws
```

`connectBackend({ anonymous: true })` is read-only. A refused reducer
rejects its promise with the module's message. Every batch call has a
timeout, every write is idempotent, and retrying a whole batch is safe.
`sql()` returns snake_case objects: timestamps as µs numbers, a none as
`null`, u64 as JS numbers. SpacetimeDB SQL supports `WHERE` (timestamps as
RFC 3339 strings, e.g. `ended_at >= '2026-10-01T00:00:00Z'`), `COUNT(*)`,
`LIMIT` and two-table joins. It does not support `ORDER BY` or `GROUP BY`.

## Measurements (single host, full history)

Real data: `import-sqlite.ts` loading a 5,621-match snapshot of
`data/history.sqlite` into a fresh database (the history has grown since;
see "Miner" for current counts).

| What | Result |
|---|---|
| Mirror tables | 382k `g_auction` in 0.61 s (629k rows/s), 382k `g_top_bid` in 0.37 s, 92k `g_word` 0.18 s, 34k participants 0.06 s |
| Derived, `put_derived` | 2.76M rows (2.24M `d_bid_obs`) in 30 s, 92k rows/s, 20k rows per call (~0.2 s per transaction) |
| Whole import | 42 s, plus 9 s reading SQLite |
| Idempotent re-put of all derived rows | 3.8 s, no writes |
| Server RSS | 345 MB before, 1.4 GB with the full history loaded |
| `sql` `d_bid_obs` for the busiest bot | 70k rows in 207 ms. Subscribing the same rows: 134 ms. |
| Subscribe all 382k `g_auction` | 1.0 s |
| Subscribe every sum table, model and bot | 29 ms |
| `market_stat` vs a recount from the SQLite rows | identical, 130 keys |
| Restart | all counts and sums identical; full-history database answers after ~20 s (commitlog replay), small `rabbot` in ~1 s |
| Largest reducer message | 24 MB accepted; 32 MB drops the connection. The client caps calls at 4 MB. |
