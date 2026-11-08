// One-shot migration of the miner's SQLite history (data/history.sqlite,
// opened read-only) into RABBOT's SpacetimeDB backend, and the real-data
// benchmark for it.
//
//   tsx src/backend/import-sqlite.ts                 throwaway rabbot-import-<pid>, measured, deleted
//   tsx src/backend/import-sqlite.ts --keep          ... and keep it
//   tsx src/backend/import-sqlite.ts --db rabbot        the real migration (keeps data; idempotent)
//   flags: --sqlite <path>
//
// Prints rows/s per table, server RSS, and checks the module's market_stat
// sums against a recount from the SQLite rows.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Timestamp } from "spacetimedb";
import { phaseBucket } from "../memory/fit.js";
import { connectBackend, type Backend, type BatchResult, type DerivedMatch } from "./client.js";

type V = number | bigint | string | null;
type Row = Record<string, V>;
interface Sqlite {
  prepare(sql: string): { all(): Row[]; iterate(): IterableIterator<Row> };
  close(): void;
}

const args = process.argv.slice(2);
const flag = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const sqlitePath = flag("--sqlite") ?? join(import.meta.dirname, "..", "..", "data", "history.sqlite");
const target = flag("--db");
const throwaway = target === undefined;
// The test harness refuses the real `rabbot` name on purpose, so it is only
// loaded for a throwaway run; the real migration needs none of it.
if (throwaway) process.env.RABBOT_TEST_DB ??= `rabbot-import-${process.pid}`;
const harness = throwaway ? await import("./testdb.js") : undefined;
const DB = target ?? harness!.TEST_DB;
const keep = args.includes("--keep") || !throwaway;

// ---------- value conversion ----------

const big = (v: V): bigint => (v === null ? 0n : typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v))));
const optBig = (v: V): bigint | undefined => (v === null ? undefined : big(v));
const int = (v: V): number => (v === null ? 0 : Number(v));
const optInt = (v: V): number | undefined => (v === null ? undefined : Number(v));
const ts = (v: V): Timestamp => new Timestamp(big(v));
const optTs = (v: V): Timestamp | undefined => (v === null ? undefined : ts(v));
const str = (v: V): string => (v === null ? "" : String(v));
const bool = (v: V): boolean => Number(v) === 1;

function serverRssMb(): number {
  try {
    const pid = execFileSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", "rabbot-stdb.service"], {
      encoding: "utf8",
    }).trim();
    return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024;
  } catch {
    return Number.NaN;
  }
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (p: string, o: { readOnly: boolean }) => Sqlite;
};
const lite = new DatabaseSync(sqlitePath, { readOnly: true });
const all = (sql: string) => lite.prepare(sql).all();

harness?.publishTestDb();
const b: Backend = await connectBackend({ db: DB });
harness?.ownerCall("add_writer", harness.identityJson(b.identity.toHexString()), '"import"');
console.log(`importing ${sqlitePath} -> ${DB}; server RSS ${serverRssMb().toFixed(0)} MB`);

const timings: Array<{ table: string; rows: number; s: number; rps: number }> = [];
async function step(table: string, p: Promise<BatchResult>): Promise<void> {
  const r = await p;
  const s = r.ms / 1000;
  timings.push({ table, rows: r.rows, s, rps: r.rows / Math.max(s, 1e-9) });
  console.log(`  ${table.padEnd(20)} ${String(r.rows).padStart(9)} rows  ${s.toFixed(2).padStart(6)} s  ${(r.rows / Math.max(s, 1e-9)).toFixed(0).padStart(7)} rows/s  (${r.calls} calls)`);
}
const tAll = performance.now();

// ---------- mirror ----------

await step("g_bot", b.upsertBots(all("SELECT * FROM bot").map((r) => ({
  id: big(r.id), name: str(r.name), teamId: big(r.team_id), isSimulated: bool(r.is_simulated),
  strategy: str(r.strategy), createdAt: ts(r.created_us), deletedAt: optTs(r.deleted_us),
}))));
await step("g_bot_stats", b.upsertBotStats(all("SELECT * FROM bot_stats").map((r) => ({
  botId: big(r.bot_id), rating: int(r.rating), matchesPlayed: int(r.matches_played), wins: int(r.wins),
  totalScore: big(r.total_score), lastPlayed: optTs(r.last_played_us), openskillMu: Number(r.mu),
  openskillSigma: Number(r.sigma),
}))));
await step("g_retired_bot_stats", b.upsertRetiredBotStats(all("SELECT * FROM retired_bot_stats").map((r) => ({
  id: big(r.id), botId: big(r.bot_id), version: int(r.version), rating: int(r.rating),
  matchesPlayed: int(r.matches_played), wins: int(r.wins), totalScore: big(r.total_score),
  lastPlayed: optTs(r.last_played_us), openskillMu: Number(r.mu), openskillSigma: Number(r.sigma),
}))));
await step("g_bot_version", b.upsertBotVersions(all("SELECT * FROM bot_version").map((r) => ({
  id: big(r.id), botId: big(r.bot_id), version: int(r.version), startedAt: ts(r.started_us),
}))));
await step("g_match", b.upsertMatches(all("SELECT * FROM match_state").map((r) => ({
  id: big(r.id), status: str(r.status), currentRound: int(r.current_round),
  currentAuctionId: optBig(r.current_auction_id), bagTotal: int(r.bag_total), auctionType: str(r.auction_type),
  createdAt: ts(r.created_us), startedAt: optTs(r.started_us), endedAt: optTs(r.ended_us),
  auctionDurationMs: big(r.auction_duration_ms ?? 1000), startingRackSize: int(r.starting_rack_size ?? 5),
  deletedAt: optTs(r.deleted_us),
}))));
await step("g_participant", b.upsertParticipants(all("SELECT * FROM match_participant").map((r) => ({
  id: big(r.id), matchId: big(r.match_id), botId: big(r.bot_id), balance: big(r.balance), score: big(r.score),
  deletedAt: optTs(r.deleted_us),
}))));
await step("g_auction", b.upsertAuctions(all("SELECT * FROM auction_result").map((r) => ({
  auctionId: big(r.auction_id), matchId: big(r.match_id), letter: str(r.letter),
  winnerBotId: optBig(r.winner_bot_id), paid: big(r.paid), closedAt: ts(r.closed_us), deletedAt: optTs(r.deleted_us),
}))));
await step("g_top_bid", b.upsertTopBids(all("SELECT * FROM auction_top_bid_archive").map((r) => ({
  auctionId: big(r.auction_id), matchId: big(r.match_id), topBid: big(r.top_bid), deletedAt: optTs(r.deleted_us),
}))));
await step("g_word", b.upsertWords(all("SELECT * FROM word_play").map((r) => ({
  id: big(r.id), matchId: big(r.match_id), botId: big(r.bot_id), word: str(r.word), baseScore: big(r.base_score),
  bonus: big(r.bonus), totalReward: big(r.total_reward), playedAt: ts(r.played_us), deletedAt: optTs(r.deleted_us),
}))));
await step("g_rating", b.upsertRatings(all("SELECT * FROM rating_history").map((r) => ({
  id: big(r.id), botId: big(r.bot_id), matchId: big(r.match_id), at: ts(r.at_us), openskillMu: Number(r.mu),
  openskillSigma: Number(r.sigma),
}))));
await step("g_tournament", b.upsertTournaments(all("SELECT * FROM tournament").map((r) => ({
  id: big(r.id), status: str(r.status), swissRoundsTotal: int(r.swiss_rounds_total), currentRound: int(r.current_round),
  topCut: int(r.top_cut), matchSize: int(r.match_size), auctionType: str(r.auction_type), createdAt: ts(r.created_us),
  endedAt: optTs(r.ended_us), winnerBotId: optBig(r.winner_bot_id),
}))));
await step("g_tournament_entry", b.upsertTournamentEntries(all("SELECT * FROM tournament_entry").map((r) => ({
  id: big(r.id), tournamentId: big(r.tournament_id), botId: big(r.bot_id), swissPoints: int(r.swiss_points),
  eliminated: bool(r.eliminated), totalScore: big(r.total_score), finalFinishPosition: optInt(r.final_finish_position),
}))));
await step("g_tournament_match", b.upsertTournamentMatches(all("SELECT * FROM tournament_match").map((r) => ({
  id: big(r.id), tournamentId: big(r.tournament_id), matchId: big(r.match_id), round: int(r.round), phase: str(r.phase),
}))));
await step("g_match_mined", b.upsertMatchMined(all("SELECT * FROM match_mined").map((r) => ({
  matchId: big(r.match_id), complete: bool(r.complete), minedAt: ts(r.mined_us),
}))));

// ---------- derived, whole matches ----------

const matches = new Map<bigint, DerivedMatch>();
const m = (id: V): DerivedMatch => {
  const k = big(id);
  let x = matches.get(k);
  if (!x) matches.set(k, (x = { matchId: k, seats: [], auctions: [], bids: [], plays: [] }));
  return x;
};
const tRead = performance.now();
for (const r of lite.prepare("SELECT * FROM match_info").iterate()) {
  m(r.match_id).info = {
    matchId: big(r.match_id), nSeats: int(r.n_seats), nReal: int(r.n_real), nAuctions: int(r.n_auctions),
    expectedAuctions: int(r.expected_auctions), auctionType: str(r.auction_type), createdAt: ts(r.created_us),
    endedAt: ts(r.ended_us), balanceOk: bool(r.balance_ok), derivedAt: ts(r.derived_us),
  };
}
for (const r of lite.prepare("SELECT * FROM match_seat").iterate()) {
  m(r.match_id).seats.push({
    id: 0n, matchId: big(r.match_id), botId: big(r.bot_id), isSim: bool(r.is_sim), strategy: str(r.strategy),
    version: int(r.version), finalScore: big(r.final_score), finalBalance: big(r.final_balance), place: int(r.place),
    wonTiles: int(r.won_tiles), paidTotal: big(r.paid_total), words: int(r.words), lettersPlayed: int(r.letters_played),
    tilesLeft: int(r.tiles_left), endedAt: ts(r.ended_us),
  });
}
// The market recount the module's sums are checked against.
const want = new Map<string, { n: bigint; sumPaid: bigint; sumsqTop: bigint }>();
for (const r of lite.prepare("SELECT * FROM auction_ctx").iterate()) {
  const a = {
    auctionId: big(r.auction_id), matchId: big(r.match_id), roundIdx: int(r.round_idx), nAuctions: int(r.n_auctions),
    phase: Number(r.phase), letter: str(r.letter), winnerBotId: optBig(r.winner_bot_id),
    winnerIsSim: r.winner_is_sim === null ? undefined : bool(r.winner_is_sim), paid: big(r.paid),
    topBid: optBig(r.top_bid), closedAt: ts(r.closed_us), endedAt: ts(r.ended_us),
    simQ: r.sim_q === null || r.sim_q === undefined ? undefined : Number(r.sim_q),
  };
  m(r.match_id).auctions.push(a);
  const k = `${a.letter}|${phaseBucket(a.phase)}`;
  const e = want.get(k) ?? { n: 0n, sumPaid: 0n, sumsqTop: 0n };
  e.n += 1n;
  if (a.winnerBotId !== undefined) e.sumPaid += a.paid;
  if (a.topBid !== undefined) e.sumsqTop += a.topBid * a.topBid;
  want.set(k, e);
}
for (const r of lite.prepare("SELECT * FROM bid_obs").iterate()) {
  m(r.match_id).bids.push({
    id: 0n, auctionId: big(r.auction_id), botId: big(r.bot_id), matchId: big(r.match_id), letter: str(r.letter),
    roundIdx: int(r.round_idx), phase: Number(r.phase), balance: big(r.balance), cap: big(r.cap),
    rackSize: int(r.rack_size), kind: int(r.kind), value: big(r.value), won: bool(r.won),
    othersMax: optBig(r.others_max), version: int(r.version), endedAt: ts(r.ended_us),
  });
}
for (const r of lite.prepare("SELECT * FROM play_obs").iterate()) {
  m(r.match_id).plays.push({
    wordId: big(r.word_id), matchId: big(r.match_id), botId: big(r.bot_id), isSim: bool(r.is_sim), word: str(r.word),
    len: int(r.len), reward: big(r.reward), roundIdx: int(r.round_idx), phase: Number(r.phase),
    rackBefore: int(r.rack_before), balanceBefore: big(r.balance_before), endedAt: ts(r.ended_us),
  });
}
console.log(`  (read derived rows from SQLite in ${((performance.now() - tRead) / 1000).toFixed(1)} s)`);
const derived = [...matches.values()].sort((x, y) => (x.matchId < y.matchId ? -1 : 1));
await step("d_* (put_derived)", b.putDerived(derived));

for (const r of all("SELECT * FROM bid_model")) {
  await b.putBidModels([{
    botId: big(r.bot_id), fittedAt: ts(r.fitted_us), dataAt: ts(r.data_us), nObs: big(r.n_obs), params: str(r.params),
  }]);
}
for (const r of all("SELECT * FROM meta")) await b.setMeta(str(r.key), str(r.value));
console.log(`total ${((performance.now() - tAll) / 1000).toFixed(1)} s; server RSS ${serverRssMb().toFixed(0)} MB`);

// ---------- checks and read timings ----------

const got = await b.sql("SELECT * FROM market_stat");
let bad = 0;
for (const g of got) {
  const e = want.get(String(g.key));
  if (!e || BigInt(g.n as number) !== e.n || BigInt(g.sum_paid as number) !== e.sumPaid || BigInt(g.sumsq_top as number) !== e.sumsqTop) bad++;
}
if (bad || got.length !== want.size) throw new Error(`market_stat mismatch: ${bad} bad of ${got.length}, want ${want.size} keys`);
console.log(`market_stat matches the SQLite recount (${got.length} keys)`);

// Every table's row count against its SQLite source. On the real rabbot the
// backend may already hold more (the miner kept going), so only fewer is a
// failure there; a fresh throwaway must match exactly.
const PAIRS: [sqlite: string, backend: string][] = [
  ["bot", "g_bot"], ["bot_stats", "g_bot_stats"], ["retired_bot_stats", "g_retired_bot_stats"],
  ["bot_version", "g_bot_version"], ["match_state", "g_match"], ["match_participant", "g_participant"],
  ["auction_result", "g_auction"], ["auction_top_bid_archive", "g_top_bid"], ["word_play", "g_word"],
  ["rating_history", "g_rating"], ["tournament", "g_tournament"], ["tournament_entry", "g_tournament_entry"],
  ["tournament_match", "g_tournament_match"], ["match_mined", "g_match_mined"], ["match_info", "d_match_info"],
  ["match_seat", "d_match_seat"], ["auction_ctx", "d_auction_ctx"], ["bid_obs", "d_bid_obs"],
  ["play_obs", "d_play_obs"], ["bid_model", "bid_model"],
];
let countBad = 0;
for (const [lt, bt] of PAIRS) {
  const want = Number(all(`SELECT COUNT(*) AS n FROM ${lt}`)[0]?.n ?? 0);
  const have = Number((await b.sql(`SELECT COUNT(*) AS n FROM ${bt}`))[0]?.n ?? 0);
  const ok = throwaway ? have === want : have >= want;
  if (!ok) countBad++;
  console.log(`  ${bt.padEnd(20)} sqlite ${String(want).padStart(9)}  backend ${String(have).padStart(9)}  ${ok ? "ok" : "MISMATCH"}`);
}
if (countBad) throw new Error(`${countBad} tables' row counts don't match SQLite`);
console.log(`row counts match SQLite (${PAIRS.length} tables)`);

const topBot = (await b.sql("SELECT * FROM seat_stat")).sort((x, y) => Number(y.matches) - Number(x.matches))[0];
if (topBot) {
  let t = performance.now();
  const rows = await b.sql(`SELECT * FROM d_bid_obs WHERE bot_id = ${topBot.bot_id}`);
  console.log(`sql d_bid_obs for bot ${topBot.bot_id}: ${rows.length} rows in ${(performance.now() - t).toFixed(0)} ms`);
  t = performance.now();
  const h = await b.subscribe([`SELECT * FROM d_bid_obs WHERE bot_id = ${topBot.bot_id}`]);
  console.log(`subscribe same: ${b.conn.db.dBidObs.count()} rows in ${(performance.now() - t).toFixed(0)} ms`);
  await b.unsubscribe(h);
}
const rss0 = process.memoryUsage().rss;
let t = performance.now();
await b.subscribeTables(["g_auction"]);
console.log(
  `subscribe g_auction: ${b.conn.db.gAuction.count()} rows in ${(performance.now() - t).toFixed(0)} ms, client RSS +${((process.memoryUsage().rss - rss0) / 2 ** 20).toFixed(0)} MB`,
);
t = performance.now();
await b.subscribeTables(["market_stat", "opp_stat", "seat_stat", "bid_model", "g_bot", "g_bot_stats"]);
console.log(`subscribe sums+models+bots: ${(performance.now() - t).toFixed(0)} ms`);

// Re-sending everything is a no-op: measures the idempotent path.
t = performance.now();
await b.putDerived(derived);
console.log(`idempotent re-put of all derived rows: ${((performance.now() - t) / 1000).toFixed(1)} s`);

await b.close();
lite.close();
if (!keep) harness?.deleteTestDb();
console.log(JSON.stringify({ db: DB, kept: keep, timings }, null, 0));
process.exit(0);
