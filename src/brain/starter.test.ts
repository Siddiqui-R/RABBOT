// The starter is the baseline: switching its word search to the engine must
// not change a single decision. Pin it to the original dictionary scan.

import assert from "node:assert/strict";
import { test } from "node:test";
import { StarterAgent, legacyChooseWords } from "../agents/starter.js";
import { countsOf, emptyCounts } from "../core/rules.js";
import type { MatchView } from "../core/types.js";
import { mulberry32, randomRack } from "../core/words.bench.js";

function view(rack: number[]): MatchView {
  return {
    matchId: 1,
    myBotId: 1,
    auctionType: "Vickrey",
    round: 1,
    bagTotal: 60,
    startingRackSize: 5,
    participants: [{ botId: 1, balance: 100, score: 0, isSim: false }],
    myRack: rack,
    history: [],
    nowMs: 0,
  };
}

test("StarterAgent.chooseWords equals the original longest-first scan", () => {
  const fast = new StarterAgent();
  const rand = mulberry32(2024);
  const racks = [emptyCounts(), countsOf("Q"), countsOf("QI"), countsOf("ZZZ"), countsOf("RETAINS"), countsOf("AEIOU")];
  for (let i = 0; i < 160; i++) racks.push(randomRack(rand, i % 17));
  for (const r of racks) assert.deepEqual(fast.chooseWords(view(r)), legacyChooseWords(view(r)));
});
