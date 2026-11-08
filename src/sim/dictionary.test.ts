// The fast paths must give exactly the server's answers.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { StarterAgent } from "../agents/starter.js";
import { DEFAULT_BAG, countsOf, emptyCounts, type Counts } from "../core/rules.js";
import type { MatchView } from "../core/types.js";
import { bestPlayable, countsToMap, findBestPlayable, isValidWord, lexWords } from "./dictionary.js";
import { FastStarterAgent } from "./fast-starter.js";
import { Rng } from "./rng.js";

test("the wordlist is the server's: 172,820 words, sorted, byte-identical when available", () => {
  const words = lexWords();
  assert.equal(words.length, 172_820);
  for (let i = 1; i < words.length; i++) assert.ok(words[i - 1]! < words[i]!, `unsorted at ${i}`);
  // The upstream game module (RABBOT_UPSTREAM, default ../scrabblebot/spacetimedb
  // next to this repo), if checked out.
  const upstream = path.join(
    process.env.RABBOT_UPSTREAM ? path.resolve(process.env.RABBOT_UPSTREAM) : path.join(import.meta.dirname, "..", "..", "..", "scrabblebot", "spacetimedb"),
    "wordlist.txt",
  );
  if (fs.existsSync(upstream)) {
    const ours = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "data", "wordlist.txt"));
    assert.ok(ours.equals(fs.readFileSync(upstream)));
  }
});

test("isValidWord follows the server: uppercases, 2+ letters, A-Z only", () => {
  assert.equal(isValidWord("CAT"), true);
  assert.equal(isValidWord("cat"), true);
  assert.equal(isValidWord("Cat"), true);
  assert.equal(isValidWord("A"), false);
  assert.equal(isValidWord(""), false);
  assert.equal(isValidWord("CA T"), false);
  assert.equal(isValidWord("CAT "), false);
  assert.equal(isValidWord("ÇAT"), false);
  assert.equal(isValidWord("AA"), true);
  assert.equal(isValidWord("ZYZZYVA"), true);
  assert.equal(isValidWord("QI"), false); // this list predates QI
});

function randomRack(rng: Rng, size: number): Counts {
  const bag = DEFAULT_BAG.slice();
  let total = 98;
  const rack = emptyCounts();
  for (let n = 0; n < size; n++) {
    let i = rng.int(0, total - 1);
    for (let s = 0; s < 26; s++) {
      if (i < bag[s]!) {
        bag[s]!--;
        rack[s]!++;
        total--;
        break;
      }
      i -= bag[s]!;
    }
  }
  return rack;
}

test("bestPlayable equals the literal findBestPlayable", () => {
  const rng = new Rng("dictionary-test");
  for (let trial = 0; trial < 500; trial++) {
    const rack = randomRack(rng, rng.int(0, 16));
    for (const minLen of [2, 3]) {
      assert.equal(bestPlayable(rack, minLen), findBestPlayable(countsToMap(rack), minLen), `rack ${countsToMap(rack).size} letters`);
    }
  }
  // Hand-picked: ties go alphabetical, short racks, no word.
  assert.equal(bestPlayable(countsOf("CAT"), 3), "ACT");
  assert.equal(bestPlayable(countsOf("XQ"), 2), undefined);
  assert.equal(bestPlayable(countsOf("AB"), 3), undefined);
  // Huge rack falls back to the scan and still agrees.
  const big = countsOf("EEEEEEEEEEEEAAAAAAAAAIIIIIIIIIOOOOOOOONNNNNNRRRRRRTTTTTT");
  assert.equal(bestPlayable(big, 3), findBestPlayable(countsToMap(big), 3));
});

test("FastStarterAgent plays exactly what StarterAgent plays", () => {
  const rng = new Rng("starter-test");
  const slow = new StarterAgent();
  const fast = new FastStarterAgent();
  const view = (rack: Counts): MatchView => ({
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
  });
  for (let trial = 0; trial < 300; trial++) {
    const rack = randomRack(rng, rng.int(0, 12));
    assert.deepEqual(fast.chooseWords(view(rack.slice())), slow.chooseWords(view(rack.slice())));
    const auction = { auctionId: 1, letter: "QZEK"[trial % 4]!, opensAtMs: 0, closesAtMs: 1000 };
    assert.equal(fast.quickBid(view(rack), auction), slow.quickBid(view(rack), auction));
  }
  assert.equal(fast.name, "starter");
});
