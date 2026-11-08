// Builds the MatchView an Agent sees from raw table rows. Pure: the live
// bot feeds it rows from the SDK cache, tests feed it hand-made rows.
//
// bagTotal: the server's drawLetter() decrements match_state.bag_total in
// the same transaction that opens the auction, so at auction open it already
// excludes the letter on the block. That is exactly MatchView.bagTotal.

import { emptyCounts, idx, type Counts } from "../core/rules.js";
import type {
  AuctionType,
  AuctionView,
  MatchView,
  ParticipantView,
  PublicEvent,
} from "../core/types.js";
import {
  tsMs,
  type AuctionResultRow,
  type AuctionRow,
  type MatchRow,
  type ParticipantRow,
  type RackRow,
  type WordPlayRow,
} from "./rows.js";

export interface MatchRows {
  match: MatchRow;
  /** May include other matches' rows; they are filtered out. */
  participants: Iterable<ParticipantRow>;
  rack: Iterable<RackRow>;
  results: Iterable<AuctionResultRow>;
  words: Iterable<WordPlayRow>;
  isSim: (botId: bigint) => boolean;
}

export function auctionTypeOf(tag: string): AuctionType {
  return tag === "FirstPrice" ? "FirstPrice" : "Vickrey";
}

export function rackCounts(rows: Iterable<RackRow>, matchId: bigint, botId: bigint): Counts {
  const c = emptyCounts();
  for (const r of rows) {
    if (r.matchId !== matchId || r.botId !== botId) continue;
    const i = idx(r.letter);
    if (i >= 0 && i < 26) c[i]! += r.count;
  }
  return c;
}

export function rackString(c: Counts): string {
  let s = "";
  for (let i = 0; i < 26; i++) s += String.fromCharCode(65 + i).repeat(c[i]!);
  return s;
}

/**
 * Auction results and word plays in server order. Each transaction has one
 * timestamp, so sort by it; inside one transaction (an auction close) the
 * result comes before the simulated winner's word, as closeAuction writes
 * them. Remaining ties fall back to ids, which the server hands out in order.
 */
export function orderHistory(
  results: Iterable<AuctionResultRow>,
  words: Iterable<WordPlayRow>,
  matchId: bigint,
): PublicEvent[] {
  type Keyed = { at: bigint; kind: 0 | 1; id: bigint; ev: PublicEvent };
  const keyed: Keyed[] = [];
  for (const r of results) {
    if (r.matchId !== matchId) continue;
    keyed.push({
      at: r.closedAt.microsSinceUnixEpoch,
      kind: 0,
      id: r.auctionId,
      ev: {
        kind: "auction",
        auctionId: Number(r.auctionId),
        letter: r.letter,
        winnerBotId: r.winnerBotId === undefined ? null : Number(r.winnerBotId),
        paid: Number(r.paid),
      },
    });
  }
  for (const w of words) {
    if (w.matchId !== matchId) continue;
    keyed.push({
      at: w.playedAt.microsSinceUnixEpoch,
      kind: 1,
      id: w.id,
      ev: { kind: "word", botId: Number(w.botId), word: w.word, reward: Number(w.totalReward) },
    });
  }
  keyed.sort((a, b) =>
    a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.kind !== b.kind ? a.kind - b.kind : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return keyed.map((k) => k.ev);
}

/** Seats in server order (participant row id), with isSim from the bot table. */
export function participantViews(
  rows: Iterable<ParticipantRow>,
  matchId: bigint,
  isSim: (botId: bigint) => boolean,
): ParticipantView[] {
  const mine = [...rows].filter((p) => p.matchId === matchId);
  mine.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return mine.map((p) => ({
    botId: Number(p.botId),
    balance: Number(p.balance),
    score: Number(p.score),
    isSim: isSim(p.botId),
  }));
}

export function buildMatchView(rows: MatchRows, myBotId: bigint, nowMs: number): MatchView {
  const m = rows.match;
  return {
    matchId: Number(m.id),
    myBotId: Number(myBotId),
    auctionType: auctionTypeOf(m.auctionType.tag),
    round: m.currentRound,
    bagTotal: m.bagTotal,
    startingRackSize: m.startingRackSize,
    participants: participantViews(rows.participants, m.id, rows.isSim),
    myRack: rackCounts(rows.rack, m.id, myBotId),
    history: orderHistory(rows.results, rows.words, m.id),
    nowMs,
  };
}

export function auctionViewOf(a: AuctionRow): AuctionView {
  return {
    auctionId: Number(a.id),
    letter: a.letter,
    opensAtMs: tsMs(a.opensAt),
    closesAtMs: tsMs(a.closesAt),
  };
}

export interface Standing {
  botId: number;
  score: number;
  balance: number;
  /** 1-based; bots level on score share the better place, as the server rates them. */
  place: number;
  isSim: boolean;
}

export function standings(participants: readonly ParticipantView[]): Standing[] {
  const sorted = [...participants].sort((a, b) => b.score - a.score);
  return sorted.map((p) => ({
    botId: p.botId,
    score: p.score,
    balance: p.balance,
    place: 1 + sorted.filter((q) => q.score > p.score).length,
    isSim: p.isSim,
  }));
}

/** Compact one-line summary for logs. */
export function viewSummary(v: MatchView) {
  const me = v.participants.find((p) => p.botId === v.myBotId);
  return {
    match: v.matchId,
    round: v.round,
    bagTotal: v.bagTotal,
    balance: me?.balance ?? null,
    score: me?.score ?? null,
    rack: rackString(v.myRack),
    seats: v.participants.map((p) => [p.botId, p.balance, p.score, p.isSim ? 1 : 0]),
    events: v.history.length,
  };
}
