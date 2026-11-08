// Tunes the brain's parameters in the simulator with the cross-entropy
// method: sample candidates around the current mean, play every candidate
// on the same fresh deals (common random numbers, so candidates are compared
// on identical luck), move the mean toward the best few, shrink the spread.
// Mean finishing place is the objective (it is what ratings reward).
//
//   npm run tune -- [--setting field[,top,rackforges]] [--deals 150] [--gens 20] [--pop 12]
//     [--elite 4] [--workers 18] [--seed 7] [--keys k1,k2] [--write]
//     [--log FILE]
//
// With several settings each gets --deals deals per candidate and the
// objective is the mean place over all of them.
// --write merges the final mean into data/params.json. Validate the result
// with eval.ts on fresh seeds before trusting it.

import * as fs from "node:fs";
import * as path from "node:path";
import { buildJobs, est, fieldTables, topBots } from "./eval.js";
import type { JobResult, SeatDef } from "./evaljobs.js";
import { EvalPool } from "./evalpool.js";
import { DEFAULT_PARAMS, PARAMS_PATH, resolveParams, type Params } from "./params.js";
import { mulberry32 } from "./value.js";

/** Search ranges. Integers are floored by the agent, so they tune as reals. */
export const RANGES: Partial<Record<keyof Params, [number, number]>> = {
  coinBonus: [0, 1],
  playMargin: [0, 12],
  minPlayLen: [2, 7.99],
  lambdaScale: [0.6, 1.8],
  incomeShare: [0, 1],
  futureScale: [0.4, 2],
  futureValueScale: [0.5, 1.5],
  selectFuture: [0, 0.6],
  kMax: [3, 16],
  maxWinShare: [0.2, 0.8],
  rivalWeight: [0, 1],
  maxOverbid: [0, 10],
  denialWeight: [0, 2],
  driveWeight: [0, 2],
  calibRate: [0, 0.2],
  riskCoef: [-0.5, 1],
};

const DEFAULT_KEYS: (keyof Params)[] = [
  "coinBonus",
  "playMargin",
  "minPlayLen",
  "lambdaScale",
  "incomeShare",
  "futureScale",
  "futureValueScale",
  "kMax",
  "rivalWeight",
  "maxOverbid",
  "calibRate",
  "riskCoef",
];

interface Args {
  setting: string;
  deals: number;
  gens: number;
  pop: number;
  elite: number;
  workers: number;
  seed: number;
  keys: (keyof Params)[];
  write: boolean;
  log?: string;
  matches: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    setting: "field",
    deals: 150,
    gens: 20,
    pop: 12,
    elite: 4,
    workers: 18,
    seed: 7,
    keys: DEFAULT_KEYS,
    write: false,
    matches: 400,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    switch (k) {
      case "--setting": a.setting = v(); break;
      case "--deals": a.deals = Number(v()); break;
      case "--gens": a.gens = Number(v()); break;
      case "--pop": a.pop = Number(v()); break;
      case "--elite": a.elite = Number(v()); break;
      case "--workers": a.workers = Number(v()); break;
      case "--seed": a.seed = Number(v()); break;
      case "--matches": a.matches = Number(v()); break;
      case "--keys": a.keys = v().split(",") as (keyof Params)[]; break;
      case "--write": a.write = true; break;
      case "--log": a.log = v(); break;
      default: throw new Error(`unknown flag ${k}`);
    }
  }
  for (const key of a.keys) if (!RANGES[key]) throw new Error(`no search range for '${key}'`);
  return a;
}

/** Box-Muller normal. */
function normal(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rand = mulberry32(args.seed * 7777 + 1);
  const start = resolveParams();
  const mean = args.keys.map((k) => start[k] as number);
  const sd = args.keys.map((k) => {
    const [lo, hi] = RANGES[k]!;
    return (hi - lo) / 4;
  });
  const settings = args.setting.split(",");
  const field: SeatDef[][] = settings.includes("field") ? await fieldTables(args.matches) : [];
  const top = settings.includes("top") ? await topBots() : [];
  const pool = new EvalPool({ workers: args.workers, model: true });
  const clip = (j: number, x: number) => {
    const [lo, hi] = RANGES[args.keys[j]!]!;
    return Math.max(lo, Math.min(hi, x));
  };
  const toParams = (x: number[]) => Object.fromEntries(args.keys.map((k, j) => [k, x[j]!]));
  const log = args.log ? fs.createWriteStream(args.log, { flags: "a" }) : undefined;

  for (let g = 0; g < args.gens; g++) {
    const t0 = performance.now();
    const cands: number[][] = [mean.slice()];
    while (cands.length < args.pop) cands.push(mean.map((m, j) => clip(j, m + sd[j]! * normal(rand))));
    const spec = { settings, deals: args.deals, agents: ["x"], seed: args.seed, dealOffset: g * args.deals };
    const base = buildJobs(spec, field, top);
    const jobs = cands.flatMap((x, ci) =>
      base.map((j, i) => ({ ...j, id: ci * base.length + i, agent: `c${ci}`, params: toParams(x) })),
    );
    const results = await pool.run(jobs);
    const by = new Map<string, JobResult[]>();
    for (const r of results) {
      let l = by.get(r.agent);
      if (!l) by.set(r.agent, (l = []));
      l.push(r);
    }
    const fit = cands.map((_, ci) => {
      const rs = by.get(`c${ci}`) ?? [];
      const place = est(rs.map((r) => r.place)).mean;
      const score = est(rs.map((r) => r.score)).mean;
      // Place first; a hair of score breaks ties between equal places.
      return { ci, place, score, f: place - score / 10_000 };
    });
    fit.sort((a, b) => a.f - b.f);
    const elites = fit.slice(0, args.elite).map((e) => cands[e.ci]!);
    for (let j = 0; j < mean.length; j++) {
      const em = elites.reduce((s, x) => s + x[j]!, 0) / elites.length;
      const ev = elites.reduce((s, x) => s + (x[j]! - em) ** 2, 0) / elites.length;
      const [lo, hi] = RANGES[args.keys[j]!]!;
      mean[j] = clip(j, 0.7 * em + 0.3 * mean[j]!);
      sd[j] = Math.max((hi - lo) / 40, 0.6 * Math.sqrt(ev) + 0.4 * sd[j]! * 0.85);
    }
    const inc = fit.find((e) => e.ci === 0)!;
    const line = {
      gen: g,
      secs: Math.round((performance.now() - t0) / 1000),
      incumbent: { place: inc.place, score: inc.score },
      best: { place: fit[0]!.place, score: fit[0]!.score, params: toParams(cands[fit[0]!.ci]!) },
      mean: toParams(mean),
      sd: toParams(sd),
    };
    log?.write(JSON.stringify(line) + "\n");
    console.log(
      `gen ${g}: incumbent place ${inc.place.toFixed(3)} score ${inc.score.toFixed(1)} | best ${fit[0]!.place.toFixed(3)} | ${line.secs}s`,
    );
    console.log(
      "  mean " + args.keys.map((k, j) => `${k}=${mean[j]!.toFixed(3)}`).join(" "),
    );
  }
  await pool.close();
  log?.end();
  const tuned = toParams(mean);
  console.log("final", JSON.stringify(tuned));
  if (args.write) {
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(fs.readFileSync(PARAMS_PATH, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    const params = { ...((current.params as Record<string, unknown>) ?? {}), ...tuned };
    const out = {
      note: `tuned by src/brain/tune.ts on '${args.setting}', ${args.gens} gens x ${args.pop} x ${args.deals} deals, seed ${args.seed}`,
      tunedAt: new Date().toISOString(),
      params,
    };
    fs.mkdirSync(path.dirname(PARAMS_PATH), { recursive: true });
    fs.writeFileSync(PARAMS_PATH, JSON.stringify(out, null, 2) + "\n");
    console.log(`wrote ${PARAMS_PATH}`);
  }
  void DEFAULT_PARAMS;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
}
