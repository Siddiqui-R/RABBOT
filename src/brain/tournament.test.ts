import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PARAMS } from "./params.js";
import { placeView, type Standing } from "./place.js";
import {
  bracketView,
  finalSeries,
  finalView,
  normCdf,
  stageView,
  stageWeights,
  swissView,
  tournamentContext,
  type TournamentRows,
} from "./tournament.js";

const P = { ...DEFAULT_PARAMS };
const s = (botId: number, score: number): Standing => ({ botId, score, balance: 20, rackSize: 3 });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function rows(): TournamentRows {
  return {
    tournaments: [{ id: 7n, status: { tag: "Final" }, swissRoundsTotal: 3, currentRound: 0, topCut: 4, matchSize: 6 }],
    entries: [
      { tournamentId: 7n, botId: 13n, swissPoints: 14, eliminated: false, totalScore: 900n },
      { tournamentId: 7n, botId: 22n, swissPoints: 15, eliminated: false, totalScore: 950n },
      { tournamentId: 7n, botId: 59n, swissPoints: 12, eliminated: true, totalScore: 800n },
      { tournamentId: 8n, botId: 99n, swissPoints: 30, eliminated: false, totalScore: 1n },
    ],
    matches: [
      { tournamentId: 7n, matchId: 100n, round: 1, phase: { tag: "Swiss" } },
      { tournamentId: 7n, matchId: 200n, round: 1, phase: { tag: "Final" } },
      { tournamentId: 7n, matchId: 201n, round: 2, phase: { tag: "Final" } },
      { tournamentId: 7n, matchId: 202n, round: 3, phase: { tag: "Final" } },
    ],
    participants: [
      { matchId: 200n, botId: 13n, score: 300n },
      { matchId: 200n, botId: 22n, score: 250n },
      { matchId: 201n, botId: 13n, score: 280n },
      { matchId: 201n, botId: 22n, score: 310n },
      { matchId: 202n, botId: 13n, score: 40n },
      { matchId: 202n, botId: 22n, score: 60n },
    ],
  };
}

test("normCdf matches known values", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normCdf(-1) - 0.158655) < 1e-5);
});

test("context builder: ladder match gives undefined, standings are sorted and scoped", () => {
  assert.equal(tournamentContext(555n, 13n, rows()), undefined);
  const v = tournamentContext(100n, 13n, rows())!;
  assert.equal(v.phase, "Swiss");
  assert.equal(v.matchSize, 6);
  assert.deepEqual(v.standings.map((x) => x.botId), [22, 13, 59]);
  assert.equal(v.standings[0]!.totalScore, 950);
  assert.equal(v.finalTotals, undefined);
});

test("context builder: final totals sum only the earlier final games", () => {
  const v = tournamentContext(202n, 13n, rows())!;
  assert.equal(v.phase, "Final");
  assert.equal(v.round, 3);
  const t = new Map(v.finalTotals!.map((x) => [x.botId, x.total]));
  assert.equal(t.get(13), 580);
  assert.equal(t.get(22), 560);
  assert.deepEqual(finalSeries(v, 13), { lead: 20, gamesAfter: 0 });
  const g2 = tournamentContext(201n, 22n, rows())!;
  assert.deepEqual(finalSeries(g2, 22), { lead: -50, gamesAfter: 1 });
});

test("no tournament: stageView is placeView", () => {
  const me = s(1, 60);
  const rivals = [s(2, 62), s(3, 120)];
  assert.deepEqual(stageView({ myBotId: 1 }, me, rivals, 0.4, 0.5, P), placeView(me, rivals, 0.4, 0.5, P));
});

test("Swiss: rivals matter like place, but a decided oversized table stops paying", () => {
  const me = s(1, 60);
  const rivals = [s(2, 62), s(3, 120), s(4, 10)];
  const v = swissView(me, rivals, 0.4, 0.3, 4, P);
  assert.ok(sum(v.weights) <= 1 + 1e-9 && sum(v.weights) > 0.9, `sum ${sum(v.weights)}`);
  assert.ok(v.weights[0]! > v.weights[1]! && v.weights[0]! > v.weights[2]!);
  // 4 rivals far ahead at size 3: I'm 5th of 5, beating the near one can't earn a point.
  const lost = swissView(s(1, 50), [s(2, 300), s(3, 310), s(4, 320), s(5, 55)], 0.4, 0.05, 3, P);
  assert.ok(lost.weights[3]! < 0.05, `near rival behind a lost table: ${lost.weights[3]}`);
  const open = swissView(s(1, 50), [s(2, 300), s(3, 310), s(4, 320), s(5, 55)], 0.4, 0.05, 6, P);
  assert.ok(open.weights[3]! > 0.9, `same table at size 6: ${open.weights[3]}`);
});

test("Bracket: the rival I might finish under matters; safe = play safe, at risk = gamble", () => {
  const safe = bracketView(s(1, 200), [s(2, 210), s(3, 120), s(4, 60)], 0.4, 0.3, P);
  assert.ok(safe.tilt < 0, `safe tilt ${safe.tilt}`);
  assert.ok(sum(safe.weights) < 0.05, `safe: rivals fade out, ${safe.weights}`);
  const risk = bracketView(s(1, 60), [s(2, 210), s(3, 120), s(4, 80)], 0.4, 0.3, P);
  assert.ok(risk.tilt > 0, `at-risk tilt ${risk.tilt}`);
  // The bottom rival (80) is the one that decides who's last.
  assert.ok(risk.weights[2]! > risk.weights[0]! && risk.weights[2]! > risk.weights[1]!);
  for (const w of [...safe.weights, ...risk.weights]) assert.ok(Number.isFinite(w) && w >= 0);
});

test("Final: zero-sum weight 1; protect a lead, chase a deficit, sigma covers the games to come", () => {
  const me = s(1, 100);
  const opp = [s(2, 100)];
  const lead = finalView(me, opp, 0.4, 0.5, 150, 1, P);
  const behind = finalView(me, opp, 0.4, 0.5, -150, 1, P);
  assert.deepEqual(lead.weights, [1]);
  assert.ok(lead.tilt < 0 && behind.tilt > 0);
  const early = finalView(me, opp, 0.4, 1, 0, 2, P);
  const last = finalView(me, opp, 0.4, 1, 0, 0, P);
  assert.ok(early.sigma > last.sigma);
});

test("stageWeights reads the view: Final with a deficit from earlier games tilts to risk", () => {
  const view = {
    myBotId: 13,
    participants: [
      { botId: 13, balance: 50, score: 100, isSim: false },
      { botId: 22, balance: 50, score: 100, isSim: false },
    ],
    tournament: tournamentContext(201n, 13n, rows())!,
  };
  // Game 2: bot 13 won game 1 by 300-250.
  const w = stageWeights(view, 0.4, 0.5, P);
  assert.deepEqual(w.rivalIds, [22]);
  assert.deepEqual(w.rivalWeights, [1]);
  assert.ok(w.tilt < 0, `leading by 50 after game 1: ${w.tilt}`);
  const swiss = stageWeights({ ...view, tournament: tournamentContext(100n, 13n, rows())! }, 0.4, 0.5, P);
  assert.equal(swiss.rivalWeights.length, 1);
});
