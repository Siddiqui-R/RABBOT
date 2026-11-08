// How well do clones reproduce their originals? Replays each bot's recent
// real tables with every real seat swapped for its clone (sims stay sims),
// then compares the target clone's numbers with what the real bot did in
// those same matches.
//
//   npx tsx src/memory/clonecheck.ts [--bots 12] [--matches 40] [--no-store]

import { DEFAULT_DB_PATH, num, openDb, setMeta } from "./db.js";
import { createCloneAgent, wordIndex } from "./clones.js";
import { runMatch, type SeatSpec } from "./clonesim.js";
import { loadOpponentModel } from "./model.js";
import { isMain, rng32 } from "./util.js";

export interface CloneRow {
  botId: number;
  name: string;
  matches: number;
  real: Stats;
  clone: Stats;
}
interface Stats {
  meanScore: number;
  winRate: number;
  meanTopBid: number;
  meanPaid: number;
  tilesWon: number;
  wordsPerMatch: number;
  meanWordLen: number;
  tilesLeft: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function cloneCheck(dbPath: string, nBots: number, nMatches: number): CloneRow[] {
  const model = loadOpponentModel(dbPath);
  const db = openDb(dbPath, { readOnly: true });
  const ix = wordIndex();
  const dict = new Set(ix.words);
  const rows: CloneRow[] = [];
  try {
    const recent = num(db.prepare("SELECT MAX(ended_us) AS m FROM match_info").get()?.m);
    const bots = db
      .prepare(
        `SELECT s.bot_id, b.name, COUNT(*) AS n FROM match_seat s JOIN bot b ON b.id = s.bot_id
         WHERE s.is_sim = 0 AND s.ended_us > ? GROUP BY s.bot_id ORDER BY n DESC LIMIT ?`,
      )
      .all(recent - 6 * 3600e6, nBots);
    for (const b of bots) {
      const botId = num(b.bot_id);
      const matches = db
        .prepare("SELECT match_id FROM match_seat WHERE bot_id = ? ORDER BY ended_us DESC LIMIT ?")
        .all(botId, nMatches)
        .map((r) => num(r.match_id));
      const real: Record<keyof Stats, number[]> = {
        meanScore: [], winRate: [], meanTopBid: [], meanPaid: [], tilesWon: [], wordsPerMatch: [], meanWordLen: [], tilesLeft: [],
      };
      const sim: Record<keyof Stats, number[]> = {
        meanScore: [], winRate: [], meanTopBid: [], meanPaid: [], tilesWon: [], wordsPerMatch: [], meanWordLen: [], tilesLeft: [],
      };
      for (const matchId of matches) {
        const seats = db
          .prepare("SELECT bot_id, is_sim, strategy, final_score, place, won_tiles, words, tiles_left FROM match_seat WHERE match_id = ?")
          .all(matchId);
        const me = seats.find((s) => num(s.bot_id) === botId)!;
        real.meanScore.push(num(me.final_score));
        real.winRate.push(num(me.place) === 1 ? 1 : 0);
        real.tilesWon.push(num(me.won_tiles));
        real.wordsPerMatch.push(num(me.words));
        real.tilesLeft.push(num(me.tiles_left));
        for (const a of db
          .prepare("SELECT paid, top_bid FROM auction_ctx WHERE match_id = ? AND winner_bot_id = ?")
          .all(matchId, botId)) {
          real.meanPaid.push(num(a.paid));
          if (a.top_bid !== null) real.meanTopBid.push(num(a.top_bid));
        }
        for (const w of db.prepare("SELECT len FROM play_obs WHERE match_id = ? AND bot_id = ?").all(matchId, botId)) {
          real.meanWordLen.push(num(w.len));
        }

        const specs: SeatSpec[] = seats.map((s, i) =>
          num(s.is_sim) === 1
            ? { botId: num(s.bot_id), simStrategy: String(s.strategy) }
            : { botId: num(s.bot_id), agent: createCloneAgent(num(s.bot_id), { seed: matchId * 31 + i, model }) },
        );
        const res = runMatch(specs, rng32(matchId), () => ix.words, (w) => dict.has(w));
        const r = res.find((x) => x.botId === botId)!;
        sim.meanScore.push(r.score);
        sim.winRate.push(r.place === 1 ? 1 : 0);
        sim.tilesWon.push(r.tilesWon);
        sim.wordsPerMatch.push(r.words.length);
        sim.tilesLeft.push(r.tilesLeft);
        sim.meanPaid.push(...r.paid);
        sim.meanTopBid.push(...r.topBids);
        sim.meanWordLen.push(...r.words.map((w) => w.length));
      }
      const summarize = (x: Record<keyof Stats, number[]>): Stats => ({
        meanScore: mean(x.meanScore),
        winRate: mean(x.winRate),
        meanTopBid: mean(x.meanTopBid),
        meanPaid: mean(x.meanPaid),
        tilesWon: mean(x.tilesWon),
        wordsPerMatch: mean(x.wordsPerMatch),
        meanWordLen: mean(x.meanWordLen),
        tilesLeft: mean(x.tilesLeft),
      });
      rows.push({ botId, name: String(b.name), matches: matches.length, real: summarize(real), clone: summarize(sim) });
    }
  } finally {
    db.close();
  }
  return rows;
}

export function formatCloneCheck(rows: CloneRow[]): string {
  const f = (x: number, d = 1) => x.toFixed(d);
  const lines = [
    "| bot | matches | score real / clone | win% real / clone | top bid real / clone | paid real / clone | tiles won | words/match | word len | tiles left |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.name} (${r.botId}) | ${r.matches} | ${f(r.real.meanScore)} / ${f(r.clone.meanScore)} | ${f(100 * r.real.winRate, 0)} / ${f(100 * r.clone.winRate, 0)} | ${f(r.real.meanTopBid)} / ${f(r.clone.meanTopBid)} | ${f(r.real.meanPaid)} / ${f(r.clone.meanPaid)} | ${f(r.real.tilesWon)} / ${f(r.clone.tilesWon)} | ${f(r.real.wordsPerMatch)} / ${f(r.clone.wordsPerMatch)} | ${f(r.real.meanWordLen)} / ${f(r.clone.meanWordLen)} | ${f(r.real.tilesLeft)} / ${f(r.clone.tilesLeft)} |`,
    );
  }
  const err = (k: keyof Stats) =>
    mean(rows.map((r) => Math.abs(r.clone[k] - r.real[k]) / Math.max(1e-9, Math.abs(r.real[k]))));
  lines.push(
    "",
    `Mean relative error across bots: score ${f(100 * err("meanScore"), 0)}%, top bid ${f(100 * err("meanTopBid"), 0)}%, paid ${f(100 * err("meanPaid"), 0)}%, tiles won ${f(100 * err("tilesWon"), 0)}%, words/match ${f(100 * err("wordsPerMatch"), 0)}%.`,
  );
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string, d: number) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : d);
  const t = Date.now();
  const rows = cloneCheck(DEFAULT_DB_PATH, arg("--bots", 12), arg("--matches", 40));
  console.log(formatCloneCheck(rows));
  console.log(`\n(${((Date.now() - t) / 1000).toFixed(1)}s)`);
  if (!argv.includes("--no-store")) {
    const db = openDb(DEFAULT_DB_PATH);
    setMeta(db, "clone_check", JSON.stringify({ at: new Date().toISOString(), rows }));
    db.close();
  }
}

if (isMain(import.meta.url)) main();
