// Per-seat-spec results. Confidence intervals are cluster-robust over
// deals: seats in one match are not independent (places sum to a
// constant), and with --swap every rotation of a deal shares its letters,
// so the deal is the unit of independent sampling.

import type { SeatOutcome } from "./engine.js";

export interface SeatGameResult extends SeatOutcome {
  spec: string;
  /** 1 = first; tied seats share the average of the places they span. */
  place: number;
  /** 1 for an outright win, 1/k for a k-way tie on top, else 0. */
  winShare: number;
}

export interface GameRecord {
  game: number;
  deal: number;
  rotation: number;
  matchId: number;
  rounds: number;
  seats: SeatGameResult[];
}

export interface Estimate {
  mean: number;
  /** 95% interval; NaN when fewer than two deals. */
  lo: number;
  hi: number;
  halfWidth: number;
}

export interface SpecStats {
  spec: string;
  /** Seat-games played (a spec seated twice in a match counts twice). */
  games: number;
  /** Independent deals it appeared in. */
  deals: number;
  score: Estimate;
  place: Estimate;
  winRate: Estimate;
  coinsLeft: Estimate;
  tilesLeft: Estimate;
  wordsPlayed: number;
  bidRejections: number;
  wordRejections: number;
  agentErrors: number;
  firstError?: string;
}

export function placesAndWins(scores: readonly number[]): { place: number[]; winShare: number[] } {
  const place: number[] = [];
  const winShare: number[] = [];
  for (const s of scores) {
    let higher = 0;
    let equal = 0;
    for (const t of scores) {
      if (t > s) higher++;
      else if (t === s) equal++;
    }
    place.push(higher + (equal + 1) / 2);
    winShare.push(higher === 0 ? 1 / equal : 0);
  }
  return { place, winShare };
}

/** Ratio-of-sums mean with a cluster-robust (sandwich) 95% interval. */
export function clusteredEstimate(clusters: readonly { sum: number; n: number }[]): Estimate {
  let total = 0;
  let n = 0;
  let g = 0;
  for (const c of clusters) {
    if (c.n === 0) continue;
    total += c.sum;
    n += c.n;
    g++;
  }
  const mean = n > 0 ? total / n : NaN;
  if (g < 2) return { mean, lo: NaN, hi: NaN, halfWidth: NaN };
  let ss = 0;
  for (const c of clusters) {
    if (c.n === 0) continue;
    const r = c.sum - mean * c.n;
    ss += r * r;
  }
  const variance = ((g / (g - 1)) * ss) / (n * n);
  const halfWidth = 1.96 * Math.sqrt(variance);
  return { mean, lo: mean - halfWidth, hi: mean + halfWidth, halfWidth };
}

type Metric = "score" | "place" | "winShare" | "balance" | "tilesLeft";
const METRICS: readonly Metric[] = ["score", "place", "winShare", "balance", "tilesLeft"];

/** Stats per spec, in order of first appearance. Pass records sorted by game for stable output. */
export function aggregate(records: readonly GameRecord[]): SpecStats[] {
  interface Acc {
    perDeal: Map<number, Record<Metric, number> & { n: number }>;
    games: number;
    wordsPlayed: number;
    bidRejections: number;
    wordRejections: number;
    agentErrors: number;
    firstError?: string;
  }
  const bySpec = new Map<string, Acc>();
  for (const r of records) {
    for (const s of r.seats) {
      let acc = bySpec.get(s.spec);
      if (!acc) {
        acc = { perDeal: new Map(), games: 0, wordsPlayed: 0, bidRejections: 0, wordRejections: 0, agentErrors: 0 };
        bySpec.set(s.spec, acc);
      }
      let d = acc.perDeal.get(r.deal);
      if (!d) {
        d = { n: 0, score: 0, place: 0, winShare: 0, balance: 0, tilesLeft: 0 };
        acc.perDeal.set(r.deal, d);
      }
      d.n++;
      for (const m of METRICS) d[m] += s[m];
      acc.games++;
      acc.wordsPlayed += s.wordsPlayed;
      acc.bidRejections += s.bidRejections;
      acc.wordRejections += s.wordRejections;
      acc.agentErrors += s.agentErrors;
      if (s.firstError !== undefined) acc.firstError ??= s.firstError;
    }
  }
  return [...bySpec].map(([spec, acc]) => {
    const deals = [...acc.perDeal.values()];
    const est = (m: Metric) => clusteredEstimate(deals.map((d) => ({ sum: d[m], n: d.n })));
    return {
      spec,
      games: acc.games,
      deals: deals.length,
      score: est("score"),
      place: est("place"),
      winRate: est("winShare"),
      coinsLeft: est("balance"),
      tilesLeft: est("tilesLeft"),
      wordsPlayed: acc.wordsPlayed / acc.games,
      bidRejections: acc.bidRejections,
      wordRejections: acc.wordRejections,
      agentErrors: acc.agentErrors,
      firstError: acc.firstError,
    };
  });
}
