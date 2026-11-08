// Node client for RABBOT's own SpacetimeDB backend (database `rabbot` on the
// local rabbot-stdb server, 127.0.0.1:3013). Imports only the generated
// bindings, the SDK and node built-ins, so it stays stable while the rest
// of the bot changes around it.
//
// Writes go through reducers that check an allow-list, so a process must
// connect with the writer token (~/.config/rabbot/writer.token) to write;
// any connection can read the public tables.
//
// Reading: small or hot tables via `subscribe*` (rows land in `conn.db`,
// kept live); big scans (d_bid_obs is ~2M rows) via `sql()` per bot or per
// range, which costs no client cache (a subscribed row costs ~1 KB of RSS).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Timestamp, type Identity } from "spacetimedb";
import { DbConnection, type SubscriptionHandle } from "../backend_bindings/index.js";
import type {
  BidModel,
  DAuctionCtx,
  DBidObs,
  DMatchInfo,
  DMatchSeat,
  DPlayObs,
  GAuction,
  GBot,
  GBotStats,
  GBotVersion,
  GMatch,
  GMatchMined,
  GParticipant,
  GRating,
  GRetiredBotStats,
  GTopBid,
  GTournament,
  GTournamentEntry,
  GTournamentMatch,
  GWord,
  RABBOTMatch,
} from "../backend_bindings/types.js";

export type {
  BidModel, DAuctionCtx, DBidObs, DMatchInfo, DMatchSeat, DPlayObs, GAuction, GBot, GBotStats,
  GBotVersion, GMatch, GMatchMined, GParticipant, GRating, GRetiredBotStats, GTopBid, GTournament,
  GTournamentEntry, GTournamentMatch, GWord, RABBOTMatch,
};
export { DbConnection, Timestamp, type SubscriptionHandle };

export const DEFAULT_URI = process.env.RABBOT_STDB_URI ?? "http://127.0.0.1:3013";
export const DEFAULT_DB = process.env.RABBOT_STDB_DB ?? "rabbot";
export const WRITER_TOKEN_PATH =
  process.env.RABBOT_WRITER_TOKEN_PATH ?? join(homedir(), ".config", "rabbot", "writer.token");

/** SQL names of every public table, for `subscribeTables`. */
export const TABLES = [
  "g_bot", "g_bot_stats", "g_retired_bot_stats", "g_bot_version", "g_match", "g_participant",
  "g_auction", "g_top_bid", "g_word", "g_rating", "g_tournament", "g_tournament_entry",
  "g_tournament_match", "g_match_mined",
  "d_match_info", "d_match_seat", "d_auction_ctx", "d_bid_obs", "d_play_obs",
  "market_stat", "opp_stat", "seat_stat", "bid_model",
  "rabbot_event", "rabbot_decision", "rabbot_word", "rabbot_match", "rabbot_status", "meta",
] as const;
export type TableName = (typeof TABLES)[number];

/** Tables `mirrorDelete` accepts: tombstoned (history) or deleted (state). */
export type MirrorTable =
  | "g_bot" | "g_match" | "g_participant" | "g_auction" | "g_top_bid" | "g_word"
  | "g_bot_stats" | "g_retired_bot_stats" | "g_bot_version" | "g_rating" | "g_tournament"
  | "g_tournament_entry" | "g_tournament_match" | "g_match_mined";

/**
 * Rows per reducer call. Measured on the deployment host (backend/README.md): ingest
 * rate climbs to ~5000 rows per call and flattens; the module refuses more
 * than 10,000 per mirror call.
 */
export const DEFAULT_BATCH = 5_000;
/** Calls in flight per batch write; more than 4 measured no faster. */
export const DEFAULT_PARALLEL = 4;
/**
 * Bytes per call, estimated. The server drops the connection on a message
 * over its limit (measured: see README), so variable-size rows (events,
 * model params) are chunked by size as well as by count.
 */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** Rows per put_derived call (all five tables); the module refuses > 50,000. */
export const DERIVED_ROWS_PER_CALL = 20_000;

export interface ConnectOptions {
  /** Token to connect with. Defaults to the writer token file. */
  token?: string;
  uri?: string;
  /** Database name; tests pass a throwaway one. */
  db?: string;
  /** Connect with a fresh anonymous identity: read-only. */
  anonymous?: boolean;
  compression?: "gzip" | "brotli" | "none";
  connectTimeoutMs?: number;
}

export interface BatchOptions {
  batchSize?: number;
  parallel?: number;
  /** Byte budget per call (estimated); default DEFAULT_MAX_BYTES. */
  maxBytes?: number;
  /** A call that hasn't returned after this long fails the write. */
  callTimeoutMs?: number;
  onProgress?: (doneRows: number, totalRows: number) => void;
}

export interface BatchResult {
  rows: number;
  calls: number;
  ms: number;
}

/** One match's derived rows; `put_derived` replaces the match with exactly these. */
export interface DerivedMatch {
  matchId: bigint;
  info?: DMatchInfo;
  seats: DMatchSeat[];
  auctions: DAuctionCtx[];
  bids: DBidObs[];
  plays: DPlayObs[];
}

/** A live log record (logs/decisions-*.jsonl line) for rabbot_event. */
export interface EventIn {
  at: Timestamp;
  type: string;
  matchId?: bigint;
  auctionId?: bigint;
  json: string;
}

export interface DecisionLog {
  auctionId: bigint;
  matchId: bigint;
  round: number;
  letter: string;
  balance: bigint;
  quickBid: bigint;
  quickMs: number;
  refinedBid?: bigint;
  refineMs?: number;
  budgetMs: number;
  sentBid: bigint;
  minSlackMs: number;
  misses: number;
  refused: number;
  valueEstimate?: number;
  won?: boolean;
  paid?: bigint;
  winnerBotId?: bigint;
  reason: string;
}

export interface WordLog {
  matchId: bigint;
  round: number;
  word: string;
  reward: bigint;
  rackBefore: string;
  thinkMs: number;
  ackMs?: number;
  ok: boolean;
  err?: string;
}

export interface Heartbeat {
  state: string;
  currentMatch?: bigint;
  latencyMs: number;
  clockOffsetMs: number;
  version: string;
  rating?: number;
  rank?: number;
}

type Rows<T> = (rows: readonly T[], o?: BatchOptions) => Promise<BatchResult>;

export interface Backend {
  conn: DbConnection;
  identity: Identity;
  /** The token this connection holds; save it to reuse the identity. Never log it. */
  token: string;
  uri: string;
  db: string;
  /** Resolves with a reason once the connection is gone. */
  closed: Promise<string>;

  // Mirror (miner): idempotent upserts by the game server's primary keys.
  upsertBots: Rows<GBot>;
  upsertBotStats: Rows<GBotStats>;
  upsertRetiredBotStats: Rows<GRetiredBotStats>;
  upsertBotVersions: Rows<GBotVersion>;
  upsertMatches: Rows<GMatch>;
  upsertParticipants: Rows<GParticipant>;
  upsertAuctions: Rows<GAuction>;
  upsertTopBids: Rows<GTopBid>;
  upsertWords: Rows<GWord>;
  upsertRatings: Rows<GRating>;
  upsertTournaments: Rows<GTournament>;
  upsertTournamentEntries: Rows<GTournamentEntry>;
  upsertTournamentMatches: Rows<GTournamentMatch>;
  upsertMatchMined: Rows<GMatchMined>;
  /** Replaces the stored rating_history of `matchIds` with `rows` (one call). */
  replaceRatings(matchIds: readonly bigint[], rows: readonly GRating[]): Promise<void>;
  /** Server-side deletes: tombstones history tables, deletes state tables. */
  mirrorDelete(table: MirrorTable, ids: readonly bigint[], at?: Timestamp): Promise<BatchResult>;

  // Derived (derive.ts): whole matches at a time; sums follow.
  putDerived(matches: readonly DerivedMatch[], o?: BatchOptions): Promise<BatchResult>;

  // Models (model.ts).
  putBidModels: Rows<BidModel>;
  /** Drops these fits, or all of them when `botIds` is empty. */
  deleteBidModels(botIds?: readonly bigint[]): Promise<void>;

  // Telemetry (live bot, monitor).
  logEvents: Rows<EventIn>;
  pruneEvents(before: Timestamp): Promise<void>;
  logDecision(d: DecisionLog): Promise<void>;
  logWord(w: WordLog): Promise<void>;
  logMatch(m: RABBOTMatch): Promise<void>;
  heartbeat(h: Heartbeat): Promise<void>;
  setMeta(key: string, value: string): Promise<void>;
  deleteMeta(key: string): Promise<void>;
  /** The cached value, if `meta` is subscribed. */
  getMeta(key: string): string | undefined;

  /** Subscribes to whole tables; resolves once their rows are in `conn.db`. */
  subscribeTables(names: readonly TableName[], timeoutMs?: number): Promise<SubscriptionHandle>;
  /** Subscribes to SQL queries (e.g. "SELECT * FROM d_bid_obs WHERE bot_id = 7"). */
  subscribe(queries: readonly string[], timeoutMs?: number): Promise<SubscriptionHandle>;
  unsubscribe(handle: SubscriptionHandle, timeoutMs?: number): Promise<void>;
  /** One-off SQL over HTTP as this identity; see `sql`. */
  sql(query: string): Promise<SqlRow[]>;
  close(): Promise<void>;
}

/** The writer token, or undefined when the file is missing/unreadable. */
export function readWriterToken(path: string = WRITER_TOKEN_PATH): string | undefined {
  try {
    const tok = readFileSync(path, "utf8").trim();
    return tok || undefined;
  } catch {
    return undefined;
  }
}

/** A rough BSATN size: strings dominate the variable part. */
export function approxBytes(row: object): number {
  let n = 16;
  for (const v of Object.values(row)) n += typeof v === "string" ? v.length + 4 : 9;
  return n;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/** Splits `rows` into chunks of at most `size` rows and about `maxBytes`. */
export function chunk<T>(rows: readonly T[], size: number, maxBytes: number, bytes: (r: T) => number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let curBytes = 0;
  for (const r of rows) {
    const b = bytes(r);
    if (cur.length > 0 && (cur.length >= size || curBytes + b > maxBytes)) {
      out.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(r);
    curBytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Sends `rows` in chunks through `call`, with at most `parallel` calls in
 * flight. Awaiting each result is the backpressure: the producer can't run
 * ahead of the server, and the first refused (or timed-out) chunk rejects
 * the whole write. Chunks already committed stay; every reducer here is
 * idempotent, so retrying the full write is safe.
 */
export async function writeBatched<T>(
  call: (rows: T[]) => Promise<void>,
  rows: readonly T[],
  o: BatchOptions = {},
  bytes: (r: T) => number = approxBytes as (r: T) => number,
): Promise<BatchResult> {
  const chunks = chunk(rows, Math.max(1, o.batchSize ?? DEFAULT_BATCH), o.maxBytes ?? DEFAULT_MAX_BYTES, bytes);
  const parallel = Math.max(1, o.parallel ?? DEFAULT_PARALLEL);
  const timeout = o.callTimeoutMs ?? 120_000;
  const t0 = performance.now();
  let next = 0;
  let done = 0;
  let failed: unknown;
  const worker = async (): Promise<void> => {
    while (failed === undefined && next < chunks.length) {
      const c = chunks[next++]!;
      try {
        await withTimeout(call(c), timeout, "reducer call");
      } catch (e) {
        failed ??= e;
        return;
      }
      done += c.length;
      o.onProgress?.(done, rows.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, worker));
  if (failed !== undefined) throw failed;
  return { rows: rows.length, calls: chunks.length, ms: performance.now() - t0 };
}

/** A row from `sql`: snake_case columns; timestamps as µs numbers; none as null. */
export type SqlRow = Record<string, unknown>;

type AlgType = Record<string, unknown>;
function decodeValue(t: AlgType, v: unknown): unknown {
  if ("Product" in t) {
    const els = (t.Product as { elements: { name: { some?: string } }[] }).elements;
    // Timestamp / Identity / Duration are single-field products.
    if (els.length === 1 && els[0]!.name.some?.startsWith("__")) return (v as unknown[])[0];
    return v;
  }
  if ("Sum" in t) {
    const vars = (t.Sum as { variants: { name: { some?: string }; algebraic_type: AlgType }[] }).variants;
    const [tag, inner] = v as [number, unknown];
    if (vars.length === 2 && vars[0]!.name.some === "some" && vars[1]!.name.some === "none") {
      return tag === 0 ? decodeValue(vars[0]!.algebraic_type, inner) : null;
    }
    return { tag: vars[tag]?.name.some ?? tag, value: inner };
  }
  return v;
}

/**
 * Runs SQL against the backend over HTTP (SpacetimeDB's /sql endpoint): no
 * subscription, no client cache, so it suits large one-off scans. u64/i64
 * come back as JS numbers (exact below 2^53, which ids and sums here are).
 * Private tables are refused unless `token` is the owner's.
 */
export async function sql(
  query: string,
  o: { uri?: string; db?: string; token?: string; timeoutMs?: number } = {},
): Promise<SqlRow[]> {
  if (/visible_auction_top_bids/i.test(query)) throw new Error("refusing to read visible_auction_top_bids");
  const uri = (o.uri ?? DEFAULT_URI).replace(/\/$/, "");
  const res = await fetch(`${uri}/v1/database/${encodeURIComponent(o.db ?? DEFAULT_DB)}/sql`, {
    method: "POST",
    headers: o.token ? { Authorization: `Bearer ${o.token}` } : {},
    body: query,
    signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`sql ${res.status}: ${text.slice(0, 300)}`);
  return decodeSqlResponse(text);
}

/** Decodes the /sql endpoint's JSON body into `SqlRow`s (see `sql`). */
export function decodeSqlResponse(text: string): SqlRow[] {
  const out: SqlRow[] = [];
  for (const stmt of JSON.parse(text) as {
    schema: { elements: { name: { some?: string }; algebraic_type: AlgType }[] };
    rows: unknown[][];
  }[]) {
    const cols = stmt.schema.elements;
    for (const r of stmt.rows) {
      const row: SqlRow = {};
      cols.forEach((c, i) => (row[c.name.some ?? String(i)] = decodeValue(c.algebraic_type, r[i])));
      out.push(row);
    }
  }
  return out;
}

export function connectBackend(opts: ConnectOptions = {}): Promise<Backend> {
  const token = opts.anonymous ? undefined : (opts.token ?? readWriterToken());
  if (!opts.anonymous && !token) {
    // Without this, a missing token file silently yields an anonymous
    // identity whose every write is refused much later.
    return Promise.reject(new Error(`no writer token (${WRITER_TOKEN_PATH}); pass anonymous: true to read only`));
  }
  const uri = opts.uri ?? DEFAULT_URI;
  const db = opts.db ?? DEFAULT_DB;
  return new Promise((resolve, reject) => {
    let resolveClosed!: (why: string) => void;
    const closed = new Promise<string>((r) => (resolveClosed = r));
    // Generous: right after a server (re)start a database with the full
    // history takes ~20 s to load before it accepts connections.
    const timer = setTimeout(() => reject(new Error(`connect to ${uri} timed out`)), opts.connectTimeoutMs ?? 60_000);
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(db)
      .withToken(token)
      // Localhost: compression costs more CPU than it saves bandwidth.
      .withCompression(opts.compression ?? "none")
      .onConnect((conn, identity, tok) => {
        clearTimeout(timer);
        resolve(makeBackend(conn, identity, tok, closed, uri, db));
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timer);
        reject(err);
        resolveClosed(`connect error: ${err.message}`);
      })
      .onDisconnect((_ctx, err) => resolveClosed(err ? `disconnected: ${err.message}` : "disconnected"))
      .build();
  });
}

function makeBackend(
  conn: DbConnection,
  identity: Identity,
  token: string,
  closed: Promise<string>,
  uri: string,
  db: string,
): Backend {
  const r = conn.reducers;
  const batch =
    <T>(fn: (rows: T[]) => Promise<void>) =>
    (rows: readonly T[], o?: BatchOptions) =>
      writeBatched(fn, rows, o);

  const subscribe = (queries: readonly string[], timeoutMs = 300_000): Promise<SubscriptionHandle> => {
    for (const q of queries) {
      // Belt and braces: this client is never pointed at the game server,
      // but the data rules forbid this view from every identity.
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
        .subscribe([...queries]);
    });
  };

  const putDerived = async (matches: readonly DerivedMatch[], o: BatchOptions = {}): Promise<BatchResult> => {
    // Whole matches per call (the reducer replaces a match atomically), as
    // many as fit the row budget; a single oversize match goes alone.
    const size = (m: DerivedMatch) =>
      (m.info ? 1 : 0) + m.seats.length + m.auctions.length + m.bids.length + m.plays.length;
    const groups = chunk(matches, 2_000, o.batchSize ?? DERIVED_ROWS_PER_CALL, size);
    let rows = 0;
    const res = await writeBatched(
      async (g: DerivedMatch[][]) => {
        for (const ms of g) {
          await r.putDerived({
            matchIds: ms.map((m) => m.matchId),
            infos: ms.flatMap((m) => (m.info ? [m.info] : [])),
            seats: ms.flatMap((m) => m.seats),
            auctions: ms.flatMap((m) => m.auctions),
            bids: ms.flatMap((m) => m.bids),
            plays: ms.flatMap((m) => m.plays),
          });
          rows += ms.reduce((s, m) => s + size(m), 0);
        }
      },
      groups,
      { ...o, batchSize: 1, maxBytes: Infinity },
      () => 1,
    );
    return { rows, calls: res.calls, ms: res.ms };
  };

  return {
    conn,
    identity,
    token,
    uri,
    db,
    closed,
    upsertBots: batch((rows: GBot[]) => r.upsertBots({ rows })),
    upsertBotStats: batch((rows: GBotStats[]) => r.upsertBotStats({ rows })),
    upsertRetiredBotStats: batch((rows: GRetiredBotStats[]) => r.upsertRetiredBotStats({ rows })),
    upsertBotVersions: batch((rows: GBotVersion[]) => r.upsertBotVersions({ rows })),
    upsertMatches: batch((rows: GMatch[]) => r.upsertMatches({ rows })),
    upsertParticipants: batch((rows: GParticipant[]) => r.upsertParticipants({ rows })),
    upsertAuctions: batch((rows: GAuction[]) => r.upsertAuctions({ rows })),
    upsertTopBids: batch((rows: GTopBid[]) => r.upsertTopBids({ rows })),
    upsertWords: batch((rows: GWord[]) => r.upsertWords({ rows })),
    upsertRatings: batch((rows: GRating[]) => r.upsertRatings({ rows })),
    upsertTournaments: batch((rows: GTournament[]) => r.upsertTournaments({ rows })),
    upsertTournamentEntries: batch((rows: GTournamentEntry[]) => r.upsertTournamentEntries({ rows })),
    upsertTournamentMatches: batch((rows: GTournamentMatch[]) => r.upsertTournamentMatches({ rows })),
    upsertMatchMined: batch((rows: GMatchMined[]) => r.upsertMatchMined({ rows })),
    replaceRatings: (matchIds, rows) => r.replaceRatings({ matchIds: [...matchIds], rows: [...rows] }),
    mirrorDelete: (table, ids, at = Timestamp.now()) =>
      writeBatched((c: bigint[]) => r.mirrorDeleteRows({ table, ids: c, at }), ids, {}, () => 9),
    putDerived,
    putBidModels: (rows, o) => writeBatched((c: BidModel[]) => r.putBidModels({ rows: c }), rows, { batchSize: 500, ...o }),
    deleteBidModels: (botIds = []) => r.deleteBidModels({ botIds: [...botIds] }),
    logEvents: (rows, o) =>
      writeBatched(
        (c: EventIn[]) => r.logEvents({ rows: c.map((e) => ({ ...e, matchId: e.matchId, auctionId: e.auctionId })) }),
        rows,
        { batchSize: 1_000, ...o },
      ),
    pruneEvents: (before) => r.pruneEvents({ before }),
    logDecision: (d) => r.logDecision(d),
    logWord: (w) => r.logWord(w),
    logMatch: (m) => r.logMatch({ row: m }),
    heartbeat: (h) => r.heartbeat(h),
    setMeta: (key, value) => r.setMeta({ key, value }),
    deleteMeta: (key) => r.deleteMeta({ key }),
    getMeta: (key) => conn.db.meta.key.find(key)?.value,
    subscribe,
    subscribeTables: (names, timeoutMs) => subscribe(names.map((n) => `SELECT * FROM ${n}`), timeoutMs),
    unsubscribe: (handle, timeoutMs = 30_000) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        try {
          handle.unsubscribeThen(() => {
            clearTimeout(timer);
            resolve();
          });
        } catch {
          clearTimeout(timer);
          resolve();
        }
      }),
    sql: (query) => sql(query, { uri, db, token }),
    close: async () => {
      if (!conn.isActive) return;
      conn.disconnect();
      await Promise.race([closed, new Promise((res) => setTimeout(res, 5_000))]);
    },
  };
}

// ---------- Telemetry sink for the live bot ----------

export interface EventSinkOptions extends ConnectOptions {
  /** Flush period. */
  flushMs?: number;
  /** Queue cap; beyond it the oldest records are dropped (and counted). */
  maxQueue?: number;
  onError?: (msg: string) => void;
}

export interface EventSink {
  /** Queues one log record; never throws, never blocks. */
  push(type: string, rec: Record<string, unknown>): void;
  /** The connection, while one is up (for heartbeat/logMatch). */
  backend(): Backend | undefined;
  stats(): { queued: number; sent: number; dropped: number; failures: number };
  /** Flushes what's queued (best effort) and disconnects. */
  close(): Promise<void>;
}

function jsonSafe(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? Number(v) : v;
}

const asId = (v: unknown): bigint | undefined =>
  typeof v === "bigint" ? v : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined;

/**
 * Buffers live log records into rabbot_event in the background, so a backend
 * hiccup can never delay a bid or crash the bot: pushes are sync and
 * O(1), flushes run on a timer, failures reconnect with backoff and keep
 * the queue (bounded). Records' `match`/`auction` fields fill the indexed
 * columns.
 */
export function createEventSink(opts: EventSinkOptions = {}): EventSink {
  const flushMs = opts.flushMs ?? 1_000;
  const maxQueue = opts.maxQueue ?? 50_000;
  const report = opts.onError ?? (() => {});
  let queue: EventIn[] = [];
  let b: Backend | undefined;
  let connecting: Promise<void> | undefined;
  let backoff = 1_000;
  let nextTry = 0;
  let busy = false;
  let closing = false;
  const st = { sent: 0, dropped: 0, failures: 0 };

  const ensure = (): Promise<void> => {
    if (b || connecting || Date.now() < nextTry) return connecting ?? Promise.resolve();
    connecting = connectBackend(opts)
      .then((x) => {
        b = x;
        backoff = 1_000;
        void x.closed.then((why) => {
          if (b === x) b = undefined;
          if (!closing) report(`event sink ${why}`);
        });
      })
      .catch((e) => {
        st.failures++;
        nextTry = Date.now() + backoff;
        backoff = Math.min(backoff * 2, 60_000);
        report(`event sink connect failed: ${e instanceof Error ? e.message : e}`);
      })
      .finally(() => (connecting = undefined));
    return connecting;
  };

  const flush = async (): Promise<void> => {
    if (busy || queue.length === 0) return;
    busy = true;
    try {
      await ensure();
      const conn = b;
      if (!conn) return;
      const batch = queue;
      queue = [];
      try {
        await conn.logEvents(batch, { parallel: 1, callTimeoutMs: 30_000 });
        st.sent += batch.length;
      } catch (e) {
        st.failures++;
        // Put them back in front; a refused record (e.g. oversize) would
        // block the queue forever, so only retry on connection trouble.
        const msg = e instanceof Error ? e.message : String(e);
        if (/allow-listed|longer than|batch too large/.test(msg)) st.dropped += batch.length;
        else queue = batch.concat(queue).slice(-maxQueue);
        report(`event sink write failed: ${msg}`);
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void flush(), flushMs);
  timer.unref?.();

  return {
    push(type, rec) {
      try {
        let json = JSON.stringify(rec, jsonSafe);
        if (json.length > 60_000) json = JSON.stringify({ truncated: true, head: json.slice(0, 50_000) });
        queue.push({
          at: Timestamp.now(),
          type: type.slice(0, 64),
          matchId: asId(rec.match ?? rec.matchId),
          auctionId: asId(rec.auction ?? rec.auctionId),
          json,
        });
        if (queue.length > maxQueue) {
          st.dropped += queue.length - maxQueue;
          queue = queue.slice(-maxQueue);
        }
      } catch (e) {
        st.dropped++;
        report(`event sink push failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    backend: () => b,
    stats: () => ({ queued: queue.length, ...st }),
    async close() {
      clearInterval(timer);
      for (let i = 0; i < 3 && queue.length > 0; i++) {
        while (busy) await new Promise((res) => setTimeout(res, 20));
        await flush();
      }
      closing = true;
      await b?.close();
    },
  };
}
