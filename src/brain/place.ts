// Finishing place, not score: how much each rival's points cost me.
//
// Ratings come from finishing order, so the objective is E[place]. If D_o is
// the final score gap to rival o (mine minus theirs), roughly normal with
// mean gap_o and spread sigma, then P(I beat o) = Phi(gap_o / sigma) and
//   dE[place]/d(my points)  = -sum_o f_o,    dE[place]/d(o's points) = f_o,
// with f_o the density of D_o at 0. So one point to rival o is worth
// w_o = f_o / sum f of one of my points: rivals near my score matter, rivals
// far ahead or behind don't, and as the match runs out (sigma shrinks) the
// weight concentrates on the nearest rivals.
//
// The same picture says when variance helps: dP(beat o)/dsigma is
// -phi(z) z / sigma, positive when I trail (z < 0). `tilt` averages that
// sign over the rivals that matter: > 0 behind (gamble), < 0 ahead (play safe).

import type { Params } from "./params.js";

export interface Standing {
  botId: number;
  score: number;
  balance: number;
  rackSize: number;
}

export interface PlaceView {
  /** Per rival, in the order given: the weight of its points against mine (sum 1). */
  weights: number[];
  /** > 0 when trailing the rivals that matter, < 0 when leading them. */
  tilt: number;
  sigma: number;
}

const phi = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

export function equity(s: Standing, lambda: number, p: Params): number {
  return s.score + lambda * s.balance + p.equityPerTile * s.rackSize;
}

export function placeView(me: Standing, rivals: readonly Standing[], lambda: number, remaining: number, p: Params): PlaceView {
  const sigma = Math.sqrt(p.placeSigmaMin ** 2 + p.placeSigma0 ** 2 * Math.max(0, Math.min(1, remaining)));
  const mine = equity(me, lambda, p);
  const f: number[] = [];
  let sum = 0;
  let tiltNum = 0;
  for (const r of rivals) {
    const z = (mine - equity(r, lambda, p)) / sigma;
    const d = phi(z) / sigma;
    f.push(d);
    sum += d;
    tiltNum += phi(z) * -z;
  }
  let phiSum = 0;
  for (const r of rivals) phiSum += phi((mine - equity(r, lambda, p)) / sigma);
  const weights = sum > 0 ? f.map((x) => x / sum) : rivals.map(() => 1 / Math.max(1, rivals.length));
  const tilt = phiSum > 0 ? Math.max(-2, Math.min(2, tiltNum / phiSum)) : 0;
  return { weights, tilt, sigma };
}
