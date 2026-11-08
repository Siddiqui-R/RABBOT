// One evaluation match: a table of seats, one of which is the agent under
// test. Shared by eval.ts (main thread) and evalworker.ts (worker threads),
// so a job's result is a pure function of the job, whatever the worker.

import type { Agent } from "../core/types.js";
import { StarterAgent } from "../agents/starter.js";
import { getWordEngine } from "../core/words.js";
import { runMatch, type MatchSeat, type SimStrategy } from "../sim/engine.js";
import { placesAndWins } from "../sim/stats.js";
import { createAgent } from "./index.js";

export type SeatDef =
  | { kind: "sim"; botId: number; strategy: SimStrategy }
  | { kind: "clone"; botId: number }
  | { kind: "starter"; botId: number }
  /** The 'rackforge' agent with the default parameters (defaults + data/params.json). */
  | { kind: "rackforge"; botId: number }
  | { kind: "test"; botId: number };

export interface Job {
  id: number;
  setting: string;
  deal: number;
  seed: number;
  seats: SeatDef[];
  /** Agent in the test seat: 'starter', or a rackforge variant name. */
  agent: string;
  /** 'rackforge' params for the test seat; overrides looking `agent` up in the variants. */
  params?: Record<string, unknown>;
  auctionType?: "Vickrey" | "FirstPrice";
}

export interface JobResult {
  id: number;
  setting: string;
  deal: number;
  agent: string;
  place: number;
  win: number;
  score: number;
  coins: number;
  tiles: number;
  /** Mean score of the other seats. */
  others: number;
  errors: number;
  firstError?: string;
  ms: number;
}

export interface Env {
  variants: Record<string, Record<string, unknown>>;
  model?: unknown;
  createClone?: (botId: number, o: { seed?: number; model?: unknown }) => Agent;
  budgetMs?: number;
}

/** Loads the opponent model and the clone factory, if present. */
export async function loadEnv(variants: Record<string, Record<string, unknown>>, withModel = true): Promise<Env> {
  const env: Env = { variants };
  getWordEngine();
  if (withModel) {
    try {
      const spec: string = "../memory/model.js";
      const m = (await import(spec)) as { loadOpponentModel?: () => unknown };
      env.model = m.loadOpponentModel?.();
    } catch {
      env.model = undefined;
    }
  }
  try {
    const spec: string = "../memory/clones.js";
    const c = (await import(spec)) as { createCloneAgent?: Env["createClone"] };
    env.createClone = c.createCloneAgent;
  } catch {
    env.createClone = undefined;
  }
  return env;
}

function makeAgent(env: Env, job: Job, seed: number): Agent {
  if (job.agent === "starter" && !job.params) return new StarterAgent();
  const params = job.params ?? env.variants[job.agent];
  if (!params) throw new Error(`unknown variant '${job.agent}'`);
  return createAgent({ params, mode: "sim", seed, model: env.model });
}

export function runJob(env: Env, job: Job): JobResult {
  const t0 = performance.now();
  const seats: MatchSeat[] = job.seats.map((s, i) => {
    const seed = (job.seed * 31 + i * 7919) >>> 0;
    switch (s.kind) {
      case "sim":
        return { botId: s.botId, isSim: true, strategy: s.strategy };
      case "starter":
        return { botId: s.botId, isSim: false, agent: new StarterAgent() };
      case "rackforge":
        return { botId: s.botId, isSim: false, agent: createAgent({ mode: "sim", seed, model: env.model }) };
      case "clone": {
        if (!env.createClone) throw new Error("clone seats need src/memory/clones.ts");
        return { botId: s.botId, isSim: false, agent: env.createClone(s.botId, { seed, model: env.model }) };
      }
      case "test":
        return { botId: s.botId, isSim: false, agent: makeAgent(env, job, seed) };
    }
  });
  const testIdx = job.seats.findIndex((s) => s.kind === "test");
  const out = runMatch({
    seats,
    seed: job.seed,
    matchId: job.deal + 1,
    auctionType: job.auctionType,
    budgetMs: env.budgetMs ?? 700,
  });
  const scores = out.seats.map((s) => s.score);
  const { place, winShare } = placesAndWins(scores);
  const me = out.seats[testIdx]!;
  const others = scores.filter((_, i) => i !== testIdx);
  return {
    id: job.id,
    setting: job.setting,
    deal: job.deal,
    agent: job.agent,
    place: place[testIdx]!,
    win: winShare[testIdx]!,
    score: me.score,
    coins: me.balance,
    tiles: me.tilesLeft,
    others: others.reduce((a, b) => a + b, 0) / Math.max(1, others.length),
    errors: me.agentErrors,
    firstError: me.firstError,
    ms: performance.now() - t0,
  };
}
