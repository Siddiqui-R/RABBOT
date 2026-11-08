import { test } from "node:test";
import assert from "node:assert/strict";
import { countsOf } from "../core/rules.js";
import { getWordEngine } from "../core/words.js";
import { lossOf } from "./calibrate.js";
import { newAcc, addTo, rankEntrants, sampleField, summarize, type FieldFile } from "./calibrate-targets.js";
import { S, STAT_KEYS } from "./calibrate-sim.js";
import { DEFAULT_PARAMS, choosePlaysParam, cloneParamsFor, type ClonesFile } from "./clones.js";
import { rng32 } from "./util.js";

test("summaries are ratios of sums and the loss is zero on a perfect match", () => {
  const a = newAcc();
  const v = new Array<number>(STAT_KEYS.length).fill(0);
  v[S.score] = 80;
  v[S.tiles] = 10;
  v[S.paid] = 130;
  v[S.words] = 2;
  v[S.letters] = 12;
  addTo(a, v);
  addTo(a, v.map((x) => x * 0));
  const s = summarize(a);
  assert.equal(s.score, 40);
  assert.equal(s.price, 13);
  assert.equal(s.wordLen, 6);
  assert.equal(lossOf(s, s), 0);
  assert.ok(lossOf(s, { ...s, score: s.score + 6 }) > 0.99);
});

test("field sampling follows the weights", () => {
  const f: FieldFile = {
    note: "",
    generatedAt: "",
    dataUntil: "",
    windowHours: 24,
    halfLifeHours: 6,
    activeHours: 6,
    bots: {},
    tables: [
      { bots: [1, 2], weight: 0.9 },
      { bots: [3, 4], weight: 0.1 },
    ],
  };
  const t = sampleField(f, 5000, rng32(3));
  const first = t.filter((x) => x[0] === 1).length / t.length;
  assert.ok(Math.abs(first - 0.9) < 0.03, `share ${first}`);
});

test("clone params: per-bot, then generic, then defaults", () => {
  const f: ClonesFile = {
    generic: { ...DEFAULT_PARAMS, holdLen: 8 },
    bots: { "7": { name: "x", params: { ...DEFAULT_PARAMS, minLen: 5 } } },
  };
  assert.equal(cloneParamsFor(7, f).minLen, 5);
  assert.equal(cloneParamsFor(8, f).holdLen, 8);
  assert.equal(cloneParamsFor(8, null).holdLen, DEFAULT_PARAMS.holdLen);
});

test("clone play rule holds for length, dumps at the end", () => {
  const words = getWordEngine();
  const p = { ...DEFAULT_PARAMS, minLen: 3, holdLen: 7, holdRack: 0, holdLate: 0 };
  // Mid-match, RETAINS is a seven: cash it in.
  assert.equal(choosePlaysParam(words, countsOf("RETAINS"), p, 3, 2, 40, 0.5)[0]?.length, 7);
  // CATSX has no seven: hold.
  assert.deepEqual(choosePlaysParam(words, countsOf("CATSX"), p, 3, 2, 40, 0.5), []);
  // Bag nearly empty: dump.
  assert.ok(choosePlaysParam(words, countsOf("CATSX"), p, 3, 2, 1, 0.99).length > 0);
});

test("entrants rank by share of real opponents outscored; sims, stale and small samples excluded", () => {
  const H = 3600e6;
  const rows: Parameters<typeof rankEntrants>[0][number][] = [];
  for (let m = 0; m < 40; m++) {
    // 1 beats everyone real, 2 beats 3, 3 beats only the sim (who does not count).
    rows.push(
      { matchId: m, botId: 1, isSim: false, score: 100, place: 1, ended: 10 * H },
      { matchId: m, botId: 2, isSim: false, score: 80, place: 2, ended: 10 * H },
      { matchId: m, botId: 3, isSim: false, score: 60, place: 3, ended: 10 * H },
      { matchId: m, botId: 99, isSim: true, score: 10, place: 4, ended: 10 * H },
    );
  }
  rows.push({ matchId: 100, botId: 4, isSim: false, score: 200, place: 1, ended: 10 * H }, { matchId: 100, botId: 3, isSim: false, score: 1, place: 2, ended: 10 * H });
  const r = rankEntrants(rows, 10 * H, { halfLifeHours: 12, activeHours: 6, minSeats: 30, top: 16, exclude: new Set([2]) });
  assert.deepEqual(r.map((e) => e.id), [1, 3]);
  assert.equal(r[0]!.beatShare, 1);
  assert.ok(Math.abs(r[1]!.beatShare - 0) < 0.03);
  const stale = rankEntrants(rows, 20 * H, { halfLifeHours: 12, activeHours: 6, minSeats: 30, top: 16 });
  assert.equal(stale.length, 0);
});
