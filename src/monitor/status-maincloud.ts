// How is RackForge doing?
//
//   npx tsx src/monitor/status-maincloud.ts   one snapshot (straight from maincloud + local logs;
//   src/monitor/status.ts reads RackForge's backend instead)
//   npm run status -- --watch 30     refresh every 30 s
//   npm run status -- --json         print the snapshot as JSON
//
// Server side (anonymous read-only SQL, the same endpoint as
// `spacetime sql --anonymous`): rating, +-, provisional, leaderboard rank,
// matches, wins, rating trend, online or not. Local side (logs/): last 10
// matches, deadline misses, think times, refusals. Every run also writes
// logs/status.json. Env: RACKFORGE_BOT_NAME (default 'RackForge'),
// STDB_HOST, STDB_DB, RACKFORGE_LOG_DIR.

import * as fs from "node:fs";
import * as path from "node:path";
import { sql, sqlString, type Row } from "../live/http.js";
import { readLogStats, type LogStats } from "./logstats.js";
import { isProvisional, rankOf, skill, spread, type Rated } from "./rating.js";

const ROOT = path.join(import.meta.dirname, "..", "..");
const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB = process.env.STDB_DB ?? "scrabblebot";
const NAME = process.env.RACKFORGE_BOT_NAME ?? "RackForge";
const LOG_DIR = process.env.RACKFORGE_LOG_DIR ?? path.join(ROOT, "logs");

interface ServerStatus {
  found: boolean;
  botId?: number;
  name: string;
  rating?: number;
  spread?: number;
  provisional?: boolean;
  rank?: number | null;
  rankAmongReal?: number | null;
  rankedBots?: number;
  matches?: number;
  wins?: number;
  winRate?: number | null;
  avgScore?: number | null;
  version?: number;
  online?: boolean;
  lastSeen?: string | null;
  trend?: Array<{ at: string; match: number; rating: number; spread: number }>;
  trendDelta?: number | null;
  lastDelta?: number | null;
  currentMatch?: number | null;
  error?: string;
}

const n = (x: unknown) => Number(x);

async function serverStatus(): Promise<ServerStatus> {
  const out: ServerStatus = { found: false, name: NAME };
  try {
    const bots = await sql(HOST, DB, "SELECT id, name, is_simulated FROM bot");
    const me = bots.find((b) => b.name === NAME);
    if (!me) return out;
    const botId = n(me.id);
    out.found = true;
    out.botId = botId;
    const sim = new Set(bots.filter((b) => b.is_simulated === true).map((b) => n(b.id)));
    const live = new Set(bots.map((b) => n(b.id)));

    const [stats, history, versions, creds, seats] = await Promise.all([
      sql(HOST, DB, "SELECT * FROM bot_stats"),
      sql(HOST, DB, `SELECT * FROM rating_history WHERE bot_id = ${botId}`),
      sql(HOST, DB, `SELECT * FROM bot_version WHERE bot_id = ${botId}`),
      sql(HOST, DB, `SELECT connected, last_seen FROM bot_credential WHERE bot_id = ${botId}`),
      sql(HOST, DB, `SELECT match_id FROM match_participant WHERE bot_id = ${botId}`),
    ]);
    const rated = (r: Row): Rated & { botId: number } => ({
      botId: n(r.bot_id),
      openskillMu: n(r.openskill_mu),
      openskillSigma: n(r.openskill_sigma),
    });
    const all = stats.filter((s) => live.has(n(s.bot_id))).map(rated);
    const mineRow = stats.find((s) => n(s.bot_id) === botId);
    if (mineRow) {
      const mine = rated(mineRow);
      out.rating = skill(mine);
      out.spread = spread(mine);
      out.provisional = isProvisional(mine);
      out.rank = rankOf(mine, all);
      out.rankAmongReal = rankOf(
        mine,
        all.filter((s) => !sim.has(s.botId)),
      );
      out.rankedBots = all.filter((s) => !isProvisional(s)).length;
      out.matches = n(mineRow.matches_played);
      out.wins = n(mineRow.wins);
      out.winRate = out.matches ? out.wins / out.matches : null;
      out.avgScore = out.matches ? n(mineRow.total_score) / out.matches : null;
    } else {
      out.rating = 1500;
      out.provisional = true;
      out.matches = 0;
      out.wins = 0;
    }
    out.version = 1 + versions.length;
    out.online = creds.some((c) => c.connected === true);
    const seen = creds.map((c) => n(c.last_seen)).filter(Number.isFinite);
    out.lastSeen = seen.length ? new Date(Math.max(...seen)).toISOString() : null;

    const trend = history
      .map((h) => ({ at: n(h.at), match: n(h.match_id), r: { openskillMu: n(h.openskill_mu), openskillSigma: n(h.openskill_sigma) } }))
      .sort((a, b) => a.at - b.at);
    out.trend = trend.slice(-15).map((h) => ({ at: new Date(h.at).toISOString(), match: h.match, rating: skill(h.r), spread: spread(h.r) }));
    out.trendDelta = out.trend.length > 1 ? out.trend[out.trend.length - 1]!.rating - out.trend[0]!.rating : null;
    out.lastDelta =
      trend.length > 1 ? skill(trend[trend.length - 1]!.r) - skill(trend[trend.length - 2]!.r) : trend.length === 1 ? skill(trend[0]!.r) - 1500 : null;

    const lastSeat = seats.map((s) => n(s.match_id)).reduce((a, b) => Math.max(a, b), 0);
    if (lastSeat > 0) {
      const m = await sql(HOST, DB, `SELECT status FROM match_state WHERE id = ${lastSeat}`);
      out.currentMatch = m[0]?.status === "running" ? lastSeat : null;
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

const fmt = (x: number | null | undefined, d = 0) => (x === null || x === undefined ? "-" : x.toFixed(d));
const sign = (x: number | null | undefined) => (x === null || x === undefined ? "-" : `${x >= 0 ? "+" : ""}${x}`);

function render(s: ServerStatus, l: LogStats): string {
  const lines: string[] = [];
  lines.push(`RackForge status  ${new Date().toISOString()}`);
  lines.push("");
  if (s.error) lines.push(`server: ERROR ${s.error}`);
  if (!s.found) lines.push(`server: no bot named '${s.name}' yet (set RACKFORGE_BOT_NAME?)`);
  else {
    const rank = s.provisional ? "provisional (no rank yet)" : `rank ${s.rank} of ${s.rankedBots} ranked (${s.rankAmongReal} among real bots)`;
    lines.push(`bot      ${s.name} (#${s.botId}, v${s.version})  ${s.online ? "ONLINE" : "offline"}  last seen ${s.lastSeen ?? "-"}`);
    lines.push(`rating   ${s.rating} ±${s.spread ?? "-"}  ${rank}`);
    lines.push(
      `record   ${s.matches} matches, ${s.wins} wins (${s.winRate === null || s.winRate === undefined ? "-" : (100 * s.winRate).toFixed(1)}%), avg score ${fmt(s.avgScore, 1)}` +
        (s.currentMatch ? `  | playing match ${s.currentMatch}` : ""),
    );
    if (s.trend?.length) {
      lines.push(`trend    last ${sign(s.lastDelta)}, over ${s.trend.length} matches ${sign(s.trendDelta)}: ${s.trend.map((t) => t.rating).join(" ")}`);
    }
  }
  lines.push("");
  lines.push(`local logs (${l.files.length ? l.files.join(", ") : "none"}), agent ${l.agent ?? "-"}, last event ${l.lastEventAt ?? "-"}`);
  const mt = l.matchTotals;
  lines.push(`  ${mt.n} matches logged, ${mt.wins} wins, avg place ${fmt(mt.avgPlace, 2)}, avg score ${fmt(mt.avgScore, 1)}`);
  if (l.matches.length) {
    lines.push("  last matches:  match     place  score  top  spent  won  words  unplayed");
    for (const m of l.matches) {
      lines.push(
        `                 ${String(m.match).padEnd(9)} ${`${fmt(m.place)}/${fmt(m.seats)}`.padEnd(6)} ${fmt(m.score).padStart(5)} ${fmt(m.winnerScore).padStart(4)} ${fmt(m.coinsSpent).padStart(6)} ${fmt(m.auctionsWon).padStart(4)}  ${String(m.words.length).padStart(5)}  ${fmt(m.unplayedTiles).padStart(8)}   ${m.words.join(" ")}`,
      );
    }
  }
  lines.push(
    `  auctions ${l.auctions}: quick p50 ${fmt(l.quickMs.p50, 1)} / p99 ${fmt(l.quickMs.p99, 1)} ms; refine (${l.refineMs.n}) p50 ${fmt(l.refineMs.p50, 1)} / p99 ${fmt(l.refineMs.p99, 1)} ms; budget p50 ${fmt(l.budgetMs.p50)} ms`,
  );
  lines.push(
    `  deadline misses ${l.deadlineMisses}, late refines skipped ${l.lateRefines}, refine overran budget ${l.refineOverruns}, disconnects ${l.disconnects}`,
  );
  const refused = (label: string, m: Record<string, number>) => {
    const e = Object.entries(m).sort((a, b) => b[1] - a[1]);
    lines.push(`  ${label} refusals: ${e.length ? e.map(([k, v]) => `${v}x ${k}`).join("; ") : "none"}`);
  };
  refused("bid", l.refusals.bid);
  refused("word", l.refusals.word);
  refused("lobby", l.refusals.lobby);
  const errs = Object.entries(l.errors);
  if (errs.length) lines.push(`  errors: ${errs.map(([k, v]) => `${v}x ${k}`).join("; ")}`);
  if (l.timing) {
    const t = l.timing;
    lines.push(`  clock: offset ${t.offsetMs ?? "-"} ms (deadline ${t.deadlineOffsetMs ?? "-"}), one-way ${t.oneWayMs ?? "-"} ms, rtt p50 ${t.rttP50 ?? "-"}, recv lag p50 ${t.lagP50 ?? "-"}`);
  }
  return lines.join("\n");
}

async function snapshot(json: boolean) {
  const [server, local] = await Promise.all([serverStatus(), Promise.resolve(readLogStats(LOG_DIR))]);
  const snap = { at: new Date().toISOString(), server, local };
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, "status.json"), JSON.stringify(snap, null, 2));
  } catch (e) {
    console.error(`could not write status.json: ${e instanceof Error ? e.message : e}`);
  }
  return json ? JSON.stringify(snap, null, 2) : render(server, local);
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const wi = argv.indexOf("--watch");
  const watch = wi >= 0 ? Math.max(5, Number(argv[wi + 1] ?? 30) || 30) : 0;
  if (!watch) {
    console.log(await snapshot(json));
    return;
  }
  for (;;) {
    const text = await snapshot(json).catch((e) => `status failed: ${e instanceof Error ? e.message : e}`);
    process.stdout.write("\x1b[2J\x1b[H" + text + `\n\n(refreshing every ${watch} s, ctrl-c to quit)\n`);
    await new Promise((r) => setTimeout(r, watch * 1000));
  }
}

main().catch((e) => {
  console.error(`status: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
