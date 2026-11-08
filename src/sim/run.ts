// npm run sim -- --games 600 --table "rackforge,starter,sim:Aggressive" --pad --swap --workers 18
//
// Plays offline matches and prints, per seat spec: mean score, mean place
// (ties share the average place), win rate (ties split), each with a 95%
// interval clustered by deal, plus coins and tiles left at the end and how
// many bids and words the server would have refused.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMatches, type RunOptions, type RunResult } from "./runner.js";
import type { Estimate } from "./stats.js";

export { runMatches } from "./runner.js";
export type { RunOptions, RunResult } from "./runner.js";

const DEFAULT_TABLE = "starter,sim:Cheapskate,sim:ValueBidder,sim:Aggressive,sim:ValueBidder,sim:Aggressive";

const HELP = `usage: npm run sim -- [options]
  --games N          matches to play (default 100; with --swap rounded up to whole deals)
  --table SPECS      comma-separated seats (default "${DEFAULT_TABLE}")
                     rackforge | rackforge#<variant> | starter | sim:Cheapskate|ValueBidder|Aggressive
                     | clone:<botId> | idle
  --pad              fill to 6 seats from the server's sim pool, like a lobby timeout
  --swap             paired evaluation: play every deal in every seat rotation
  --seed S           base seed (default 1)
  --workers W        worker threads (default 1 = in-process)
  --rng MODE         server (default): the live server's skewed per-transaction ctx.random
                     streams: fair independent streams (letters never depend on bids)
  --first-price      FirstPrice auctions instead of Vickrey
  --rack N           starting rack size (default 5)
  --budget MS        refineBid budget handed to agents (default 700)
  --params JSON      params for 'rackforge' seats
  --variant NAME=JSON  params for 'rackforge#NAME' seats (repeatable)
  --model PATH       opponent model db for rackforge seats; --no-model to skip it
  --records FILE     write every game's record as JSON lines
  --strict           stop on the first agent exception
  --json             print the result as JSON`;

function parseArgs(argv: string[]): { opts: RunOptions; json: boolean; records?: string } {
  const opts: RunOptions = { table: DEFAULT_TABLE, games: 100, seed: 1, workers: 1 };
  let json = false;
  let records: string | undefined;
  const variants: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const int = (): number => {
      const v = value();
      const n = Number(v);
      if (!Number.isSafeInteger(n)) throw new Error(`${a} needs an integer, got '${v}'`);
      return n;
    };
    switch (a) {
      case "--games": opts.games = int(); break;
      case "--table": opts.table = value(); break;
      case "--seed": opts.seed = int(); break;
      case "--workers": opts.workers = int(); break;
      case "--swap": opts.swap = true; break;
      case "--pad": opts.pad = true; break;
      case "--first-price": opts.auctionType = "FirstPrice"; break;
      case "--rng": {
        const v = value();
        if (v !== "server" && v !== "streams") throw new Error(`--rng needs server or streams, got '${v}'`);
        opts.rng = v;
        break;
      }
      case "--rack": opts.startingRackSize = int(); break;
      case "--budget": opts.budgetMs = int(); break;
      case "--params": opts.params = JSON.parse(value()) as Record<string, unknown>; break;
      case "--variant": {
        const v = value();
        const eq = v.indexOf("=");
        if (eq <= 0) throw new Error(`--variant needs NAME=JSON, got '${v}'`);
        variants[v.slice(0, eq)] = JSON.parse(v.slice(eq + 1)) as Record<string, unknown>;
        break;
      }
      case "--model": opts.model = value(); break;
      case "--no-model": opts.model = false; break;
      case "--records": records = value(); break;
      case "--strict": opts.strict = true; break;
      case "--json": json = true; break;
      case "--help":
      case "-h":
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option '${a}'\n${HELP}`);
    }
  }
  if (Object.keys(variants).length > 0) opts.variants = variants;
  if (records) opts.keepRecords = true;
  return { opts, json, records };
}

const fmt = (x: number, digits = 1) => (Number.isFinite(x) ? x.toFixed(digits) : "n/a");
const ci = (e: Estimate, digits = 1, scale = 1) =>
  `${fmt(e.mean * scale, digits)} ±${fmt(e.halfWidth * scale, digits)}`;

export function formatResult(r: RunResult): string {
  const rows = [
    ["seat", "n", "score", "place", "win %", "coins", "tiles", "words", "bid rej", "word rej", "errors"],
    ...r.stats.map((s) => [
      s.spec,
      String(s.games),
      ci(s.score),
      ci(s.place, 2),
      ci(s.winRate, 1, 100),
      fmt(s.coinsLeft.mean),
      fmt(s.tilesLeft.mean, 2),
      fmt(s.wordsPlayed, 1),
      String(s.bidRejections),
      String(s.wordRejections),
      String(s.agentErrors),
    ]),
  ];
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
  const lines = rows.map((row) => row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join("  "));
  lines.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "));
  const head =
    `${r.games} matches (${r.deals} deals, ${r.seatsPerGame} seats${r.swap ? ", rotated" : ""}${r.pad ? ", sim-padded" : ""}), ` +
    `seed ${r.seed}, ${r.workers} worker${r.workers === 1 ? "" : "s"}: ` +
    `${(r.elapsedMs / 1000).toFixed(2)} s, ${r.matchesPerSec.toFixed(1)} matches/s`;
  const notes = r.warnings.map((w) => `warning: ${w}`);
  const errs = r.stats
    .filter((s) => s.firstError)
    .map((s) => `first error in ${s.spec}:\n${s.firstError}`);
  return [head, "", ...lines, ...(notes.length ? ["", ...notes] : []), ...(errs.length ? ["", ...errs] : [])].join("\n");
}

async function main() {
  const { opts, json, records } = parseArgs(process.argv.slice(2));
  const result = await runMatches(opts);
  if (records) {
    fs.writeFileSync(records, result.records!.map((g) => JSON.stringify(g)).join("\n") + "\n");
    delete result.records;
  }
  console.log(json ? JSON.stringify(result, null, 2) : formatResult(result));
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && fs.existsSync(entry) && fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
