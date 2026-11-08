// Loads an Agent by name without hard imports, so the bot runs (on the
// starter) even while src/brain or src/memory don't exist yet. The module
// paths are variables on purpose: TypeScript doesn't resolve them, and a
// missing module is a caught error, not a crash.

import { StarterAgent } from "../agents/starter.js";
import type { Agent, AuctionView, MatchView } from "../core/types.js";
import { errMsg } from "./log.js";

export interface LoadedAgent {
  agent: Agent;
  /** What was asked for and what we got, e.g. rabbot -> starter. */
  requested: string;
  fallback: boolean;
  notes: string[];
}

/**
 * Worst-case refiner for validating the deadline math: starter bids, and a
 * refineBid that spins for its entire budget and then changes the bid by
 * one, so every auction exercises a full-budget refine and a second send.
 */
export class TimingProbeAgent implements Agent {
  readonly name = "timing-probe";
  private readonly base = new StarterAgent();
  quickBid(view: MatchView, auction: AuctionView): number {
    return this.base.quickBid(view, auction);
  }
  refineBid(view: MatchView, auction: AuctionView, budgetMs: number): number | null {
    const end = performance.now() + budgetMs;
    while (performance.now() < end) {
      /* spin: simulate a search that uses all of its time */
    }
    return this.base.quickBid(view, auction) + 1;
  }
  chooseWords(view: MatchView): string[] {
    return this.base.chooseWords(view);
  }
}

async function tryImport(spec: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(spec)) as Record<string, unknown>;
  } catch (e) {
    const msg = errMsg(e);
    if (/Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load/i.test(msg)) return null;
    throw e;
  }
}

export async function loadAgent(name: string, mode: "live" | "sim" = "live", seed?: number): Promise<LoadedAgent> {
  const notes: string[] = [];
  const fallback = (why: string): LoadedAgent => {
    notes.push(why);
    return { agent: new StarterAgent(), requested: name, fallback: true, notes };
  };

  if (name === "starter") return { agent: new StarterAgent(), requested: name, fallback: false, notes };
  if (name === "timing-probe") return { agent: new TimingProbeAgent(), requested: name, fallback: false, notes };

  if (name.startsWith("clone:")) {
    const botId = Number(name.slice(6));
    const spec = "../memory/clones.js";
    try {
      const mod = await tryImport(spec);
      const make = mod?.createCloneAgent as ((id: number, o?: { seed?: number }) => Agent) | undefined;
      if (!make) return fallback("src/memory/clones.ts missing or has no createCloneAgent");
      return { agent: make(botId, { seed }), requested: name, fallback: false, notes };
    } catch (e) {
      return fallback(`clone agent failed to load: ${errMsg(e)}`);
    }
  }

  if (name !== "rabbot") return fallback(`unknown agent '${name}'`);

  let model: unknown;
  try {
    const mm = await tryImport("../memory/model.js");
    const load = mm?.loadOpponentModel as ((dbPath?: string) => unknown) | undefined;
    if (load) {
      model = load();
      notes.push("opponent model loaded");
    } else notes.push("no opponent model (src/memory/model.ts missing)");
  } catch (e) {
    notes.push(`opponent model failed to load: ${errMsg(e)}`);
  }

  try {
    const mod = await tryImport("../brain/index.js");
    const create = mod?.createAgent as ((o?: Record<string, unknown>) => Agent) | undefined;
    if (!create) return fallback("src/brain/index.ts missing or has no createAgent");
    const agent = create({ mode, seed, ...(model !== undefined ? { model } : {}) });
    return { agent, requested: name, fallback: false, notes };
  } catch (e) {
    return fallback(`rabbot agent failed to load: ${errMsg(e)}`);
  }
}
