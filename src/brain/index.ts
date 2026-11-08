// RABBOT's strategy, loaded by name by the simulator and the live bot.
// 'rabbot' is the strategy's internal id. It
// remembers every opponent), hence RABBOTAgent, the 'rabbot' seat spec in the
// simulator, `--agent rabbot` and the RABBOT_* environment variables.
//
//   createAgent({ params?, mode?: 'live' | 'sim', seed?, model? }): Agent
//
// `model` is src/memory/model.ts's OpponentModel (anything with predictBid
// and strategyOf works); without one the brain bids against a generic
// market guess. Params: defaults < data/params.json < opts.params.

import type { Agent } from "../core/types.js";
import { getWordEngine } from "../core/words.js";
import { RABBOTAgent, type Mode, type RABBOTOptions } from "./agent.js";
import type { BidModel } from "./market.js";
import { resolveParams, type Params } from "./params.js";

export { RABBOTAgent, type BidTrace, type Mode } from "./agent.js";
export { DEFAULT_PARAMS, resolveParams, type Params } from "./params.js";
export type { BidModel } from "./market.js";

export interface CreateOptions {
  params?: Partial<Params> | Record<string, unknown>;
  mode?: Mode;
  seed?: number;
  model?: unknown;
}

function asModel(m: unknown): RABBOTOptions["model"] {
  if (!m || typeof m !== "object") return undefined;
  const o = m as Record<string, unknown>;
  if (typeof o.predictBid !== "function" || typeof o.strategyOf !== "function") return undefined;
  return m as BidModel;
}

export function createAgent(opts: CreateOptions = {}): Agent {
  return new RABBOTAgent({
    params: resolveParams(opts.params ?? {}),
    mode: opts.mode ?? "live",
    seed: opts.seed ?? 0x13,
    engine: getWordEngine(),
    model: asModel(opts.model),
  });
}
