// Sums the module maintains as derived rows change, so readers get per-letter
// prices, per-bot bid evidence and per-bot match records without scanning
// d_* (SpacetimeDB SQL has no GROUP BY).
//
// Invariant, whatever order or how often rows arrive:
//   market_stat = sum over d_auction_ctx rows of market(row)
//   opp_stat    = sum over d_bid_obs rows of opp(row)
//   seat_stat   = sum over d_match_seat rows of seat(row)
// Every write to those tables goes through put_derived, which adds the new
// row's contribution and subtracts the old one's; unchanged rows contribute
// nothing. A sum row whose counts all return to zero is deleted.

import type { DAuctionCtx, DBidObs, DMatchSeat } from "./schema";

/** fit.ts's phaseBucket: quartiles of the match, plus the last ~3% (4). */
export function phaseBucket(phase: number): number {
  if (phase >= 0.97) return 4;
  return Math.max(0, Math.min(3, Math.floor(phase * 4)));
}

/** Per-key field deltas for one reducer call, written once at the end. */
export class Sums<F extends string> {
  private m = new Map<string, { init: Record<string, unknown>; d: Record<F, bigint> }>();
  constructor(readonly fields: readonly F[]) {}

  at(key: string, init: Record<string, unknown>): Record<F, bigint> {
    let e = this.m.get(key);
    if (!e) {
      const d = {} as Record<F, bigint>;
      for (const f of this.fields) d[f] = 0n;
      e = { init, d };
      this.m.set(key, e);
    }
    return e.d;
  }

  /**
   * Applies the deltas to `tb` (rows keyed by `pk`). Rows with every field
   * at zero are removed, so a full retraction leaves nothing behind.
   */
  flush<K>(
    tb: {
      find(k: K): object | null | undefined;
      update(r: object): unknown;
      delete(k: K): boolean;
      insert(r: object): unknown;
    },
    pk: string,
    now: unknown,
  ): void {
    for (const { init, d } of this.m.values()) {
      if (this.fields.every((f) => d[f] === 0n)) continue;
      const k = init[pk] as K;
      const old = tb.find(k) as Record<string, unknown> | null | undefined;
      const row: Record<string, unknown> = old ? { ...old } : { ...init };
      for (const f of this.fields) row[f] = ((old?.[f] as bigint | undefined) ?? 0n) + d[f];
      row.updatedAt = now;
      const empty = this.fields.every((f) => row[f] === 0n);
      if (old && empty) tb.delete(k);
      else if (old) tb.update(row);
      else if (!empty) tb.insert(row);
    }
    this.m.clear();
  }
}

export const MARKET_FIELDS = [
  "n", "nSold", "nSimWin", "sumPaid", "sumsqPaid", "nTop", "sumTop", "sumsqTop",
] as const;
export const OPP_FIELDS = [
  "nObs", "nWon", "nEq", "nZero", "sumEq", "sumsqEq", "nLe", "sumLe", "sumsqLe", "nGe", "sumGe",
] as const;
export const SEAT_FIELDS = [
  "matches", "wins", "sumPlace", "sumScore", "sumWonTiles", "sumPaid", "sumWords",
  "sumLettersPlayed", "sumTilesLeft",
] as const;

/** All three sum tables' pending deltas for one reducer call. */
export class StatAcc {
  readonly market = new Sums(MARKET_FIELDS);
  readonly opp = new Sums(OPP_FIELDS);
  readonly seat = new Sums(SEAT_FIELDS);

  /** s = 1n adds the row's contribution, -1n removes it. */
  auction(a: DAuctionCtx, s: bigint): void {
    const pb = phaseBucket(a.phase);
    const key = `${a.letter}|${pb}`;
    const d = this.market.at(key, { key, letter: a.letter, phase: pb });
    d.n += s;
    if (a.winnerBotId !== undefined) {
      d.nSold += s;
      d.sumPaid += s * a.paid;
      d.sumsqPaid += s * a.paid * a.paid;
      if (a.winnerIsSim === true) d.nSimWin += s;
    }
    if (a.topBid !== undefined) {
      d.nTop += s;
      d.sumTop += s * a.topBid;
      d.sumsqTop += s * a.topBid * a.topBid;
    }
  }

  bid(b: DBidObs, s: bigint): void {
    const pb = phaseBucket(b.phase);
    const key = `${b.botId}|${b.letter}|${pb}`;
    const d = this.opp.at(key, { key, botId: b.botId, letter: b.letter, phase: pb });
    d.nObs += s;
    if (b.won) d.nWon += s;
    if (b.kind === 0) {
      d.nEq += s;
      if (b.value === 0n) d.nZero += s;
      d.sumEq += s * b.value;
      d.sumsqEq += s * b.value * b.value;
    } else if (b.kind === 1) {
      d.nLe += s;
      d.sumLe += s * b.value;
      d.sumsqLe += s * b.value * b.value;
    } else {
      d.nGe += s;
      d.sumGe += s * b.value;
    }
  }

  seatRow(r: DMatchSeat, s: bigint): void {
    const d = this.seat.at(String(r.botId), { botId: r.botId });
    d.matches += s;
    if (r.place === 1) d.wins += s;
    d.sumPlace += s * BigInt(r.place);
    d.sumScore += s * r.finalScore;
    d.sumWonTiles += s * BigInt(r.wonTiles);
    d.sumPaid += s * r.paidTotal;
    d.sumWords += s * BigInt(r.words);
    d.sumLettersPlayed += s * BigInt(r.lettersPlayed);
    d.sumTilesLeft += s * BigInt(r.tilesLeft);
  }
}
