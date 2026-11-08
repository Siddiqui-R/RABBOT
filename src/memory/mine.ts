// History miner: mirrors every public match into data/history.sqlite.
//
//   npm run mine                  backfill everything not yet mined, derive, fit, exit
//   npm run mine -- --follow      then stay connected and apply live changes
//
// Flags: --db <path>  --chunk <matches per subscription>  --no-derive  --no-fit
//        --rederive (rebuild all derived rows)  --fit-every <minutes> (follow mode)
//        --no-backend (don't mirror into RABBOT's SpacetimeDB backend)
//        --sync-every <seconds> (backend sync period, default 3)
//
// SQLite is the miner's working copy; src/backend/mirror-sync.ts pushes
// every difference (mirror rows, derived rows, bid models) to the `rabbot`
// database on the local rabbot-stdb server, which is RABBOT's store of record.
// The backend being down never stops the miner; the next sync repairs it.
//
// Anonymous, read-only: no token, no reducer calls, and only NAMED public
// tables. Never `subscribeToAllTables()` and never `visible_auction_top_bids`
// (live winning bids that the rules hide from bots).

import {
  DbConnection,
  type EventContext,
  type SubscriptionHandle,
} from "../module_bindings/index.js";
import type {
  AuctionResult,
  AuctionTopBidArchive,
  Bot,
  BotStats,
  BotVersion,
  Match,
  MatchParticipant,
  RatingHistory,
  RetiredBotStats,
  Tournament,
  TournamentEntry,
  TournamentMatch,
  WordPlay,
} from "../module_bindings/types.js";
import { openDb, setMeta, tx, upsertSql, DEFAULT_DB_PATH, type Db, type SqlValue } from "./db.js";
import { deriveAll } from "./derive.js";
import { isMain } from "./util.js";
import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { MirrorSync } from "../backend/mirror-sync.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";

type Ts = { microsSinceUnixEpoch: bigint };
const us = (t: Ts | undefined | null): number | null => (t ? Number(t.microsSinceUnixEpoch) : null);
const n = (v: bigint | number | undefined | null): number | null =>
  v === undefined || v === null ? null : Number(v);

// Structural view of a generated table handle: enough to read the cache
// and hear about changes.
interface Handle<R> {
  iter(): Iterable<R>;
  onInsert(cb: (ctx: EventContext, row: R) => void): void;
  onDelete(cb: (ctx: EventContext, row: R) => void): void;
  onUpdate?(cb: (ctx: EventContext, old: R, row: R) => void): void;
}

interface Spec<R> {
  table: string;
  handle(c: DbConnection): Handle<R>;
  cols: string[];
  pk: string;
  values(r: R): SqlValue[];
  /** Per-match tables are fetched in match_id chunks. */
  matchId?(r: R): number;
  /** History tables keep deleted rows, marked; state tables mirror deletes. */
  tombstone: boolean;
}

function spec<R>(s: Spec<R>): Spec<R> {
  return s;
}

const BOT = spec<Bot>({
  table: "bot",
  handle: (c) => c.db.bot,
  cols: ["id", "name", "team_id", "is_simulated", "strategy", "created_us", "deleted_us"],
  pk: "id",
  values: (r) => [n(r.id), r.name, n(r.teamId), r.isSimulated ? 1 : 0, r.strategy.tag, us(r.createdAt), null],
  tombstone: true,
});
const BOT_STATS = spec<BotStats>({
  table: "bot_stats",
  handle: (c) => c.db.botStats,
  cols: ["bot_id", "rating", "matches_played", "wins", "total_score", "last_played_us", "mu", "sigma"],
  pk: "bot_id",
  values: (r) => [
    n(r.botId), r.rating, r.matchesPlayed, r.wins, n(r.totalScore), us(r.lastPlayed),
    r.openskillMu, r.openskillSigma,
  ],
  tombstone: false,
});
const RETIRED = spec<RetiredBotStats>({
  table: "retired_bot_stats",
  handle: (c) => c.db.retiredBotStats,
  cols: ["id", "bot_id", "version", "rating", "matches_played", "wins", "total_score", "last_played_us", "mu", "sigma"],
  pk: "id",
  values: (r) => [
    n(r.id), n(r.botId), r.version, r.rating, r.matchesPlayed, r.wins, n(r.totalScore),
    us(r.lastPlayed), r.openskillMu, r.openskillSigma,
  ],
  tombstone: false,
});
const BOT_VERSION = spec<BotVersion>({
  table: "bot_version",
  handle: (c) => c.db.botVersion,
  cols: ["id", "bot_id", "version", "started_us"],
  pk: "id",
  values: (r) => [n(r.id), n(r.botId), r.version, us(r.startedAt)],
  tombstone: false,
});
const MATCH = spec<Match>({
  table: "match_state",
  handle: (c) => c.db.matchState,
  cols: [
    "id", "status", "current_round", "current_auction_id", "bag_total", "auction_type", "created_us",
    "started_us", "ended_us", "auction_duration_ms", "starting_rack_size", "deleted_us",
  ],
  pk: "id",
  values: (r) => [
    n(r.id), r.status.tag, r.currentRound, n(r.currentAuctionId), r.bagTotal, r.auctionType.tag,
    us(r.createdAt), us(r.startedAt), us(r.endedAt), n(r.auctionDurationMs), r.startingRackSize, null,
  ],
  tombstone: true,
});
const TOURNAMENT = spec<Tournament>({
  table: "tournament",
  handle: (c) => c.db.tournament,
  cols: [
    "id", "status", "swiss_rounds_total", "current_round", "top_cut", "match_size", "auction_type",
    "created_us", "ended_us", "winner_bot_id",
  ],
  pk: "id",
  values: (r) => [
    n(r.id), r.status.tag, r.swissRoundsTotal, r.currentRound, r.topCut, r.matchSize, r.auctionType.tag,
    us(r.createdAt), us(r.endedAt), n(r.winnerBotId),
  ],
  tombstone: false,
});
const TOURNAMENT_ENTRY = spec<TournamentEntry>({
  table: "tournament_entry",
  handle: (c) => c.db.tournamentEntry,
  cols: ["id", "tournament_id", "bot_id", "swiss_points", "eliminated", "total_score", "final_finish_position"],
  pk: "id",
  values: (r) => [
    n(r.id), n(r.tournamentId), n(r.botId), r.swissPoints, r.eliminated ? 1 : 0, n(r.totalScore),
    n(r.finalFinishPosition),
  ],
  tombstone: false,
});
const TOURNAMENT_MATCH = spec<TournamentMatch>({
  table: "tournament_match",
  handle: (c) => c.db.tournamentMatch,
  cols: ["id", "tournament_id", "match_id", "round", "phase"],
  pk: "id",
  values: (r) => [n(r.id), n(r.tournamentId), n(r.matchId), r.round, r.phase.tag],
  tombstone: false,
});

const PARTICIPANT = spec<MatchParticipant>({
  table: "match_participant",
  handle: (c) => c.db.matchParticipant,
  cols: ["id", "match_id", "bot_id", "balance", "score", "deleted_us"],
  pk: "id",
  values: (r) => [n(r.id), n(r.matchId), n(r.botId), n(r.balance), n(r.score), null],
  matchId: (r) => Number(r.matchId),
  tombstone: true,
});
const RESULT = spec<AuctionResult>({
  table: "auction_result",
  handle: (c) => c.db.auctionResult,
  cols: ["auction_id", "match_id", "letter", "winner_bot_id", "paid", "closed_us", "deleted_us"],
  pk: "auction_id",
  values: (r) => [n(r.auctionId), n(r.matchId), r.letter, n(r.winnerBotId), n(r.paid), us(r.closedAt), null],
  matchId: (r) => Number(r.matchId),
  tombstone: true,
});
const ARCHIVE = spec<AuctionTopBidArchive>({
  table: "auction_top_bid_archive",
  handle: (c) => c.db.auctionTopBidArchive,
  cols: ["auction_id", "match_id", "top_bid", "deleted_us"],
  pk: "auction_id",
  values: (r) => [n(r.auctionId), n(r.matchId), n(r.topBid), null],
  matchId: (r) => Number(r.matchId),
  tombstone: true,
});
const WORD = spec<WordPlay>({
  table: "word_play",
  handle: (c) => c.db.wordPlay,
  cols: ["id", "match_id", "bot_id", "word", "base_score", "bonus", "total_reward", "played_us", "deleted_us"],
  pk: "id",
  values: (r) => [
    n(r.id), n(r.matchId), n(r.botId), r.word, n(r.baseScore), n(r.bonus), n(r.totalReward),
    us(r.playedAt), null,
  ],
  matchId: (r) => Number(r.matchId),
  tombstone: true,
});
// backfill_elo rebuilds this table with fresh ids, so it's replaced per
// match rather than tombstoned.
const RATING = spec<RatingHistory>({
  table: "rating_history",
  handle: (c) => c.db.ratingHistory,
  cols: ["id", "bot_id", "match_id", "at_us", "mu", "sigma"],
  pk: "id",
  values: (r) => [n(r.id), n(r.botId), n(r.matchId), us(r.at), r.openskillMu, r.openskillSigma],
  matchId: (r) => Number(r.matchId),
  tombstone: false,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpec = Spec<any>;
const BASE: AnySpec[] = [BOT, BOT_STATS, RETIRED, BOT_VERSION, MATCH, TOURNAMENT, TOURNAMENT_ENTRY, TOURNAMENT_MATCH];
const PER_MATCH: AnySpec[] = [PARTICIPANT, RESULT, ARCHIVE, WORD, RATING];
const ALL: AnySpec[] = [...BASE, ...PER_MATCH];

const baseQueries = () => BASE.map((s) => `SELECT * FROM ${s.table}`);
const rangeQueries = (lo: number, hi: number) =>
  PER_MATCH.map((s) => `SELECT * FROM ${s.table} WHERE match_id >= ${lo} AND match_id <= ${hi}`);
const followQueries = (above: number) => PER_MATCH.map((s) => `SELECT * FROM ${s.table} WHERE match_id > ${above}`);

// ---------- SQLite writers ----------

class Writer {
  private up = new Map<string, ReturnType<Db["prepare"]>>();
  private del = new Map<string, ReturnType<Db["prepare"]>>();
  constructor(readonly db: Db) {}

  upsert(s: AnySpec, row: unknown): void {
    let st = this.up.get(s.table);
    if (!st) this.up.set(s.table, (st = this.db.prepare(upsertSql(s.table, s.cols, [s.pk]))));
    st.run(...s.values(row));
  }

  remove(s: AnySpec, row: unknown, nowUs: number): void {
    let st = this.del.get(s.table);
    if (!st) {
      st = this.db.prepare(
        s.tombstone
          ? `UPDATE ${s.table} SET deleted_us = ? WHERE ${s.pk} = ?`
          : `DELETE FROM ${s.table} WHERE ${s.pk} = ?`,
      );
      this.del.set(s.table, st);
    }
    const key = s.values(row)[0]!;
    if (s.tombstone) st.run(nowUs, key);
    else st.run(key);
  }
}

/** Mirrors a whole base table from the cache, including server-side deletes. */
function writeBaseTable(w: Writer, conn: DbConnection, s: AnySpec, nowUs: number): number {
  const keys = new Set<number>();
  let count = 0;
  for (const r of s.handle(conn).iter()) {
    w.upsert(s, r);
    keys.add(Number(s.values(r)[0]));
    count++;
  }
  const local = w.db.prepare(`SELECT ${s.pk} AS k FROM ${s.table}${s.tombstone ? " WHERE deleted_us IS NULL" : ""}`).all();
  for (const row of local) {
    const k = Number(row.k);
    if (!keys.has(k)) {
      if (s.tombstone) w.db.prepare(`UPDATE ${s.table} SET deleted_us = ? WHERE ${s.pk} = ?`).run(nowUs, k);
      else w.db.prepare(`DELETE FROM ${s.table} WHERE ${s.pk} = ?`).run(k);
    }
  }
  return count;
}

function writeBase(w: Writer, conn: DbConnection): Record<string, number> {
  const nowUs = Date.now() * 1000;
  const counts: Record<string, number> = {};
  tx(w.db, () => {
    for (const s of BASE) counts[s.table] = writeBaseTable(w, conn, s, nowUs);
  });
  return counts;
}

/**
 * Writes one chunk of per-match rows. Each fetched match is replaced as a
 * whole for rating_history (whose ids change on rebuilds); the rest upsert.
 */
function writeChunk(w: Writer, conn: DbConnection, ids: number[]): Record<string, number> {
  const want = new Set(ids);
  const counts: Record<string, number> = {};
  const nowUs = Date.now() * 1000;
  tx(w.db, () => {
    const clearRating = w.db.prepare("DELETE FROM rating_history WHERE match_id = ?");
    for (const id of ids) clearRating.run(id);
    for (const s of PER_MATCH) {
      let c = 0;
      for (const r of s.handle(conn).iter()) {
        if (!want.has(s.matchId!(r))) continue;
        w.upsert(s, r);
        c++;
      }
      counts[s.table] = c;
    }
    // A match whose cached status is Ended had all its rows in this
    // snapshot (archive rows are written in the same transaction as the end).
    const mark = w.db.prepare(
      "INSERT INTO match_mined(match_id, complete, mined_us) VALUES (?, ?, ?) " +
        "ON CONFLICT(match_id) DO UPDATE SET complete = excluded.complete, mined_us = excluded.mined_us",
    );
    for (const id of ids) {
      const m = conn.db.matchState.id.find(BigInt(id));
      if (m) w.upsert(MATCH, m);
      mark.run(id, m?.status.tag === "Ended" ? 1 : 0, nowUs);
    }
  });
  return counts;
}

/** Matches the server has that we haven't fully mined, ascending. */
function matchesToFetch(db: Db, conn: DbConnection): number[] {
  const done = new Set(
    db.prepare("SELECT match_id FROM match_mined WHERE complete = 1").all().map((r) => Number(r.match_id)),
  );
  const ids: number[] = [];
  for (const m of conn.db.matchState.iter()) {
    const id = Number(m.id);
    if (!done.has(id)) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

/** Highest id below which every known match is complete. */
function completeBelow(db: Db, conn: DbConnection): number {
  const todo = matchesToFetch(db, conn);
  if (todo.length > 0) return todo[0]! - 1;
  let max = 0;
  for (const m of conn.db.matchState.iter()) max = Math.max(max, Number(m.id));
  return max;
}

// ---------- connection plumbing ----------

function connect(): Promise<{ conn: DbConnection; closed: Promise<string> }> {
  return new Promise((resolve, reject) => {
    let resolveClosed!: (why: string) => void;
    const closed = new Promise<string>((r) => (resolveClosed = r));
    DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      // No token: an anonymous identity that holds no bot credential.
      .onConnect((conn) => resolve({ conn, closed }))
      .onConnectError((_ctx, err) => {
        reject(err);
        resolveClosed(`connect error: ${err.message}`);
      })
      .onDisconnect((_ctx, err) => resolveClosed(err ? `disconnected: ${err.message}` : "disconnected"))
      .build();
  });
}

function subscribe(conn: DbConnection, queries: string[], timeoutMs = 120_000): Promise<SubscriptionHandle> {
  for (const q of queries) {
    if (/visible_auction_top_bids/i.test(q)) throw new Error("refusing to read visible_auction_top_bids");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`subscription timed out: ${queries[0]}`)), timeoutMs);
    const handle: SubscriptionHandle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        clearTimeout(timer);
        resolve(handle);
      })
      .onError((ctx) => {
        clearTimeout(timer);
        reject(ctx.event ?? new Error("subscription error"));
      })
      .subscribe(queries);
  });
}

function unsubscribe(handle: SubscriptionHandle): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 30_000);
    try {
      handle.unsubscribeThen(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- live changes ----------

type Op = { s: AnySpec; row: unknown; del: boolean };

/**
 * Queues every live change and flushes them in one transaction per tick.
 * Rows that enter or leave the cache because WE (un)subscribed are not
 * server changes and are ignored: snapshots are written from onApplied.
 */
class LiveSink {
  private ops: Op[] = [];
  endedSinceFlush = 0;
  constructor(private w: Writer) {}

  attach(conn: DbConnection): void {
    const live = (ctx: EventContext) => ctx.event.tag === "Transaction" || ctx.event.tag === "Reducer";
    for (const s of ALL) {
      const h = s.handle(conn);
      h.onInsert((ctx, row) => live(ctx) && this.ops.push({ s, row, del: false }));
      h.onDelete((ctx, row) => live(ctx) && this.ops.push({ s, row, del: true }));
      h.onUpdate?.((ctx, _old, row) => live(ctx) && this.ops.push({ s, row, del: false }));
    }
  }

  flush(): number {
    if (this.ops.length === 0) return 0;
    const ops = this.ops;
    this.ops = [];
    const nowUs = Date.now() * 1000;
    tx(this.w.db, () => {
      const mark = this.w.db.prepare(
        "INSERT INTO match_mined(match_id, complete, mined_us) VALUES (?, 1, ?) " +
          "ON CONFLICT(match_id) DO UPDATE SET complete = 1, mined_us = excluded.mined_us",
      );
      for (const op of ops) {
        if (op.del) this.w.remove(op.s, op.row, nowUs);
        else this.w.upsert(op.s, op.row);
        if (op.s === MATCH && !op.del && (op.row as Match).status.tag === "Ended") {
          mark.run(Number((op.row as Match).id), nowUs);
          this.endedSinceFlush++;
        }
      }
    });
    return ops.length;
  }
}

// ---------- the session ----------

interface Options {
  dbPath: string;
  recent?: number;
  follow: boolean;
  chunk: number;
  derive: boolean;
  fit: boolean;
  rederive: boolean;
  fitEveryMin: number;
  backend: boolean;
  syncEverySec: number;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    dbPath: DEFAULT_DB_PATH,
    follow: false,
    chunk: 250,
    derive: true,
    fit: true,
    rederive: false,
    fitEveryMin: 60,
    backend: true,
    syncEverySec: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--follow") o.follow = true;
    else if (a === "--db") o.dbPath = argv[++i]!;
    else if (a === "--chunk") o.chunk = Math.max(10, Number(argv[++i]));
    else if (a === "--recent") {
      const count = Number(argv[++i]);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('--recent needs a positive integer');
      o.recent = count;
    }
    else if (a === "--no-derive") o.derive = false;
    else if (a === "--no-fit") o.fit = false;
    else if (a === "--rederive") o.rederive = true;
    else if (a === "--fit-every") o.fitEveryMin = Number(argv[++i]);
    else if (a === "--no-backend") o.backend = false;
    else if (a === "--sync-every") o.syncEverySec = Math.max(1, Number(argv[++i]));
    else throw new Error(`unknown flag ${a}`);
  }
  return o;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function fitInProcess(dbPath: string): Promise<void> {
  const { fitAndPersist } = await import("./train.js");
  const t = Date.now();
  const r = fitAndPersist(dbPath);
  log(`fitted ${r.bots} bot models + market from ${r.obs} observations in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

/**
 * The fit takes ~1 min of CPU and is synchronous, which would stall both
 * connections (the backend's drops). Run it in a child process at lower
 * priority; SQLite's WAL lets it write while we keep mining.
 */
async function fitAndPersistSafe(dbPath: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "--fit-only", "--db", dbPath], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      try {
        if (child.pid) setPriority(child.pid, 15);
      } catch {
        /* keep the inherited priority */
      }
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fit exited with ${code}`))));
    });
  } catch (e) {
    log("model fit failed:", e instanceof Error ? e.message : e);
  }
}

/** One connection's life: backfill, then (optionally) follow until it drops. */
async function session(o: Options, db: Db, w: Writer): Promise<string> {
  const t0 = Date.now();
  const { conn, closed } = await connect();
  log("connected (anonymous)");
  const sink = new LiveSink(w);
  sink.attach(conn);
  try {
    await subscribe(conn, baseQueries());
    const baseCounts = writeBase(w, conn);
    log("base tables:", JSON.stringify(baseCounts));

    const allTodo = matchesToFetch(db, conn);
    const todo = o.recent ? allTodo.slice(-o.recent) : allTodo;
    log(`${todo.length} matches to fetch in chunks of ${o.chunk}`);
    const totals: Record<string, number> = {};
    for (let i = 0; i < todo.length; i += o.chunk) {
      const ids = todo.slice(i, i + o.chunk);
      const h = await subscribe(conn, rangeQueries(ids[0]!, ids.at(-1)!));
      const counts = writeChunk(w, conn, ids);
      for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + v;
      await unsubscribe(h);
      sink.flush();
      if ((i / o.chunk) % 5 === 0 || i + o.chunk >= todo.length) {
        log(`  matches ${ids[0]}..${ids.at(-1)} (${Math.min(i + o.chunk, todo.length)}/${todo.length})`, JSON.stringify(counts));
      }
      await sleep(150); // be gentle
    }
    writeBase(w, conn);
    sink.flush();
    setMeta(db, "last_backfill_us", String(Date.now() * 1000));
    log(`backfill done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(totals));

    if (o.derive) {
      const t = Date.now();
      const d = deriveAll(db, { rebuild: o.rederive });
      log(`derived ${d.matches} matches (${d.bidObs} bid obs, ${d.playObs} plays, ${d.balanceMismatches} balance mismatches) in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      o.rederive = false;
    }
    if (o.fit) await fitAndPersistSafe(o.dbPath);
    if (!o.follow) return "done";

    // Follow: stream every per-match row above what's already complete.
    let floor = completeBelow(db, conn);
    let followHandle = await subscribe(conn, followQueries(floor));
    tx(db, () => {
      for (const s of PER_MATCH) for (const r of s.handle(conn).iter()) w.upsert(s, r);
    });
    log(`following live changes above match ${floor}`);

    let lastFit = Date.now();
    let lastWindow = Date.now();
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        sink.flush();
        if (sink.endedSinceFlush > 0 && o.derive) {
          sink.endedSinceFlush = 0;
          deriveAll(db);
        }
        // Slide the window up so the client cache doesn't grow forever.
        if (Date.now() - lastWindow > 30 * 60_000) {
          lastWindow = Date.now();
          const next = completeBelow(db, conn);
          if (next > floor + 200) {
            const h = await subscribe(conn, followQueries(next));
            await unsubscribe(followHandle);
            followHandle = h;
            floor = next;
            log(`follow window moved above match ${floor}`);
          }
        }
        if (o.fit && o.fitEveryMin > 0 && Date.now() - lastFit > o.fitEveryMin * 60_000) {
          lastFit = Date.now();
          await fitAndPersistSafe(o.dbPath);
        }
      } catch (e) {
        log("follow tick failed:", e instanceof Error ? e.message : e);
      } finally {
        busy = false;
      }
    }, 1000);
    const why = await closed;
    clearInterval(timer);
    sink.flush();
    return why;
  } finally {
    try {
      conn.disconnect();
    } catch {
      /* already closed */
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--fit-only") {
    // Child of fitAndPersistSafe.
    await fitInProcess(parseArgs(argv.slice(1)).dbPath);
    process.exit(0);
  }
  const o = parseArgs(argv);
  const db = openDb(o.dbPath);
  const w = new Writer(db);
  const sync = o.backend ? new MirrorSync(db, { log: (m) => log(m) }) : undefined;
  if (sync) {
    void sync.tick();
    sync.start(o.syncEverySec * 1000);
  }
  let backoff = 1000;
  for (;;) {
    const started = Date.now();
    try {
      const why = await session(o, db, w);
      if (!o.follow) break;
      log(`session ended: ${why}`);
    } catch (e) {
      log("session failed:", e instanceof Error ? e.message : e);
      if (!o.follow) {
        await sync?.stop();
        db.close();
        process.exit(1);
      }
    }
    // A session that lived a while earns a fresh backoff.
    if (Date.now() - started > 5 * 60_000) backoff = 1000;
    log(`reconnecting in ${backoff / 1000}s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
  if (sync) {
    // One-shot run: make sure the backend has everything before exiting.
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      ok = await sync.tick();
      if (!ok) await sleep(2_000);
    }
    log(ok ? "backend in sync" : "backend sync incomplete (the next run repairs it)");
    await sync.stop();
  }
  db.close();
  process.exit(0);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
