// Clones: stand-ins for real opponents in the simulator.
//
//   createCloneAgent(67)  ->  Agent named "clone:67"
//
// A clone bids by sampling the opponent model's fitted bid distribution for
// its bot (letter, phase, balance, rack size), then bends it with a few
// explicit behaviour params, and plays words by a hold-for-length rule. The
// params are fitted per bot by calibrate.ts so that clone-only replays of
// real tables reproduce each real bot's measured numbers (score, tiles,
// price, word lengths, 7+ words, place); they live in data/clones.json.
// Unknown bots get the generic params fitted to the pooled small bots.
//
// The bid model alone is not enough: it is fitted to censored bids, so its
// lower tail and its mapping to *which* letters a bot wins are guesses, and
// it says nothing about when a bot cashes words in. The params absorb that.

import * as fs from "node:fs";
import * as path from "node:path";
import { auctionsPerMatch, letterValue, totalTiles, type Counts } from "../core/rules.js";
import type { Agent, AuctionView, MatchView } from "../core/types.js";
import { getWordEngine, type WordEngine } from "../core/words.js";
import { HISTORY_DB, RankAllocator } from "./calibrate-legacy.js";
import { xBalance } from "./fit.js";
import { loadOpponentModel, phaseOf, type OpponentModel } from "./model.js";
import { rng32 } from "./util.js";

// The legacy helpers stay importable from here (clonecheck, tests).
export { RankAllocator, bestWord, choosePlays, policyFromHabits, wordIndex, type PlayPolicy } from "./calibrate-legacy.js";
export { HISTORY_DB };

export const CLONES_PATH = path.join(import.meta.dirname, "..", "..", "data", "clones.json");

// ---------- behaviour params ----------

export interface CloneParams {
  /** Log multiplier on every bid. */
  bidLog: number;
  /** Extra log multipliers per letter class (1-point consonants are the reference). */
  vowelLog: number;
  midLog: number;
  highLog: number;
  /** Extra log multiplier per unit of phase, centred mid-match (+: spends late). */
  phaseLog: number;
  /** Exponent on balance/100: budget pacing beyond what the bid model has. */
  pace: number;
  /** Last auctions: bid at least endSpend * balance / auctions left on useful letters. */
  endSpend: number;
  /** 0..1: how strongly letters that improve the rack get the high bids. */
  rankAware: number;
  /** Never cash in a word shorter than this (fractional: per-match random rounding). */
  minLen: number;
  /** Length to hold out for with a 7-tile rack at the start... */
  holdLen: number;
  /** ...lowered by this per tile beyond 7... */
  holdRack: number;
  /** ...and by this times the phase. */
  holdLate: number;
  /** Dump the best partition while fewer than this many tiles are left in the bag. */
  dumpAt: number;
}

export type ParamKey = keyof CloneParams;

export const PARAM_KEYS: readonly ParamKey[] = [
  "bidLog", "vowelLog", "midLog", "highLog", "phaseLog", "pace", "endSpend", "rankAware",
  "minLen", "holdLen", "holdRack", "holdLate", "dumpAt",
];

export const PARAM_BOUNDS: Record<ParamKey, readonly [number, number]> = {
  bidLog: [-1.2, 1.2],
  vowelLog: [-0.8, 0.8],
  midLog: [-0.8, 0.8],
  highLog: [-0.8, 0.8],
  phaseLog: [-1.5, 1.5],
  pace: [-1, 1],
  endSpend: [0, 3],
  rankAware: [0, 1],
  minLen: [2, 7],
  holdLen: [2, 11],
  holdRack: [0, 2],
  holdLate: [0, 9],
  dumpAt: [0, 10],
};

/** Before any fit: the bid model as is, hold for ~6 letters, dump in the last auctions. */
export const DEFAULT_PARAMS: CloneParams = {
  bidLog: 0,
  vowelLog: 0,
  midLog: 0,
  highLog: 0,
  phaseLog: 0,
  pace: 0,
  endSpend: 0.5,
  rankAware: 1,
  minLen: 3,
  holdLen: 6.5,
  holdRack: 0.5,
  holdLate: 2,
  dumpAt: 2,
};

export function clampParams(p: CloneParams): CloneParams {
  const out = { ...p };
  for (const k of PARAM_KEYS) {
    const [lo, hi] = PARAM_BOUNDS[k];
    const v = Number.isFinite(out[k]) ? out[k] : DEFAULT_PARAMS[k];
    out[k] = Math.max(lo, Math.min(hi, v));
  }
  return out;
}

/** 0 vowel, 1 one-point consonant, 2 two-to-four points, 3 five or more. */
export function letterClass(letter: string): number {
  if ("AEIOU".includes(letter)) return 0;
  const v = letterValue(letter);
  return v <= 1 ? 1 : v <= 4 ? 2 : 3;
}

// ---------- data/clones.json ----------

export interface CloneFit {
  /** Fit-set and held-out seat-matches behind the targets. */
  nFit: number;
  nHoldout: number;
  /** Weighted RMS error over the fitted stats, in target scale units. */
  errFit: number;
  errHoldout: number;
  real: Record<string, number>;
  sim: Record<string, number>;
}

export interface CloneEntry {
  name: string;
  params: CloneParams;
  fit?: CloneFit;
  /** Too few fit seats: params copied from this fitted bot (nearest real score). */
  borrowedFrom?: number;
}

export interface ClonesFile {
  note?: string;
  fittedAt?: string;
  /**
   * Bid-quantile floor for every clone: quantile q becomes floorQ + (1 - floorQ) * q.
   * The fitted params come from clone-only replays, where nobody punishes
   * low bids on unwanted letters; a strong agent then buys those tiles far
   * below the real market. Measured: raising it makes v2's edge larger, not
   * smaller (clones go broke sooner), so it stays 0. 0 or absent: no floor.
   */
  floorQ?: number;
  /**
   * Added to every clone's phaseLog (+: spends later). Clone-only fits have no
   * per-phase spend target, so clones front-load spending and go broke late;
   * a coin-hoarding agent then buys the last quarter for almost nothing.
   * Set by scanning v2 against its real numbers. 0 or absent: none.
   */
  phaseTilt?: number;
  /** Added to every clone's bidLog (log bid multiplier), with phaseTilt. 0 or absent: none. */
  bidShift?: number;
  generic: CloneParams;
  bots: Record<string, CloneEntry>;
}

let file: ClonesFile | null | undefined;

export function loadClonesFile(p: string = CLONES_PATH): ClonesFile | null {
  if (p === CLONES_PATH && file !== undefined) return file;
  let out: ClonesFile | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as ClonesFile;
    if (raw && typeof raw === "object" && raw.bots) out = raw;
  } catch {
    out = null;
  }
  if (p === CLONES_PATH) file = out;
  return out;
}

/** Fitted params for a bot, else the generic fit, else the defaults. */
export function cloneParamsFor(botId: number, f: ClonesFile | null = loadClonesFile()): CloneParams {
  const p = f?.bots[String(botId)]?.params ?? f?.generic ?? DEFAULT_PARAMS;
  return clampParams({ ...DEFAULT_PARAMS, ...p });
}

// ---------- the agent ----------

let sharedModel: OpponentModel | undefined;

export function cloneModel(): OpponentModel {
  sharedModel ??= loadOpponentModel(HISTORY_DB);
  return sharedModel;
}

/** Bids are sealed and over in a second: the last few auctions get the end-game rule. */
const END_WINDOW = 10;
/** bestPartition cap for the final dump; end racks are small, so it nearly always finishes. */
const DUMP_BUDGET_MS = 30;

export interface CloneOptions {
  seed?: number;
  model?: OpponentModel;
  /** Overrides data/clones.json (calibration passes candidate params here). */
  params?: Partial<CloneParams>;
  /** Override data/clones.json floorQ / phaseTilt / bidShift (else env RABBOT_CLONE_FLOORQ / _TILT / _SHIFT, for scans). */
  floorQ?: number;
  phaseTilt?: number;
  bidShift?: number;
  words?: WordEngine;
}

export function createCloneAgent(botId: number, opts: CloneOptions = {}): Agent {
  const m = opts.model ?? cloneModel();
  const words = opts.words ?? getWordEngine();
  const p = clampParams({ ...cloneParamsFor(botId), ...opts.params });
  const rng = rng32(opts.seed ?? botId * 7919 + 17);
  const ranks = new RankAllocator(p.rankAware);
  // Fractional thresholds round up or down once per match, so a clone's
  // average behaviour moves smoothly with its params (which the fit needs).
  const uLen = rng();
  const minLen = Math.max(2, Math.floor(p.minLen + uLen));
  const uHold = rng();
  const dumpN = Math.floor(p.dumpAt + rng());
  const classMul = [p.vowelLog, 0, p.midLog, p.highLog];
  const envFloor = Number(process.env.RABBOT_CLONE_FLOORQ);
  const floorQ = Math.max(0, Math.min(0.95, opts.floorQ ?? (Number.isFinite(envFloor) && process.env.RABBOT_CLONE_FLOORQ ? envFloor : (loadClonesFile()?.floorQ ?? 0))));
  const envTilt = Number(process.env.RABBOT_CLONE_TILT);
  const tilt = opts.phaseTilt ?? (Number.isFinite(envTilt) && process.env.RABBOT_CLONE_TILT ? envTilt : (loadClonesFile()?.phaseTilt ?? 0));
  const envShift = Number(process.env.RABBOT_CLONE_SHIFT);
  const shift = opts.bidShift ?? (Number.isFinite(envShift) && process.env.RABBOT_CLONE_SHIFT ? envShift : (loadClonesFile()?.bidShift ?? 0));
  let rackKey = "";
  let rackReward = 0;

  const phaseNow = (view: MatchView) =>
    phaseOf(view.round, auctionsPerMatch(view.participants.length, view.startingRackSize));

  return {
    name: `clone:${botId}`,
    quickBid(view: MatchView, auction: AuctionView): number {
      const me = view.participants.find((x) => x.botId === view.myBotId);
      const balance = Math.max(0, Math.floor(me?.balance ?? 0));
      if (balance === 0) return 0;
      const L = auction.letter;
      const phase = phaseNow(view);
      const rack = view.myRack;
      const d = m.predictBid(botId, L, { phase, balance, rackSize: totalTiles(rack) });
      const key = rack.join(",");
      if (key !== rackKey) {
        rackKey = key;
        rackReward = words.bestReward(rack);
      }
      const r = [...rack];
      r[L.charCodeAt(0) - 65]!++;
      const useful = words.bestReward(r) > rackReward;
      const q = ranks.quantile(rng(), useful);
      const base = d.quantile(floorQ + (1 - floorQ) * q);
      let bid = 0;
      if (base > 0) {
        const logMul = p.bidLog + shift + classMul[letterClass(L)]! + (p.phaseLog + tilt) * (phase - 0.5) + p.pace * xBalance(balance);
        bid = Math.max(1, Math.round(base * Math.exp(logMul)));
      }
      const left = view.bagTotal + 1;
      if (useful && left <= END_WINDOW && p.endSpend > 0) bid = Math.max(bid, Math.floor((p.endSpend * balance) / left));
      return Math.min(balance, bid);
    },
    chooseWords(view: MatchView): string[] {
      return choosePlaysParam(words, view.myRack, p, minLen, dumpN, view.bagTotal, phaseNow(view), uHold);
    },
  };
}

/** The clone's play rule: dump at the end, else cash in words at least as long as the hold target. */
export function choosePlaysParam(
  words: WordEngine,
  rack: Counts,
  p: CloneParams,
  minLen: number,
  dumpN: number,
  bagTotal: number,
  phase: number,
  /** Per-match rounding offset in [0, 1): floor(target + u) averages to the target. */
  u = 0.5,
): string[] {
  const tiles = totalTiles(rack);
  if (tiles < 2) return [];
  if (bagTotal < dumpN) return words.bestPartition(rack, { timeBudgetMs: DUMP_BUDGET_MS }).words;
  const target = p.holdLen - p.holdRack * Math.max(0, tiles - 7) - p.holdLate * phase;
  const need = Math.max(minLen, Math.floor(target + u));
  const r = [...rack];
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const hit = words.best(r, { minLen: need });
    if (!hit) break;
    out.push(hit.word);
    for (let i = 0; i < hit.word.length; i++) r[hit.word.charCodeAt(i) - 65]!--;
  }
  return out;
}
