import { test } from "node:test";
import assert from "node:assert/strict";
import { countsOf, wordReward } from "../core/rules.js";
import { RankAllocator, bestWord, choosePlays, policyFromHabits, type PlayPolicy } from "./clones.js";
import { rng32 } from "./util.js";

test("bestWord finds the longest playable word, then the best paying", () => {
  const w = bestWord(countsOf("RETAINS"))!;
  assert.equal(w.length, 7);
  assert.equal(bestWord(countsOf("QZ")), undefined);
  const w3 = bestWord(countsOf("CATX"), 2)!;
  assert.ok(w3.length >= 3);
  // Among equal lengths it prefers the higher reward.
  const two = bestWord(countsOf("AXE"), 3)!;
  assert.ok(wordReward(two) >= wordReward("AXE") || two.length > 3);
});

test("play policy holds for long words, clears small racks, flushes at the end", () => {
  const p: PlayPolicy = { target: 7, slack: 0, midLen: 4, rackCap: 12, flushAuctions: 4, silent: false };
  // Seven tiles that spell a seven: play it.
  assert.equal(choosePlays(countsOf("RETAINS"), p, 40)[0]?.length, 7);
  // Eight tiles with no seven but a three: hold (mid-match).
  assert.deepEqual(choosePlays(countsOf("QZXJCATV"), p, 40), []);
  // ...but flush once the bag is nearly empty.
  assert.ok(choosePlays(countsOf("QZXJCATV"), p, 2).length > 0);
  // A four-letter word that clears a four-tile rack is fine with slack 0.
  assert.equal(choosePlays(countsOf("CATS"), p, 40)[0]?.length, 4);
  assert.deepEqual(choosePlays(countsOf("CATS"), { ...p, slack: -1 }, 40), []);
  // A silent bot never plays.
  assert.deepEqual(choosePlays(countsOf("RETAINS"), { ...p, silent: true }, 0), []);
});

test("policy read from habits", () => {
  const plays = [
    ...Array.from({ length: 300 }, () => ({ len: 7, rack: 9, phase: 0.5 })),
    ...Array.from({ length: 30 }, () => ({ len: 2, rack: 2, phase: 0.95 })),
  ];
  const pol = policyFromHabits({
    lengthDist: [],
    rackBeforePlay: plays.map((p) => p.rack).sort((a, b) => a - b),
    wordsPerMatch: 3.6,
    tilesLeftAtEnd: 0.5,
    playPhases: plays.map((p) => p.phase).sort(),
    plays,
    matches: 100,
  });
  assert.equal(pol.target, 7);
  assert.equal(pol.slack, -1); // never seen clearing a small rack mid-match
  assert.equal(pol.flushAuctions, 0); // 0.3 late plays per match is not a habit
});

test("rank allocation keeps the bid quantiles uniform overall", () => {
  const r = new RankAllocator(1);
  const rng = rng32(5);
  const bins = new Array(10).fill(0);
  let usefulHigh = 0;
  let useful = 0;
  for (let i = 0; i < 50_000; i++) {
    const isUseful = rng() < 0.3;
    const q = r.quantile(rng(), isUseful);
    bins[Math.min(9, Math.floor(q * 10))]++;
    if (isUseful) {
      useful++;
      if (q >= 0.7) usefulHigh++;
    }
  }
  for (const b of bins) assert.ok(Math.abs(b / 50_000 - 0.1) < 0.01, `bins ${bins}`);
  assert.ok(usefulHigh / useful > 0.95);
});
