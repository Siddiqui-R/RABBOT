// How is RackForge doing? Everything comes from RackForge's own SpacetimeDB backend
// (database `rackforge` on 127.0.0.1:3013): the mirrored leaderboard and history
// (kept current by rackforge-miner.service) and the live bot's telemetry
// (rackforge_status / rackforge_decision / rackforge_match).
//
//   npx tsx src/monitor/status.ts                one snapshot
//   npx tsx src/monitor/status.ts --watch 30     refresh every 30 s
//   npx tsx src/monitor/status.ts --json         the snapshot as JSON
//
// Env: RACKFORGE_BOT_NAME (default 'RackForge'), RACKFORGE_STDB_URI, RACKFORGE_STDB_DB.
// status-maincloud.ts is the older view straight from maincloud + local logs.

import { sql, type SqlRow } from "../backend/client.js";
import { isoUs } from "../backend/sync.js";
import { isMain } from "../memory/util.js";
import { isProvisional, rankOf, skill, spread, type Rated } from "./rating.js";

const NAME = process.env.RACKFORGE_BOT_NAME ?? "RackForge";
/** Style comparison: each bot's last LAST_N matches within WINDOW_H hours. */
const WINDOW_H = 48;
const LAST_N = 30;

const n = (x: unknown) => Number(x);

export interface SeatRow {
  matchId: number;
  botId: number;
  place: number;
  score: number;
  wonTiles: number;
  paidTotal: number;
  finalBalance: number;
  words: number;
  lettersPlayed: number;
  endedUs: number;
}

export interface Style {
  botId: number;
  name: string;
  rating?: number;
  matches: number;
  avgScore: number;
  avgPlace: number;
  tiles: number;
  price: number;
  wordLen: number;
  sevenPlus: number;
}

export function seatFrom(r: SqlRow): SeatRow {
  return {
    matchId: n(r.match_id), botId: n(r.bot_id), place: n(r.place), score: n(r.final_score), wonTiles: n(r.won_tiles),
    paidTotal: n(r.paid_total), finalBalance: n(r.final_balance), words: n(r.words), lettersPlayed: n(r.letters_played),
    endedUs: n(r.ended_at),
  };
}

/** Per-match style of one bot over `seats` (its own rows), most recent `lastN`. */
export function styleOf(botId: number, name: string, seats: readonly SeatRow[], sevens: ReadonlyMap<string, number>, lastN = LAST_N): Style {
  const mine = seats.filter((s) => s.botId === botId).sort((a, b) => b.endedUs - a.endedUs).slice(0, lastN);
  const k = Math.max(1, mine.length);
  const sum = (f: (s: SeatRow) => number) => mine.reduce((t, s) => t + f(s), 0);
  const tiles = sum((s) => s.wonTiles);
  const words = sum((s) => s.words);
  return {
    botId,
    name,
    matches: mine.length,
    avgScore: sum((s) => s.score) / k,
    avgPlace: sum((s) => s.place) / k,
    tiles: tiles / k,
    price: tiles ? sum((s) => s.paidTotal) / tiles : 0,
    wordLen: words ? sum((s) => s.lettersPlayed) / words : 0,
    sevenPlus: sum((s) => sevens.get(`${s.matchId}|${s.botId}`) ?? 0) / k,
  };
}

// ---------- Tournament ----------
// Mirrors tournament / tournament_entry / tournament_match (g_tournament*),
// kept current by the miner. Standings use the server's own order
// (tournament.ts byStanding): Swiss points, then total score, then the
// lower bot id.

export interface TourRow {
  id: number;
  status: string;
  swissRoundsTotal: number;
  currentRound: number;
  topCut: number;
  matchSize: number;
  auctionType: string;
  createdUs: number;
  endedUs: number | null;
  winnerBotId: number | null;
}
export interface EntryRow {
  tournamentId: number;
  botId: number;
  swissPoints: number;
  eliminated: boolean;
  totalScore: number;
  finalFinishPosition: number | null;
}
export interface TMatchRow {
  tournamentId: number;
  matchId: number;
  round: number;
  phase: string;
}
export interface PartRow {
  matchId: number;
  botId: number;
  score: number;
}
export interface TourView {
  tournament: TourRow;
  /** Registration / Swiss / Bracket / Final: not Ended or ForceEnded. */
  active: boolean;
  registered: boolean;
  entrants: number;
  alive: number;
  me?: EntryRow & { rank: number };
  standings: Array<EntryRow & { rank: number; name: string }>;
  myMatches: Array<{ matchId: number; round: number; phase: string; place: number; seats: number; score: number; ended: boolean; bestOther: number }>;
  /** Final phase: my total minus the opponent's over the final games so far. */
  finalDiff?: number;
  finalGames?: number;
}

export const tourFrom = (r: SqlRow): TourRow => ({
  id: n(r.id), status: String(r.status), swissRoundsTotal: n(r.swiss_rounds_total), currentRound: n(r.current_round),
  topCut: n(r.top_cut), matchSize: n(r.match_size), auctionType: String(r.auction_type), createdUs: n(r.created_at),
  endedUs: r.ended_at === null || r.ended_at === undefined ? null : n(r.ended_at),
  winnerBotId: r.winner_bot_id === null || r.winner_bot_id === undefined ? null : n(r.winner_bot_id),
});
export const entryFrom = (r: SqlRow): EntryRow => ({
  tournamentId: n(r.tournament_id), botId: n(r.bot_id), swissPoints: n(r.swiss_points), eliminated: r.eliminated === true,
  totalScore: n(r.total_score),
  finalFinishPosition: r.final_finish_position === null || r.final_finish_position === undefined ? null : n(r.final_finish_position),
});
export const tmatchFrom = (r: SqlRow): TMatchRow => ({
  tournamentId: n(r.tournament_id), matchId: n(r.match_id), round: n(r.round), phase: String(r.phase),
});

const DONE = new Set(["ended", "forceended"]);
export const byStanding = (a: EntryRow, b: EntryRow) => b.swissPoints - a.swissPoints || b.totalScore - a.totalScore || a.botId - b.botId;

/**
 * The tournament to show (the newest unfinished one, else the newest) and
 * RackForge's place in it. `parts` are g_participant rows of the tournament's
 * matches (running ones included); `endedMatches` the ids already over.
 */
export function tournamentView(
  tours: readonly TourRow[], entries: readonly EntryRow[], tmatches: readonly TMatchRow[], parts: readonly PartRow[],
  endedMatches: ReadonlySet<number>, meId: number, names: ReadonlyMap<number, string>,
): TourView | undefined {
  if (!tours.length) return undefined;
  const sorted = [...tours].sort((a, b) => b.id - a.id);
  const t = sorted.find((x) => !DONE.has(x.status.toLowerCase())) ?? sorted[0]!;
  const es = entries.filter((e) => e.tournamentId === t.id).sort(byStanding);
  const standings = es.map((e, i) => ({ ...e, rank: i + 1, name: names.get(e.botId) ?? `#${e.botId}` }));
  const mine = standings.find((e) => e.botId === meId);
  const myMatches: TourView["myMatches"] = [];
  let finalDiff: number | undefined;
  let finalGames = 0;
  for (const tm of tmatches.filter((m) => m.tournamentId === t.id).sort((a, b) => a.matchId - b.matchId)) {
    const ps = parts.filter((p) => p.matchId === tm.matchId);
    const me = ps.find((p) => p.botId === meId);
    if (!me) continue;
    const others = ps.filter((p) => p.botId !== meId);
    const bestOther = others.reduce((m, p) => Math.max(m, p.score), -Infinity);
    myMatches.push({
      matchId: tm.matchId, round: tm.round, phase: tm.phase, place: 1 + others.filter((p) => p.score > me.score).length,
      seats: ps.length, score: me.score, ended: endedMatches.has(tm.matchId), bestOther: Number.isFinite(bestOther) ? bestOther : 0,
    });
    if (tm.phase.toLowerCase() === "final") {
      finalDiff = (finalDiff ?? 0) + me.score - others.reduce((s, p) => s + p.score, 0);
      finalGames++;
    }
  }
  return {
    tournament: t,
    active: !DONE.has(t.status.toLowerCase()),
    registered: mine !== undefined,
    entrants: es.length,
    alive: es.filter((e) => !e.eliminated).length,
    me: mine,
    standings,
    myMatches,
    finalDiff,
    finalGames: finalDiff === undefined ? undefined : finalGames,
  };
}

function renderTournament(v: TourView | undefined, meId: number): string[] {
  const L: string[] = [];
  if (!v) return ["tourney  none on the server"];
  const t = v.tournament;
  const round = t.status.toLowerCase() === "swiss" ? `, Swiss round ${t.currentRound}/${t.swissRoundsTotal}` : "";
  L.push(
    `tourney  #${t.id} ${t.status}${round}  (${t.swissRoundsTotal} Swiss rounds, top cut ${t.topCut}, match size ${t.matchSize}, ${t.auctionType}; ${v.entrants} entrants, ${v.alive} alive)`,
  );
  if (!v.active) {
    const w = v.standings.find((e) => e.botId === t.winnerBotId);
    L.push(`         finished${w ? `, champion ${w.name}` : ""}${v.me ? `; RackForge ${v.me.finalFinishPosition ? `finished #${v.me.finalFinishPosition}` : `standing ${v.me.rank}/${v.entrants}`}` : "; RackForge was not entered"}`);
  } else if (!v.me) {
    L.push(t.status.toLowerCase() === "registration" ? "         RackForge is NOT REGISTERED (register_for_tournament from the bot's credential)" : "         RackForge is not in it (registration has closed)");
  } else {
    const e = v.me;
    L.push(
      `         RackForge: standing ${e.rank}/${v.entrants}, ${e.swissPoints} Swiss points, total score ${e.totalScore}${e.eliminated ? ", ELIMINATED" : ""}${e.finalFinishPosition ? `, finish #${e.finalFinishPosition}` : ""}`,
    );
  }
  if (v.finalDiff !== undefined) L.push(`         final: ${v.finalGames} game(s), RackForge minus opponent ${v.finalDiff >= 0 ? "+" : ""}${v.finalDiff}`);
  for (const m of v.myMatches) {
    L.push(`         ${m.phase.padEnd(7)} r${String(m.round).padEnd(2)} match ${String(m.matchId).padEnd(7)} ${`${m.place}/${m.seats}`.padEnd(6)} score ${String(m.score).padStart(4)} (best other ${m.bestOther})${m.ended ? "" : "  running"}`);
  }
  const show = v.standings.filter((e, i) => i < 8 || e.botId === meId);
  if (show.length) {
    L.push(`         ${"#".padStart(3)} ${"bot".padEnd(16)} ${"pts".padStart(4)} ${"total".padStart(6)}`);
    for (const e of show) {
      L.push(`         ${String(e.rank).padStart(3)} ${e.name.slice(0, 16).padEnd(16)} ${String(e.swissPoints).padStart(4)} ${String(e.totalScore).padStart(6)}${e.eliminated ? "  out" : ""}${e.finalFinishPosition ? `  #${e.finalFinishPosition}` : ""}${e.botId === meId ? "  <- RackForge" : ""}`);
    }
  }
  return L;
}

function pct(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]!;
}

export interface Snapshot {
  at: string;
  bot?: { id: number; name: string; rating: number; spread: number; provisional: boolean; rank: number | null; rankedBots: number; matches: number; wins: number };
  trend: number[];
  last: Array<SeatRow & { seats: number; sevens: number; wordList: string[] }>;
  telemetry: {
    heartbeatAgeS: number | null;
    state?: string;
    currentMatch?: number | null;
    latencyMs?: number;
    version?: string;
    decisions: number;
    misses: number;
    refused: number;
    quickMs: { p50: number | null; p99: number | null };
    refineMs: { p50: number | null; p99: number | null };
    minSlackMs: number | null;
    matchesLogged: number;
  };
  mirror: { newestMatch: number; newestMinedAgeS: number | null };
  tournament?: TourView;
  meId?: number;
  me?: Style;
  top: Style[];
  error?: string;
}

export async function snapshot(): Promise<Snapshot> {
  const nowUs = Date.now() * 1000;
  const since = isoUs(nowUs - WINDOW_H * 3600e6);
  const snap: Snapshot = {
    at: new Date().toISOString(),
    trend: [],
    last: [],
    telemetry: { heartbeatAgeS: null, decisions: 0, misses: 0, refused: 0, quickMs: { p50: null, p99: null }, refineMs: { p50: null, p99: null }, minSlackMs: null, matchesLogged: 0 },
    mirror: { newestMatch: 0, newestMinedAgeS: null },
    top: [],
  };
  const [bots, stats, seatsRaw, sevensRaw, status, decisions, rackforgem, mined] = await Promise.all([
    sql("SELECT id, name, is_simulated, deleted_at FROM g_bot"),
    sql("SELECT * FROM g_bot_stats"),
    sql(`SELECT * FROM d_match_seat WHERE ended_at >= '${since}'`),
    sql(`SELECT match_id, bot_id FROM d_play_obs WHERE ended_at >= '${since}' AND len >= 7`),
    sql("SELECT * FROM rackforge_status"),
    sql(`SELECT * FROM rackforge_decision WHERE at >= '${isoUs(nowUs - 6 * 3600e6)}'`),
    sql("SELECT match_id FROM rackforge_match"),
    sql("SELECT match_id, mined_at FROM g_match_mined"),
  ]);
  const name = new Map(bots.map((b) => [n(b.id), String(b.name)]));
  const live = new Set(bots.filter((b) => b.deleted_at === null && b.is_simulated !== true).map((b) => n(b.id)));
  const sim = new Set(bots.filter((b) => b.is_simulated === true).map((b) => n(b.id)));
  const seats = seatsRaw.map(seatFrom);
  const sevens = new Map<string, number>();
  for (const r of sevensRaw) {
    const key = `${n(r.match_id)}|${n(r.bot_id)}`;
    sevens.set(key, (sevens.get(key) ?? 0) + 1);
  }
  const rated = (r: SqlRow): Rated & { botId: number } => ({ botId: n(r.bot_id), openskillMu: n(r.openskill_mu), openskillSigma: n(r.openskill_sigma) });
  const allRated = stats.filter((s) => live.has(n(s.bot_id)) || sim.has(n(s.bot_id))).map(rated);

  const me = bots.find((b) => b.name === NAME && b.deleted_at === null) ?? bots.find((b) => b.name === NAME);
  const meId = me ? n(me.id) : -1;
  const meStats = stats.find((s) => n(s.bot_id) === meId);
  if (me && meStats) {
    const r = rated(meStats);
    snap.bot = {
      id: meId, name: NAME, rating: skill(r), spread: spread(r), provisional: isProvisional(r), rank: rankOf(r, allRated),
      rankedBots: allRated.filter((s) => !isProvisional(s)).length, matches: n(meStats.matches_played), wins: n(meStats.wins),
    };
  }
  if (me) {
    const [mySeats, myPlays, myRatings] = await Promise.all([
      sql(`SELECT * FROM d_match_seat WHERE bot_id = ${meId}`),
      sql(`SELECT match_id, word, len FROM d_play_obs WHERE bot_id = ${meId}`),
      sql(`SELECT * FROM g_rating WHERE bot_id = ${meId}`),
    ]);
    const last = mySeats.map(seatFrom).sort((a, b) => b.endedUs - a.endedUs).slice(0, 10);
    const lastIds = last.map((s) => s.matchId);
    const seatCounts = new Map<number, number>();
    if (lastIds.length) {
      for (const r of await sql(`SELECT match_id, n_seats FROM d_match_info WHERE match_id >= ${Math.min(...lastIds)}`)) {
        seatCounts.set(n(r.match_id), n(r.n_seats));
      }
    }
    snap.last = last.map((s) => {
      const words = myPlays.filter((p) => n(p.match_id) === s.matchId);
      return { ...s, seats: seatCounts.get(s.matchId) ?? 6, sevens: words.filter((p) => n(p.len) >= 7).length, wordList: words.map((p) => String(p.word)) };
    });
    snap.trend = myRatings
      .map((r) => ({ at: n(r.at), r: { openskillMu: n(r.openskill_mu), openskillSigma: n(r.openskill_sigma) } }))
      .sort((a, b) => a.at - b.at)
      .slice(-12)
      .map((x) => skill(x.r));
    const mySevens = new Map<string, number>();
    for (const p of myPlays) {
      if (n(p.len) < 7) continue;
      const key = `${n(p.match_id)}|${meId}`;
      mySevens.set(key, (mySevens.get(key) ?? 0) + 1);
    }
    // RackForge's own line: its last LAST_N matches (any age), the current release's play.
    snap.me = { ...styleOf(meId, NAME, mySeats.map(seatFrom), mySevens), rating: snap.bot?.rating };
  }

  // Top 10 real, ranked bots other than RackForge.
  const top = allRated
    .filter((s) => live.has(s.botId) && s.botId !== meId && !isProvisional(s))
    .sort((a, b) => skill(b) - skill(a))
    .slice(0, 10);
  snap.top = top.map((s) => ({ ...styleOf(s.botId, name.get(s.botId) ?? `#${s.botId}`, seats, sevens), rating: skill(s) }));

  const st = status[0];
  if (st) {
    snap.telemetry.heartbeatAgeS = (nowUs - n(st.heartbeat_at)) / 1e6;
    snap.telemetry.state = String(st.state);
    snap.telemetry.currentMatch = st.current_match === null ? null : n(st.current_match);
    snap.telemetry.latencyMs = n(st.latency_ms);
    snap.telemetry.version = String(st.version);
  }
  snap.telemetry.decisions = decisions.length;
  snap.telemetry.misses = decisions.reduce((t, d) => t + n(d.misses), 0);
  snap.telemetry.refused = decisions.reduce((t, d) => t + n(d.refused), 0);
  const q = decisions.map((d) => n(d.quick_ms));
  const rf = decisions.map((d) => d.refine_ms).filter((x) => x !== null).map(n);
  snap.telemetry.quickMs = { p50: pct(q, 0.5), p99: pct(q, 0.99) };
  snap.telemetry.refineMs = { p50: pct(rf, 0.5), p99: pct(rf, 0.99) };
  const slack = decisions.filter((d) => n(d.sent_bid) > 0).map((d) => n(d.min_slack_ms));
  snap.telemetry.minSlackMs = slack.length ? Math.min(...slack) : null;
  snap.telemetry.matchesLogged = rackforgem.length;
  let newest = 0;
  let newestAt = 0;
  for (const m of mined) {
    if (n(m.match_id) > newest) newest = n(m.match_id);
    newestAt = Math.max(newestAt, n(m.mined_at));
  }
  snap.mirror = { newestMatch: newest, newestMinedAgeS: newestAt ? (nowUs - newestAt) / 1e6 : null };
  snap.meId = meId;
  try {
    snap.tournament = await tournamentSnapshot(meId, name);
  } catch (e) {
    snap.error = `tournament: ${e instanceof Error ? e.message : e}`;
  }
  return snap;
}

export async function tournamentSnapshot(meId: number, names: ReadonlyMap<number, string>): Promise<TourView | undefined> {
  const tours = (await sql("SELECT * FROM g_tournament")).map(tourFrom);
  if (!tours.length) return undefined;
  const [entries, tms] = await Promise.all([
    sql("SELECT * FROM g_tournament_entry").then((r) => r.map(entryFrom)),
    sql("SELECT * FROM g_tournament_match").then((r) => r.map(tmatchFrom)),
  ]);
  const ids = tms.map((m) => m.matchId);
  const parts: PartRow[] = [];
  const ended = new Set<number>();
  if (ids.length) {
    const lo = Math.min(...ids);
    const want = new Set(ids);
    const [ps, ms] = await Promise.all([
      sql(`SELECT match_id, bot_id, score FROM g_participant WHERE match_id >= ${lo}`),
      sql(`SELECT id, status FROM g_match WHERE id >= ${lo}`),
    ]);
    for (const p of ps) if (want.has(n(p.match_id))) parts.push({ matchId: n(p.match_id), botId: n(p.bot_id), score: n(p.score) });
    for (const m of ms) if (want.has(n(m.id)) && String(m.status).toLowerCase() === "ended") ended.add(n(m.id));
  }
  return tournamentView(tours, entries, tms, parts, ended, meId, names);
}

const f = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(d));

function styleLine(s: Style): string {
  return `${s.name.slice(0, 16).padEnd(16)} ${f(s.rating).padStart(5)} ${String(s.matches).padStart(4)} ${f(s.avgScore, 1).padStart(6)} ${f(s.avgPlace, 2).padStart(6)} ${f(s.tiles, 1).padStart(6)} ${f(s.price, 1).padStart(6)} ${f(s.wordLen, 2).padStart(6)} ${f(s.sevenPlus, 2).padStart(6)}`;
}

export function render(s: Snapshot): string {
  const L: string[] = [];
  L.push(`RackForge status  ${s.at}  (from the rackforge backend)`);
  if (s.error) L.push(`ERROR ${s.error}`);
  if (!s.bot) L.push(`no rated bot named '${NAME}' in the mirror (set RACKFORGE_BOT_NAME?)`);
  else {
    const b = s.bot;
    const rank = b.provisional ? "provisional (no rank yet)" : `rank ${b.rank} of ${b.rankedBots} ranked`;
    L.push(`rating   ${b.rating} ±${b.spread}  ${rank}   ${b.matches} matches, ${b.wins} wins`);
    if (s.trend.length) L.push(`trend    ${s.trend.join(" ")}`);
  }
  const t = s.telemetry;
  L.push(
    `live     ${t.heartbeatAgeS === null ? "no heartbeat yet" : `heartbeat ${f(t.heartbeatAgeS)} s ago, ${t.state}${t.currentMatch ? ` in match ${t.currentMatch}` : ""}, rtt ${f(t.latencyMs)} ms, ${t.version}`}`,
  );
  L.push(
    `last 6h  ${t.decisions} decisions logged: deadline misses ${t.misses}, refused ${t.refused}, quick p50/p99 ${f(t.quickMs.p50, 1)}/${f(t.quickMs.p99, 1)} ms, refine p50/p99 ${f(t.refineMs.p50, 1)}/${f(t.refineMs.p99, 1)} ms, min slack ${f(t.minSlackMs)} ms; ${t.matchesLogged} matches in rackforge_match`,
  );
  L.push(`mirror   newest match ${s.mirror.newestMatch}, last mined ${f(s.mirror.newestMinedAgeS)} s ago`);
  L.push(...renderTournament(s.tournament, s.meId ?? -1));
  L.push("");
  L.push("last 10  match   place  score  coins-left  spent  tiles  words  7+   words played");
  for (const m of s.last) {
    L.push(
      `         ${String(m.matchId).padEnd(7)} ${`${m.place}/${m.seats}`.padEnd(6)} ${String(m.score).padStart(5)}  ${String(m.finalBalance).padStart(10)}  ${String(m.paidTotal).padStart(5)}  ${String(m.wonTiles).padStart(5)}  ${String(m.words).padStart(5)}  ${String(m.sevens).padStart(2)}   ${m.wordList.join(" ")}`,
    );
  }
  L.push("");
  L.push(`style (each bot's last ${LAST_N} matches within ${WINDOW_H} h; per match)`);
  L.push(`${"bot".padEnd(16)} ${"elo".padStart(5)} ${"n".padStart(4)} ${"score".padStart(6)} ${"place".padStart(6)} ${"tiles".padStart(6)} ${"price".padStart(6)} ${"wlen".padStart(6)} ${"7+".padStart(6)}`);
  if (s.me) L.push(styleLine(s.me));
  for (const x of s.top) L.push(styleLine(x));
  const withData = s.top.filter((x) => x.matches > 0);
  if (s.me && withData.length) {
    const avg = (g: (x: Style) => number) => withData.reduce((a, x) => a + g(x), 0) / withData.length;
    L.push(
      `RackForge vs top ${withData.length}: tiles ${f(s.me.tiles, 1)} vs ${f(avg((x) => x.tiles), 1)}, price ${f(s.me.price, 1)} vs ${f(avg((x) => x.price), 1)}, word length ${f(s.me.wordLen, 2)} vs ${f(avg((x) => x.wordLen), 2)}, 7+ words/match ${f(s.me.sevenPlus, 2)} vs ${f(avg((x) => x.sevenPlus), 2)}`,
    );
  }
  return L.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const wi = argv.indexOf("--watch");
  const watch = wi >= 0 ? Math.max(5, Number(argv[wi + 1] ?? 30) || 30) : 0;
  const once = async () => {
    try {
      const s = await snapshot();
      return json ? JSON.stringify(s, null, 2) : render(s);
    } catch (e) {
      return `status failed (is rackforge-stdb.service up?): ${e instanceof Error ? e.message : e}`;
    }
  };
  if (!watch) {
    console.log(await once());
    process.exit(0);
  }
  for (;;) {
    process.stdout.write("\x1b[2J\x1b[H" + (await once()) + `\n\n(refreshing every ${watch} s, ctrl-c to quit)\n`);
    await new Promise((r) => setTimeout(r, watch * 1000));
  }
}

if (isMain(import.meta.url)) void main();
