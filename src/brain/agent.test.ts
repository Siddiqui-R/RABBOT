import assert from "node:assert/strict";
import { test } from "node:test";
import { canSpell, countsOf, emptyCounts, totalTiles } from "../core/rules.js";
import type { AuctionView, MatchView } from "../core/types.js";
import { getWordEngine } from "../core/words.js";
import { runMatch, type MatchSeat } from "../sim/engine.js";
import { createAgent, RABBOTAgent, resolveParams } from "./index.js";
import { envOverrides } from "./params.js";

const engine = getWordEngine();

function seats(agent: () => ReturnType<typeof createAgent>): MatchSeat[] {
  return [
    { botId: 1_000_000, isSim: false, agent: agent() },
    { botId: 1, isSim: true, strategy: "Cheapskate" },
    { botId: 2, isSim: true, strategy: "ValueBidder" },
    { botId: 3, isSim: true, strategy: "Aggressive" },
    { botId: 1_000_001, isSim: false, agent: agent() },
    { botId: 5, isSim: true, strategy: "Aggressive" },
  ];
}

test("sim mode is deterministic and every move is legal", () => {
  const play = (seed: number) =>
    runMatch({ seats: seats(() => createAgent({ mode: "sim", seed })), seed, strict: true });
  for (const seed of [1, 2]) {
    const a = play(seed);
    const b = play(seed);
    assert.deepEqual(
      a.seats.map((s) => [s.score, s.balance, s.tilesLeft]),
      b.seats.map((s) => [s.score, s.balance, s.tilesLeft]),
    );
    for (const s of a.seats.filter((x) => !x.isSim)) {
      assert.equal(s.bidRejections, 0);
      assert.equal(s.wordRejections, 0);
      assert.equal(s.agentErrors, 0);
    }
  }
});

function lastView(rack: string, withSim: boolean): MatchView {
  return {
    matchId: 3,
    myBotId: 10,
    auctionType: "Vickrey",
    round: 68,
    bagTotal: 0,
    startingRackSize: 5,
    participants: [
      { botId: 10, balance: 42, score: 50, isSim: false },
      { botId: 11, balance: 30, score: 60, isSim: false },
      { botId: withSim ? 3 : 12, balance: 20, score: 40, isSim: withSim },
    ],
    myRack: countsOf(rack),
    history: [],
    nowMs: 0,
  };
}

test("last auction: no bid unless a sim could still play the tile; dump everything", () => {
  const a = createAgent({ mode: "sim", seed: 1 });
  const auction: AuctionView = { auctionId: 99, letter: "E", opensAtMs: 0, closesAtMs: 1000 };
  assert.equal(a.quickBid(lastView("RETAINSQ", false), auction), 0);
  assert.equal(a.quickBid(lastView("RETAINSQ", true), auction), 42);
  const words = a.chooseWords(lastView("RETAINSDOG", false));
  const exact = engine.bestPartition(countsOf("RETAINSDOG"), { timeBudgetMs: 250 });
  assert.deepEqual(words, exact.words);
  const left = countsOf("RETAINSDOG");
  for (const w of words) {
    assert.ok(canSpell(w, left) && engine.isWord(w));
    for (let i = 0; i < w.length; i++) left[w.charCodeAt(i) - 65]!--;
  }
});

test("bids are whole numbers within the balance; words are spellable", () => {
  const agent = createAgent({ mode: "sim", seed: 4 }) as RABBOTAgent;
  const view: MatchView = {
    matchId: 5,
    myBotId: 10,
    auctionType: "Vickrey",
    round: 10,
    bagTotal: 50,
    startingRackSize: 5,
    participants: [
      { botId: 10, balance: 23, score: 12, isSim: false },
      { botId: 1, balance: 80, score: 0, isSim: true },
      { botId: 22, balance: 64, score: 30, isSim: false },
    ],
    myRack: countsOf("SATIREN"),
    history: [],
    nowMs: 0,
  };
  for (const letter of "AEQZSXK") {
    const auction: AuctionView = { auctionId: letter.charCodeAt(0), letter, opensAtMs: 0, closesAtMs: 1000 };
    const q = agent.quickBid(view, auction);
    assert.ok(Number.isInteger(q) && q >= 0 && q <= 23, `quick ${q}`);
    const r = agent.refineBid(view, auction, 50);
    if (r !== null) assert.ok(Number.isInteger(r) && r >= 0 && r <= 23, `refine ${r}`);
  }
  const words = agent.chooseWords(view);
  const left = view.myRack.slice();
  for (const w of words) {
    assert.ok(canSpell(w, left) && engine.isWord(w), w);
    for (let i = 0; i < w.length; i++) left[w.charCodeAt(i) - 65]!--;
  }
  assert.deepEqual(createAgent({ mode: "sim" }).chooseWords({ ...view, myRack: emptyCounts() }), []);
  assert.ok(totalTiles(left) >= 0);
});

test("live refine respects its time budget", () => {
  const agent = createAgent({ mode: "live", seed: 4 });
  const view: MatchView = {
    matchId: 6,
    myBotId: 10,
    auctionType: "Vickrey",
    round: 20,
    bagTotal: 40,
    startingRackSize: 5,
    participants: [
      { botId: 10, balance: 60, score: 12, isSim: false },
      { botId: 22, balance: 64, score: 30, isSim: false },
      { botId: 59, balance: 70, score: 20, isSim: false },
    ],
    myRack: countsOf("SATIRENQU"),
    history: [],
    nowMs: 0,
  };
  for (const [i, budget] of [40, 120].entries()) {
    const auction: AuctionView = { auctionId: 500 + i, letter: "E", opensAtMs: 0, closesAtMs: 1000 };
    agent.quickBid(view, auction);
    const t0 = performance.now();
    agent.refineBid!(view, auction, budget);
    const took = performance.now() - t0;
    assert.ok(took < budget + 30, `refine took ${took.toFixed(1)} ms of ${budget}`);
  }
});

test("params: defaults, file and overrides merge; junk is dropped", () => {
  const p = resolveParams({ coinBonus: 0.123, nonsense: 5, kMax: "7" });
  assert.equal(p.coinBonus, 0.123);
  assert.equal((p as unknown as Record<string, unknown>).nonsense, undefined);
  assert.equal(typeof p.kMax, "number");
});

test("liveCompute only changes live mode; sim replays exactly as without it", () => {
  const play = (params: Record<string, unknown>) =>
    runMatch({ seats: seats(() => createAgent({ mode: "sim", seed: 7, params })), seed: 7, strict: true }).seats.map((s) => [
      s.score,
      s.balance,
      s.tilesLeft,
    ]);
  assert.deepEqual(play({ liveCompute: 16 }), play({}));
});

test("RABBOT_PARAMS overrides the file and bad JSON is ignored", () => {
  assert.deepEqual(envOverrides('{"liveCompute":4,"bogus":1}'), { liveCompute: 4 });
  assert.deepEqual(envOverrides("{not json"), {});
  assert.deepEqual(envOverrides(undefined), {});
});
