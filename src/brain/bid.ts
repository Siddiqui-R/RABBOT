// Turning a letter's value into a bid: maximise expected utility over every
// bid I could place, against the predicted bids of the bots actually seated.
//
//   U(b) = E[my surplus | b] + sum_o w_o * lambda * (E[o's surplus | 0] - E[o's surplus | b])
//
// My surplus is value - lambda * price when I win. A rival's surplus is what
// it bid minus what it paid (Vickrey), in coins, worth lambda points each:
// the coins it keeps for later tiles. My bid cuts that surplus in two ways:
// when I win, the rival who would have won gets nothing (denial); when I
// lose, the winner pays my bid instead of the next one (price-driving). w_o
// is how much rival o's points cost my finishing place (see place.ts).
//
// Without rivals, Vickrey's optimum is the truthful bid value / lambda; the
// rival term only pushes the bid up, and maxOverbid caps how far above the
// truthful bid it may go, because a model error there buys a tile I don't
// want. FirstPrice pays the bid itself, so the same search shades the bid
// against the distribution of the highest competing bid.

import { maxCdf } from "./market.js";

export interface BidInput {
  /** My value of the letter, points. */
  value: number;
  /** Points per coin. */
  lambda: number;
  balance: number;
  firstPrice: boolean;
  /** Each opponent's bid pmf and CDF, all of length len. */
  pmfs: readonly Float64Array[];
  cdfs: readonly Float64Array[];
  /** Weight of each opponent's surplus (0 = ignore). */
  weights: readonly number[];
  /** Scales the part of the rival term earned when I win (denial) and when I lose (price-driving). */
  denialWeight?: number;
  driveWeight?: number;
  tieShare: number;
  maxOverbid: number;
}

export interface BidChoice {
  bid: number;
  /** The best bid for my own surplus alone. */
  selfBid: number;
  utility: number;
  pWin: number;
  /** Expected price paid, given a win. */
  price: number;
}

export function chooseBid(inp: BidInput): BidChoice {
  const len = inp.cdfs[0]?.length ?? Math.max(2, Math.floor(inp.balance) + 2);
  const B = Math.max(0, Math.min(Math.floor(inp.balance), len - 1));
  const G = inp.cdfs.length > 0 ? maxCdf(inp.cdfs, len) : new Float64Array(len).fill(1);
  const g = (x: number) => G[x]! - (x > 0 ? G[x - 1]! : 0);
  const { value: v, lambda: lam, tieShare: tie } = inp;

  // My own surplus and win chance for every bid.
  const mine = new Float64Array(B + 1);
  const pWin = new Float64Array(B + 1);
  const pay = new Float64Array(B + 1);
  let acc = 0;
  let accPay = 0;
  let accP = 0;
  for (let b = 0; b <= B; b++) {
    const gb = g(b);
    if (b > 0) {
      if (inp.firstPrice) {
        const pw = G[b - 1]! + tie * gb;
        mine[b] = pw * (v - lam * b);
        pWin[b] = pw;
        pay[b] = pw * b;
      } else {
        mine[b] = acc + tie * gb * (v - lam * b);
        pWin[b] = accP + tie * gb;
        pay[b] = accPay + tie * gb * b;
      }
    }
    const price = Math.max(b, 1);
    acc += gb * (v - lam * price);
    accPay += gb * price;
    accP += gb;
  }
  let selfBid = 0;
  for (let b = 1; b <= B; b++) if (mine[b]! > mine[selfBid]! + 1e-9) selfBid = b;

  // Rivals' Vickrey surplus E_o(b) for every bid of mine.
  const util = mine.slice();
  if (!inp.firstPrice && lam > 0) {
    for (let o = 0; o < inp.pmfs.length; o++) {
      const w = inp.weights[o] ?? 0;
      if (!(w > 0)) continue;
      const others = maxCdf(
        inp.cdfs.filter((_, j) => j !== o),
        len,
      );
      const { denial, cut } = rivalCut(inp.pmfs[o]!, others, B);
      const dW = inp.denialWeight ?? 1;
      const vW = inp.driveWeight ?? 1;
      for (let b = 1; b <= B; b++) util[b]! += w * lam * (dW * denial[b]! + vW * (cut[b]! - denial[b]!));
    }
  }

  const cap = Math.min(B, selfBid + Math.max(0, Math.floor(inp.maxOverbid)));
  let bid = 0;
  for (let b = 1; b <= cap; b++) if (util[b]! > util[bid]! + 1e-9) bid = b;
  return {
    bid,
    selfBid,
    utility: util[bid]!,
    pWin: pWin[bid]!,
    price: pWin[bid]! > 0 ? pay[bid]! / pWin[bid]! : 0,
  };
}

/**
 * How much my bid b cuts rival o's Vickrey surplus, in coins, for every b in
 * 0..B. `f` is o's bid pmf, `others` the CDF of the highest bid among the
 * rest (me excluded). With Y = max(b, M_-o), o's surplus is (bid_o - Y)^+
 * (price at least the reserve 1), so cut(b) = E_o(0) - E_o(b), where
 * E_o(b) = G_-o(b) S(max(b,1)) + sum_{y>b} g_-o(y) S(y), S(y) = E[(bid_o - y)^+].
 * denial(b) is the part from outcomes where I win (o and the rest both
 * below b): sum_{x<b} f(x) sum_{y<x} (x - max(y,1)) g_-o(y). The rest of
 * the cut is price-driving: o still wins but pays my bid.
 */
export function rivalCut(f: Float64Array, others: Float64Array, B: number): { denial: Float64Array; cut: Float64Array } {
  const len = others.length;
  const S = new Float64Array(len + 1);
  let tailP = 0;
  let tailX = 0;
  for (let y = len - 1; y >= 0; y--) {
    S[y] = tailX - y * tailP;
    tailP += f[y] ?? 0;
    tailX += y * (f[y] ?? 0);
  }
  const T = new Float64Array(len + 1);
  for (let y = len - 2; y >= 0; y--) T[y] = T[y + 1]! + (others[y + 1]! - others[y]!) * S[y + 1]!;
  const E = (b: number) => others[b]! * S[Math.max(b, 1)]! + T[b]!;
  const e0 = E(0);
  const denial = new Float64Array(B + 1);
  const cut = new Float64Array(B + 1);
  let d = 0;
  let accG = 0;
  let accYG = 0;
  for (let b = 1; b <= B; b++) {
    const x = b - 1;
    if (x >= 1) {
      const gy = others[x - 1]! - (x - 1 > 0 ? others[x - 2]! : 0);
      accG += gy;
      accYG += Math.max(x - 1, 1) * gy;
      d += (f[x] ?? 0) * (x * accG - accYG);
    }
    denial[b] = d;
    cut[b] = e0 - E(b);
  }
  return { denial, cut };
}
