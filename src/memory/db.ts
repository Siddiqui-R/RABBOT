// SQLite home of the mined history. One writer (the miner) and any number of
// readers (bot, model, tools) share the file, so it runs in WAL mode with a
// busy timeout: readers never block the writer and a brief lock just waits.
//
// Timestamps are server microseconds (`*_us`). Rows mirrored from the server
// keep the server's primary keys so every write is an idempotent upsert.

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

// @types/node 20 has no `node:sqlite` typings, and a global `declare module`
// could clash with another directory's copy, so declare just what we use.
export type SqlValue = number | bigint | string | null | Uint8Array;
export interface Stmt {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
  all(...params: SqlValue[]): Record<string, SqlValue>[];
  iterate(...params: SqlValue[]): IterableIterator<Record<string, SqlValue>>;
}
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (file: string, opts?: { readOnly?: boolean; timeout?: number }) => Db;
}

let sqlite: SqliteModule | undefined;
function sqliteModule(): SqliteModule {
  if (!sqlite) {
    // Node 22 flags node:sqlite as experimental on first load; that warning
    // is noise for every tool that opens the history.
    const emit = process.emitWarning;
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
      if (String(w).includes("SQLite is an experimental")) return;
      return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    try {
      sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
    } finally {
      process.emitWarning = emit;
    }
  }
  return sqlite;
}

export const DEFAULT_DB_PATH = path.join(import.meta.dirname, "..", "..", "data", "history.sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- Mirrors of public server tables. deleted_us tombstones history rows the
-- server deleted: we keep the history, but remember it went away.
CREATE TABLE IF NOT EXISTS bot (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, team_id INTEGER, is_simulated INTEGER NOT NULL,
  strategy TEXT NOT NULL, created_us INTEGER, deleted_us INTEGER);
CREATE TABLE IF NOT EXISTS bot_stats (
  bot_id INTEGER PRIMARY KEY, rating INTEGER, matches_played INTEGER, wins INTEGER,
  total_score INTEGER, last_played_us INTEGER, mu REAL, sigma REAL);
CREATE TABLE IF NOT EXISTS retired_bot_stats (
  id INTEGER PRIMARY KEY, bot_id INTEGER, version INTEGER, rating INTEGER, matches_played INTEGER,
  wins INTEGER, total_score INTEGER, last_played_us INTEGER, mu REAL, sigma REAL);
CREATE TABLE IF NOT EXISTS bot_version (
  id INTEGER PRIMARY KEY, bot_id INTEGER NOT NULL, version INTEGER NOT NULL, started_us INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS match_state (
  id INTEGER PRIMARY KEY, status TEXT NOT NULL, current_round INTEGER, current_auction_id INTEGER,
  bag_total INTEGER, auction_type TEXT, created_us INTEGER, started_us INTEGER, ended_us INTEGER,
  auction_duration_ms INTEGER, starting_rack_size INTEGER, deleted_us INTEGER);
CREATE TABLE IF NOT EXISTS match_participant (
  id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL, bot_id INTEGER NOT NULL, balance INTEGER,
  score INTEGER, deleted_us INTEGER);
CREATE INDEX IF NOT EXISTS mp_match ON match_participant(match_id);
CREATE INDEX IF NOT EXISTS mp_bot ON match_participant(bot_id);
CREATE TABLE IF NOT EXISTS auction_result (
  auction_id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL, letter TEXT NOT NULL,
  winner_bot_id INTEGER, paid INTEGER NOT NULL, closed_us INTEGER NOT NULL, deleted_us INTEGER);
CREATE INDEX IF NOT EXISTS ar_match ON auction_result(match_id);
CREATE TABLE IF NOT EXISTS auction_top_bid_archive (
  auction_id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL, top_bid INTEGER NOT NULL, deleted_us INTEGER);
CREATE INDEX IF NOT EXISTS tba_match ON auction_top_bid_archive(match_id);
CREATE TABLE IF NOT EXISTS word_play (
  id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL, bot_id INTEGER NOT NULL, word TEXT NOT NULL,
  base_score INTEGER, bonus INTEGER, total_reward INTEGER NOT NULL, played_us INTEGER NOT NULL,
  deleted_us INTEGER);
CREATE INDEX IF NOT EXISTS wp_match ON word_play(match_id);
CREATE INDEX IF NOT EXISTS wp_bot ON word_play(bot_id);
CREATE TABLE IF NOT EXISTS rating_history (
  id INTEGER PRIMARY KEY, bot_id INTEGER NOT NULL, match_id INTEGER NOT NULL, at_us INTEGER,
  mu REAL, sigma REAL);
CREATE INDEX IF NOT EXISTS rh_bot ON rating_history(bot_id);
CREATE INDEX IF NOT EXISTS rh_match ON rating_history(match_id);
CREATE TABLE IF NOT EXISTS tournament (
  id INTEGER PRIMARY KEY, status TEXT, swiss_rounds_total INTEGER, current_round INTEGER,
  top_cut INTEGER, match_size INTEGER, auction_type TEXT, created_us INTEGER, ended_us INTEGER,
  winner_bot_id INTEGER);
CREATE TABLE IF NOT EXISTS tournament_entry (
  id INTEGER PRIMARY KEY, tournament_id INTEGER, bot_id INTEGER, swiss_points INTEGER,
  eliminated INTEGER, total_score INTEGER, final_finish_position INTEGER);
CREATE TABLE IF NOT EXISTS tournament_match (
  id INTEGER PRIMARY KEY, tournament_id INTEGER, match_id INTEGER, round INTEGER, phase TEXT);

-- Which matches have had their per-match rows fetched; complete = fetched
-- after the match ended, so it never needs fetching again.
CREATE TABLE IF NOT EXISTS match_mined (
  match_id INTEGER PRIMARY KEY, complete INTEGER NOT NULL, mined_us INTEGER NOT NULL);

-- Derived, rebuilt per match by derive.ts.
CREATE TABLE IF NOT EXISTS match_info (
  match_id INTEGER PRIMARY KEY, n_seats INTEGER, n_real INTEGER, n_auctions INTEGER,
  expected_auctions INTEGER, auction_type TEXT, created_us INTEGER, ended_us INTEGER,
  balance_ok INTEGER, derived_us INTEGER);
CREATE INDEX IF NOT EXISTS mi_ended ON match_info(ended_us);
CREATE TABLE IF NOT EXISTS match_seat (
  match_id INTEGER NOT NULL, bot_id INTEGER NOT NULL, is_sim INTEGER NOT NULL, strategy TEXT,
  version INTEGER, final_score INTEGER, final_balance INTEGER, place INTEGER, won_tiles INTEGER,
  paid_total INTEGER, words INTEGER, letters_played INTEGER, tiles_left INTEGER, ended_us INTEGER,
  PRIMARY KEY (match_id, bot_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ms_bot ON match_seat(bot_id);
CREATE TABLE IF NOT EXISTS auction_ctx (
  auction_id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL, round_idx INTEGER NOT NULL,
  n_auctions INTEGER NOT NULL, phase REAL NOT NULL, letter TEXT NOT NULL, winner_bot_id INTEGER,
  winner_is_sim INTEGER, paid INTEGER NOT NULL, top_bid INTEGER, closed_us INTEGER, ended_us INTEGER,
  sim_q REAL);
CREATE INDEX IF NOT EXISTS ac_match ON auction_ctx(match_id);
CREATE INDEX IF NOT EXISTS ac_ended ON auction_ctx(ended_us);
-- One row per (auction, real bot seated): what its sealed bid is known to
-- be. kind 0 = exactly value, 1 = at most value, 2 = at least value.
CREATE TABLE IF NOT EXISTS bid_obs (
  auction_id INTEGER NOT NULL, bot_id INTEGER NOT NULL, match_id INTEGER NOT NULL,
  letter TEXT NOT NULL, round_idx INTEGER NOT NULL, phase REAL NOT NULL, balance INTEGER NOT NULL,
  cap INTEGER NOT NULL, rack_size INTEGER NOT NULL, kind INTEGER NOT NULL, value INTEGER NOT NULL,
  won INTEGER NOT NULL, others_max INTEGER, version INTEGER NOT NULL, ended_us INTEGER NOT NULL,
  PRIMARY KEY (auction_id, bot_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bo_bot ON bid_obs(bot_id, ended_us);
CREATE INDEX IF NOT EXISTS bo_ended ON bid_obs(ended_us);
CREATE TABLE IF NOT EXISTS play_obs (
  word_id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL, bot_id INTEGER NOT NULL,
  is_sim INTEGER NOT NULL, word TEXT NOT NULL, len INTEGER NOT NULL, reward INTEGER NOT NULL,
  round_idx INTEGER NOT NULL, phase REAL NOT NULL, rack_before INTEGER NOT NULL,
  balance_before INTEGER NOT NULL, ended_us INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS po_bot ON play_obs(bot_id);

-- Fitted bid models; bot_id 0 is the market. data_us is the newest
-- observation the fit saw, so a reader knows whether it's stale.
CREATE TABLE IF NOT EXISTS bid_model (
  bot_id INTEGER PRIMARY KEY, fitted_us INTEGER, data_us INTEGER, n_obs INTEGER, params TEXT);
`;

export interface OpenOptions {
  readOnly?: boolean;
  /** ms to wait on a locked database before failing. */
  busyTimeoutMs?: number;
}

export function openDb(dbPath: string = DEFAULT_DB_PATH, opts: OpenOptions = {}): Db {
  const { DatabaseSync } = sqliteModule();
  const timeout = opts.busyTimeoutMs ?? 10_000;
  if (opts.readOnly) {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout });
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
    db.exec("PRAGMA cache_size = -65536");
    return db;
  }
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout });
  db.exec(`PRAGMA busy_timeout = ${timeout}`);
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // The derived indexes outgrow SQLite's 2 MB default cache; a bigger one
  // turns the rebuild from disk-bound to CPU-bound.
  db.exec("PRAGMA cache_size = -262144");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after a table first shipped: add them to older files.
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [["auction_ctx", "sim_q", "REAL"]];

function migrate(db: Db): void {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** Runs `fn` in one transaction; rolls back if it throws. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? String(row.value) : undefined;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Numeric column helper: SQLite hands back number | bigint | null. */
export function num(v: SqlValue | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "bigint" ? Number(v) : Number(v);
}

export function numOrNull(v: SqlValue | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}

/** Upsert statement builder: INSERT ... ON CONFLICT(pk) DO UPDATE every other column. */
export function upsertSql(table: string, cols: string[], pk: string[]): string {
  const ph = cols.map(() => "?").join(", ");
  const set = cols
    .filter((c) => !pk.includes(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph}) ON CONFLICT(${pk.join(", ")}) DO UPDATE SET ${set}`;
}
