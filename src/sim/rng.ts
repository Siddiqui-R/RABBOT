// Seeded randomness for the simulator. xoshiro128** seeded through
// SplitMix32, so any (seed, stream key) pair gives an independent,
// replayable stream. The server draws everything from one ctx.random; we
// split it into streams (bag, ties, sim jitter per seat, ...) so the letter
// sequence of a deal doesn't depend on what the bidders did. That keeps
// paired comparisons (same deal, seats rotated) on common random numbers.
// Distributionally it's the same game: every draw is still an independent
// uniform pick.

export type SeedKey = number | string;

function splitmix32(state: number): [number, number] {
  state = (state + 0x9e3779b9) | 0;
  let z = state;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return [state, (z ^ (z >>> 16)) >>> 0];
}

function hashString(s: string): number {
  // FNV-1a, then mixed below; only needs to separate stream names.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Folds keys into one 32-bit seed. Order matters: (1, 2) != (2, 1). */
export function deriveSeed(...keys: SeedKey[]): number {
  let h = 0x2545f491;
  for (const k of keys) {
    const v = typeof k === "number" ? k >>> 0 : hashString(k);
    // Mix the high part of large numeric keys too, so seeds above 2^32 differ.
    const hi = typeof k === "number" ? Math.floor(k / 4294967296) >>> 0 : 0;
    h = splitmix32((h ^ v) >>> 0)[1];
    if (hi) h = splitmix32((h ^ hi) >>> 0)[1];
  }
  return h >>> 0;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(...keys: SeedKey[]) {
    let s = deriveSeed(...keys);
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [ns, v] = splitmix32(s);
      s = ns;
      out.push(v);
    }
    [this.a, this.b, this.c, this.d] = out as [number, number, number, number];
    if ((this.a | this.b | this.c | this.d) === 0) this.a = 1;
  }

  /** Uniform uint32. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.b, 5), 7), 9) >>> 0;
    const t = this.b << 9;
    this.c ^= this.a;
    this.d ^= this.b;
    this.b ^= this.c;
    this.a ^= this.d;
    this.c ^= t;
    this.d = rotl(this.d, 11);
    return result;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [lo, hi], both inclusive, like ctx.random.integerInRange. */
  int(lo: number, hi: number): number {
    const range = hi - lo + 1;
    if (range <= 1) return lo;
    // Rejection sampling: no modulo bias, so tie-breaks are exactly fair.
    const limit = 4294967296 - (4294967296 % range);
    let u = this.nextU32();
    while (u >= limit) u = this.nextU32();
    return lo + (u % range);
  }

  /** Fisher-Yates exactly as the server's `shuffle` (rand's SliceRandom). */
  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i >= 1; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

// ---------- the live server's ctx.random ----------
//
// SpacetimeDB's TypeScript SDK (2.12 and 2.13, src/server/rng.ts) seeds a
// fresh generator for every reducer call from ctx.timestamp: PCG32 turns the
// microsecond timestamp into a 32-bit seed for pure-rand's xoroshiro128+.
// Its PCG32 rotates with JS's signed `>>`, so whenever the top bit is set the
// top `rot` bits of the seed come out all ones: ~3% of transactions get seed
// -1 exactly and many more get seeds near it. xoroshiro128+ seeded that way
// returns ~seed first, and the whole sequence stays structured, so the
// server's integerInRange is far from uniform (some letter indices come up
// 3x as often as they should). Live history shows it: the first auction's
// letter is D 7.1% of the time against 4.1% for a fair draw, which this
// port reproduces (runner.test.ts). game.ts's generateNonceCode comment
// admits the same seeding flaw. This is a line-for-line port of that code.

const PCG_MUL = 6364136223846793005n;
const PCG_INC = 11634580027462260723n;

function pcg32(state: bigint): number {
  state = BigInt.asUintN(64, state * PCG_MUL + PCG_INC);
  const xorshifted = Number(BigInt.asUintN(32, ((state >> 18n) ^ state) >> 27n));
  const rot = Number(BigInt.asUintN(32, state >> 59n));
  // The SDK's exact expression, sign-extending `>>` included: that is the bug.
  return (xorshifted >> rot) | (xorshifted << (32 - rot));
}

/** ctx.random for one transaction whose ctx.timestamp is `timestampUs`. */
export class ServerRandom {
  // pure-rand's XoroShiro128Plus fields, named as there.
  private s01: number;
  private s00: number;
  private s11: number;
  private s10: number;

  constructor(timestampUs: number | bigint) {
    const seed = pcg32(BigInt(timestampUs));
    // pure-rand 7: xoroshiro128plus(seed) = new XoroShiro128Plus(-1, ~seed, seed | 0, 0)
    this.s01 = -1;
    this.s00 = ~seed;
    this.s11 = seed | 0;
    this.s10 = 0;
  }

  /** pure-rand's unsafeNext: a signed 32-bit int. */
  unsafeNext(): number {
    const out = (this.s00 + this.s10) | 0;
    const a0 = this.s10 ^ this.s00;
    const a1 = this.s11 ^ this.s01;
    const s00 = this.s00;
    const s01 = this.s01;
    this.s00 = (s00 << 24) ^ (s01 >>> 8) ^ a0 ^ (a0 << 16);
    this.s01 = (s01 << 24) ^ (s00 >>> 8) ^ a1 ^ ((a1 << 16) | (a0 >>> 16));
    this.s10 = (a1 << 5) ^ (a0 >>> 27);
    this.s11 = (a0 << 5) ^ (a1 >>> 27);
    return out;
  }

  /** ctx.random.integerInRange(min, max): pure-rand's unsafeUniformIntDistribution. Always draws. */
  int(min: number, max: number): number {
    const rangeSize = max - min + 1;
    const maxAllowed = rangeSize > 2 ? Math.floor(0x100000000 / rangeSize) * rangeSize : 0x100000000;
    let deltaV = this.unsafeNext() + 0x80000000;
    while (deltaV >= maxAllowed) deltaV = this.unsafeNext() + 0x80000000;
    return (deltaV % rangeSize) + min;
  }

  /** The server's game.ts shuffle (Fisher-Yates over ctx.random). */
  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i >= 1; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
  }
}

/** Anything that shuffles like the server: Rng or ServerRandom. */
export interface Shuffler {
  shuffle<T>(items: T[]): void;
}

// Around late 2026 in microseconds; any realistic value works, since PCG
// scrambles the timestamp before the flawed rotation.
const SERVER_EPOCH_US = 1_790_000_000_000_000;

/** ctx.timestamp (µs) of the transaction that starts a deal's match. */
export function serverStartUs(seed: number): number {
  // Up to ~50 days of spread, kept well inside 2^53.
  return SERVER_EPOCH_US + deriveSeed(seed, "t0") * 1000 + (deriveSeed(seed, "t0us") % 1000);
}
