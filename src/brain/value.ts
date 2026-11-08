// Letter values by simulated futures.
//
// V(rack) = E[ P(rack + F) ], where F is the k tiles I expect to buy from
// here on, drawn from the unseen pool, and P is the points the best
// partition of those tiles into words would score at the end. A letter's
// value is V(rack + L) - V(rack). Both sides use the same draws F_s (common
// random numbers), so the noise of F mostly cancels in the difference and a
// few dozen samples rank letters reliably.
//
// One sample computes P for the rack and for the rack plus each of the 26
// letters, so a single table answers the current auction, feeds the lambda
// solver (which needs every letter's value) and the play decision (which
// reuses the same F_s). The table lives as long as the rack does: samples
// accumulate across auctions, and old ones are dropped as the pool drifts.
//
// P is approximate: the best of the top-K first words, each followed by
// greedy best words. It is within ~1-2% of the exact partition at 12-16
// tiles and 5-10x faster, and deterministic (no time budget), which keeps
// sim runs reproducible. The exact bestPartition is used for the final dump.

import { emptyCounts, type Counts } from "../core/rules.js";
import type { WordEngine } from "../core/words.js";

export type Rand = () => number;

export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rackKey(rack: Counts): string {
  return rack.join(",");
}

/**
 * Draws `k` tiles without replacement from `pool` into `out` (added). With
 * `weights`, each tile of letter i is drawn with relative weight weights[i]
 * (how likely I am to end up with it), otherwise uniformly.
 */
export function drawInto(pool: Counts, k: number, rand: Rand, out: Counts, weights?: ArrayLike<number>): void {
  const left = pool.slice();
  let W = 0;
  for (let i = 0; i < 26; i++) W += left[i]! * (weights ? weights[i]! : 1);
  for (let j = 0; j < k && W > 1e-12; j++) {
    let r = rand() * W;
    let pick = -1;
    for (let i = 0; i < 26; i++) {
      const wi = left[i]! * (weights ? weights[i]! : 1);
      if (wi <= 0) continue;
      pick = i;
      if (r < wi) break;
      r -= wi;
    }
    if (pick < 0) break;
    left[pick]!--;
    out[pick]!++;
    W -= weights ? weights[pick]! : 1;
  }
}

function sub(rack: Counts, word: string): Counts {
  const r = rack.slice();
  for (let i = 0; i < word.length; i++) r[word.charCodeAt(i) - 65]!--;
  return r;
}

/** Approximate best-partition points of a rack, cached. */
export class Partitioner {
  private cache = new Map<string, number>();
  private scratch = emptyCounts();

  constructor(
    readonly engine: WordEngine,
    private topK: number,
  ) {}

  value(rack: Counts): number {
    let tiles = 0;
    for (let i = 0; i < 26; i++) tiles += rack[i]!;
    if (tiles < 2) return 0;
    const key = rackKey(rack);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    for (const h of this.engine.topK(rack, this.topK)) {
      const r = this.scratch;
      for (let i = 0; i < 26; i++) r[i] = rack[i]!;
      for (let i = 0; i < h.word.length; i++) r[h.word.charCodeAt(i) - 65]!--;
      let total = h.reward;
      for (;;) {
        const g = this.engine.best(r);
        if (!g) break;
        total += g.reward;
        for (let i = 0; i < g.word.length; i++) r[g.word.charCodeAt(i) - 65]!--;
      }
      if (total > best) best = total;
    }
    if (this.cache.size > 200_000) this.cache.clear();
    this.cache.set(key, best);
    return best;
  }

  clear(): void {
    this.cache.clear();
  }
}

export interface Sample {
  round: number;
  k: number;
  /** The imagined future tiles. */
  future: Counts;
  /** P(rack + F). */
  base: number;
  /** P(rack + L + F) - P(rack + F) per letter; NaN until asked for. */
  delta: Float64Array;
  /** P(rack - w + F) for play candidates, filled on demand. */
  after: Map<string, number>;
}

/**
 * Samples for one rack; dies when the rack changes. A sample costs one
 * partition; each letter's value costs one more per sample and is computed
 * only when asked for (the lambda solve needs letters that can still come
 * up, the bid needs the letter on the block, the play decision needs none).
 */
export class LetterTable {
  readonly key: string;
  readonly rack: Counts;
  samples: Sample[] = [];

  constructor(
    rack: Counts,
    private part: Partitioner,
  ) {
    this.rack = rack.slice();
    this.key = rackKey(rack);
  }

  /** Drops samples that are too old or imagined a very different k. */
  prune(round: number, k: number, maxAge: number): void {
    this.samples = this.samples.filter((s) => round - s.round <= maxAge && Math.abs(s.k - k) <= 1.5);
  }

  /**
   * Adds up to `n` samples with `k` future tiles (fractional k: floor + coin
   * flip), stopping early at `deadline` (performance.now() ms) once at least
   * one was added. Sim mode passes no deadline, so runs stay reproducible.
   */
  add(
    pool: Counts,
    k: number,
    n: number,
    rand: Rand,
    round: number,
    weights?: ArrayLike<number>,
    deadline = Infinity,
  ): void {
    const kk = Math.max(0, k);
    for (let s = 0; s < n; s++) {
      if (s > 0 && deadline !== Infinity && performance.now() > deadline) break;
      const ks = Math.floor(kk) + (rand() < kk - Math.floor(kk) ? 1 : 0);
      const future = emptyCounts();
      drawInto(pool, ks, rand, future, weights);
      const r = this.rack.slice();
      for (let i = 0; i < 26; i++) r[i]! += future[i]!;
      this.samples.push({ round, k, future, base: this.part.value(r), delta: new Float64Array(26).fill(NaN), after: new Map() });
    }
  }

  get size(): number {
    return this.samples.length;
  }

  private ensure(i: number): void {
    for (const s of this.samples) {
      if (!Number.isNaN(s.delta[i]!)) continue;
      const r = this.rack.slice();
      for (let j = 0; j < 26; j++) r[j]! += s.future[j]!;
      r[i]!++;
      s.delta[i] = this.part.value(r) - s.base;
    }
  }

  /** Mean value of each letter whose `want` entry is > 0 (others 0), in points. */
  deltas(want?: ArrayLike<number>): Float64Array {
    const out = new Float64Array(26);
    const n = this.samples.length;
    if (n === 0) return out;
    for (let i = 0; i < 26; i++) {
      if (want && !(want[i]! > 0)) continue;
      this.ensure(i);
      let m = 0;
      for (const s of this.samples) m += s.delta[i]!;
      out[i] = m / n;
    }
    return out;
  }

  /** Mean and standard error of one letter's value. */
  letter(i: number): { mean: number; se: number } {
    const n = this.samples.length;
    if (n === 0) return { mean: 0, se: Infinity };
    this.ensure(i);
    let m = 0;
    for (const s of this.samples) m += s.delta[i]!;
    m /= n;
    let v = 0;
    for (const s of this.samples) v += (s.delta[i]! - m) ** 2;
    return { mean: m, se: n > 1 ? Math.sqrt(v / (n - 1) / n) : Infinity };
  }

  /** E[P(rack + F)]: what the rack plus expected purchases should score. */
  baseValue(): number {
    const n = this.samples.length;
    if (n === 0) return this.part.value(this.rack);
    let m = 0;
    for (const s of this.samples) m += s.base;
    return m / n;
  }

  /**
   * Per-sample points if `word` is played now and the rest held:
   * P(rack - word + F_s). Same F_s as the hold value (CRN). Only the first
   * `limit` samples (the same ones holdSamples(limit) returns).
   */
  afterPlay(word: string, limit = Infinity): number[] {
    const rest = sub(this.rack, word);
    const ss = limit < this.samples.length ? this.samples.slice(0, limit) : this.samples;
    return ss.map((s) => {
      let v = s.after.get(word);
      if (v === undefined) {
        const r = rest.slice();
        for (let i = 0; i < 26; i++) r[i]! += s.future[i]!;
        v = this.part.value(r);
        s.after.set(word, v);
      }
      return v;
    });
  }

  holdSamples(limit = Infinity): number[] {
    const ss = limit < this.samples.length ? this.samples.slice(0, limit) : this.samples;
    return ss.map((s) => s.base);
  }
}
