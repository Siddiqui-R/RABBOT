// Does the opponent model loaded from RackForge's backend ("stdb:") answer like
// the one loaded from the miner's SQLite copy? Times the backend load and
// compares predictBid / marketPrice / playHabits / botSummary on a sample.
//
//   npx tsx src/backend/model-compare.ts [--sqlite data/miner.sqlite] [--samples 3000]

import { join } from "node:path";
import { loadOpponentModel } from "../memory/model.js";
import { backendSnapshotDb, type LoadTimings } from "./model-source.js";

const args = process.argv.slice(2);
const flag = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const sqlitePath = flag("--sqlite") ?? join(import.meta.dirname, "..", "..", "data", "miner.sqlite");
const samples = Number(flag("--samples") ?? 3000);

const timings: LoadTimings[] = [];
let t = performance.now();
backendSnapshotDb({}, timings).close();
const snapMs = performance.now() - t;
for (const x of timings) console.log(`  ${x.table.padEnd(12)} ${String(x.rows).padStart(8)} rows ${x.ms.toFixed(0).padStart(6)} ms`);

t = performance.now();
const be = loadOpponentModel("stdb:");
const beMs = performance.now() - t;
t = performance.now();
const lite = loadOpponentModel(sqlitePath);
const liteMs = performance.now() - t;
console.log(`load: backend ${beMs.toFixed(0)} ms (snapshot alone ${snapMs.toFixed(0)} ms), sqlite ${liteMs.toFixed(0)} ms`);

// Deterministic sample of (bot, letter, phase, balance, rack).
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const bots = lite.knownBots();
const beBots = new Set(be.knownBots());
console.log(`bots: sqlite ${bots.length}, backend ${beBots.size}, missing in backend ${bots.filter((b) => !beBots.has(b)).length}`);
const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
let maxMean = 0;
let maxP = 0;
let differ = 0;
const differBots = new Set<number>();
for (let i = 0; i < samples; i++) {
  const bot = bots[Math.floor(rnd() * bots.length)]!;
  const letter = L[Math.floor(rnd() * 26)]!;
  const ctx = { phase: rnd(), balance: Math.floor(rnd() * 150), rackSize: rnd() < 0.5 ? undefined : Math.floor(rnd() * 14) };
  const a = lite.predictBid(bot, letter, ctx);
  const b = be.predictBid(bot, letter, ctx);
  const dm = Math.abs(a.mean - b.mean);
  let dp = 0;
  for (let k = 0; k < Math.min(a.pmf.length, b.pmf.length); k++) dp = Math.max(dp, Math.abs(a.pmf[k]! - b.pmf[k]!));
  if (a.pmf.length !== b.pmf.length) dp = Math.max(dp, 1);
  maxMean = Math.max(maxMean, dm);
  maxP = Math.max(maxP, dp);
  if (dm > 1e-9 || dp > 1e-9) {
    differ++;
    differBots.add(bot);
  }
}
console.log(`predictBid: ${samples} samples, ${differ} differ (bots ${[...differBots].slice(0, 10).join(",")}), max |mean diff| ${maxMean.toExponential(2)}, max |pmf diff| ${maxP.toExponential(2)}`);

let priceDiff = 0;
for (const letter of L) {
  for (const phase of [0.1, 0.4, 0.7, 0.9, 0.99]) {
    const a = lite.marketPrice(letter, phase);
    const b = be.marketPrice(letter, phase);
    priceDiff = Math.max(priceDiff, Math.abs(a.mean - b.mean), Math.abs(a.pUnsold - b.pUnsold), Math.abs(a.n - b.n));
  }
}
console.log(`marketPrice: 130 (letter, phase) cells, max diff ${priceDiff}`);

let habitDiff = 0;
let summaryDiff = 0;
const summaryFields = ["matches", "wins", "meanPlace", "meanScore", "wordsPlayed", "meanWordLength", "wordsPerMatch", "tilesLeftAtEnd", "playThrough", "paidVsMarket", "rating", "aggressiveness"] as const;
for (const bot of bots.slice(0, 60)) {
  const a = lite.playHabits(bot);
  const b = be.playHabits(bot);
  habitDiff = Math.max(habitDiff, Math.abs(a.wordsPerMatch - b.wordsPerMatch), Math.abs(a.matches - b.matches), ...a.lengthDist.map((x, i) => Math.abs(x - b.lengthDist[i]!)));
  const sa = lite.botSummary(bot) as unknown as Record<string, number | null>;
  const sb = be.botSummary(bot) as unknown as Record<string, number | null>;
  for (const f of summaryFields) summaryDiff = Math.max(summaryDiff, Math.abs(Number(sa[f] ?? 0) - Number(sb[f] ?? 0)));
}
console.log(`playHabits (60 bots) max diff ${habitDiff}; botSummary (60 bots, ${summaryFields.length} fields) max diff ${summaryDiff}`);
process.exit(0);
