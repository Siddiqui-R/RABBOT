// Keeps RABBOT's SpacetimeDB backend (`rabbot`) in step with the miner's SQLite
// working copy. The miner (src/memory/mine.ts) still writes SQLite first
// (its proven code path, and derive.ts/train.ts work on SQLite); this module
// pushes every difference to the backend:
//
//   - per-match mirror rows of every match whose `match_mined` stamp differs
//     from the backend's `g_match_mined`, and of every match still running
//     (so the backend tracks live auctions within a tick);
//   - derived rows of every match whose `match_info.derived_us` differs from
//     the backend's `d_match_info.derived_at` (put_derived replaces a match);
//   - bid models whose `fitted_us` differs; the small base tables (bots,
//     stats, versions, tournaments) whole, with deletes;
//   - `meta.last_backfill_us`.
//
// Every write is an idempotent upsert, so a tick is a diff, not a log: a
// backend that was down, or a tick that failed half way, is repaired by the
// next tick. Nothing here throws into the miner: failures are reported and
// retried with backoff.

import { Timestamp } from "spacetimedb";
import type { Db, SqlValue } from "../memory/db.js";
import { connectBackend, type Backend, type ConnectOptions, type DerivedMatch, type MirrorTable } from "./client.js";

type V = SqlValue | undefined;
type Row = Record<string, V>;

// ---------- value conversion (same mapping as import-sqlite.ts) ----------

const big = (v: V): bigint =>
  v === null || v === undefined ? 0n : typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v)));
const optBig = (v: V): bigint | undefined => (v === null || v === undefined ? undefined : big(v));
const int = (v: V): number => (v === null || v === undefined ? 0 : Number(v));
const optInt = (v: V): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const ts = (v: V): Timestamp => new Timestamp(big(v));
const optTs = (v: V): Timestamp | undefined => (v === null || v === undefined ? undefined : ts(v));
const str = (v: V): string => (v === null || v === undefined ? "" : String(v));
const bool = (v: V): boolean => Number(v) === 1;

export const conv = {
  bot: (r: Row) => ({
    id: big(r.id), name: str(r.name), teamId: big(r.team_id), isSimulated: bool(r.is_simulated),
    strategy: str(r.strategy), createdAt: ts(r.created_us), deletedAt: optTs(r.deleted_us),
  }),
  botStats: (r: Row) => ({
    botId: big(r.bot_id), rating: int(r.rating), matchesPlayed: int(r.matches_played), wins: int(r.wins),
    totalScore: big(r.total_score), lastPlayed: optTs(r.last_played_us), openskillMu: Number(r.mu),
    openskillSigma: Number(r.sigma),
  }),
  retired: (r: Row) => ({
    id: big(r.id), botId: big(r.bot_id), version: int(r.version), rating: int(r.rating),
    matchesPlayed: int(r.matches_played), wins: int(r.wins), totalScore: big(r.total_score),
    lastPlayed: optTs(r.last_played_us), openskillMu: Number(r.mu), openskillSigma: Number(r.sigma),
  }),
  botVersion: (r: Row) => ({ id: big(r.id), botId: big(r.bot_id), version: int(r.version), startedAt: ts(r.started_us) }),
  match: (r: Row) => ({
    id: big(r.id), status: str(r.status), currentRound: int(r.current_round),
    currentAuctionId: optBig(r.current_auction_id), bagTotal: int(r.bag_total), auctionType: str(r.auction_type),
    createdAt: ts(r.created_us), startedAt: optTs(r.started_us), endedAt: optTs(r.ended_us),
    auctionDurationMs: big(r.auction_duration_ms ?? 1000), startingRackSize: int(r.starting_rack_size ?? 5),
    deletedAt: optTs(r.deleted_us),
  }),
  participant: (r: Row) => ({
    id: big(r.id), matchId: big(r.match_id), botId: big(r.bot_id), balance: big(r.balance), score: big(r.score),
    deletedAt: optTs(r.deleted_us),
  }),
  auction: (r: Row) => ({
    auctionId: big(r.auction_id), matchId: big(r.match_id), letter: str(r.letter),
    winnerBotId: optBig(r.winner_bot_id), paid: big(r.paid), closedAt: ts(r.closed_us), deletedAt: optTs(r.deleted_us),
  }),
  topBid: (r: Row) => ({
    auctionId: big(r.auction_id), matchId: big(r.match_id), topBid: big(r.top_bid), deletedAt: optTs(r.deleted_us),
  }),
  word: (r: Row) => ({
    id: big(r.id), matchId: big(r.match_id), botId: big(r.bot_id), word: str(r.word), baseScore: big(r.base_score),
    bonus: big(r.bonus), totalReward: big(r.total_reward), playedAt: ts(r.played_us), deletedAt: optTs(r.deleted_us),
  }),
  rating: (r: Row) => ({
    id: big(r.id), botId: big(r.bot_id), matchId: big(r.match_id), at: ts(r.at_us), openskillMu: Number(r.mu),
    openskillSigma: Number(r.sigma),
  }),
  tournament: (r: Row) => ({
    id: big(r.id), status: str(r.status), swissRoundsTotal: int(r.swiss_rounds_total), currentRound: int(r.current_round),
    topCut: int(r.top_cut), matchSize: int(r.match_size), auctionType: str(r.auction_type), createdAt: ts(r.created_us),
    endedAt: optTs(r.ended_us), winnerBotId: optBig(r.winner_bot_id),
  }),
  tournamentEntry: (r: Row) => ({
    id: big(r.id), tournamentId: big(r.tournament_id), botId: big(r.bot_id), swissPoints: int(r.swiss_points),
    eliminated: bool(r.eliminated), totalScore: big(r.total_score), finalFinishPosition: optInt(r.final_finish_position),
  }),
  tournamentMatch: (r: Row) => ({
    id: big(r.id), tournamentId: big(r.tournament_id), matchId: big(r.match_id), round: int(r.round), phase: str(r.phase),
  }),
  mined: (r: Row) => ({ matchId: big(r.match_id), complete: bool(r.complete), minedAt: ts(r.mined_us) }),
  bidModel: (r: Row) => ({
    botId: big(r.bot_id), fittedAt: ts(r.fitted_us), dataAt: ts(r.data_us), nObs: big(r.n_obs), params: str(r.params),
  }),
};

/** Reads one match's derived rows from SQLite, in put_derived's shape. */
export function readDerived(db: Db, matchId: number): DerivedMatch {
  const q = (sql: string) => db.prepare(sql).all(matchId) as Row[];
  const m: DerivedMatch = { matchId: BigInt(matchId), seats: [], auctions: [], bids: [], plays: [] };
  const info = q("SELECT * FROM match_info WHERE match_id = ?")[0];
  if (info) {
    m.info = {
      matchId: big(info.match_id), nSeats: int(info.n_seats), nReal: int(info.n_real), nAuctions: int(info.n_auctions),
      expectedAuctions: int(info.expected_auctions), auctionType: str(info.auction_type), createdAt: ts(info.created_us),
      endedAt: ts(info.ended_us), balanceOk: bool(info.balance_ok), derivedAt: ts(info.derived_us),
    };
  }
  for (const r of q("SELECT * FROM match_seat WHERE match_id = ?")) {
    m.seats.push({
      id: 0n, matchId: big(r.match_id), botId: big(r.bot_id), isSim: bool(r.is_sim), strategy: str(r.strategy),
      version: int(r.version), finalScore: big(r.final_score), finalBalance: big(r.final_balance), place: int(r.place),
      wonTiles: int(r.won_tiles), paidTotal: big(r.paid_total), words: int(r.words), lettersPlayed: int(r.letters_played),
      tilesLeft: int(r.tiles_left), endedAt: ts(r.ended_us),
    });
  }
  for (const r of q("SELECT * FROM auction_ctx WHERE match_id = ?")) {
    m.auctions.push({
      auctionId: big(r.auction_id), matchId: big(r.match_id), roundIdx: int(r.round_idx), nAuctions: int(r.n_auctions),
      phase: Number(r.phase), letter: str(r.letter), winnerBotId: optBig(r.winner_bot_id),
      winnerIsSim: r.winner_is_sim === null || r.winner_is_sim === undefined ? undefined : bool(r.winner_is_sim),
      paid: big(r.paid), topBid: optBig(r.top_bid), closedAt: ts(r.closed_us), endedAt: ts(r.ended_us),
      simQ: r.sim_q === null || r.sim_q === undefined ? undefined : Number(r.sim_q),
    });
  }
  for (const r of q(
    "SELECT * FROM bid_obs WHERE auction_id IN (SELECT auction_id FROM auction_result WHERE match_id = ?)",
  )) {
    m.bids.push({
      id: 0n, auctionId: big(r.auction_id), botId: big(r.bot_id), matchId: big(r.match_id), letter: str(r.letter),
      roundIdx: int(r.round_idx), phase: Number(r.phase), balance: big(r.balance), cap: big(r.cap),
      rackSize: int(r.rack_size), kind: int(r.kind), value: big(r.value), won: bool(r.won),
      othersMax: optBig(r.others_max), version: int(r.version), endedAt: ts(r.ended_us),
    });
  }
  for (const r of q("SELECT * FROM play_obs WHERE word_id IN (SELECT id FROM word_play WHERE match_id = ?)")) {
    m.plays.push({
      wordId: big(r.word_id), matchId: big(r.match_id), botId: big(r.bot_id), isSim: bool(r.is_sim), word: str(r.word),
      len: int(r.len), reward: big(r.reward), roundIdx: int(r.round_idx), phase: Number(r.phase),
      rackBefore: int(r.rack_before), balanceBefore: big(r.balance_before), endedAt: ts(r.ended_us),
    });
  }
  return m;
}

export interface SyncStats {
  ticks: number;
  failures: number;
  matchesPushed: number;
  derivedPushed: number;
  modelsPushed: number;
  rowsPushed: number;
  lastOkAt: number;
  lastError?: string;
}

export interface MirrorSyncOptions extends ConnectOptions {
  log?: (msg: string) => void;
  /** Matches per batch of per-match pushes. */
  matchesPerBatch?: number;
  /** How often the whole match_state table and state-table deletes are synced. */
  fullEveryMs?: number;
}

/**
 * SQLite -> backend sync. Call `tick()` as often as you like (it never
 * overlaps itself and never throws); `start(ms)` runs it on a timer.
 */
export class MirrorSync {
  private b?: Backend;
  private connecting?: Promise<Backend | undefined>;
  private nextTry = 0;
  private backoff = 1_000;
  private busy = false;
  private lastBaseFull = 0;
  private lastBackfill?: string;
  private timer?: ReturnType<typeof setInterval>;
  readonly stats: SyncStats = {
    ticks: 0, failures: 0, matchesPushed: 0, derivedPushed: 0, modelsPushed: 0, rowsPushed: 0, lastOkAt: 0,
  };

  constructor(
    private db: Db,
    private o: MirrorSyncOptions = {},
  ) {}

  private log(msg: string): void {
    (this.o.log ?? ((m: string) => console.log(new Date().toISOString().slice(11, 19), m)))(msg);
  }

  private async backend(): Promise<Backend | undefined> {
    if (this.b) return this.b;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.nextTry) return undefined;
    this.connecting = connectBackend(this.o)
      .then((x) => {
        this.b = x;
        this.backoff = 1_000;
        void x.closed.then((why) => {
          if (this.b === x) this.b = undefined;
          this.log(`backend sync: ${why}`);
        });
        this.log("backend sync: connected to rabbot");
        return x;
      })
      .catch((e) => {
        this.nextTry = Date.now() + this.backoff;
        this.backoff = Math.min(this.backoff * 2, 60_000);
        this.log(`backend sync: connect failed: ${e instanceof Error ? e.message : e}`);
        return undefined;
      })
      .finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  start(everyMs = 3_000): void {
    this.timer ??= setInterval(() => void this.tick(), everyMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
    await this.b?.close();
    this.b = undefined;
  }

  /** One diff-and-push pass. Resolves true when everything went through. */
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const b = await this.backend();
      if (!b) return false;
      // A dropped connection leaves reducer calls pending until their
      // timeout; give up on the pass at once (writes are idempotent, the
      // next pass on a fresh connection redoes whatever didn't land).
      await Promise.race([
        this.pass(b),
        b.closed.then((why) => {
          throw new Error(`backend connection lost mid-sync (${why})`);
        }),
      ]);
      this.stats.ticks++;
      this.stats.lastOkAt = Date.now();
      return true;
    } catch (e) {
      this.stats.failures++;
      this.stats.lastError = e instanceof Error ? e.message : String(e);
      this.log(`backend sync failed: ${this.stats.lastError}`);
      return false;
    } finally {
      this.busy = false;
    }
  }

  private all(sql: string, ...args: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }

  private async pass(b: Backend): Promise<void> {
    // 1. Small base tables, whole (unchanged rows write nothing).
    const full = Date.now() - this.lastBaseFull >= (this.o.fullEveryMs ?? 60_000);
    await b.upsertBots(this.all("SELECT * FROM bot").map(conv.bot));
    await b.upsertBotStats(this.all("SELECT * FROM bot_stats").map(conv.botStats));
    await b.upsertRetiredBotStats(this.all("SELECT * FROM retired_bot_stats").map(conv.retired));
    await b.upsertBotVersions(this.all("SELECT * FROM bot_version").map(conv.botVersion));
    await b.upsertTournaments(this.all("SELECT * FROM tournament").map(conv.tournament));
    await b.upsertTournamentEntries(this.all("SELECT * FROM tournament_entry").map(conv.tournamentEntry));
    await b.upsertTournamentMatches(this.all("SELECT * FROM tournament_match").map(conv.tournamentMatch));
    if (full) {
      await b.upsertMatches(this.all("SELECT * FROM match_state").map(conv.match));
      // State tables mirror server-side deletes: drop backend keys SQLite lost.
      const del: [MirrorTable, string, string, string][] = [
        ["g_bot_stats", "bot_id", "bot_stats", "bot_id"],
        ["g_retired_bot_stats", "id", "retired_bot_stats", "id"],
        ["g_bot_version", "id", "bot_version", "id"],
        ["g_tournament", "id", "tournament", "id"],
        ["g_tournament_entry", "id", "tournament_entry", "id"],
        ["g_tournament_match", "id", "tournament_match", "id"],
      ];
      for (const [bt, bk, lt, lk] of del) {
        const have = new Set(this.all(`SELECT ${lk} AS k FROM ${lt}`).map((r) => Number(r.k)));
        const gone = (await b.sql(`SELECT ${bk} FROM ${bt}`)).map((r) => Number(r[bk])).filter((k) => !have.has(k));
        if (gone.length) await b.mirrorDelete(bt, gone.map((k) => BigInt(k)));
      }
      this.lastBaseFull = Date.now();
    }

    // 2. Per-match mirror rows: matches whose mined stamp differs, plus the
    // ones still running (they have no final stamp yet).
    const bMined = new Map<number, { complete: boolean; at: number }>();
    for (const r of await b.sql("SELECT match_id, complete, mined_at FROM g_match_mined")) {
      bMined.set(Number(r.match_id), { complete: Boolean(r.complete), at: Number(r.mined_at) });
    }
    const minedRows = this.all("SELECT * FROM match_mined");
    const changed = minedRows.filter((r) => {
      const x = bMined.get(Number(r.match_id));
      return !x || x.at !== Number(r.mined_us) || x.complete !== bool(r.complete);
    });
    const running = this.all("SELECT id FROM match_state WHERE status <> 'Ended' AND deleted_us IS NULL").map((r) =>
      Number(r.id),
    );
    const changedIds = new Set(changed.map((r) => Number(r.match_id)));
    const ids = [...new Set([...changedIds, ...running])].sort((x, y) => x - y);
    const per = Math.max(1, this.o.matchesPerBatch ?? 200);
    for (let i = 0; i < ids.length; i += per) {
      const chunkIds = ids.slice(i, i + per);
      const inList = chunkIds.join(",");
      const w = (t: string) => this.all(`SELECT * FROM ${t} WHERE match_id IN (${inList})`);
      let rows = 0;
      const ms = this.all(`SELECT * FROM match_state WHERE id IN (${inList})`).map(conv.match);
      const ps = w("match_participant").map(conv.participant);
      const as = w("auction_result").map(conv.auction);
      const tb = w("auction_top_bid_archive").map(conv.topBid);
      const ws = w("word_play").map(conv.word);
      await b.upsertMatches(ms);
      await b.upsertParticipants(ps);
      await b.upsertAuctions(as);
      await b.upsertTopBids(tb);
      await b.upsertWords(ws);
      rows += ms.length + ps.length + as.length + tb.length + ws.length;
      // rating_history ids change on server rebuilds: replace per match.
      const done = chunkIds.filter((id) => changedIds.has(id));
      if (done.length) {
        const rs = this.all(`SELECT * FROM rating_history WHERE match_id IN (${done.join(",")})`).map(conv.rating);
        await b.replaceRatings(done.map((id) => BigInt(id)), rs);
        rows += rs.length;
        const mm = changed.filter((r) => done.includes(Number(r.match_id))).map(conv.mined);
        await b.upsertMatchMined(mm);
        rows += mm.length;
        this.stats.matchesPushed += done.length;
      }
      this.stats.rowsPushed += rows;
    }
    if (changed.length > 0) this.log(`backend sync: mirrored ${changed.length} matches (+${running.length} running)`);

    // 3. Derived rows, whole matches.
    const bDerived = new Map<number, number>();
    for (const r of await b.sql("SELECT match_id, derived_at FROM d_match_info")) {
      bDerived.set(Number(r.match_id), Number(r.derived_at));
    }
    const stale = this.all("SELECT match_id, derived_us FROM match_info")
      .filter((r) => bDerived.get(Number(r.match_id)) !== Number(r.derived_us))
      .map((r) => Number(r.match_id))
      .sort((x, y) => x - y);
    for (let i = 0; i < stale.length; i += per) {
      const list = stale.slice(i, i + per).map((id) => readDerived(this.db, id));
      const res = await b.putDerived(list);
      this.stats.derivedPushed += list.length;
      this.stats.rowsPushed += res.rows;
    }
    if (stale.length > 0) this.log(`backend sync: derived rows of ${stale.length} matches`);

    // 4. Bid models.
    const bModels = new Map<number, number>();
    for (const r of await b.sql("SELECT bot_id, fitted_at FROM bid_model")) {
      bModels.set(Number(r.bot_id), Number(r.fitted_at));
    }
    const models = this.all("SELECT * FROM bid_model").filter(
      (r) => bModels.get(Number(r.bot_id)) !== Number(r.fitted_us),
    );
    if (models.length) {
      await b.putBidModels(models.map(conv.bidModel));
      this.stats.modelsPushed += models.length;
      this.log(`backend sync: ${models.length} bid models`);
    }

    // 5. Miner bookkeeping.
    const lb = this.all("SELECT value FROM meta WHERE key = 'last_backfill_us'")[0];
    if (lb && this.lastBackfill !== str(lb.value)) {
      await b.setMeta("last_backfill_us", str(lb.value));
      this.lastBackfill = str(lb.value);
    }
  }
}
