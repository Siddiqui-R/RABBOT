// The word engine against independent oracles: brute force over the whole
// word list, and literal ports of the server's dictionary functions.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { mulberry32, randomRack } from "./words.bench.js";
import { canSpell, countsOf, emptyCounts, totalTiles, wordReward, type Counts } from "./rules.js";
import { WORDLIST_PATH, getWordEngine, type WordHit } from "./words.js";

const engine = getWordEngine();
const text = fs.readFileSync(WORDLIST_PATH, "utf8");

// --- Literal ports of spacetimedb/src/{dictionary,text}.ts ------------------

const SERVER_LEX = text.split("\n").filter((l) => l.length > 0);
const SERVER_BY_LENGTH = [...SERVER_LEX].sort(
  (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
);
const encoder = new TextEncoder();

function serverIsValidWord(word: string): boolean {
  const target = word.replace(/[a-z]/g, (c) => c.toUpperCase());
  if (encoder.encode(target).length < 2) return false;
  if (!/^[A-Z]*$/.test(target)) return false;
  let lo = 0;
  let hi = SERVER_LEX.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const w = SERVER_LEX[mid]!;
    if (w < target) lo = mid + 1;
    else if (w === target) return true;
    else hi = mid;
  }
  return false;
}

function serverFindBestPlayable(rack: Map<string, number>, minLen: number): string | undefined {
  const A = "A".charCodeAt(0);
  const U32_MAX = 0xffffffff;
  const rackCounts = new Array<number>(26).fill(0);
  let total = 0;
  for (const [c, n] of rack) {
    if (/^[A-Z]$/.test(c)) {
      const slot = c.charCodeAt(0) - A;
      rackCounts[slot] = Math.min(rackCounts[slot]! + n, U32_MAX);
      total = Math.min(total + n, U32_MAX);
    }
  }
  if (total < minLen) return undefined;
  const need = new Array<number>(26);
  for (const word of SERVER_BY_LENGTH) {
    if (word.length < minLen) break;
    if (word.length > total) continue;
    need.fill(0);
    let ok = true;
    for (let i = 0; i < word.length; i++) {
      const slot = word.charCodeAt(i) - A;
      if (slot < 0 || slot >= 26) {
        ok = false;
        break;
      }
      need[slot]!++;
    }
    if (!ok) continue;
    if (need.every((n, i) => n <= rackCounts[i]!)) return word;
  }
  return undefined;
}

// --- Brute force over every word ------------------------------------------

const ALL = SERVER_LEX.filter((w) => /^[A-Z]{2,}$/.test(w));
const ALL_COUNTS = ALL.map(countsOf);

function brutePlayable(rack: Counts, minLen = 2, maxLen = Infinity): WordHit[] {
  const out: WordHit[] = [];
  for (let i = 0; i < ALL.length; i++) {
    const w = ALL[i]!;
    if (w.length < minLen || w.length > maxLen) continue;
    const need = ALL_COUNTS[i]!;
    let ok = true;
    for (let l = 0; l < 26 && ok; l++) if (need[l]! > (rack[l] ?? 0)) ok = false;
    if (ok) out.push({ word: w, reward: wordReward(w) });
  }
  return out.sort(
    (a, b) =>
      b.reward - a.reward ||
      b.word.length - a.word.length ||
      (a.word < b.word ? -1 : a.word > b.word ? 1 : 0),
  );
}

function rackMap(rack: Counts): Map<string, number> {
  const m = new Map<string, number>();
  rack.forEach((n, l) => {
    if (n > 0) m.set(String.fromCharCode(65 + l), n);
  });
  return m;
}

function rackString(rack: Counts): string {
  return rack.map((n, l) => String.fromCharCode(65 + l).repeat(n)).join("");
}

/** Exhaustive best partition: [max total, fewest tiles at that total]. */
function brutePartition(rack: Counts, maxWords = Infinity, minLen = 2): [number, number] {
  const seen = new Set<string>();
  const cands: { counts: Counts; reward: number; len: number }[] = [];
  for (const h of brutePlayable(rack, minLen)) {
    const sig = [...h.word].sort().join("");
    if (seen.has(sig)) continue;
    seen.add(sig);
    cands.push({ counts: countsOf(h.word), reward: h.reward, len: h.word.length });
  }
  const r = [...rack];
  let best: [number, number] = [0, 0];
  const rec = (start: number, total: number, used: number, words: number): void => {
    if (total > best[0] || (total === best[0] && used < best[1])) best = [total, used];
    if (words >= maxWords) return;
    for (let i = start; i < cands.length; i++) {
      const c = cands[i]!;
      let ok = true;
      for (let l = 0; l < 26 && ok; l++) if (c.counts[l]! > r[l]!) ok = false;
      if (!ok) continue;
      for (let l = 0; l < 26; l++) r[l]! -= c.counts[l]!;
      rec(i, total + c.reward, used + c.len, words + 1);
      for (let l = 0; l < 26; l++) r[l]! += c.counts[l]!;
    }
  };
  rec(0, 0, 0, 0);
  return best;
}

// --- Tests -------------------------------------------------------------------

test("loads the server's exact word list", () => {
  const s = engine.stats;
  assert.equal(s.lines, 172820);
  assert.equal(s.words, 172820, "every line is an A-Z word of 2+ letters");
  assert.equal(s.nonAZ, 0);
  assert.equal(s.sorted, true, "the server binary-searches the raw list");
  assert.ok(s.loadMs < 1500, `engine build took ${s.loadMs.toFixed(0)} ms`);
});

test("reward math matches the server", () => {
  assert.equal(wordReward("RETAINS"), 21); // 7 x 3
  assert.equal(wordReward("QI"), 11); // 10 + 1, x1 (QI is not in this list though)
  assert.equal(wordReward("QUIZ"), 33); // 22 x 1.5
  assert.equal(wordReward("JAKE"), 22); // 15 x 1.5 = 22.5, floored
  assert.equal(wordReward("JOKERS"), 42); // 17 x 2.5 = 42.5, floored
  assert.equal(wordReward("ZAX"), 19);
  assert.equal(engine.reward("QUIZZES"), 3 * 34);
  assert.deepEqual(engine.best(countsOf("RETAINS")), { word: "ANESTRI", reward: 21 });
  assert.deepEqual(engine.best(countsOf("QUIZ")), { word: "QUIZ", reward: 33 });
});

test("isWord matches the server's isValidWord", () => {
  const cases = [
    "AA", "aa", "Aa", "cat", "CAT", "QUIZ", "quiz", "RETAINS", "ZYZZYVAS",
    "QI", "ZA", "A", "a", "", " ", "CA T", "CAT ", " CAT", "CAT1", "CAFÉ", "café",
    "ß", "STRAßE", "ıT", "İT", "ﬁ", "CAT\n", "CAT\r", "\u0000AA", "AA\u0000", "XQZT",
    "AAH", "AAHED", "ZYZZYVA", "ZZZ",
  ];
  for (const w of cases) assert.equal(engine.isWord(w), serverIsValidWord(w), JSON.stringify(w));
  assert.equal(engine.isWord("QI"), false, "QI is not in this list");
  assert.equal(engine.isWord("cat"), true);
  assert.equal(engine.isWord("A"), false);
  assert.equal(engine.isWord("CAFÉ"), false);
  assert.equal(engine.isWord("ıT"), false, "only a-z are uppercased");
  for (const w of SERVER_LEX) if (!engine.isWord(w)) assert.fail(`rejects listed ${w}`);
  const rand = mulberry32(7);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdeéz 1";
  for (let i = 0; i < 20000; i++) {
    let w = "";
    const n = Math.floor(rand() * 6);
    for (let j = 0; j < n; j++) w += alphabet[Math.floor(rand() * alphabet.length)];
    if (rand() < 0.3) w = SERVER_LEX[Math.floor(rand() * SERVER_LEX.length)]!.toLowerCase() + w;
    assert.equal(engine.isWord(w), serverIsValidWord(w), JSON.stringify(w));
  }
});

test("best, topK, playable agree with brute force", () => {
  const rand = mulberry32(42);
  for (let i = 0; i < 400; i++) {
    const size = i < 20 ? i : 2 + Math.floor(rand() * 17);
    const rack = randomRack(rand, size);
    const minLen = rand() < 0.3 ? 2 + Math.floor(rand() * 5) : undefined;
    const maxLen = rand() < 0.2 ? 2 + Math.floor(rand() * 8) : undefined;
    const opts = { minLen, maxLen };
    const expect = brutePlayable(rack, minLen ?? 2, maxLen ?? Infinity);
    const label = `${rackString(rack)} ${JSON.stringify(opts)}`;
    assert.deepEqual(engine.playable(rack, opts), expect, label);
    assert.equal(engine.countPlayable(rack, opts), expect.length, label);
    assert.deepEqual(engine.best(rack, opts), expect[0] ?? null, label);
    assert.equal(engine.bestReward(rack, opts), expect[0]?.reward ?? 0, label);
    for (const k of [1, 3, 10, 50]) {
      assert.deepEqual(engine.topK(rack, k, opts), expect.slice(0, k), `${label} k=${k}`);
    }
  }
});

test("degenerate racks", () => {
  assert.equal(engine.best(emptyCounts()), null);
  assert.deepEqual(engine.playable(emptyCounts()), []);
  assert.deepEqual(engine.topK(countsOf("RETAINS"), 0), []);
  assert.deepEqual(engine.bestPartition(emptyCounts()), { words: [], total: 0, optimal: true });
  assert.equal(engine.best(countsOf("QQQ")), null);
  // Short arrays, negatives and NaN all count as no tiles.
  const odd = [1, NaN, -3] as Counts;
  assert.equal(engine.best(odd), null);
  // Absurd counts are clamped harmlessly: everything is playable.
  const huge = emptyCounts().fill(1000);
  assert.deepEqual(engine.best(huge), brutePlayable(huge)[0]);
  assert.equal(engine.countPlayable(huge), ALL.length);
});

test("serverBestPlayable is an exact replica of findBestPlayable", () => {
  const rand = mulberry32(2024);
  for (let i = 0; i < 3000; i++) {
    const size = 1 + Math.floor(rand() * 20);
    const rack = randomRack(rand, size);
    const minLen = [3, 3, 3, 2, 4, 5, 1, 0][i % 8]!;
    const expect = serverFindBestPlayable(rackMap(rack), minLen);
    assert.equal(engine.serverBestPlayable(rack, minLen), expect, `${rackString(rack)} min ${minLen}`);
    assert.equal(engine.serverBestPlayable(rackMap(rack), minLen), expect);
  }
  // Map quirks: only single A-Z keys count.
  const quirky = new Map<string, number>([["C", 1], ["A", 1], ["T", 1], ["a", 5], ["?", 5], ["SS", 2]]);
  assert.equal(engine.serverBestPlayable(quirky, 3), serverFindBestPlayable(quirky, 3));
  assert.equal(engine.serverBestPlayable(new Map(), 2), undefined);
  // Fractional and negative counts behave as they do on the server.
  for (const m of [
    new Map([["Q", 1], ["I", 1], ["A", 1.5], ["T", 1]]),
    new Map([["C", 1], ["A", 1], ["T", 1], ["S", -1]]),
    new Map([["E", 2.5], ["T", 1], ["A", 1]]),
    new Map([["C", 1], ["A", 1], ["T", 1], ["Z", NaN]]),
  ]) {
    for (const minLen of [0, 2, 2.5, 3, NaN]) {
      assert.equal(engine.serverBestPlayable(m, minLen), serverFindBestPlayable(m, minLen));
    }
  }
  assert.equal(engine.serverBestPlayable(countsOf("AA"), 3), undefined);
  assert.equal(engine.serverBestPlayable(countsOf("AA"), 2), "AA");
  // It is not max reward: longest wins even when a shorter word pays more.
  const rack = countsOf("QUIZEST");
  const srv = engine.serverBestPlayable(rack, 3)!;
  assert.ok(srv.length >= engine.best(rack)!.word.length);
});

test("bestPartition is optimal on small racks", () => {
  const rand = mulberry32(99);
  for (let i = 0; i < 150; i++) {
    const rack = randomRack(rand, 2 + Math.floor(rand() * 9));
    const maxWords = i % 5 === 0 ? 1 + (i % 3) : undefined;
    const minLen = i % 3 === 0 ? 3 : undefined;
    const p = engine.bestPartition(rack, { maxWords, minLen, timeBudgetMs: 10_000 });
    const [total, tiles] = brutePartition(rack, maxWords, minLen);
    const label = `${rackString(rack)} maxWords ${maxWords} minLen ${minLen}`;
    assert.equal(p.optimal, true, label);
    assert.equal(p.total, total, label);
    assert.equal(p.words.reduce((s, w) => s + w.length, 0), tiles, `${label}: fewest tiles`);
    if (maxWords !== undefined) assert.ok(p.words.length <= maxWords);
    if (minLen !== undefined) assert.ok(p.words.every((w) => w.length >= minLen));
  }
});

test("bestPartition plays legal disjoint words on big racks", () => {
  const rand = mulberry32(5);
  for (let i = 0; i < 100; i++) {
    const rack = randomRack(rand, 12 + Math.floor(rand() * 6));
    const p = engine.bestPartition(rack, { timeBudgetMs: 1000 });
    const left = [...rack];
    let sum = 0;
    for (const w of p.words) {
      assert.ok(engine.isWord(w), w);
      assert.ok(canSpell(w, left), `${w} not spellable from what is left`);
      const c = countsOf(w);
      for (let l = 0; l < 26; l++) left[l]! -= c[l]!;
      sum += wordReward(w);
    }
    assert.equal(p.total, sum);
    assert.ok(p.total >= engine.bestReward(rack), "never worse than the best single word");
    assert.equal(engine.bestPartition(rack, { maxWords: 1 }).total, engine.bestReward(rack));
  }
  const p = engine.bestPartition(countsOf("ETAOINSHRDLUCMF"), { timeBudgetMs: 1000 });
  assert.equal(p.total, 78, "every tile at 3x: the bound itself");
  assert.equal(p.optimal, true);
});

test("bestPartition respects its time budget", () => {
  const rack = emptyCounts().map(() => 3); // 78 tiles: far too many to finish
  assert.ok(totalTiles(rack) > 70);
  const t = performance.now();
  const p = engine.bestPartition(rack, { timeBudgetMs: 5 });
  const ms = performance.now() - t;
  assert.equal(p.optimal, false);
  assert.ok(p.total > 0 && p.words.length > 1);
  // Enumerating candidates isn't budgeted; the search after it is.
  assert.ok(ms < 200, `took ${ms.toFixed(1)} ms`);
});
