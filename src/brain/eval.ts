// Evaluates RackForge in the faithful simulator, paired by deal:
// every deal is played once per agent under test, in the same seat, with the
// same opponents and the same seed, so per-deal differences cancel most of
// the luck of the draw.
//
//   npx tsx src/brain/eval.ts [--settings sims,starters,field] [--deals 300]
//     [--agents rackforge,starter] [--ablations] [--variant NAME=JSON]...
//     [--workers 18] [--seed 1] [--matches 400] [--first-price] [--no-model]
//     [--budget MS] [--json FILE] [--md FILE]
//
// Settings:
//   sims      me + 5 of the server's 6 sims (a lobby timeout)
//   starters  me + 5 copies of the official starter bot
//   field     me + the other 5 seats of a recent real match, each a clone of
//             the real bot that sat there (sims exact); the seat I take is
//             the one my own bot (RackForge) held, else a random real seat.
//             --match-offset N skips the newest N matches (held-out tables).
//   top       me + 5 clones drawn from the 12 best-rated active real bots.
//   rackforges   me + 5 copies of rackforge (a much stronger field than today's).
//   table     me + the fixed seats of --table SPECS (clone:<id>, sim:<Strategy>,
//             starter, rackforge), e.g. --table clone:59,clone:22,clone:67,clone:60,clone:120.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SimStrategy } from "../sim/engine.js";
import type { Job, JobResult, SeatDef } from "./evaljobs.js";
import { EvalPool } from "./evalpool.js";
import { mulberry32 } from "./value.js";

const SIM_POOL: { botId: number; strategy: SimStrategy }[] = [
  { botId: 1, strategy: "Cheapskate" },
  { botId: 2, strategy: "ValueBidder" },
  { botId: 3, strategy: "Aggressive" },
  { botId: 4, strategy: "ValueBidder" },
  { botId: 5, strategy: "Aggressive" },
  { botId: 6, strategy: "Cheapskate" },
];
/** Our own bots in the live history: never cloned, their seat is the one we take. */
const OWN_BOTS = new Set([127]);
const TEST_ID = 1_000_000;

/** Ablations: each turns one idea off (or a risky one on). */
export const ABLATIONS: Record<string, Record<string, unknown>> = {
  noModel: { useModel: false },
  noCalib: { calibRate: 0 },
  noRival: { rivalWeight: 0 },
  noDenial: { denialWeight: 0 },
  noDriving: { driveWeight: 0 },
  noFuture: { futureScale: 0, kMax: 0 },
  fixedLambda: { lambdaFixed: 0.45 },
  noIncome: { incomeShare: 0 },
  noCoinBonus: { coinBonus: 0 },
  fullCoinBonus: { coinBonus: 1 },
  hold7: { holdRule: 7 },
  playAny: { holdRule: 2 },
  noLastDeny: { lastTileDeny: false },
  riskSeeking: { riskCoef: 0.5 },
  selectFuture: { selectFuture: 0.5 },
};

interface Args {
  settings: string[];
  deals: number;
  agents: string[];
  variants: Record<string, Record<string, unknown>>;
  workers: number;
  seed: number;
  matches: number;
  firstPrice: boolean;
  model: boolean;
  budgetMs?: number;
  json?: string;
  md?: string;
  matchOffset: number;
  table?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    settings: ["sims", "starters", "field"],
    deals: 200,
    agents: ["rackforge", "starter"],
    variants: {},
    workers: 18,
    seed: 1,
    matches: 400,
    firstPrice: false,
    model: true,
    matchOffset: 0,
  };
  let ablations = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    switch (k) {
      case "--settings": a.settings = v().split(","); break;
      case "--deals": a.deals = Number(v()); break;
      case "--agents": a.agents = v().split(","); break;
      case "--workers": a.workers = Number(v()); break;
      case "--seed": a.seed = Number(v()); break;
      case "--matches": a.matches = Number(v()); break;
      case "--match-offset": a.matchOffset = Number(v()); break;
      case "--table": a.table = v(); break;
      case "--first-price": a.firstPrice = true; break;
      case "--no-model": a.model = false; break;
      case "--budget": a.budgetMs = Number(v()); break;
      case "--json": a.json = v(); break;
      case "--md": a.md = v(); break;
      case "--ablations": ablations = true; break;
      case "--variant": {
        const s = v();
        const eq = s.indexOf("=");
        if (eq <= 0) throw new Error(`--variant needs NAME=JSON`);
        a.variants[s.slice(0, eq)] = JSON.parse(s.slice(eq + 1)) as Record<string, unknown>;
        if (!a.agents.includes(s.slice(0, eq))) a.agents.push(s.slice(0, eq));
        break;
      }
      default:
        throw new Error(`unknown flag ${k}`);
    }
  }
  a.variants.rackforge ??= {};
  if (ablations) {
    for (const [name, p] of Object.entries(ABLATIONS)) {
      a.variants[name] = { ...a.variants.rackforge, ...p };
      if (!a.agents.includes(name)) a.agents.push(name);
    }
  }
  return a;
}

// ---------- tables ----------

async function openHistory() {
  const spec: string = "../memory/db.js";
  const { openDb } = (await import(spec)) as typeof import("../memory/db.js");
  return openDb(undefined, { readOnly: true });
}

/** The best-rated real bots that played at least 50 matches in the last day. */
export async function topBots(n = 12): Promise<number[]> {
  const db = await openHistory();
  try {
    return db
      .prepare(
        `SELECT s.bot_id FROM bot_stats s JOIN bot b ON b.id = s.bot_id
         WHERE b.is_simulated = 0
           AND (SELECT COUNT(*) FROM match_seat m WHERE m.bot_id = s.bot_id
                AND m.ended_us > (SELECT MAX(ended_us) FROM match_info) - 24 * 3600e6) >= 50
         ORDER BY s.mu - 2 * s.sigma DESC LIMIT ?`,
      )
      .all(n)
      .map((r) => Number(r.bot_id))
      .filter((id) => !OWN_BOTS.has(id));
  } finally {
    db.close();
  }
}

export async function fieldTables(n: number, offset = 0): Promise<SeatDef[][]> {
  const db = await openHistory();
  try {
    const ids = db
      .prepare(
        "SELECT match_id FROM match_info WHERE n_seats = 6 AND balance_ok = 1 ORDER BY ended_us DESC LIMIT ? OFFSET ?",
      )
      .all(n, offset)
      .map((r) => Number(r.match_id));
    const seatQ = db.prepare("SELECT bot_id, is_sim, strategy FROM match_seat WHERE match_id = ? ORDER BY bot_id");
    return ids.map((id) =>
      seatQ.all(id).map((r): SeatDef => {
        const botId = Number(r.bot_id);
        if (Number(r.is_sim) === 1) return { kind: "sim", botId, strategy: String(r.strategy) as SimStrategy };
        return { kind: "clone", botId };
      }),
    );
  } finally {
    db.close();
  }
}

export interface JobSpec {
  settings: string[];
  deals: number;
  agents: string[];
  seed: number;
  firstPrice?: boolean;
  /** First deal index (the tuner moves on to fresh deals each generation). */
  dealOffset?: number;
  /** Seats of the 'table' setting (see parseTableSeats). */
  table?: string;
}

/** 'clone:59,sim:Aggressive,starter,rackforge' -> seats (my own seat excluded). */
export function parseTableSeats(spec: string): SeatDef[] {
  const seats = spec
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .map((x, i): SeatDef => {
      const clone = /^clone:(\d+)$/.exec(x);
      if (clone) return { kind: "clone", botId: Number(clone[1]) };
      const sim = /^sim:(Cheapskate|ValueBidder|Aggressive)$/.exec(x);
      if (sim) {
        const s = SIM_POOL.find((p) => p.strategy === sim[1]);
        return { kind: "sim", botId: (s?.botId ?? 1) + 10 * i, strategy: sim[1] as SimStrategy };
      }
      if (x === "starter") return { kind: "starter", botId: TEST_ID + 1 + i };
      if (x === "rackforge") return { kind: "rackforge", botId: TEST_ID + 1 + i };
      throw new Error(`unknown --table seat '${x}'`);
    });
  if (seats.length < 1 || seats.length > 5) throw new Error("--table needs 1-5 seats");
  return seats;
}

export function buildJobs(args: JobSpec, field: SeatDef[][], top: number[] = []): Job[] {
  const jobs: Job[] = [];
  let id = 0;
  for (const setting of args.settings) {
    const d0 = args.dealOffset ?? 0;
    for (let deal = d0; deal < d0 + args.deals; deal++) {
      const rand = mulberry32((args.seed * 1_000_003 + deal * 7919 + setting.length * 104_729) >>> 0);
      let seats: SeatDef[];
      if (setting === "sims") {
        const pool = SIM_POOL.slice();
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [pool[i], pool[j]] = [pool[j]!, pool[i]!];
        }
        seats = pool.slice(0, 5).map((s): SeatDef => ({ kind: "sim", botId: s.botId, strategy: s.strategy }));
      } else if (setting === "starters") {
        seats = [1, 2, 3, 4, 5].map((k): SeatDef => ({ kind: "starter", botId: TEST_ID + k }));
      } else if (setting === "rackforges") {
        seats = [1, 2, 3, 4, 5].map((k): SeatDef => ({ kind: "rackforge", botId: TEST_ID + k }));
      } else if (setting === "field") {
        if (field.length === 0) throw new Error("no field tables (is data/history.sqlite mined?)");
        const table = field[deal % field.length]!;
        let mine = table.findIndex((s) => OWN_BOTS.has(s.botId));
        if (mine < 0) {
          const real = table.map((s, i) => (s.kind === "clone" ? i : -1)).filter((i) => i >= 0);
          mine = real.length ? real[Math.floor(rand() * real.length)]! : Math.floor(rand() * table.length);
        }
        seats = table.filter((_, i) => i !== mine);
      } else if (setting === "top") {
        if (top.length < 5) throw new Error("not enough top bots (is data/history.sqlite mined?)");
        const pool = top.slice();
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [pool[i], pool[j]] = [pool[j]!, pool[i]!];
        }
        seats = pool.slice(0, 5).map((botId): SeatDef => ({ kind: "clone", botId }));
      } else if (setting === "table") {
        if (!args.table) throw new Error("setting 'table' needs --table SPECS");
        seats = parseTableSeats(args.table);
      } else throw new Error(`unknown setting '${setting}'`);
      // My seat moves around the table so seat order can't favour anyone.
      const at = deal % (seats.length + 1);
      const full = [...seats.slice(0, at), { kind: "test", botId: TEST_ID } as SeatDef, ...seats.slice(at)];
      const seed = (Math.floor(rand() * 2 ** 31) ^ (args.seed * 2654435761)) >>> 0;
      for (const agent of args.agents) {
        jobs.push({
          id: id++,
          setting,
          deal,
          seed,
          seats: full,
          agent,
          auctionType: args.firstPrice ? "FirstPrice" : "Vickrey",
        });
      }
    }
  }
  return jobs;
}

// ---------- statistics ----------

export interface Est {
  mean: number;
  half: number;
  n: number;
}

export function est(xs: readonly number[]): Est {
  const n = xs.length;
  if (n === 0) return { mean: NaN, half: NaN, n };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean: m, half: NaN, n };
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return { mean: m, half: 1.96 * Math.sqrt(v / n), n };
}

const fmt = (e: Est, d = 2) => `${e.mean.toFixed(d)} ±${Number.isFinite(e.half) ? e.half.toFixed(d) : "?"}`;

export function report(results: JobResult[], agents: string[], settings: string[]): string {
  const lines: string[] = [];
  for (const setting of settings) {
    const rs = results.filter((r) => r.setting === setting);
    const by = new Map<string, Map<number, JobResult>>();
    for (const r of rs) {
      let m = by.get(r.agent);
      if (!m) by.set(r.agent, (m = new Map()));
      m.set(r.deal, r);
    }
    const deals = new Set(rs.map((r) => r.deal)).size;
    lines.push(`### ${setting} (${deals} deals)`, "");
    lines.push(
      "| agent | mean place | win rate | score | others' score | coins left | tiles left | Δplace vs starter | Δplace vs rackforge | Δscore vs rackforge |",
      "|---|---|---|---|---|---|---|---|---|---|",
    );
    const paired = (a: string, b: string, f: (r: JobResult) => number) => {
      const A = by.get(a);
      const B = by.get(b);
      if (!A || !B || a === b) return undefined;
      const d: number[] = [];
      for (const [deal, ra] of A) {
        const rb = B.get(deal);
        if (rb) d.push(f(ra) - f(rb));
      }
      return est(d);
    };
    for (const agent of agents) {
      const m = by.get(agent);
      if (!m) continue;
      const xs = [...m.values()];
      const vs = paired(agent, "starter", (r) => r.place);
      const vp = paired(agent, "rackforge", (r) => r.place);
      const vsc = paired(agent, "rackforge", (r) => r.score);
      lines.push(
        `| ${agent} | ${fmt(est(xs.map((r) => r.place)))} | ${fmt(est(xs.map((r) => r.win * 100)), 1)}% | ${fmt(est(xs.map((r) => r.score)), 1)} | ${est(xs.map((r) => r.others)).mean.toFixed(1)} | ${est(xs.map((r) => r.coins)).mean.toFixed(1)} | ${est(xs.map((r) => r.tiles)).mean.toFixed(2)} | ${vs ? fmt(vs) : "-"} | ${vp ? fmt(vp) : "-"} | ${vsc ? fmt(vsc, 1) : "-"} |`,
      );
    }
    const errs = rs.filter((r) => r.errors > 0);
    if (errs.length) lines.push("", `agent errors in ${errs.length} games, first: ${errs[0]!.firstError?.split("\n")[0]}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const field = args.settings.includes("field") ? await fieldTables(args.matches, args.matchOffset) : [];
  const top = args.settings.includes("top") ? await topBots() : [];
  const jobs = buildJobs(args, field, top);
  const t0 = performance.now();
  let last = 0;
  const pool = new EvalPool({ workers: args.workers, variants: args.variants, model: args.model, budgetMs: args.budgetMs });
  const results = await pool.run(jobs, (n) => {
    const now = performance.now();
    if (now - last > 5000) {
      last = now;
      process.stderr.write(`  ${n}/${jobs.length} games, ${((now - t0) / 1000).toFixed(0)} s\n`);
    }
  });
  await pool.close();
  const secs = (performance.now() - t0) / 1000;
  const ms = results.map((r) => r.ms);
  const head = [
    `RackForge evaluation: ${jobs.length} games in ${secs.toFixed(0)} s (${(jobs.length / secs).toFixed(1)}/s, ${args.workers} workers), seed ${args.seed}, ${args.firstPrice ? "FirstPrice" : "Vickrey"}, model ${args.model ? "on" : "off"}.`,
    `Mean match time ${est(ms).mean.toFixed(0)} ms. Intervals are 95% over deals; Δ columns are paired by deal (negative Δplace = better).`,
    "",
  ];
  const md = head.join("\n") + report(results, args.agents, args.settings);
  console.log(md);
  if (args.md) fs.writeFileSync(args.md, md);
  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify({ args, results }, null, 0));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
}
