// Clone-only matches for calibration and evaluation: per-seat statistics
// measured the same way calibrate-targets.ts measures real matches, and a
// persistent worker pool (each worker has its own WordEngine and model).

import * as os from "node:os";
import { Worker } from "node:worker_threads";
import { auctionsPerMatch, letterValue } from "../core/rules.js";
import type { Agent } from "../core/types.js";
import { runMatch, type MatchSeat, type SimStrategy } from "../sim/engine.js";
import { placesAndWins } from "../sim/stats.js";
import { createLegacyCloneAgent } from "./calibrate-legacy.js";
import { PARAM_KEYS, cloneModel, createCloneAgent, letterClass, type CloneParams } from "./clones.js";

/** Per seat-match statistics; real targets use the same keys. */
export const STAT_KEYS = [
  "score", "place", "win", "tiles", "paid", "coins", "words", "letters", "bingos",
  "phaseSum", "vowel", "high", "left", "l23", "l4", "l5", "l6",
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export const S = Object.fromEntries(STAT_KEYS.map((k, i) => [k, i])) as Record<StatKey, number>;

export type SeatJob =
  | { kind: "clone"; botId: number; params?: number[] }
  | { kind: "legacy"; botId: number }
  | { kind: "rackforge"; botId: number; params?: Record<string, unknown> }
  | { kind: "sim"; botId: number; strategy: SimStrategy };

export interface MatchJob {
  seats: SeatJob[];
  seed: number;
}

export const paramsFromVec = (v: readonly number[]): CloneParams =>
  Object.fromEntries(PARAM_KEYS.map((k, i) => [k, v[i]!])) as unknown as CloneParams;
export const paramsToVec = (p: CloneParams): number[] => PARAM_KEYS.map((k) => p[k]);

export interface Env {
  createRackForge?: (o: object) => Agent;
}

/** Plays one match; returns each seat's STAT_KEYS vector, in seat order. */
export function playJob(env: Env, job: MatchJob): number[][] {
  const model = cloneModel();
  const seats: MatchSeat[] = job.seats.map((s, i) => {
    const seed = (job.seed * 31 + i * 7919) >>> 0;
    switch (s.kind) {
      case "sim":
        return { botId: s.botId, isSim: true, strategy: s.strategy };
      case "legacy":
        return { botId: s.botId, isSim: false, agent: createLegacyCloneAgent(s.botId, { seed, model }) };
      case "rackforge":
        if (!env.createRackForge) throw new Error("rackforge seat needs src/brain/index.ts");
        return { botId: s.botId, isSim: false, agent: env.createRackForge({ params: s.params, mode: "sim", seed, model }) };
      case "clone":
        return {
          botId: s.botId,
          isSim: false,
          agent: createCloneAgent(s.botId, { seed, model, params: s.params ? paramsFromVec(s.params) : undefined }),
        };
    }
  });
  const out = runMatch({ seats, seed: job.seed, matchId: (job.seed % 1_000_000) + 1 });
  const n = auctionsPerMatch(seats.length);
  const { place, winShare } = placesAndWins(out.seats.map((s) => s.score));
  const pos = new Map(out.seats.map((s, i) => [s.botId, i]));
  const st = out.seats.map((s, i) => {
    const v = new Array<number>(STAT_KEYS.length).fill(0);
    v[S.score] = s.score;
    v[S.place] = place[i]!;
    v[S.win] = winShare[i]!;
    v[S.coins] = s.balance;
    v[S.left] = s.tilesLeft;
    return v;
  });
  let closed = 0;
  for (const e of out.engine.history) {
    if (e.kind === "auction") {
      closed++;
      if (e.winnerBotId === null) continue;
      const v = st[pos.get(e.winnerBotId)!]!;
      v[S.tiles]++;
      v[S.paid] += e.paid;
      const c = letterClass(e.letter);
      if (c === 0) v[S.vowel]++;
      else if (c === 3) v[S.high]++;
    } else {
      const v = st[pos.get(e.botId)!]!;
      const L = e.word.length;
      v[S.words]++;
      v[S.letters] += L;
      v[S.phaseSum] += Math.min(1, closed / n);
      v[L >= 7 ? S.bingos : L === 6 ? S.l6 : L === 5 ? S.l5 : L === 4 ? S.l4 : S.l23]++;
    }
  }
  return st;
}

// Kept for symmetry with targets: the class letters are scored by value.
export const isHighLetter = (l: string) => letterValue(l) >= 5;

// ---------- worker pool ----------

function workerExecArgv(): string[] {
  let loader = "tsx";
  try {
    loader = import.meta.resolve("tsx");
  } catch {
    // resolve from the working directory instead
  }
  return ["--import", loader];
}

type FromWorker = { type: "ready" } | { type: "done"; id: number; stats: number[][][] } | { type: "error"; message: string };

export class SimPool {
  private workers: Worker[] = [];
  private ready: Promise<void>;
  readonly size: number;

  constructor(size = Math.min(8, os.cpus().length)) {
    this.size = Math.max(1, size);
    const url = new URL("./calibrate-worker.ts", import.meta.url);
    const boot: Promise<void>[] = [];
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(url, { execArgv: workerExecArgv() });
      this.workers.push(w);
      boot.push(
        new Promise((resolve, reject) => {
          const onMsg = (m: FromWorker) => {
            if (m.type === "ready") {
              w.off("message", onMsg);
              resolve();
            } else if (m.type === "error") reject(new Error(m.message));
          };
          w.on("message", onMsg);
          w.once("error", reject);
        }),
      );
    }
    this.ready = Promise.all(boot).then(() => undefined);
  }

  /** Runs every job; results in job order. */
  async run(jobs: MatchJob[], chunk = 24, onProgress?: (done: number) => void): Promise<number[][][]> {
    await this.ready;
    const out: number[][][] = new Array(jobs.length);
    let next = 0;
    let done = 0;
    await Promise.all(
      this.workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const feed = () => {
              if (next >= jobs.length) {
                w.off("message", onMsg);
                resolve();
                return;
              }
              const from = next;
              next = Math.min(jobs.length, next + chunk);
              w.postMessage({ type: "run", id: from, jobs: jobs.slice(from, next) });
            };
            const onMsg = (m: FromWorker) => {
              if (m.type === "done") {
                for (let i = 0; i < m.stats.length; i++) out[m.id + i] = m.stats[i]!;
                done += m.stats.length;
                onProgress?.(done);
                feed();
              } else if (m.type === "error") {
                w.off("message", onMsg);
                reject(new Error(`calibration worker failed: ${m.message}`));
              }
            };
            w.on("message", onMsg);
            feed();
          }),
      ),
    );
    return out;
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
