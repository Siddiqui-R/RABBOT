import { Identity, type Timestamp } from "spacetimedb";
import { Range, SenderError, t } from "spacetimedb/server";
import type { Ctx } from "./ctx";
import spacetimedb, {
  bidModel,
  dAuctionCtx,
  dBidObs,
  decisionFields,
  dMatchInfo,
  dMatchSeat,
  dPlayObs,
  gAuction,
  gBot,
  gBotStats,
  gBotVersion,
  gMatch,
  gMatchMined,
  gParticipant,
  gRating,
  gRetiredBotStats,
  gTopBid,
  gTournament,
  gTournamentEntry,
  gTournamentMatch,
  gWord,
  rackforgeMatch,
  wordFields,
  type DAuctionCtx,
  type DBidObs,
  type DMatchInfo,
  type DMatchSeat,
  type DPlayObs,
} from "./schema";
import { StatAcc } from "./stats";

export default spacetimedb;

// Reducer names are the snake_case of the export names (`upsertAuctions`
// is `upsert_auctions`).

/**
 * Rows per mirror call. A g_auction row is ~60 bytes of BSATN, so 10k rows
 * is well under the server's message limit and a ~30 ms transaction. The
 * client chunks below it.
 */
const MAX_ROWS = 10_000;
/** Derived rows per put_derived call (all five tables together). */
const MAX_DERIVED_ROWS = 50_000;
const MAX_DERIVED_MATCHES = 2_000;
const MAX_EVENTS = 2_000;
const MAX_TEXT = 1_000;
const MAX_JSON = 64 * 1024;
const MAX_PARAMS = 256 * 1024;

// ---------- Checks ----------

function writerRow(ctx: Ctx) {
  return ctx.db.writer.identity.find(ctx.sender);
}

// Anonymous identities (any fresh connection gets one) are never in the
// allow-list, so this is the only gate every write needs.
function requireWriter(ctx: Ctx): void {
  if (!writerRow(ctx)) throw new SenderError("not an allow-listed writer");
}

function requireOwner(ctx: Ctx): void {
  if (writerRow(ctx)?.role !== "owner") throw new SenderError("owner only");
}

function checkBatch(rows: readonly unknown[], max = MAX_ROWS): void {
  if (rows.length > max) throw new SenderError(`batch too large: ${rows.length} > ${max}`);
}

function checkText(name: string, s: string, max = MAX_TEXT): void {
  if (s.length > max) throw new SenderError(`${name} longer than ${max} chars`);
}

function checkLetter(l: string): void {
  if (!/^[A-Z]$/.test(l)) throw new SenderError(`bad letter ${JSON.stringify(l)}`);
}

// ---------- Generic upsert ----------

// Field-wise equality so re-sending an unchanged row writes nothing (no
// commitlog entry, no subscriber traffic, no stats churn).
function sameValue(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (x == null || y == null || typeof x !== "object" || typeof y !== "object") return false;
  if (x instanceof Identity && y instanceof Identity) return x.isEqual(y);
  if ("microsSinceUnixEpoch" in x && "microsSinceUnixEpoch" in y) {
    return x.microsSinceUnixEpoch === y.microsSinceUnixEpoch;
  }
  return false;
}

/** Equal on every column of `a` except `skip` (a module-assigned id). */
function sameRow(a: object, b: object, skip?: string): boolean {
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  for (const k of Object.keys(ar)) if (k !== skip && !sameValue(ar[k], br[k])) return false;
  return true;
}

type Pk<R, K> = { find(key: K): R | null | undefined; update(row: R): R };

/** Returns the replaced row, `null` for an insert, `"same"` for a no-op. */
function upsert<R extends object, K>(pk: Pk<R, K>, insert: (row: R) => R, key: K, row: R): R | null | "same" {
  const old = pk.find(key);
  if (old == null) {
    insert(row);
    return null;
  }
  if (sameRow(old, row)) return "same";
  pk.update(row);
  return old;
}

// ---------- Lifecycle and writers ----------

// The publisher becomes the owner. Republishing doesn't rerun init, so the
// owner never changes after the first publish.
export const init = spacetimedb.init((ctx) => {
  if (!ctx.db.writer.identity.find(ctx.sender)) {
    ctx.db.writer.insert({
      identity: ctx.sender,
      role: "owner",
      label: "publisher",
      addedAt: ctx.timestamp,
      addedBy: undefined,
    });
  }
});

export const addWriter = spacetimedb.reducer(
  { identity: t.identity(), label: t.string() },
  (ctx, { identity, label }) => {
    requireOwner(ctx);
    checkText("label", label, 200);
    const old = ctx.db.writer.identity.find(identity);
    if (old) {
      if (old.role === "owner") return; // never demote the owner
      ctx.db.writer.identity.update({ ...old, label });
      return;
    }
    ctx.db.writer.insert({ identity, role: "writer", label, addedAt: ctx.timestamp, addedBy: ctx.sender });
  },
);

export const removeWriter = spacetimedb.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  requireOwner(ctx);
  const old = ctx.db.writer.identity.find(identity);
  if (!old) return;
  if (old.role === "owner") throw new SenderError("can't remove the owner");
  ctx.db.writer.identity.delete(identity);
});

// ---------- Mirror upserts (miner) ----------

export const upsertBots = spacetimedb.reducer({ rows: t.array(gBot.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows);
  const tb = ctx.db.gBot;
  for (const r of rows) upsert(tb.id, (x) => tb.insert(x), r.id, r);
});

export const upsertBotStats = spacetimedb.reducer({ rows: t.array(gBotStats.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows);
  const tb = ctx.db.gBotStats;
  for (const r of rows) upsert(tb.botId, (x) => tb.insert(x), r.botId, r);
});

export const upsertRetiredBotStats = spacetimedb.reducer(
  { rows: t.array(gRetiredBotStats.rowType) },
  (ctx, { rows }) => {
    requireWriter(ctx);
    checkBatch(rows);
    const tb = ctx.db.gRetiredBotStats;
    for (const r of rows) upsert(tb.id, (x) => tb.insert(x), r.id, r);
  },
);

export const upsertBotVersions = spacetimedb.reducer({ rows: t.array(gBotVersion.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows);
  const tb = ctx.db.gBotVersion;
  for (const r of rows) upsert(tb.id, (x) => tb.insert(x), r.id, r);
});

export const upsertMatches = spacetimedb.reducer({ rows: t.array(gMatch.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows);
  const tb = ctx.db.gMatch;
  for (const r of rows) upsert(tb.id, (x) => tb.insert(x), r.id, r);
});

export const upsertParticipants = spacetimedb.reducer(
  { rows: t.array(gParticipant.rowType) },
  (ctx, { rows }) => {
    requireWriter(ctx);
    checkBatch(rows);
    const tb = ctx.db.gParticipant;
    for (const r of rows) upsert(tb.id, (x) => tb.insert(x), r.id, r);
  },
);

export const upsertAuctions = spacetimedb.reducer({ rows: t.array(gAuction.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows);
  const tb = ctx.db.gAuction;
  for (const r of rows) {
    checkLetter(r.letter);
    upsert(tb.auctionId, (x) => tb.insert(x), r.auctionId, r);
  }
});

export const upsertTopBids = spacetimedb.reducer({ rows: t.array(gTopBid.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows);
  const tb = ctx.db.gTopBid;
  for (const r of rows) upsert(tb.auctionId, (x) => tb.insert(x), r.auctionId, r);
});

export const upsertWords = spacetimedb.reducer({ rows: t.array(gWord.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows);
  const tb = ctx.db.gWord;
  for (const r of rows) {
    checkText("word", r.word, 64);
    upsert(tb.id, (x) => tb.insert(x), r.id, r);
  }
});

export const upsertRatings = spacetimedb.reducer({ rows: t.array(gRating.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows);
  const tb = ctx.db.gRating;
  for (const r of rows) upsert(tb.id, (x) => tb.insert(x), r.id, r);
});

// rating_history ids change when the server rebuilds ratings, so a fetched
// match's rows replace whatever was stored for it, in one transaction.
export const replaceRatings = spacetimedb.reducer(
  { matchIds: t.array(t.u64()), rows: t.array(gRating.rowType) },
  (ctx, { matchIds, rows }) => {
    requireWriter(ctx);
    checkBatch(rows);
    checkBatch(matchIds);
    const want = new Set(matchIds);
    for (const r of rows) {
      if (!want.has(r.matchId)) throw new SenderError(`rating ${r.id} is for match ${r.matchId}, not in matchIds`);
    }
    const tb = ctx.db.gRating;
    const keep = new Set(rows.map((r) => r.id));
    for (const m of want) {
      for (const old of [...tb.gRatingByMatch.filter(m)]) if (!keep.has(old.id)) tb.id.delete(old.id);
    }
    for (const r of rows) upsert(tb.id, (x) => tb.insert(x), r.id, r);
  },
);

export const upsertTournaments = spacetimedb.reducer({ rows: t.array(gTournament.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows);
  const tb = ctx.db.gTournament;
  for (const r of rows) upsert(tb.id, (x) => tb.insert(x), r.id, r);
});

export const upsertTournamentEntries = spacetimedb.reducer(
  { rows: t.array(gTournamentEntry.rowType) },
  (ctx, { rows }) => {
    requireWriter(ctx);
    checkBatch(rows);
    const tb = ctx.db.gTournamentEntry;
    for (const r of rows) upsert(tb.id, (x) => tb.insert(x), r.id, r);
  },
);

export const upsertTournamentMatches = spacetimedb.reducer(
  { rows: t.array(gTournamentMatch.rowType) },
  (ctx, { rows }) => {
    requireWriter(ctx);
    checkBatch(rows);
    const tb = ctx.db.gTournamentMatch;
    for (const r of rows) upsert(tb.id, (x) => tb.insert(x), r.id, r);
  },
);

export const upsertMatchMined = spacetimedb.reducer({ rows: t.array(gMatchMined.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows);
  const tb = ctx.db.gMatchMined;
  for (const r of rows) upsert(tb.matchId, (x) => tb.insert(x), r.matchId, r);
});

/** Tombstone where the miner keeps history, delete where it mirrors state. */
function mirrorDelete(ctx: Ctx, table: string, id: bigint, at: Timestamp): void {
  const db = ctx.db;
  const stamp = <R extends { deletedAt?: Timestamp }>(pk: Pk<R, bigint>) => {
    const old = pk.find(id);
    if (old && old.deletedAt === undefined) pk.update({ ...old, deletedAt: at });
  };
  switch (table) {
    case "g_bot": return stamp(db.gBot.id);
    case "g_match": return stamp(db.gMatch.id);
    case "g_participant": return stamp(db.gParticipant.id);
    case "g_auction": return stamp(db.gAuction.auctionId);
    case "g_top_bid": return stamp(db.gTopBid.auctionId);
    case "g_word": return stamp(db.gWord.id);
    case "g_bot_stats": db.gBotStats.botId.delete(id); return;
    case "g_retired_bot_stats": db.gRetiredBotStats.id.delete(id); return;
    case "g_bot_version": db.gBotVersion.id.delete(id); return;
    case "g_rating": db.gRating.id.delete(id); return;
    case "g_tournament": db.gTournament.id.delete(id); return;
    case "g_tournament_entry": db.gTournamentEntry.id.delete(id); return;
    case "g_tournament_match": db.gTournamentMatch.id.delete(id); return;
    case "g_match_mined": db.gMatchMined.matchId.delete(id); return;
    default: throw new SenderError(`mirror_delete: unknown table ${JSON.stringify(table)}`);
  }
}

// Server-side deletes, by primary key. `at` is when the miner saw it go.
export const mirrorDeleteRows = spacetimedb.reducer(
  { table: t.string(), ids: t.array(t.u64()), at: t.timestamp() },
  (ctx, { table, ids, at }) => {
    requireWriter(ctx);
    checkBatch(ids);
    for (const id of ids) mirrorDelete(ctx, table, id, at);
  },
);

// ---------- Derived facts (derive.ts) ----------

type Group<R> = Map<bigint, R[]>;
function byMatch<R extends { matchId: bigint }>(rows: readonly R[], want: Set<bigint>, what: string): Group<R> {
  const g: Group<R> = new Map();
  for (const r of rows) {
    if (!want.has(r.matchId)) throw new SenderError(`${what} row for match ${r.matchId}, not in matchIds`);
    let a = g.get(r.matchId);
    if (!a) g.set(r.matchId, (a = []));
    a.push(r);
  }
  return g;
}

/**
 * Makes the stored rows of one match exactly `next`. Rows are matched on a
 * natural key; unchanged rows are left alone, changed ones updated in place
 * (keeping a module-assigned `id`), missing ones deleted. `stat` sees every
 * change as (-old, +new), which keeps the sums exact.
 */
function syncRows<R extends object>(
  old: Iterable<R>,
  next: readonly R[],
  key: (r: R) => string,
  ops: { insert(r: R): void; update(old: R, r: R): void; remove(r: R): void },
  stat: ((r: R, s: bigint) => void) | undefined,
  idCol?: string,
): void {
  const prev = new Map<string, R>();
  for (const r of old) prev.set(key(r), r);
  const seen = new Set<string>();
  for (const r of next) {
    const k = key(r);
    if (seen.has(k)) throw new SenderError(`duplicate derived row ${k}`);
    seen.add(k);
    const o = prev.get(k);
    if (o) {
      prev.delete(k);
      if (sameRow(o, r, idCol)) continue;
      ops.update(o, r);
      stat?.(o, -1n);
    } else {
      ops.insert(r);
    }
    stat?.(r, 1n);
  }
  for (const o of prev.values()) {
    ops.remove(o);
    stat?.(o, -1n);
  }
}

// Replaces every derived row of `matchIds` with the rows given (a match
// with no rows given is cleared). Rows for other matches are refused. The
// *_stat sums move by exactly the difference.
export const putDerived = spacetimedb.reducer(
  {
    matchIds: t.array(t.u64()),
    infos: t.array(dMatchInfo.rowType),
    seats: t.array(dMatchSeat.rowType),
    auctions: t.array(dAuctionCtx.rowType),
    bids: t.array(dBidObs.rowType),
    plays: t.array(dPlayObs.rowType),
  },
  (ctx, { matchIds, infos, seats, auctions, bids, plays }) => {
    requireWriter(ctx);
    checkBatch(matchIds, MAX_DERIVED_MATCHES);
    checkBatch([...infos, ...seats, ...auctions, ...bids, ...plays], MAX_DERIVED_ROWS);
    const want = new Set(matchIds);
    for (const a of auctions) checkLetter(a.letter);
    for (const b of bids) {
      checkLetter(b.letter);
      if (b.kind > 2) throw new SenderError(`bad bid kind ${b.kind}`);
    }
    for (const p of plays) checkText("word", p.word, 64);
    const g = {
      infos: byMatch(infos, want, "d_match_info"),
      seats: byMatch(seats, want, "d_match_seat"),
      auctions: byMatch(auctions, want, "d_auction_ctx"),
      bids: byMatch(bids, want, "d_bid_obs"),
      plays: byMatch(plays, want, "d_play_obs"),
    };
    const db = ctx.db;
    const acc = new StatAcc();
    for (const m of want) {
      const info = db.dMatchInfo.matchId.find(m);
      syncRows<DMatchInfo>(info ? [info] : [], g.infos.get(m) ?? [], (r) => String(r.matchId), {
        insert: (r) => db.dMatchInfo.insert(r),
        update: (_o, r) => db.dMatchInfo.matchId.update(r),
        remove: (o) => db.dMatchInfo.matchId.delete(o.matchId),
      }, undefined);
      syncRows<DMatchSeat>(db.dMatchSeat.dSeatByMatch.filter(m), g.seats.get(m) ?? [], (r) => String(r.botId), {
        insert: (r) => db.dMatchSeat.insert({ ...r, id: 0n }),
        update: (o, r) => db.dMatchSeat.id.update({ ...r, id: o.id }),
        remove: (o) => db.dMatchSeat.id.delete(o.id),
      }, (r, s) => acc.seatRow(r, s), "id");
      // A key already stored under another match fails the insert on the
      // primary key, which rolls the whole call back: ids never move.
      syncRows<DAuctionCtx>(
        db.dAuctionCtx.dCtxByMatch.filter(m),
        g.auctions.get(m) ?? [],
        (r) => String(r.auctionId),
        {
          insert: (r) => db.dAuctionCtx.insert(r),
          update: (_o, r) => db.dAuctionCtx.auctionId.update(r),
          remove: (o) => db.dAuctionCtx.auctionId.delete(o.auctionId),
        },
        (r, s) => acc.auction(r, s),
      );
      syncRows<DBidObs>(db.dBidObs.dBidByMatch.filter(m), g.bids.get(m) ?? [], (r) => `${r.auctionId}|${r.botId}`, {
        insert: (r) => db.dBidObs.insert({ ...r, id: 0n }),
        update: (o, r) => db.dBidObs.id.update({ ...r, id: o.id }),
        remove: (o) => db.dBidObs.id.delete(o.id),
      }, (r, s) => acc.bid(r, s), "id");
      syncRows<DPlayObs>(
        db.dPlayObs.dPlayByMatch.filter(m),
        g.plays.get(m) ?? [],
        (r) => String(r.wordId),
        {
          insert: (r) => db.dPlayObs.insert(r),
          update: (_o, r) => db.dPlayObs.wordId.update(r),
          remove: (o) => db.dPlayObs.wordId.delete(o.wordId),
        },
        undefined,
      );
    }
    flushStats(ctx, acc);
  },
);

function flushStats(ctx: Ctx, acc: StatAcc): void {
  const now = ctx.timestamp;
  const db = ctx.db;
  // Sums.flush is untyped over the row; these adapters pair each table's
  // primary-key index with its insert.
  acc.market.flush<string>({
    find: (k) => db.marketStat.key.find(k),
    update: (r) => db.marketStat.key.update(r as never),
    delete: (k) => db.marketStat.key.delete(k),
    insert: (r) => db.marketStat.insert(r as never),
  }, "key", now);
  acc.opp.flush<string>({
    find: (k) => db.oppStat.key.find(k),
    update: (r) => db.oppStat.key.update(r as never),
    delete: (k) => db.oppStat.key.delete(k),
    insert: (r) => db.oppStat.insert(r as never),
  }, "key", now);
  acc.seat.flush<bigint>({
    find: (k) => db.seatStat.botId.find(k),
    update: (r) => db.seatStat.botId.update(r as never),
    delete: (k) => db.seatStat.botId.delete(k),
    insert: (r) => db.seatStat.insert(r as never),
  }, "botId", now);
}

// Recomputes the sums from d_* from scratch: recovery, or after changing the
// bucketing. One transaction over the whole history; owner only.
export const rebuildStats = spacetimedb.reducer((ctx) => {
  requireOwner(ctx);
  const db = ctx.db;
  for (const r of [...db.marketStat.iter()]) db.marketStat.key.delete(r.key);
  for (const r of [...db.oppStat.iter()]) db.oppStat.key.delete(r.key);
  for (const r of [...db.seatStat.iter()]) db.seatStat.botId.delete(r.botId);
  const acc = new StatAcc();
  for (const a of db.dAuctionCtx.iter()) acc.auction(a, 1n);
  for (const b of db.dBidObs.iter()) acc.bid(b, 1n);
  for (const s of db.dMatchSeat.iter()) acc.seatRow(s, 1n);
  flushStats(ctx, acc);
});

// ---------- Fitted models (model.ts) ----------

export const putBidModels = spacetimedb.reducer({ rows: t.array(bidModel.rowType) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows, 1_000);
  const tb = ctx.db.bidModel;
  for (const r of rows) {
    checkText("params", r.params, MAX_PARAMS);
    upsert(tb.botId, (x) => tb.insert(x), r.botId, r);
  }
});

// Drops the given fits, or every fit when botIds is empty (before a full
// refit, so bots that no longer have data don't keep stale fits).
export const deleteBidModels = spacetimedb.reducer({ botIds: t.array(t.u64()) }, (ctx, { botIds }) => {
  requireWriter(ctx);
  checkBatch(botIds);
  const tb = ctx.db.bidModel;
  const ids = botIds.length ? botIds : [...tb.iter()].map((r) => r.botId);
  for (const id of ids) tb.botId.delete(id);
});

// ---------- RackForge telemetry (live bot, monitor) ----------

const eventIn = t.row("RACKFORGEEventIn", {
  at: t.timestamp(),
  type: t.string(),
  matchId: t.option(t.u64()),
  auctionId: t.option(t.u64()),
  json: t.string(),
});

export const logEvents = spacetimedb.reducer({ rows: t.array(eventIn) }, (ctx, { rows }) => {
  requireWriter(ctx);
  checkBatch(rows, MAX_EVENTS);
  for (const r of rows) {
    checkText("type", r.type, 64);
    checkText("json", r.json, MAX_JSON);
    ctx.db.rackforgeEvent.insert({
      id: 0n,
      at: r.at,
      type: r.type,
      matchId: r.matchId,
      auctionId: r.auctionId,
      json: r.json,
    });
  }
});

// Events older than `before` go (SpacetimeDB keeps every row in memory).
// Bounded per call so one transaction stays short; call until it returns
// without deleting (the count is in the module log).
export const pruneEvents = spacetimedb.reducer({ before: t.timestamp() }, (ctx, { before }) => {
  requireWriter(ctx);
  const tb = ctx.db.rackforgeEvent;
  const ids: bigint[] = [];
  for (const r of tb.eventByAt.filter(new Range<Timestamp>({ tag: "unbounded" }, { tag: "excluded", value: before }))) {
    ids.push(r.id);
    if (ids.length >= 50_000) break;
  }
  for (const id of ids) tb.id.delete(id);
  console.info(`prune_events: deleted ${ids.length}`);
});

export const logDecision = spacetimedb.reducer(decisionFields, (ctx, args) => {
  requireWriter(ctx);
  checkLetter(args.letter);
  checkText("reason", args.reason);
  const tb = ctx.db.rackforgeDecision;
  const old = tb.auctionId.find(args.auctionId);
  // Option args arrive as optional properties; rows need them present.
  const row = {
    ...args,
    refinedBid: args.refinedBid,
    refineMs: args.refineMs,
    valueEstimate: args.valueEstimate,
    won: args.won,
    paid: args.paid,
    winnerBotId: args.winnerBotId,
    // Keep the first `at`: a second call only fills in the outcome.
    at: old ? old.at : ctx.timestamp,
  };
  if (old) tb.auctionId.update(row);
  else tb.insert(row);
});

export const logWord = spacetimedb.reducer(wordFields, (ctx, args) => {
  requireWriter(ctx);
  checkText("word", args.word, 64);
  checkText("rackBefore", args.rackBefore, 128);
  if (args.err !== undefined) checkText("err", args.err);
  ctx.db.rackforgeWord.insert({ id: 0n, ...args, ackMs: args.ackMs, err: args.err, at: ctx.timestamp });
});

export const logMatch = spacetimedb.reducer({ row: rackforgeMatch.rowType }, (ctx, { row }) => {
  requireWriter(ctx);
  checkText("words", row.words, 4_000);
  checkText("agent", row.agent, 200);
  const tb = ctx.db.rackforgeMatch;
  upsert(tb.matchId, (x) => tb.insert(x), row.matchId, row);
});

export const heartbeat = spacetimedb.reducer(
  {
    state: t.string(),
    currentMatch: t.option(t.u64()),
    latencyMs: t.f64(),
    clockOffsetMs: t.f64(),
    version: t.string(),
    rating: t.option(t.i32()),
    rank: t.option(t.u32()),
  },
  (ctx, args) => {
    requireWriter(ctx);
    checkText("state", args.state, 200);
    checkText("version", args.version, 200);
    const tb = ctx.db.rackforgeStatus;
    const row = {
      ...args,
      id: 0,
      heartbeatAt: ctx.timestamp,
      currentMatch: args.currentMatch,
      rating: args.rating,
      rank: args.rank,
    };
    if (tb.id.find(0)) tb.id.update(row);
    else tb.insert(row);
  },
);

export const setMeta = spacetimedb.reducer({ key: t.string(), value: t.string() }, (ctx, { key, value }) => {
  requireWriter(ctx);
  checkText("key", key, 200);
  checkText("value", value, 1_000_000);
  const tb = ctx.db.meta;
  const row = { key, value, updatedAt: ctx.timestamp };
  if (tb.key.find(key)) tb.key.update(row);
  else tb.insert(row);
});

export const deleteMeta = spacetimedb.reducer({ key: t.string() }, (ctx, { key }) => {
  requireWriter(ctx);
  ctx.db.meta.key.delete(key);
});
