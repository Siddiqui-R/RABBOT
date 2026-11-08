import assert from "node:assert/strict";
import { test } from "node:test";
import { styleOf, type SeatRow } from "./status.js";

const seat = (matchId: number, botId: number, o: Partial<SeatRow> = {}): SeatRow => ({
  matchId, botId, place: 1, score: 100, wonTiles: 10, paidTotal: 140, finalBalance: 20, words: 2, lettersPlayed: 12,
  endedUs: matchId * 1_000_000, ...o,
});

test("styleOf: per-match tiles, price, word length, 7+ words over the most recent matches", () => {
  const seats = [
    seat(1, 7, { wonTiles: 8, paidTotal: 80, words: 1, lettersPlayed: 7, place: 3 }),
    seat(2, 7, { wonTiles: 12, paidTotal: 180, words: 3, lettersPlayed: 15, place: 1 }),
    seat(3, 7, { wonTiles: 100, place: 6 }),
    seat(2, 9),
  ];
  const sevens = new Map([["1|7", 1], ["2|7", 2], ["3|7", 5]]);
  const all = styleOf(7, "x", seats, sevens, 10);
  assert.equal(all.matches, 3);
  assert.equal(all.tiles, (8 + 12 + 100) / 3);
  assert.equal(all.price, (80 + 180 + 140) / 120);
  assert.equal(all.wordLen, (7 + 15 + 12) / 6);
  assert.equal(all.sevenPlus, 8 / 3);
  const recent = styleOf(7, "x", seats, sevens, 2); // matches 3 and 2
  assert.equal(recent.matches, 2);
  assert.equal(recent.avgPlace, 3.5);
  assert.equal(recent.sevenPlus, 3.5);
  const none = styleOf(42, "y", seats, sevens);
  assert.equal(none.matches, 0);
  assert.equal(none.price, 0);
});

test("tournamentView: picks the open tournament, server standing order, RackForge's matches and final difference", async () => {
  const { tournamentView } = await import("./status.js");
  const tour = (id: number, status: string) => ({
    id, status, swissRoundsTotal: 3, currentRound: 2, topCut: 2, matchSize: 6, auctionType: "Vickrey", createdUs: id, endedUs: null, winnerBotId: null,
  });
  const entry = (tournamentId: number, botId: number, swissPoints: number, totalScore: number) => ({
    tournamentId, botId, swissPoints, eliminated: false, totalScore, finalFinishPosition: null,
  });
  const tours = [tour(1, "Ended"), tour(2, "Final")];
  const entries = [entry(2, 5, 9, 300), entry(2, 13, 9, 310), entry(2, 4, 9, 300), entry(2, 8, 2, 500), entry(1, 13, 0, 0)];
  const tms = [
    { tournamentId: 2, matchId: 50, round: 1, phase: "Swiss" },
    { tournamentId: 2, matchId: 60, round: 1, phase: "Final" },
    { tournamentId: 2, matchId: 61, round: 2, phase: "Final" },
    { tournamentId: 1, matchId: 10, round: 1, phase: "Swiss" },
  ];
  const parts = [
    { matchId: 50, botId: 13, score: 90 }, { matchId: 50, botId: 5, score: 95 }, { matchId: 50, botId: 4, score: 90 },
    { matchId: 60, botId: 13, score: 100 }, { matchId: 60, botId: 5, score: 80 },
    { matchId: 61, botId: 13, score: 70 }, { matchId: 61, botId: 5, score: 75 },
  ];
  const v = tournamentView(tours, entries, tms, parts, new Set([50, 60]), 13, new Map([[13, "RackForge"]]))!;
  assert.equal(v.tournament.id, 2);
  assert.equal(v.active, true);
  assert.deepEqual(v.standings.map((e) => e.botId), [13, 4, 5, 8]); // points, then total, then lower id
  assert.equal(v.me?.rank, 1);
  assert.equal(v.myMatches.length, 3);
  assert.equal(v.myMatches[0]!.place, 2); // one bot strictly ahead; the tie does not count
  assert.equal(v.myMatches[2]!.ended, false);
  assert.equal(v.finalDiff, 20 - 5);
  assert.equal(v.finalGames, 2);
  const unreg = tournamentView([tour(3, "Registration")], [], [], [], new Set(), 13, new Map())!;
  assert.equal(unreg.registered, false);
  assert.equal(tournamentView([], [], [], [], new Set(), 13, new Map()), undefined);
});
