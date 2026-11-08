import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BAG, countsOf, emptyCounts, idx } from "../core/rules.js";
import { mulberry32 as benchRand, randomRack } from "../core/words.bench.js";
import { getWordEngine } from "../core/words.js";
import { LetterTable, Partitioner, drawInto, mulberry32 } from "./value.js";

const engine = getWordEngine();

test("approximate partition: legal lower bound of the exact one, close to it", () => {
  const part = new Partitioner(engine, 12);
  const rand = benchRand(3);
  let approx = 0;
  let exact = 0;
  for (let i = 0; i < 300; i++) {
    const rack = randomRack(rand, 4 + (i % 12));
    const a = part.value(rack);
    const e = engine.bestPartition(rack, { timeBudgetMs: 200 }).total;
    const best = engine.best(rack)?.reward ?? 0;
    assert.ok(a <= e + 1e-9, `approx ${a} > exact ${e}`);
    assert.ok(a >= best, `approx ${a} < best word ${best}`);
    approx += a;
    exact += e;
  }
  assert.ok(approx / exact > 0.97, `approx/exact ${approx / exact}`);
});

test("drawInto never exceeds the pool and honours zero weights", () => {
  const rand = mulberry32(9);
  const pool = emptyCounts();
  pool[idx("E")] = 3;
  pool[idx("Q")] = 1;
  pool[idx("Z")] = 2;
  for (let n = 0; n < 200; n++) {
    const out = emptyCounts();
    drawInto(pool, 5, rand, out);
    for (let i = 0; i < 26; i++) assert.ok(out[i]! <= pool[i]!);
    assert.equal(out.reduce((a, b) => a + b, 0), 5);
    const w = new Float64Array(26).fill(1);
    w[idx("Z")] = 0;
    const out2 = emptyCounts();
    drawInto(pool, 6, rand, out2, w);
    assert.equal(out2[idx("Z")], 0);
    assert.equal(out2.reduce((a, b) => a + b, 0), 4);
  }
});

test("letter values: exact with no future tiles, deterministic with a seed", () => {
  const part = new Partitioner(engine, 12);
  const t = new LetterTable(countsOf("RETAIN"), part);
  t.add(DEFAULT_BAG.slice(), 0, 3, mulberry32(1), 1);
  // RETAIN (6 letters, 2.5x) = 15; any 7-letter anagram with S (3x) = 21.
  assert.equal(t.baseValue(), 15);
  assert.equal(t.letter(idx("S")).mean, 6);
  assert.equal(t.letter(idx("S")).se, 0);

  const mk = (seed: number) => {
    const x = new LetterTable(countsOf("QUAIL"), new Partitioner(engine, 12));
    x.add(DEFAULT_BAG.slice(), 4, 20, mulberry32(seed), 1);
    return Array.from(x.deltas());
  };
  assert.deepEqual(mk(5), mk(5));
  assert.notDeepEqual(mk(5), mk(6));
});

test("play values reuse the same futures (common random numbers)", () => {
  const part = new Partitioner(engine, 12);
  const t = new LetterTable(countsOf("STONEAX"), part);
  t.add(DEFAULT_BAG.slice(), 3, 12, mulberry32(4), 1);
  const hold = t.holdSamples();
  const after = t.afterPlay("STONE");
  assert.equal(after.length, hold.length);
  // Holding can still play STONE later, so on average it is not worse than
  // playing it now (the partition is approximate, so allow a little slack).
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(hold) >= mean(after) + engine.reward("STONE") - 1);
  assert.deepEqual(t.afterPlay("STONE"), after);
});

test("the play decision can weigh just the first samples (same ones on both sides)", () => {
  const rack = countsOf("RETAINS");
  const t = new LetterTable(rack, new Partitioner(engine, 12));
  const pool = countsOf("AEIOUBCDLMNPRST".repeat(3));
  t.add(pool, 4, 20, mulberry32(3), 1);
  const hold = t.holdSamples(5);
  const after = t.afterPlay("RETAINS", 5);
  assert.equal(hold.length, 5);
  assert.equal(after.length, 5);
  assert.deepEqual(t.afterPlay("RETAINS").slice(0, 5), after);
  assert.deepEqual(t.holdSamples().slice(0, 5), hold);
});
