// The opponent model's data, loaded from RackForge's backend instead of the
// miner's SQLite file: the tables model.ts reads are copied (synchronously,
// over the backend's SQL endpoint) into an in-memory SQLite database with
// the miner's schema, so the model's queries run unchanged.
//
// Not copied: d_bid_obs (2.8M rows, ~10 s). The model only reads it to
// decide which bots to refit at load time and for botSummary's bid counts;
// with the backend, the fits come from bid_model (the miner refits hourly
// and pushes them), so no refit happens at load, and botSummary's
// bidObs/exactBids/censoredBids read 0 (opp_stat has those sums).

import { openDb, type Db, type SqlValue } from "../memory/db.js";
import { DEFAULT_DB, DEFAULT_URI, type SqlRow } from "./client.js";
import { sqlSync } from "./sync.js";

export const BACKEND_PREFIX = "stdb:";

/** "stdb:" or "stdb:<db>" or "stdb:<db>@<uri>" -> where to read. */
export function parseBackendPath(p: string): { db: string; uri: string } | undefined {
  if (!p.startsWith(BACKEND_PREFIX)) return undefined;
  const rest = p.slice(BACKEND_PREFIX.length);
  const at = rest.indexOf("@");
  const db = (at >= 0 ? rest.slice(0, at) : rest) || DEFAULT_DB;
  const uri = at >= 0 ? rest.slice(at + 1) : DEFAULT_URI;
  return { db, uri };
}

const v = (x: unknown): SqlValue => {
  if (x === null || x === undefined) return null;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number" || typeof x === "string" || typeof x === "bigint") return x;
  return JSON.stringify(x);
};

export interface LoadTimings {
  table: string;
  rows: number;
  ms: number;
}

/**
 * A fresh in-memory SQLite database holding what the opponent model reads.
 * Throws when the backend can't be reached.
 */
export function backendSnapshotDb(where: { db?: string; uri?: string } = {}, timings: LoadTimings[] = []): Db {
  const o = { db: where.db ?? DEFAULT_DB, uri: where.uri ?? DEFAULT_URI, timeoutMs: 60_000 };
  const mem = openDb(":memory:");
  const copy = (query: string, table: string, cols: string[], row: (r: SqlRow) => unknown[]) => {
    const t0 = performance.now();
    const rows = sqlSync(query, o);
    const st = mem.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    mem.exec("BEGIN");
    try {
      for (const r of rows) st.run(...row(r).map(v));
      mem.exec("COMMIT");
    } catch (e) {
      mem.exec("ROLLBACK");
      throw e;
    }
    timings.push({ table, rows: rows.length, ms: performance.now() - t0 });
  };
  copy("SELECT * FROM g_bot", "bot", ["id", "name", "team_id", "is_simulated", "strategy", "created_us", "deleted_us"], (r) => [
    r.id, r.name, r.team_id, r.is_simulated, r.strategy, r.created_at, r.deleted_at,
  ]);
  copy("SELECT * FROM g_bot_version", "bot_version", ["id", "bot_id", "version", "started_us"], (r) => [
    r.id, r.bot_id, r.version, r.started_at,
  ]);
  copy(
    "SELECT * FROM g_bot_stats",
    "bot_stats",
    ["bot_id", "rating", "matches_played", "wins", "total_score", "last_played_us", "mu", "sigma"],
    (r) => [r.bot_id, r.rating, r.matches_played, r.wins, r.total_score, r.last_played, r.openskill_mu, r.openskill_sigma],
  );
  copy("SELECT * FROM bid_model", "bid_model", ["bot_id", "fitted_us", "data_us", "n_obs", "params"], (r) => [
    r.bot_id, r.fitted_at, r.data_at, r.n_obs, r.params,
  ]);
  copy(
    "SELECT * FROM d_match_info",
    "match_info",
    ["match_id", "n_seats", "n_real", "n_auctions", "expected_auctions", "auction_type", "created_us", "ended_us", "balance_ok", "derived_us"],
    (r) => [r.match_id, r.n_seats, r.n_real, r.n_auctions, r.expected_auctions, r.auction_type, r.created_at, r.ended_at, r.balance_ok, r.derived_at],
  );
  copy(
    "SELECT * FROM d_match_seat",
    "match_seat",
    ["match_id", "bot_id", "is_sim", "strategy", "version", "final_score", "final_balance", "place", "won_tiles", "paid_total", "words", "letters_played", "tiles_left", "ended_us"],
    (r) => [r.match_id, r.bot_id, r.is_sim, r.strategy, r.version, r.final_score, r.final_balance, r.place, r.won_tiles, r.paid_total, r.words, r.letters_played, r.tiles_left, r.ended_at],
  );
  copy(
    "SELECT * FROM d_auction_ctx",
    "auction_ctx",
    ["auction_id", "match_id", "round_idx", "n_auctions", "phase", "letter", "winner_bot_id", "winner_is_sim", "paid", "top_bid", "closed_us", "ended_us", "sim_q"],
    (r) => [r.auction_id, r.match_id, r.round_idx, r.n_auctions, r.phase, r.letter, r.winner_bot_id, r.winner_is_sim, r.paid, r.top_bid, r.closed_at, r.ended_at, r.sim_q],
  );
  copy(
    "SELECT * FROM d_play_obs",
    "play_obs",
    ["word_id", "match_id", "bot_id", "is_sim", "word", "len", "reward", "round_idx", "phase", "rack_before", "balance_before", "ended_us"],
    (r) => [r.word_id, r.match_id, r.bot_id, r.is_sim, r.word, r.len, r.reward, r.round_idx, r.phase, r.rack_before, r.balance_before, r.ended_at],
  );
  return mem;
}

/** Wraps a database so callers that close it after each use don't. */
export function keepOpen(db: Db): Db {
  return { exec: (s) => db.exec(s), prepare: (s) => db.prepare(s), close: () => {} };
}
