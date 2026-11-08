// Live-mode timing of the brain's three entry points, in real field-replay
// matches (clones of recent opponents): quickBid must stay under ~20 ms, and
// refineBid must hand its bid back within the budget it was given.
//
//   npx tsx src/brain/bench.ts [--games 6] [--budget 150] [--params JSON]

import * as path from "node:path";
import type { Agent, AuctionView, MatchView } from "../core/types.js";
import { runMatch, type MatchSeat } from "../sim/engine.js";
import { fieldTables } from "./eval.js";
import { loadEnv } from "./evaljobs.js";
import { createAgent } from "./index.js";

function quantile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string, d: number) => {
    const i = argv.indexOf(k);
    return i >= 0 ? Number(argv[i + 1]) : d;
  };
  const games = arg("--games", 6);
  const budget = arg("--budget", 150);
  const pi = argv.indexOf("--params");
  const params = pi >= 0 ? (JSON.parse(argv[pi + 1]!) as Record<string, unknown>) : {};
  const env = await loadEnv({});
  const tables = await fieldTables(games);
  const quick: number[] = [];
  const over: number[] = [];
  const words: number[] = [];
  const samples: number[] = [];
  for (let g = 0; g < games; g++) {
    const rackforge = createAgent({ params, mode: "live", seed: g, model: env.model });
    const timed: Agent = {
      name: "rackforge",
      quickBid(v: MatchView, a: AuctionView) {
        const t = performance.now();
        const r = rackforge.quickBid(v, a);
        quick.push(performance.now() - t);
        return r;
      },
      refineBid(v: MatchView, a: AuctionView, b: number) {
        const t = performance.now();
        const r = rackforge.refineBid!(v, a, b);
        over.push(performance.now() - t - b);
        const tr = (rackforge as { lastTrace?: { samples: number } }).lastTrace;
        if (tr) samples.push(tr.samples);
        return r;
      },
      chooseWords(v: MatchView) {
        const t = performance.now();
        const r = rackforge.chooseWords(v);
        words.push(performance.now() - t);
        return r;
      },
    };
    const table = tables[g % tables.length]!;
    const seats: MatchSeat[] = table.slice(1).map((s, i) =>
      s.kind === "sim"
        ? { botId: s.botId, isSim: true, strategy: s.strategy }
        : { botId: s.botId, isSim: false, agent: env.createClone!(s.botId, { seed: g * 10 + i, model: env.model }) },
    );
    runMatch({ seats: [{ botId: 1_000_000, isSim: false, agent: timed }, ...seats], seed: 9000 + g, budgetMs: budget });
    process.stderr.write(`  game ${g + 1}/${games}\n`);
  }
  const row = (name: string, xs: number[]) =>
    `${name.padEnd(22)} n ${String(xs.length).padStart(5)}  p50 ${quantile(xs, 0.5).toFixed(2).padStart(7)}  p99 ${quantile(xs, 0.99).toFixed(2).padStart(7)}  max ${quantile(xs, 1).toFixed(2).padStart(7)} ms`;
  console.log(`live mode, refine budget ${budget} ms, ${games} field-replay matches`);
  console.log(row("quickBid", quick));
  console.log(row("refineBid overshoot", over));
  console.log(row("chooseWords", words));
  console.log(`refine samples         p50 ${quantile(samples, 0.5)}  p10 ${quantile(samples, 0.1)}  mean ${(samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)).toFixed(1)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
}
