// The other bidders: what each seated opponent will bid (from the opponent
// model, exact for sims), the distribution of the highest and second
// highest competing bid, an in-match calibration of the model, and the
// shadow price of a coin (lambda) that balances my expected future spending
// against my budget.

import { LETTER_VALUES, SIM_BID_JITTER, idx } from "../core/rules.js";
import type { Params } from "./params.js";

/**
 * What the brain needs from src/memory/model.ts's OpponentModel, declared
 * structurally so the brain never imports the memory code: the model is
 * handed in (or loaded with a guarded dynamic import) and may be missing.
 */
export interface BidModel {
  strategyOf(botId: number): string;
  predictBid(
    botId: number,
    letter: string,
    ctx: { phase: number; balance: number; rackSize?: number },
  ): { pmf: Float64Array; mean: number };
}

/** P(bid = x), x = 0..cap. */
export type Pmf = Float64Array;

export type SimKind = "Cheapskate" | "ValueBidder" | "Aggressive";

/** The live sim pool (bot ids 1-6), used when no model is loaded. */
const SIM_IDS: Record<number, SimKind> = {
  1: "Cheapskate",
  2: "ValueBidder",
  3: "Aggressive",
  4: "ValueBidder",
  5: "Aggressive",
  6: "Cheapskate",
};

/** The server's sim bid: clamp(base + U{-2..2}, 1, balance), never below 0. */
export function simPmf(kind: SimKind, letter: string, balance: number, len: number): Pmf {
  const pmf = new Float64Array(len);
  const cap = Math.max(0, Math.floor(balance));
  const i = idx(letter);
  const value = LETTER_VALUES[i] ?? 0;
  const base =
    kind === "Cheapskate" ? value - 1 : kind === "ValueBidder" ? value : value + ("AEIOU".includes(letter) ? 4 : 2);
  const n = 2 * SIM_BID_JITTER + 1;
  for (let j = -SIM_BID_JITTER; j <= SIM_BID_JITTER; j++) {
    const b = Math.max(Math.min(Math.max(base + j, 1), cap), 0);
    pmf[Math.min(b, len - 1)]! += 1 / n;
  }
  return pmf;
}

/** A generic bidder: discretised normal around a value-linear mean, plus a chance to sit out. */
export function genericPmf(p: Params, letter: string, balance: number, len: number): Pmf {
  const pmf = new Float64Array(len);
  const cap = Math.min(len - 1, Math.max(0, Math.floor(balance)));
  const v = LETTER_VALUES[idx(letter)] ?? 1;
  const mean = p.mktBase + p.mktPerValue * v;
  const sd = Math.max(0.5, p.mktSd);
  pmf[0] = p.mktPZero;
  let tot = 0;
  const w = new Float64Array(cap + 1);
  for (let x = 1; x <= cap; x++) {
    w[x] = Math.exp(-0.5 * ((x - mean) / sd) ** 2);
    tot += w[x]!;
  }
  // Everything the normal puts above the balance lands on the balance.
  let above = 0;
  for (let x = cap + 1; x <= cap + 4 * sd + mean; x++) above += Math.exp(-0.5 * ((x - mean) / sd) ** 2);
  tot += above;
  if (tot <= 0) {
    pmf[0] = 1;
    return pmf;
  }
  for (let x = 1; x <= cap; x++) pmf[x] = ((1 - p.mktPZero) * w[x]!) / tot;
  if (cap > 0) pmf[cap]! += ((1 - p.mktPZero) * above) / tot;
  else pmf[0] = 1;
  return pmf;
}

/** Rescales bids x -> round(s * x) (capped), keeping zeros at zero. */
export function scalePmf(pmf: Pmf, s: number, cap: number): Pmf {
  if (Math.abs(s - 1) < 1e-9) return pmf;
  const out = new Float64Array(pmf.length);
  const top = Math.min(pmf.length - 1, Math.max(0, Math.floor(cap)));
  out[0] = pmf[0]!;
  for (let x = 1; x < pmf.length; x++) {
    const m = pmf[x]!;
    if (m === 0) continue;
    out[Math.min(top, Math.max(1, Math.round(s * x)))]! += m;
  }
  return out;
}

export function cdfOf(pmf: Pmf): Float64Array {
  const c = new Float64Array(pmf.length);
  let acc = 0;
  for (let x = 0; x < pmf.length; x++) {
    acc += pmf[x]!;
    c[x] = Math.min(1, acc);
  }
  return c;
}

/** CDF of the max of independent bids. */
export function maxCdf(cdfs: readonly Float64Array[], len: number): Float64Array {
  const g = new Float64Array(len).fill(1);
  for (const c of cdfs) for (let x = 0; x < len; x++) g[x]! *= c[Math.min(x, c.length - 1)]!;
  return g;
}

/** CDF of the second highest of independent bids. */
export function secondCdf(cdfs: readonly Float64Array[], len: number): Float64Array {
  const all = maxCdf(cdfs, len);
  const h = all.slice();
  for (let o = 0; o < cdfs.length; o++) {
    const others = maxCdf(
      cdfs.filter((_, j) => j !== o),
      len,
    );
    const co = cdfs[o]!;
    for (let x = 0; x < len; x++) h[x]! += (1 - co[Math.min(x, co.length - 1)]!) * others[x]!;
  }
  for (let x = 0; x < len; x++) h[x] = Math.min(1, h[x]!);
  return h;
}

export function pmfOfCdf(c: Float64Array): Float64Array {
  const p = new Float64Array(c.length);
  for (let x = 0; x < c.length; x++) p[x] = Math.max(0, c[x]! - (x > 0 ? c[x - 1]! : 0));
  return p;
}

export interface Seat {
  botId: number;
  isSim: boolean;
  balance: number;
  rackSize: number;
}

interface Pending {
  letter: string;
  myBid: number;
  /** CDF of the highest and second highest competing bid. */
  max: Float64Array;
  second: Float64Array;
}

/** Opponent bids for one match: model + calibration. */
export class Market {
  /** Multiplicative correction on real bots' predicted bids, learned in-match. */
  logScale = 0;
  private pending = new Map<number, Pending>();
  private observed = 0;

  constructor(
    private p: Params,
    private model: BidModel | undefined,
  ) {}

  get scale(): number {
    return Math.exp(this.logScale);
  }

  simKind(botId: number, isSim: boolean): SimKind | undefined {
    if (!isSim) return undefined;
    const s = this.p.useModel ? this.model?.strategyOf(botId) : undefined;
    if (s === "Cheapskate" || s === "ValueBidder" || s === "Aggressive") return s;
    return SIM_IDS[botId] ?? "ValueBidder";
  }

  /** One opponent's bid pmf (length `len`), calibrated. */
  bidPmf(seat: Seat, letter: string, phase: number, len: number): Pmf {
    const kind = this.simKind(seat.botId, seat.isSim);
    if (kind) return simPmf(kind, letter, seat.balance, len);
    let pmf: Pmf;
    if (this.p.useModel && this.model) {
      try {
        const d = this.model.predictBid(seat.botId, letter, {
          phase,
          balance: Math.max(0, Math.floor(seat.balance)),
          rackSize: seat.rackSize,
        });
        pmf = new Float64Array(len);
        const src = d.pmf;
        for (let x = 0; x < src.length; x++) pmf[Math.min(x, len - 1)]! += src[x]!;
        let tot = 0;
        for (let x = 0; x < len; x++) tot += pmf[x]!;
        if (!(tot > 0)) pmf = genericPmf(this.p, letter, seat.balance, len);
        else if (Math.abs(tot - 1) > 1e-9) for (let x = 0; x < len; x++) pmf[x]! /= tot;
      } catch {
        pmf = genericPmf(this.p, letter, seat.balance, len);
      }
    } else pmf = genericPmf(this.p, letter, seat.balance, len);
    return scalePmf(pmf, this.scale, seat.balance);
  }

  /** Remembers what I expected of an auction, to learn from its result. */
  expect(auctionId: number, letter: string, myBid: number, cdfs: readonly Float64Array[], len: number): void {
    if (this.p.calibRate <= 0) return;
    this.pending.set(auctionId, {
      letter,
      myBid,
      max: maxCdf(cdfs, len),
      second: secondCdf(cdfs, len),
    });
  }

  /** Updates my final bid for an auction (refine may change it). */
  setMyBid(auctionId: number, bid: number): void {
    const e = this.pending.get(auctionId);
    if (e) e.myBid = bid;
  }

  /**
   * Learns from a closed auction: where the observed price fell in the
   * predicted distribution (mid-PIT). Calibrated predictions average 0.5;
   * prices persistently in the upper tail scale real bots' bids up.
   */
  observe(auctionId: number, winner: number | null, paid: number, myBotId: number, firstPrice: boolean): void {
    const e = this.pending.get(auctionId);
    if (!e) return;
    this.pending.delete(auctionId);
    const pit = (c: Float64Array, x: number) => {
      const xi = Math.min(c.length - 1, Math.max(0, x));
      const hi = c[xi]!;
      const lo = xi > 0 ? c[xi - 1]! : 0;
      return (lo + hi) / 2;
    };
    let u: number | undefined;
    if (winner === null) u = pit(e.max, 0);
    else if (winner === myBotId) {
      // Vickrey: I paid the highest competing bid (1 = maybe nobody else bid).
      if (!firstPrice) u = paid <= 1 ? e.max[Math.min(1, e.max.length - 1)]! / 2 : pit(e.max, paid);
    } else if (e.myBid < paid) {
      // I was outside the top two: the price is the competitors' own.
      u = firstPrice ? pit(e.max, paid) : paid <= 1 ? e.second[Math.min(1, e.second.length - 1)]! / 2 : pit(e.second, paid);
    }
    if (u === undefined || !Number.isFinite(u)) return;
    this.observed++;
    const lo = Math.log(this.p.calibMin);
    const hi = Math.log(this.p.calibMax);
    this.logScale = Math.min(hi, Math.max(lo, this.logScale + this.p.calibRate * (u - 0.5)));
  }

  get observations(): number {
    return this.observed;
  }
}

// ---------- lambda: the shadow price of a coin ----------

export interface LetterMarket {
  /** CDF of the highest competing bid, 0..len-1. */
  G: Float64Array;
  /** Expected payment if I bid b: sum_{x<b} g(x) max(x,1) + tie g(b) b. */
  spend: Float64Array;
  /** P(win) if I bid b. */
  win: Float64Array;
}

export function letterMarket(G: Float64Array, tie: number): LetterMarket {
  const len = G.length;
  const spend = new Float64Array(len);
  const win = new Float64Array(len);
  let accPay = 0;
  for (let b = 0; b < len; b++) {
    const g = G[b]! - (b > 0 ? G[b - 1]! : 0);
    if (b === 0) {
      spend[0] = 0;
      win[0] = 0;
    } else {
      spend[b] = accPay + tie * g * b;
      win[b] = G[b - 1]! + tie * g;
    }
    accPay += g * Math.max(b, 1);
  }
  return { G, spend, win };
}

export interface LambdaInput {
  /** My value of each letter now (points). */
  values: Float64Array;
  /** Expected count of each letter among the useful auctions still to come. */
  counts: Float64Array;
  /** Competition per letter at a typical future auction. */
  markets: (LetterMarket | undefined)[];
  budget: number;
  p: Params;
}

export interface LambdaResult {
  lambda: number;
  /** Tiles I expect to win from here at that lambda. */
  wins: number;
  spend: number;
}

/** Spending and wins over the remaining auctions if I bid value / lambda. */
export function projected(inp: LambdaInput, lambda: number): { spend: number; wins: number } {
  let spend = 0;
  let wins = 0;
  for (let i = 0; i < 26; i++) {
    const n = inp.counts[i]!;
    const m = inp.markets[i];
    if (n <= 0 || !m) continue;
    const v = Math.max(0, inp.values[i]! * inp.p.futureValueScale);
    if (v <= 0) continue;
    // Not capped at today's balance: the budget is spread over time, and
    // capping makes a broke bot look like coins are worthless to it (it
    // can't win anything at any lambda), when they are precious.
    const b = Math.min(m.spend.length - 1, Math.floor(v / lambda));
    if (b <= 0) continue;
    spend += n * m.spend[b]!;
    wins += n * m.win[b]!;
  }
  return { spend, wins };
}

/** The lambda at which projected spending matches the budget (bisection in log space). */
export function solveLambda(inp: LambdaInput): LambdaResult {
  const { lambdaMin, lambdaMax } = inp.p;
  const atMin = projected(inp, lambdaMin);
  if (atMin.spend <= inp.budget) return { lambda: lambdaMin, ...atMin };
  const atMax = projected(inp, lambdaMax);
  if (atMax.spend >= inp.budget) return { lambda: lambdaMax, ...atMax };
  let lo = Math.log(lambdaMin);
  let hi = Math.log(lambdaMax);
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2;
    if (projected(inp, Math.exp(mid)).spend > inp.budget) lo = mid;
    else hi = mid;
  }
  const lambda = Math.exp(hi);
  return { lambda, ...projected(inp, lambda) };
}
