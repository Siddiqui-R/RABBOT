// Tournament integration in the agent: stageAware (stage objectives when
// view.tournament is set) and lambdaScaleBig (big tables). Neither may change
// a ladder match: 6 seats and no view.tournament.

import assert from "node:assert/strict";
import { test } from "node:test";
import { countsOf } from "../core/rules.js";
import type { AuctionView, MatchView, TournamentView } from "../core/types.js";
import { runMatch, type MatchSeat } from "../sim/engine.js";
import { createAgent, RackForgeAgent } from "./index.js";

function table(params: Record<string, unknown>, seed: number): MatchSeat[] {
  const mk = () => createAgent({ mode: "sim", seed, params });
  return [
    { botId: 1_000_000, isSim: false, agent: mk() },
    { botId: 1, isSim: true, strategy: "Cheapskate" },
    { botId: 2, isSim: true, strategy: "ValueBidder" },
    { botId: 1_000_001, isSim: false, agent: mk() },
    { botId: 3, isSim: true, strategy: "Aggressive" },
    { botId: 5, isSim: true, strategy: "Aggressive" },
  ];
}

const tour = (ids: number[], phase: TournamentView["phase"]): TournamentView => ({
  phase,
  round: 1,
  matchSize: 6,
  topCut: 4,
  swissRoundsTotal: 3,
  standings: ids.map((botId) => ({ botId, swissPoints: 0, totalScore: 0, eliminated: false })),
});

const outcome = (o: ReturnType<typeof runMatch>) => o.seats.map((s) => [s.score, s.balance, s.tilesLeft]);

test("ladder match (6 seats, no view.tournament): stageAware and lambdaScaleBig change nothing", () => {
  const seed = 7;
  const base = runMatch({ seats: table({}, seed), seed, strict: true });
  const flags = runMatch({ seats: table({ stageAware: 1, lambdaScaleBig: 0.8 }, seed), seed, strict: true });
  assert.deepEqual(outcome(flags), outcome(base));
});

test("tournament stages with stageAware: every move legal, no errors", () => {
  for (const phase of ["Swiss", "Bracket"] as const) {
    const seed = 11;
    const seats = table({ stageAware: 1 }, seed);
    const out = runMatch({ seats, seed, strict: true, tournament: tour(seats.map((s) => s.botId), phase) });
    for (const s of out.seats.filter((x) => !x.isSim)) {
      assert.equal(s.bidRejections, 0);
      assert.equal(s.wordRejections, 0);
      assert.equal(s.agentErrors, 0);
    }
  }
});

function bigView(seats: number): MatchView {
  const participants = Array.from({ length: seats }, (_, i) => ({ botId: 100 + i, balance: 100, score: 0, isSim: false }));
  return {
    matchId: 9,
    myBotId: 100,
    auctionType: "Vickrey",
    round: 3,
    bagTotal: 40,
    startingRackSize: 5,
    participants,
    myRack: countsOf("RSTEA"),
    history: [],
    nowMs: 0,
  };
}

const auction: AuctionView = { auctionId: 3, letter: "E", opensAtMs: 0, closesAtMs: 1000 };

function lambdaAt(seats: number, params: Record<string, unknown>): number {
  const a = createAgent({ mode: "sim", seed: 3, params: { useModel: false, ...params } }) as RackForgeAgent;
  a.quickBid(bigView(seats), auction);
  return a.lastTrace!.lambda;
}

test("lambdaScaleBig replaces lambdaScale from bigTableSeats seats up, and only there", () => {
  const big = { lambdaScale: 1, lambdaScaleBig: 0.5, bigTableSeats: 9 };
  // 8 seats: below the gate, identical to lambdaScaleBig off.
  assert.equal(lambdaAt(8, big), lambdaAt(8, { lambdaScale: 1, lambdaScaleBig: 0 }));
  // 9 seats: half the lambda (unless clamped at lambdaMin).
  const off = lambdaAt(9, { lambdaScale: 1, lambdaScaleBig: 0 });
  const on = lambdaAt(9, big);
  assert.ok(on < off, `lambda ${on} should be below ${off}`);
});
