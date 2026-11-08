// Tournament-stage stress tests for the brain.
//
//   npx tsx src/sim/tournament.ts --table rackforge,clone:59 --games 20 [--stage Swiss|Bracket|Final]
//       [--series] [--first-price] [--rack 7] [--match-size 6] [--live] [--params JSON]
//       [--budget MS] [--no-model] [--out FILE] [--seed S]
//
// Plays matches in this thread (run several processes for parallelism) with
// every sealed bid recorded and every agent call timed, and reports per
// rackforge seat what a tournament cares about: place, Swiss points
// (max(matchSize - place, 0), ties share the higher place), last place
// (Bracket), score, 7+ letter words, and failures: agent exceptions,
// refused bids/words, slow calls, bids that look absurd, coins and tiles
// left unused at the end.
//
// --stage sets MatchView.tournament for every seat (standings: everyone
// level). --series plays the Final: FINAL_GAMES heads-up games per deal with
// the running totals carried in view.tournament.finalTotals, the champion by
// total score. --live builds rackforge seats in 'live' mode so their time
// budgets are real (wall-clock timings; the machine's load counts).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { STARTING_BALANCE, letterValue } from "../core/rules.js";
import type { Agent, AuctionType, AuctionView, MatchView, TournamentStage, TournamentView } from "../core/types.js";
import { runMatch, type MatchOutcome, type MatchSeat } from "./engine.js";
import { importIfPresent } from "./registry.js";
import { deriveSeed } from "./rng.js";
import { planGame, prepare, type RunContext } from "./runner.js";

/** Games in a final (server FINAL_GAMES). */
export const FINAL_GAMES = 3;

export interface TournamentRunOptions {
  table: string;
  games: number;
  seed?: number;
  stage?: TournamentStage;
  /** Final: play FINAL_GAMES games per deal and sum the totals. */
  series?: boolean;
  auctionType?: AuctionType;
  startingRackSize?: number;
  /** Swiss points are max(matchSize - place, 0). Default: the table size. */
  matchSize?: number;
  /** 'rackforge' seats in 'live' mode (real time budgets). */
  live?: boolean;
  budgetMs?: number;
  model?: boolean | string;
  /** Params for rackforge seats (e.g. a stage-aware flag once the brain has one). */
  params?: Record<string, unknown>;
}

export interface CallTimes {
  quickMax: number;
  quickOver20: number;
  refineMax: number;
  refineOverBudget: number;
  wordsMax: number;
  calls: number;
}

/** One rackforge seat's match, with everything a failure hunt needs. */
export interface SeatReport {
  game: number;
  seatGame: number;
  seats: number;
  place: number;
  swissPoints: number;
  last: boolean;
  score: number;
  bestRival: number;
  words: number;
  sevenPlus: number;
  tilesLeft: number;
  coinsLeft: number;
  bidRejections: number;
  wordRejections: number;
  agentErrors: number;
  firstError?: string;
  /** Largest bid, and bids that look absurd: above max(3 x (letter value + 4), 25) before the last 5 auctions. */
  maxBid: number;
  absurdBids: number;
  absurdSample?: string;
  /** All-in bids (bid == balance >= 10) before the last 5 auctions. */
  allIn: number;
  tilesWon: number;
  spent: number;
  times: CallTimes;
}

export interface SeriesReport {
  deal: number;
  myTotal: number;
  oppTotal: number;
  won: boolean;
  games: number[];
}

function placeOf(scores: readonly number[], i: number): number {
  return scores.filter((s) => s > scores[i]!).length + 1;
}

/** Wraps an agent to time every call (wall clock). */
function timed(agent: Agent, budgetMs: number, t: CallTimes): Agent {
  const clock = () => performance.now();
  const wrapped: Agent = {
    name: agent.name,
    quickBid(view: MatchView, auction: AuctionView) {
      const t0 = clock();
      const b = agent.quickBid(view, auction);
      const dt = clock() - t0;
      t.quickMax = Math.max(t.quickMax, dt);
      if (dt > 20) t.quickOver20++;
      t.calls++;
      return b;
    },
    chooseWords(view: MatchView) {
      const t0 = clock();
      const w = agent.chooseWords(view);
      t.wordsMax = Math.max(t.wordsMax, clock() - t0);
      return w;
    },
  };
  if (agent.refineBid) {
    wrapped.refineBid = (view, auction, budget) => {
      const t0 = clock();
      const b = agent.refineBid!(view, auction, budget);
      const dt = clock() - t0;
      t.refineMax = Math.max(t.refineMax, dt);
      if (dt > budgetMs) t.refineOverBudget++;
      return b;
    };
  }
  if (agent.onMatchEnd) wrapped.onMatchEnd = (v) => agent.onMatchEnd!(v);
  return wrapped;
}

export function levelStandings(botIds: readonly number[], stage: TournamentStage, matchSize: number, round = 1): TournamentView {
  return {
    phase: stage,
    round,
    matchSize,
    topCut: Math.min(botIds.length, 8),
    swissRoundsTotal: 3,
    standings: botIds.map((botId) => ({ botId, swissPoints: 0, totalScore: 0, eliminated: false })),
  };
}

interface Ctx {
  run: RunContext;
  opts: TournamentRunOptions;
  createLive?: (o: object) => Agent;
  model?: unknown;
}

async function setup(opts: TournamentRunOptions): Promise<Ctx> {
  const run = await prepare({
    table: opts.table,
    games: opts.games,
    seed: opts.seed ?? 1,
    auctionType: opts.auctionType,
    startingRackSize: opts.startingRackSize,
    model: opts.model,
    params: opts.params,
  });
  const ctx: Ctx = { run, opts };
  if (opts.live) {
    const brain = await importIfPresent("../brain/index.js");
    ctx.createLive = brain?.["createAgent"] as (o: object) => Agent;
    if (opts.model !== false) {
      const mod = await importIfPresent("../memory/model.js");
      const load = mod?.["loadOpponentModel"] as ((p?: string) => unknown) | undefined;
      ctx.model = load?.(typeof opts.model === "string" ? opts.model : undefined);
    }
  }
  return ctx;
}

function playOne(ctx: Ctx, game: number, matchId: number, view: ((ids: number[]) => TournamentView | undefined) | undefined): {
  out: MatchOutcome;
  reports: SeatReport[];
} {
  const plan = planGame(ctx.run, game);
  const budgetMs = ctx.opts.budgetMs ?? 700;
  const times = plan.seats.map((): CallTimes => ({ quickMax: 0, quickOver20: 0, refineMax: 0, refineOverBudget: 0, wordsMax: 0, calls: 0 }));
  const seats: MatchSeat[] = plan.seats.map((s, i) => {
    const seed = deriveSeed(plan.dealSeed, "agent", i);
    let agent =
      s.spec.kind === "rackforge" && ctx.createLive
        ? ctx.createLive({ params: ctx.run.opts.params, mode: "live", seed, model: ctx.model })
        : ctx.run.registry.create(s.spec, seed);
    if (agent && s.spec.kind === "rackforge") agent = timed(agent, budgetMs, times[i]!);
    return { botId: s.botId, isSim: s.isSim, strategy: s.spec.strategy, agent };
  });
  const ids = plan.seats.map((s) => s.botId);
  const out = runMatch({
    seats,
    seed: plan.dealSeed,
    matchId,
    auctionType: ctx.run.opts.auctionType,
    startingRackSize: ctx.run.opts.startingRackSize,
    budgetMs,
    recordBids: true,
    tournament: view?.(ids),
  });
  const scores = out.seats.map((s) => s.score);
  const size = ctx.opts.matchSize ?? plan.seats.length;
  const lastAuctions = 5;
  const totalRounds = out.rounds;
  const reports: SeatReport[] = [];
  out.seats.forEach((s, i) => {
    if (plan.seats[i]!.spec.kind !== "rackforge") return;
    const place = placeOf(scores, i);
    const words = out.engine.history.filter((e) => e.kind === "word" && e.botId === s.botId) as { word: string }[];
    let maxBid = 0;
    let absurd = 0;
    let absurdSample: string | undefined;
    let allIn = 0;
    let won = 0;
    let spent = 0;
    // Balance before each auction, rebuilt from the record (bids are placed after this round's words).
    for (const b of out.engine.bidLog) {
      const mine = b.bids.filter(([id]) => id === s.botId).map(([, x]) => x);
      const bid = mine.length ? mine[mine.length - 1]! : 0;
      if (b.winnerBotId === s.botId) {
        won++;
        spent += b.paid;
      }
      if (bid <= 0) continue;
      maxBid = Math.max(maxBid, bid);
      const late = b.round > totalRounds - lastAuctions;
      if (!late && bid > Math.max(3 * (letterValue(b.letter) + 4), 25)) {
        absurd++;
        absurdSample ??= `round ${b.round}/${totalRounds} letter ${b.letter} bid ${bid}`;
      }
      if (!late && bid >= 10 && isAllIn(out, s.botId, b.round, bid)) allIn++;
    }
    reports.push({
      game,
      seatGame: matchId,
      seats: plan.seats.length,
      place,
      swissPoints: Math.max(size - (place - 1), 0),
      last: scores.every((x, j) => j === i || x > s.score),
      score: s.score,
      bestRival: Math.max(...scores.filter((_, j) => j !== i)),
      words: words.length,
      sevenPlus: words.filter((w) => [...w.word].length >= 7).length,
      tilesLeft: s.tilesLeft,
      coinsLeft: s.balance,
      bidRejections: s.bidRejections,
      wordRejections: s.wordRejections,
      agentErrors: s.agentErrors,
      firstError: s.firstError?.split("\n").slice(0, 3).join(" | "),
      maxBid,
      absurdBids: absurd,
      absurdSample,
      allIn,
      tilesWon: won,
      spent,
      times: times[i]!,
    });
  });
  return { out, reports };
}

// The engine keeps no per-round balances: rebuild the balance at round
// `round`'s bid (after that round's words) from the payments and rewards in
// the history (round r's words come before the r-th auction close).
function isAllIn(out: MatchOutcome, botId: number, round: number, bid: number): boolean {
  let bal = STARTING_BALANCE;
  let closes = 0;
  for (const e of out.engine.history) {
    if (e.kind === "auction") {
      closes++;
      if (closes >= round) break;
      if (e.winnerBotId === botId) bal -= e.paid;
    } else if (e.botId === botId) bal += e.reward;
  }
  return bid >= bal;
}

export interface TournamentRunResult {
  options: TournamentRunOptions;
  elapsedMs: number;
  reports: SeatReport[];
  series?: SeriesReport[];
  warnings: string[];
}

export async function runTournamentConfig(opts: TournamentRunOptions, onProgress?: (done: number, total: number) => void): Promise<TournamentRunResult> {
  const t0 = performance.now();
  const ctx = await setup(opts);
  const reports: SeatReport[] = [];
  const series: SeriesReport[] = [];
  const size = opts.matchSize ?? ctx.run.seatsPerGame;
  if (opts.series) {
    for (let deal = 0; deal < opts.games; deal++) {
      const totals = new Map<number, number>();
      const games: number[] = [];
      // The series is scored for the first rackforge seat (self-play: seat 1).
      const myId = ctx.run.base.find((b) => b.spec.kind === "rackforge")?.botId ?? -1;
      for (let g = 1; g <= FINAL_GAMES; g++) {
        const game = deal * FINAL_GAMES + (g - 1);
        const { out, reports: rs } = playOne(ctx, game, game + 1, (ids) => ({
          ...levelStandings(ids, "Final", 2, g),
          finalTotals: ids.map((botId) => ({ botId, total: totals.get(botId) ?? 0 })),
        }));
        reports.push(...rs);
        for (const s of out.seats) totals.set(s.botId, (totals.get(s.botId) ?? 0) + s.score);
        const me = out.seats.find((s) => s.botId === myId);
        const best = Math.max(...out.seats.filter((s) => s.botId !== myId).map((s) => s.score));
        if (me) games.push(me.score - best);
      }
      const mine = totals.get(myId) ?? 0;
      const opp = Math.max(...[...totals].filter(([id]) => id !== myId).map(([, x]) => x));
      series.push({ deal, myTotal: mine, oppTotal: opp, won: mine > opp, games });
      onProgress?.(deal + 1, opts.games);
    }
  } else {
    for (let game = 0; game < opts.games; game++) {
      const { reports: rs } = playOne(ctx, game, game + 1, opts.stage ? (ids) => levelStandings(ids, opts.stage!, size) : undefined);
      reports.push(...rs);
      onProgress?.(game + 1, opts.games);
    }
  }
  return {
    options: opts,
    elapsedMs: performance.now() - t0,
    reports,
    series: opts.series ? series : undefined,
    warnings: ctx.run.registry.warnings,
  };
}

// ---------- summary ----------

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: readonly number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const ci95 = (xs: readonly number[]) => 1.96 * sd(xs) / Math.sqrt(Math.max(1, xs.length));
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

export function summarize(r: TournamentRunResult): Record<string, unknown> {
  const rs = r.reports;
  const pick = (k: (s: SeatReport) => number) => rs.map(k);
  const out: Record<string, unknown> = {
    table: r.options.table,
    stage: r.options.stage ?? (r.options.series ? "Final" : "none"),
    auctionType: r.options.auctionType ?? "Vickrey",
    rack: r.options.startingRackSize ?? 5,
    live: r.options.live ?? false,
    n: rs.length,
    elapsedS: +(r.elapsedMs / 1000).toFixed(1),
    place: `${f(mean(pick((s) => s.place)), 2)} ±${f(ci95(pick((s) => s.place)), 2)}`,
    winPct: f(100 * mean(pick((s) => (s.place === 1 ? 1 : 0)))),
    lastPct: f(100 * mean(pick((s) => (s.last ? 1 : 0)))),
    swissPoints: f(mean(pick((s) => s.swissPoints)), 2),
    score: `${f(mean(pick((s) => s.score)))} ±${f(ci95(pick((s) => s.score)))}`,
    bestRival: f(mean(pick((s) => s.bestRival))),
    sevenPlusPerMatch: f(mean(pick((s) => s.sevenPlus)), 2),
    words: f(mean(pick((s) => s.words)), 1),
    tilesLeft: f(mean(pick((s) => s.tilesLeft)), 2),
    tilesLeftMax: Math.max(0, ...pick((s) => s.tilesLeft)),
    coinsLeft: f(mean(pick((s) => s.coinsLeft))),
    coinsLeftMax: Math.max(0, ...pick((s) => s.coinsLeft)),
    tilesWon: f(mean(pick((s) => s.tilesWon)), 1),
    spent: f(mean(pick((s) => s.spent))),
    maxBid: Math.max(0, ...pick((s) => s.maxBid)),
    absurdBids: pick((s) => s.absurdBids).reduce((a, b) => a + b, 0),
    absurdSample: rs.find((s) => s.absurdSample)?.absurdSample,
    allInEarly: pick((s) => s.allIn).reduce((a, b) => a + b, 0),
    bidRejections: pick((s) => s.bidRejections).reduce((a, b) => a + b, 0),
    wordRejections: pick((s) => s.wordRejections).reduce((a, b) => a + b, 0),
    agentErrors: pick((s) => s.agentErrors).reduce((a, b) => a + b, 0),
    firstError: rs.find((s) => s.firstError)?.firstError,
    quickMaxMs: f(Math.max(0, ...pick((s) => s.times.quickMax))),
    quickOver20: pick((s) => s.times.quickOver20).reduce((a, b) => a + b, 0),
    refineMaxMs: f(Math.max(0, ...pick((s) => s.times.refineMax))),
    refineOverBudget: pick((s) => s.times.refineOverBudget).reduce((a, b) => a + b, 0),
    wordsMaxMs: f(Math.max(0, ...pick((s) => s.times.wordsMax))),
  };
  if (r.series) {
    const diffs = r.series.map((s) => s.myTotal - s.oppTotal);
    out["series"] = {
      n: r.series.length,
      winPct: f(100 * mean(r.series.map((s) => (s.won ? 1 : 0)))),
      meanDiff: `${f(mean(diffs))} ±${f(ci95(diffs))}`,
      minDiff: Math.min(...diffs),
      myTotal: f(mean(r.series.map((s) => s.myTotal))),
      oppTotal: f(mean(r.series.map((s) => s.oppTotal))),
    };
  }
  if (r.warnings.length) out["warnings"] = r.warnings;
  return out;
}

// ---------- CLI ----------

function parseArgs(argv: string[]): { opts: TournamentRunOptions; out?: string } {
  const opts: TournamentRunOptions = { table: "rackforge,clone:59", games: 10, seed: 1 };
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--table": opts.table = value(); break;
      case "--games": opts.games = Number(value()); break;
      case "--seed": opts.seed = Number(value()); break;
      case "--stage": {
        const v = value();
        if (v !== "Swiss" && v !== "Bracket" && v !== "Final") throw new Error(`--stage needs Swiss|Bracket|Final, got '${v}'`);
        opts.stage = v;
        break;
      }
      case "--series": opts.series = true; break;
      case "--first-price": opts.auctionType = "FirstPrice"; break;
      case "--rack": opts.startingRackSize = Number(value()); break;
      case "--match-size": opts.matchSize = Number(value()); break;
      case "--live": opts.live = true; break;
      case "--budget": opts.budgetMs = Number(value()); break;
      case "--no-model": opts.model = false; break;
      case "--params": opts.params = JSON.parse(value()) as Record<string, unknown>; break;
      case "--out": out = value(); break;
      default: throw new Error(`unknown option '${a}'`);
    }
  }
  return { opts, out };
}

async function main() {
  const { opts, out } = parseArgs(process.argv.slice(2));
  const r = await runTournamentConfig(opts, (d, t) => process.stderr.write(`\r${d}/${t}`));
  process.stderr.write("\n");
  const s = summarize(r);
  if (out) fs.writeFileSync(out, JSON.stringify({ summary: s, reports: r.reports, series: r.series }, null, 1));
  console.log(JSON.stringify(s));
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && fs.existsSync(entry) && fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
}
