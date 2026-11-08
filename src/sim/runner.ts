// Many matches, in-process or across worker threads. Every game is a pure
// function of (seed, game index, table, options): game g plays deal
// floor(g / k) in rotation g % k with --swap (k seats), deal g otherwise.
// So results don't depend on the worker count or on scheduling.

import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { LOBBY_MAX_SIZE } from "../core/rules.js";
import type { AuctionType, TournamentView } from "../core/types.js";
import { runMatch, type MatchSeat, type RngMode } from "./engine.js";
import {
  assignBotIds,
  availableSims,
  loadRegistry,
  padWithSims,
  parseTable,
  type AgentOptions,
  type Registry,
  type SeatPlan,
  type SeatSpec,
} from "./registry.js";
import { Rng, ServerRandom, deriveSeed, serverStartUs } from "./rng.js";
import { aggregate, placesAndWins, type GameRecord, type SpecStats } from "./stats.js";

export interface RunOptions extends AgentOptions {
  /** Seat specs, as a list or comma-separated. */
  table: string | readonly string[];
  /** Matches to play. With swap, rounded up to whole deals (a multiple of the seat count). */
  games: number;
  seed?: number;
  /** Worker threads; 1 or less runs in this thread. */
  workers?: number;
  /** Play each deal once per cyclic rotation of the seats (paired evaluation). */
  swap?: boolean;
  /** Fill the table up to 6 seats from the server's sim pool, as a lobby timeout does. */
  pad?: boolean;
  auctionType?: AuctionType;
  startingRackSize?: number;
  /** "server" (default): the live server's skewed ctx.random. "streams": fair streams, tighter --swap pairs. */
  rng?: RngMode;
  /** refineBid budget handed to agents. */
  budgetMs?: number;
  /** Rethrow agent exceptions instead of counting them. */
  strict?: boolean;
  /** Return every game's record (default false). */
  keepRecords?: boolean;
  /** Games per work unit sent to a worker. */
  chunkSize?: number;
  /** MatchView.tournament for every seat (tournament-stage play); absent = ladder. */
  tournament?: TournamentView;
  /** Main thread only; not sent to workers. */
  onProgress?: (done: number, total: number) => void;
}

export type WorkerOptions = Omit<RunOptions, "onProgress">;

export interface RunResult {
  table: string[];
  seed: number;
  games: number;
  deals: number;
  seatsPerGame: number;
  workers: number;
  swap: boolean;
  pad: boolean;
  elapsedMs: number;
  matchesPerSec: number;
  stats: SpecStats[];
  warnings: string[];
  records?: GameRecord[];
}

export interface RunContext {
  opts: WorkerOptions;
  seed: number;
  specs: SeatSpec[];
  base: SeatPlan[];
  seatsPerGame: number;
  registry: Registry;
}

export interface GamePlan {
  game: number;
  deal: number;
  rotation: number;
  dealSeed: number;
  /** In seat (deal) order. */
  seats: SeatPlan[];
  /** Sims the lobby timeout shuffled in the start transaction (0: no padding). */
  lobbyShuffle: number;
}

export function seatsPerGame(tableSize: number, pad: boolean): number {
  return pad ? Math.max(tableSize, LOBBY_MAX_SIZE) : tableSize;
}

export function totalGames(games: number, seats: number, swap: boolean): number {
  return swap ? Math.ceil(games / seats) * seats : games;
}

export async function prepare(opts: WorkerOptions): Promise<RunContext> {
  const specs = parseTable(opts.table);
  const registry = await loadRegistry(specs, opts);
  return {
    opts,
    seed: opts.seed ?? 1,
    specs,
    base: assignBotIds(specs),
    seatsPerGame: seatsPerGame(specs.length, opts.pad ?? false),
    registry,
  };
}

export function planGame(ctx: RunContext, game: number): GamePlan {
  const k = ctx.seatsPerGame;
  const swap = ctx.opts.swap ?? false;
  const deal = swap ? Math.floor(game / k) : game;
  const rotation = swap ? game % k : 0;
  const dealSeed = deriveSeed(ctx.seed, "deal", deal);
  // Only a lobby short of real bots times out and pads; a full one starts
  // at once, without the shuffle.
  const padded = (ctx.opts.pad ?? false) && ctx.base.length < LOBBY_MAX_SIZE;
  const server = (ctx.opts.rng ?? "server") === "server";
  // Server mode: the padding shuffle is the start transaction's first use of
  // ctx.random, so the engine replays it from the same timestamp.
  const lobbyShuffle = padded && server ? availableSims(ctx.base).length : 0;
  const shuffler = server ? new ServerRandom(serverStartUs(dealSeed)) : new Rng(dealSeed, "pad");
  const base = padded ? padWithSims(ctx.base, shuffler) : ctx.base;
  const seats = base.map((_, i) => base[(i + rotation) % k]!);
  return { game, deal, rotation, dealSeed, seats, lobbyShuffle };
}

export function playGame(ctx: RunContext, game: number): GameRecord {
  const plan = planGame(ctx, game);
  const seats: MatchSeat[] = plan.seats.map((s, i) => ({
    botId: s.botId,
    isSim: s.isSim,
    strategy: s.spec.strategy,
    agent: ctx.registry.create(s.spec, deriveSeed(plan.dealSeed, "agent", i)),
  }));
  const out = runMatch({
    seats,
    seed: plan.dealSeed,
    matchId: game + 1,
    auctionType: ctx.opts.auctionType,
    startingRackSize: ctx.opts.startingRackSize,
    rng: ctx.opts.rng,
    lobbyShuffle: plan.lobbyShuffle,
    budgetMs: ctx.opts.budgetMs,
    strict: ctx.opts.strict,
    tournament: ctx.opts.tournament,
  });
  const { place, winShare } = placesAndWins(out.seats.map((s) => s.score));
  return {
    game,
    deal: plan.deal,
    rotation: plan.rotation,
    matchId: out.matchId,
    rounds: out.rounds,
    seats: out.seats.map((s, i) => ({
      ...s,
      spec: plan.seats[i]!.spec.spec,
      place: place[i]!,
      winShare: winShare[i]!,
    })),
  };
}

export async function runMatches(opts: RunOptions): Promise<RunResult> {
  const { onProgress, ...wopts } = opts;
  const t0 = performance.now();
  const ctx = await prepare(wopts);
  const total = totalGames(Math.max(0, Math.floor(opts.games)), ctx.seatsPerGame, opts.swap ?? false);
  const workers = Math.max(1, Math.min(Math.floor(opts.workers ?? 1), total || 1));
  const records: GameRecord[] = [];
  const warnings = new Set(ctx.registry.warnings);

  if (workers <= 1) {
    for (let g = 0; g < total; g++) {
      records.push(playGame(ctx, g));
      onProgress?.(g + 1, total);
    }
  } else {
    const chunk = Math.max(1, opts.chunkSize ?? Math.min(16, Math.ceil(total / (workers * 4))));
    await runInWorkers(wopts, total, workers, chunk, (recs) => {
      records.push(...recs);
      onProgress?.(records.length, total);
    }, warnings);
  }

  records.sort((a, b) => a.game - b.game);
  const elapsedMs = performance.now() - t0;
  return {
    table: ctx.specs.map((s) => s.spec),
    seed: ctx.seed,
    games: total,
    deals: new Set(records.map((r) => r.deal)).size,
    seatsPerGame: ctx.seatsPerGame,
    workers,
    swap: opts.swap ?? false,
    pad: opts.pad ?? false,
    elapsedMs,
    matchesPerSec: total / (elapsedMs / 1000),
    stats: aggregate(records),
    warnings: [...warnings],
    records: opts.keepRecords ? records : undefined,
  };
}

// Workers run the .ts sources, so they need tsx's loader like the parent.
function workerExecArgv(): string[] {
  let loader = "tsx";
  try {
    loader = import.meta.resolve("tsx");
  } catch {
    // fall back to resolving from the working directory
  }
  return ["--import", loader];
}

type FromWorker =
  | { type: "ready"; warnings: string[] }
  | { type: "done"; records: GameRecord[] }
  | { type: "error"; message: string };

async function runInWorkers(
  opts: WorkerOptions,
  total: number,
  workers: number,
  chunk: number,
  onRecords: (records: GameRecord[]) => void,
  warnings: Set<string>,
): Promise<void> {
  const url = new URL("./worker.ts", import.meta.url);
  if (!fs.existsSync(url)) throw new Error(`worker entry missing: ${url.pathname}`);
  const pool: Worker[] = [];
  let next = 0;
  let failed = false;
  try {
    await Promise.all(
      Array.from(
        { length: workers },
        () =>
          new Promise<void>((resolve, reject) => {
            const w = new Worker(url, { execArgv: workerExecArgv(), workerData: opts });
            pool.push(w);
            const feed = () => {
              if (next >= total || failed) {
                w.postMessage({ type: "exit" });
                return;
              }
              const from = next;
              next = Math.min(total, next + chunk);
              w.postMessage({ type: "run", from, to: next });
            };
            w.on("message", (m: FromWorker) => {
              if (m.type === "ready") {
                for (const x of m.warnings) warnings.add(x);
                feed();
              } else if (m.type === "done") {
                onRecords(m.records);
                feed();
              } else {
                failed = true;
                reject(new Error(`sim worker failed: ${m.message}`));
              }
            });
            w.on("error", (e) => {
              failed = true;
              reject(e);
            });
            w.on("exit", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`sim worker exited with code ${code}`));
            });
          }),
      ),
    );
  } finally {
    if (failed) await Promise.all(pool.map((w) => w.terminate()));
  }
}

export type { GameRecord, SpecStats } from "./stats.js";
