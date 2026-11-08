import assert from "node:assert/strict";
import { test } from "node:test";
import { idx } from "../core/rules.js";
import type {
  AuctionResultRow,
  AuctionRow,
  MatchRow,
  ParticipantRow,
  RackRow,
  WordPlayRow,
} from "./rows.js";
import {
  auctionViewOf,
  buildMatchView,
  orderHistory,
  rackCounts,
  rackString,
  standings,
} from "./view.js";

const ts = (ms: number) => ({ microsSinceUnixEpoch: BigInt(Math.round(ms * 1000)) });
const T0 = 1_792_885_000_000;

function match(over: Partial<MatchRow> = {}): MatchRow {
  return {
    id: 7n,
    status: { tag: "Running" },
    currentRound: 3,
    currentAuctionId: 503n,
    bagTotal: 65,
    auctionType: { tag: "Vickrey" },
    startingRackSize: 5,
    ...over,
  };
}

const seat = (id: bigint, matchId: bigint, botId: bigint, balance: bigint, score: bigint): ParticipantRow => ({
  id,
  matchId,
  botId,
  balance,
  score,
});
const tile = (id: bigint, matchId: bigint, botId: bigint, letter: string, count: number): RackRow => ({
  id,
  matchId,
  botId,
  letter,
  count,
});
const result = (auctionId: bigint, matchId: bigint, letter: string, winner: bigint | undefined, paid: bigint, at: number): AuctionResultRow => ({
  auctionId,
  matchId,
  letter,
  winnerBotId: winner,
  paid,
  closedAt: ts(at),
});
const play = (id: bigint, matchId: bigint, botId: bigint, word: string, reward: bigint, at: number): WordPlayRow => ({
  id,
  matchId,
  botId,
  word,
  totalReward: reward,
  playedAt: ts(at),
});

const sims = new Set([1n, 3n]);
const isSim = (b: bigint) => sims.has(b);

test("view: seats in server order with isSim, balance and score", () => {
  const v = buildMatchView(
    {
      match: match(),
      participants: [
        seat(12n, 7n, 3n, 90n, 4n),
        seat(10n, 7n, 42n, 95n, 0n),
        seat(11n, 7n, 1n, 100n, 0n),
        seat(99n, 8n, 42n, 100n, 0n), // another match: ignored
      ],
      rack: [],
      results: [],
      words: [],
      isSim,
    },
    42n,
    T0,
  );
  assert.deepEqual(v.participants, [
    { botId: 42, balance: 95, score: 0, isSim: false },
    { botId: 1, balance: 100, score: 0, isSim: true },
    { botId: 3, balance: 90, score: 4, isSim: true },
  ]);
  assert.equal(v.matchId, 7);
  assert.equal(v.myBotId, 42);
  assert.equal(v.round, 3);
  assert.equal(v.bagTotal, 65, "bag_total at auction open already excludes the letter on the block");
  assert.equal(v.startingRackSize, 5);
  assert.equal(v.auctionType, "Vickrey");
  assert.equal(v.nowMs, T0);
});

test("view: rack counts only this match and this bot", () => {
  const rack = [
    tile(1n, 7n, 42n, "E", 2),
    tile(2n, 7n, 42n, "Q", 1),
    tile(3n, 6n, 42n, "Z", 1), // leftover from an ended match
    tile(4n, 7n, 9n, "X", 1), // not ours (my_rack never has these, but be safe)
  ];
  const c = rackCounts(rack, 7n, 42n);
  assert.equal(c[idx("E")], 2);
  assert.equal(c[idx("Q")], 1);
  assert.equal(c[idx("Z")], 0);
  assert.equal(c[idx("X")], 0);
  assert.equal(rackString(c), "EEQ");
});

test("view: history merges results and words in server order", () => {
  const results = [
    result(502n, 7n, "B", 3n, 4n, T0 + 1000), // sim 3 wins B and plays in the same transaction
    result(501n, 7n, "A", undefined, 0n, T0), // nobody bid: discarded
    result(503n, 7n, "C", 42n, 1n, T0 + 2000),
    result(400n, 6n, "Z", 42n, 9n, T0 + 1500), // another match
  ];
  const words = [
    play(20n, 7n, 3n, "BAD", 6n, T0 + 1000), // same timestamp as auction 502's close
    play(21n, 7n, 42n, "CAB", 7n, T0 + 1700.5),
  ];
  const h = orderHistory(results, words, 7n);
  assert.deepEqual(h, [
    { kind: "auction", auctionId: 501, letter: "A", winnerBotId: null, paid: 0 },
    { kind: "auction", auctionId: 502, letter: "B", winnerBotId: 3, paid: 4 },
    { kind: "word", botId: 3, word: "BAD", reward: 6 },
    { kind: "word", botId: 42, word: "CAB", reward: 7 },
    { kind: "auction", auctionId: 503, letter: "C", winnerBotId: 42, paid: 1 },
  ]);
});

test("view: FirstPrice auction type and auction view from a row", () => {
  const v = buildMatchView(
    { match: match({ auctionType: { tag: "FirstPrice" } }), participants: [], rack: [], results: [], words: [], isSim },
    42n,
    T0,
  );
  assert.equal(v.auctionType, "FirstPrice");
  const a: AuctionRow = { id: 504n, matchId: 7n, letter: "Q", opensAt: ts(T0 + 0.25), closesAt: ts(T0 + 1000.25), status: { tag: "Open" } };
  assert.deepEqual(auctionViewOf(a), { auctionId: 504, letter: "Q", opensAtMs: T0 + 0.25, closesAtMs: T0 + 1000.25 });
});

test("standings: ties share the better place, as the server rates them", () => {
  const st = standings([
    { botId: 1, balance: 0, score: 50, isSim: true },
    { botId: 2, balance: 0, score: 70, isSim: false },
    { botId: 3, balance: 0, score: 50, isSim: false },
    { botId: 4, balance: 0, score: 10, isSim: false },
  ]);
  assert.deepEqual(
    st.map((s) => [s.botId, s.place]),
    [
      [2, 1],
      [1, 2],
      [3, 2],
      [4, 4],
    ],
  );
});
