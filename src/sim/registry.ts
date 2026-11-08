// Seat specs -> seated bots. Agents other than the starter are loaded by
// name through the shared factory conventions (dynamic import), so the
// simulator runs before the brain or the clones exist, and fails with a
// clear message only when a table actually asks for one.
//
//   rabbot            src/brain/index.ts      createAgent({ params, mode: 'sim', seed, model })
//   rabbot#<variant>  same, params from opts.variants[<variant>] (A/B tables for the tuner)
//   starter           src/agents/starter.ts   StarterAgent (word search via the index, see fast-starter.ts)
//   sim:<Strategy>    engine-driven server sim: Cheapskate | ValueBidder | Aggressive
//   clone:<botId>     src/memory/clones.ts    createCloneAgent(botId, { seed })
//   idle              a connected bot that never bids or plays

import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOBBY_MAX_SIZE } from "../core/rules.js";
import type { Agent } from "../core/types.js";
import { SIM_STRATEGIES, type SimStrategy } from "./engine.js";
import { FastStarterAgent } from "./fast-starter.js";
import type { Shuffler } from "./rng.js";

export type SeatKind = "rabbot" | "starter" | "sim" | "clone" | "idle";

export interface SeatSpec {
  /** Canonical spec string; stats are keyed by it. */
  spec: string;
  kind: SeatKind;
  strategy?: SimStrategy;
  cloneBotId?: number;
  variant?: string;
}

/**
 * The live server's sim pool (public `bot` table, is_simulated = true,
 * read 2026-10-24). Lobby timeouts pad empty seats from it.
 */
export const SIM_POOL: readonly { botId: number; name: string; strategy: SimStrategy }[] = [
  { botId: 1, name: "Cheapo-sim", strategy: "Cheapskate" },
  { botId: 2, name: "Valor-sim", strategy: "ValueBidder" },
  { botId: 3, name: "Brutus-sim", strategy: "Aggressive" },
  { botId: 4, name: "Hagrid-sim", strategy: "ValueBidder" },
  { botId: 5, name: "Maverick-sim", strategy: "Aggressive" },
  { botId: 6, name: "Snippet-sim", strategy: "Cheapskate" },
];

/** Ids for seats with no real counterpart; far from live ids. */
export const SYNTHETIC_ID_BASE = 1_000_000;

const SPEC_HELP =
  "use rabbot, rabbot#<variant>, starter, sim:Cheapskate|ValueBidder|Aggressive, clone:<botId> or idle";

export function parseSeatSpec(raw: string): SeatSpec {
  const s = raw.trim();
  if (s === "rabbot") return { spec: s, kind: "rabbot" };
  const variant = /^rabbot#([\w.-]+)$/.exec(s);
  if (variant) return { spec: s, kind: "rabbot", variant: variant[1] };
  if (s === "starter") return { spec: s, kind: "starter" };
  if (s === "idle") return { spec: s, kind: "idle" };
  const sim = /^sim:(\w+)$/i.exec(s);
  if (sim) {
    const strategy = SIM_STRATEGIES.find((x) => x.toLowerCase() === sim[1]!.toLowerCase());
    if (!strategy) throw new Error(`unknown sim strategy in '${raw}': ${SPEC_HELP}`);
    return { spec: `sim:${strategy}`, kind: "sim", strategy };
  }
  const clone = /^clone:(\d+)$/.exec(s);
  if (clone) return { spec: s, kind: "clone", cloneBotId: Number(clone[1]) };
  throw new Error(`unknown seat spec '${raw}': ${SPEC_HELP}`);
}

export function parseTable(table: string | readonly string[]): SeatSpec[] {
  const parts = typeof table === "string" ? table.split(",") : [...table];
  const specs = parts.filter((p) => p.trim() !== "").map(parseSeatSpec);
  if (specs.length < 1) throw new Error("empty table");
  return specs;
}

export interface SeatPlan {
  spec: SeatSpec;
  botId: number;
  isSim: boolean;
}

/**
 * Bot ids as the live server would show them: sims take the real pool ids
 * of their strategy, clones their real bot id (so a model keyed by bot id
 * recognises them), everyone else a synthetic id. Duplicates fall back to
 * synthetic ids.
 */
export function assignBotIds(specs: readonly SeatSpec[]): SeatPlan[] {
  const used = new Set<number>();
  const plans = specs.map((spec): SeatPlan => {
    let botId: number | undefined;
    if (spec.kind === "sim") {
      botId = SIM_POOL.find((s) => s.strategy === spec.strategy && !used.has(s.botId))?.botId;
    } else if (spec.kind === "clone" && !used.has(spec.cloneBotId!)) {
      botId = spec.cloneBotId!;
    }
    if (botId !== undefined) used.add(botId);
    return { spec, botId: botId ?? -1, isSim: spec.kind === "sim" };
  });
  let next = SYNTHETIC_ID_BASE;
  for (const p of plans) {
    if (p.botId !== -1) continue;
    while (used.has(next)) next++;
    p.botId = next;
    used.add(next);
  }
  return plans;
}

/** Sims resolveLobby would shuffle: the pool (bot table order) minus those seated. */
export function availableSims(plans: readonly SeatPlan[]): (typeof SIM_POOL)[number][] {
  const seated = new Set(plans.map((p) => p.botId));
  return SIM_POOL.filter((s) => !seated.has(s.botId));
}

/**
 * resolveLobby's timeout padding: shuffle the sims not already seated and
 * take as many as the table is short of `maxSize`.
 */
export function padWithSims(plans: SeatPlan[], rng: Shuffler, maxSize = LOBBY_MAX_SIZE): SeatPlan[] {
  const available = availableSims(plans);
  rng.shuffle(available);
  const need = Math.max(maxSize - plans.length, 0);
  return [
    ...plans,
    ...available.slice(0, need).map(
      (s): SeatPlan => ({
        spec: { spec: `sim:${s.strategy}`, kind: "sim", strategy: s.strategy },
        botId: s.botId,
        isSim: true,
      }),
    ),
  ];
}

// ---------- agent factories ----------

export type Params = Record<string, unknown>;

export interface AgentOptions {
  /** Params for plain 'rabbot' seats. */
  params?: Params;
  /** Params for 'rabbot#<name>' seats. */
  variants?: Record<string, Params>;
  /** Load the opponent model for rabbot seats: true (default path), a db path, or false. */
  model?: boolean | string;
}

export interface Registry {
  /** A fresh agent for one match, or undefined for engine-driven and idle seats. */
  create(spec: SeatSpec, seed: number): Agent | undefined;
  warnings: string[];
}

type Module = Record<string, unknown>;

// Resolves a module relative to src/sim by its .ts source, so a missing
// file (undefined) is told apart from one that fails to load (throws).
export async function importIfPresent(rel: string): Promise<Module | undefined> {
  const url = new URL(rel, import.meta.url);
  const ts = fileURLToPath(url).replace(/\.js$/, ".ts");
  const js = fileURLToPath(url);
  const file = fs.existsSync(ts) ? ts : fs.existsSync(js) ? js : undefined;
  if (!file) return undefined;
  // A non-literal specifier keeps tsc from requiring the module to exist.
  const specifier: string = pathToFileURL(file).href;
  return (await import(specifier)) as Module;
}

function need(mod: Module | undefined, file: string, fn: string, why: string): (...a: never[]) => unknown {
  if (!mod) throw new Error(`${why} needs ${file}, which doesn't exist yet`);
  const f = mod[fn];
  if (typeof f !== "function") throw new Error(`${why} needs ${file} to export ${fn}()`);
  return f as (...a: never[]) => unknown;
}

export async function loadRegistry(specs: readonly SeatSpec[], opts: AgentOptions = {}): Promise<Registry> {
  const warnings: string[] = [];
  const kinds = new Set(specs.map((s) => s.kind));

  let createRABBOT: ((o: object) => Agent) | undefined;
  let model: unknown;
  if (kinds.has("rabbot")) {
    const brain = await importIfPresent("../brain/index.js");
    createRABBOT = need(brain, "src/brain/index.ts", "createAgent", "seat 'rabbot'") as (o: object) => Agent;
    if (opts.model !== false) {
      try {
        const mod = await importIfPresent("../memory/model.js");
        if (!mod || typeof mod["loadOpponentModel"] !== "function") {
          warnings.push("no opponent model: src/memory/model.ts (loadOpponentModel) not available");
        } else {
          const load = mod["loadOpponentModel"] as (p?: string) => unknown;
          model = load(typeof opts.model === "string" ? opts.model : undefined);
        }
      } catch (e) {
        warnings.push(`no opponent model: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const s of specs) {
      if (s.variant !== undefined && !opts.variants?.[s.variant]) {
        throw new Error(`seat '${s.spec}' has no params: pass variants['${s.variant}']`);
      }
    }
  }

  let createClone: ((botId: number, o: object) => Agent) | undefined;
  if (kinds.has("clone")) {
    const clones = await importIfPresent("../memory/clones.js");
    createClone = need(clones, "src/memory/clones.ts", "createCloneAgent", "seat 'clone:<botId>'") as (
      botId: number,
      o: object,
    ) => Agent;
  }

  return {
    warnings,
    create(spec, seed) {
      switch (spec.kind) {
        case "sim":
        case "idle":
          return undefined;
        case "starter":
          return new FastStarterAgent();
        case "rabbot": {
          const params = spec.variant !== undefined ? opts.variants![spec.variant] : opts.params;
          return createRABBOT!({ params, mode: "sim", seed, model });
        }
        case "clone":
          return createClone!(spec.cloneBotId!, { seed });
      }
    },
  };
}
