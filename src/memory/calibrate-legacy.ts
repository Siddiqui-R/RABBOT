// Legacy clones: the uncalibrated stand-ins used before calibrate.ts, kept
// verbatim (bar the explicit model path) so the old and the calibrated field
// can be compared on the same tables. New code uses clones.ts.
//
//   createLegacyCloneAgent(67)  ->  Agent named "clone:67"
//
// A clone bids by sampling the opponent model's bid distribution for that
// bot (letter, phase, its balance and rack size), and plays words the way
// the bot was seen to: its typical word lengths, how full its rack gets
// before it plays, and whether it empties its rack before the end. It can't
// see the real bot's private reasons (which tiles it held), so it imitates
// behaviour on average, not move by move.
//
// Self-contained on purpose: it reads data/wordlist.txt itself rather than
// depending on the shared word engine.

import * as fs from "node:fs";
import * as path from "node:path";
import { auctionsPerMatch, totalTiles, wordReward, type Counts } from "../core/rules.js";
import type { Agent, AuctionView, MatchView } from "../core/types.js";
import { loadOpponentModel, phaseOf, type OpponentModel, type PlayHabits } from "./model.js";
import { rng32 } from "./util.js";

// ---------- a small, fast word finder ----------

interface WordIndex {
  words: string[];
  len: Uint8Array;
  mask: Int32Array;
  counts: Uint8Array; // 26 per word
}

let index: WordIndex | undefined;

/** Dictionary sorted longest first, then by reward, with letter-set masks. */
export function wordIndex(): WordIndex {
  if (index) return index;
  const file = path.join(import.meta.dirname, "..", "..", "data", "wordlist.txt");
  const words = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((w) => w.trim().toUpperCase())
    .filter((w) => w.length >= 2 && /^[A-Z]+$/.test(w));
  const reward = new Map(words.map((w) => [w, wordReward(w)]));
  words.sort((a, b) => b.length - a.length || reward.get(b)! - reward.get(a)! || (a < b ? -1 : 1));
  const n = words.length;
  const len = new Uint8Array(n);
  const mask = new Int32Array(n);
  const counts = new Uint8Array(n * 26);
  words.forEach((w, i) => {
    len[i] = Math.min(255, w.length);
    let m = 0;
    for (let j = 0; j < w.length; j++) {
      const c = w.charCodeAt(j) - 65;
      m |= 1 << c;
      counts[i * 26 + c]!++;
    }
    mask[i] = m;
  });
  index = { words, len, mask, counts };
  return index;
}

/** Longest playable word (then highest reward) of at least minLen, or undefined. */
export function bestWord(rack: Counts, minLen = 2): string | undefined {
  const ix = wordIndex();
  const tiles = totalTiles(rack);
  if (tiles < minLen) return undefined;
  let rackMask = 0;
  for (let c = 0; c < 26; c++) if (rack[c]! > 0) rackMask |= 1 << c;
  for (let i = 0; i < ix.words.length; i++) {
    const L = ix.len[i]!;
    if (L > tiles) continue;
    if (L < minLen) break;
    if ((ix.mask[i]! & ~rackMask) !== 0) continue;
    let ok = true;
    const base = i * 26;
    for (let c = 0; c < 26; c++) {
      if (ix.counts[base + c]! > rack[c]!) {
        ok = false;
        break;
      }
    }
    if (ok) return ix.words[i];
  }
  return undefined;
}

// ---------- play policy ----------

// Real bots mostly hold tiles until they can play a long word (7+ letters
// pay 3x), play a word that clears most of a small rack, and empty the rack
// in the last auctions. The rule below has one knob for each, read from the
// bot's own plays (length, rack size just before, phase).

export interface PlayPolicy {
  /** Play any word at least this long. */
  target: number;
  /** Or one of at least midLen letters that leaves at most `slack` tiles (-1: never). */
  slack: number;
  midLen: number;
  /** Or anything at all once the rack holds this many tiles. */
  rackCap: number;
  /** In the last N auctions, play anything (0: never). */
  flushAuctions: number;
  /** The bot was never seen to play. */
  silent: boolean;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)]!;
}

function quantileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))]!;
}

/** Turns observed habits into the clone's play rule. */
export function policyFromHabits(h: PlayHabits): PlayPolicy {
  if (h.matches > 0 && h.wordsPerMatch < 0.05) {
    return { target: 99, slack: -1, midLen: 99, rackCap: 99, flushAuctions: 0, silent: true };
  }
  if (h.plays.length < 5) {
    // Nothing seen: behave like the starter bot (longest word, right away).
    return { target: 2, slack: -1, midLen: 99, rackCap: 99, flushAuctions: 0, silent: false };
  }
  const matches = Math.max(1, h.matches);
  const big = h.plays.filter((p) => p.rack >= 8).map((p) => p.len);
  const target =
    big.length >= 10
      ? Math.max(4, Math.min(8, Math.round(median(big))))
      : Math.max(3, quantileOf([...h.plays.map((p) => p.len)].sort((a, b) => a - b), 0.75));
  // Before the endgame, with a small rack: how much of it does it clear,
  // and how short a word will it settle for?
  const mid = h.plays.filter((p) => p.rack <= 7 && p.len < target && p.phase < 0.85);
  const useMid = mid.length / matches >= 0.4;
  const slack = useMid ? Math.max(0, Math.min(3, Math.round(median(mid.map((p) => p.rack - p.len))))) : -1;
  const midLen = useMid ? Math.max(2, quantileOf(mid.map((p) => p.len).sort((a, b) => a - b), 0.5)) : 99;
  const late = h.plays.filter((p) => p.phase >= 0.9).length;
  return {
    target,
    slack,
    midLen,
    rackCap: quantileOf(h.rackBeforePlay, 0.95) + 1,
    flushAuctions: late / matches >= 0.5 ? 4 : 0,
    silent: false,
  };
}

/** Words to play now under `policy`, applied one after another. */
export function choosePlays(rack: Counts, policy: PlayPolicy, bagTotal: number): string[] {
  if (policy.silent) return [];
  const r = [...rack];
  const out: string[] = [];
  const flushing = policy.flushAuctions > 0 && bagTotal < policy.flushAuctions;
  for (let k = 0; k < 4; k++) {
    const tiles = totalTiles(r);
    const w = bestWord(r, 2);
    if (!w) break;
    const L = w.length;
    const ok =
      L >= policy.target ||
      (policy.slack >= 0 && L >= policy.midLen && tiles - L <= policy.slack) ||
      tiles >= policy.rackCap ||
      flushing;
    if (!ok) break;
    out.push(w);
    for (let i = 0; i < L; i++) r[w.charCodeAt(i) - 65]!--;
  }
  return out;
}

// ---------- the agent ----------

let sharedModel: OpponentModel | undefined;

// The default model source is moving to SpacetimeDB; clones stay on the
// mined SQLite history they were calibrated against.
export const HISTORY_DB = path.join(import.meta.dirname, "..", "..", "data", "history.sqlite");

function model(): OpponentModel {
  sharedModel ??= loadOpponentModel(HISTORY_DB);
  return sharedModel;
}

/**
 * Where in its bid distribution the clone bids: a uniform draw, but
 * letters that lengthen its best word get the top share and the rest the
 * bottom share, sized by how often letters have been useful. The marginal
 * bid distribution stays exactly the model's; only which letters get the
 * high bids changes, as a real bot's rack would make it.
 */
export class RankAllocator {
  private seen = 0;
  private useful = 0;
  constructor(private strength = 1) {}

  quantile(u: number, isUseful: boolean): number {
    const pu = (this.useful + 1) / (this.seen + 2);
    this.seen++;
    if (isUseful) this.useful++;
    const ranked = isUseful ? 1 - pu + pu * u : (1 - pu) * u;
    return this.strength * ranked + (1 - this.strength) * u;
  }
}

export function createLegacyCloneAgent(botId: number, opts: { seed?: number; model?: OpponentModel; rackAware?: number } = {}): Agent {
  const m = opts.model ?? model();
  const rng = rng32(opts.seed ?? botId * 7919 + 17);
  const ranks = new RankAllocator(opts.rackAware ?? 1);
  let policy: PlayPolicy | undefined;
  const policyNow = () => (policy ??= policyFromHabits(m.playHabits(botId)));
  const phaseNow = (view: MatchView) =>
    phaseOf(view.round, auctionsPerMatch(view.participants.length, view.startingRackSize));
  let lastRack = "";
  let lastBest = 0;

  return {
    name: `clone:${botId}`,
    quickBid(view: MatchView, auction: AuctionView): number {
      const me = view.participants.find((p) => p.botId === view.myBotId);
      const balance = Math.max(0, Math.floor(me?.balance ?? 0));
      if (balance === 0) return 0;
      const d = m.predictBid(botId, auction.letter, {
        phase: phaseNow(view),
        balance,
        rackSize: totalTiles(view.myRack),
      });
      const key = view.myRack.join(",");
      if (key !== lastRack) {
        lastRack = key;
        lastBest = bestWord(view.myRack, 2)?.length ?? 0;
      }
      const r = [...view.myRack];
      r[auction.letter.charCodeAt(0) - 65]!++;
      const useful = (bestWord(r, Math.max(2, lastBest + 1))?.length ?? 0) > lastBest;
      return Math.min(balance, d.quantile(ranks.quantile(rng(), useful)));
    },
    chooseWords(view: MatchView): string[] {
      return choosePlays(view.myRack, policyNow(), view.bagTotal);
    },
  };
}
