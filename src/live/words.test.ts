import assert from "node:assert/strict";
import { test } from "node:test";
import { countsOf } from "../core/rules.js";
import type { MatchView } from "../core/types.js";
import { checkWords, WordPlayer } from "./words.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function view(rack: string): MatchView {
  return {
    matchId: 7,
    myBotId: 42,
    auctionType: "Vickrey",
    round: 4,
    bagTotal: 60,
    startingRackSize: 5,
    participants: [{ botId: 42, balance: 50, score: 0, isSim: false }],
    myRack: countsOf(rack),
    history: [],
    nowMs: 0,
  };
}

test("checkWords: in order, from what's left, A-Z only", () => {
  const out = checkWords(["cat", "TAB", "AT", "x1", 5, "Q"], countsOf("CATAT"));
  assert.deepEqual(out, [
    { word: "CAT", rackBefore: "AACTT" },
    { invalid: "TAB", why: "not spellable from AT" },
    { word: "AT", rackBefore: "AT" },
    { invalid: "X1", why: "not 2+ letters A-Z" },
    { invalid: "5", why: "not a string" },
    { invalid: "Q", why: "not 2+ letters A-Z" },
  ]);
  assert.deepEqual(checkWords("CAT", countsOf("CAT")), []);
});

test("words: same rack state never sends the same word twice; refusals aren't retried", async () => {
  let rack = "CATS";
  const sent: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const wp = new WordPlayer({
    agent: { name: "t", quickBid: () => 0, chooseWords: () => ["CATS"] },
    transport: {
      dry: false,
      submitWord: async (_m, w) => {
        sent.push(w);
        throw new Error("'CATS' is not in the dictionary");
      },
    },
    view: () => view(rack),
    log: (_t, r) => logs.push(r),
    human: () => {},
  });
  wp.check(7n);
  await tick();
  wp.check(7n);
  await tick();
  assert.deepEqual(sent, ["CATS"], "refused once, not resent for the same rack");
  assert.equal(logs[0]!.ok, false);
  rack = "CATSE";
  wp.check(7n);
  await tick();
  assert.deepEqual(sent, ["CATS", "CATS"], "new rack state: the agent may try again");
});

test("words: a check during in-flight words waits for their acks", async () => {
  let rack = "DOGCAT";
  const sent: string[] = [];
  const pending: Array<() => void> = [];
  const wp = new WordPlayer({
    agent: { name: "t", quickBid: () => 0, chooseWords: (v) => (v.myRack[2]! > 0 ? ["CAT", "DOG"] : ["DOG"]) },
    transport: {
      dry: false,
      submitWord: (_m, w) => {
        sent.push(w);
        return new Promise<void>((res) => pending.push(res));
      },
    },
    view: () => view(rack),
    log: () => {},
    human: () => {},
  });
  wp.check(7n);
  assert.deepEqual(sent, ["CAT", "DOG"], "both words go out in order without waiting");
  assert.equal(wp.inFlightCount, 2);
  wp.check(7n); // rack in the cache is stale: must not resubmit
  assert.equal(sent.length, 2);
  const idle = wp.waitIdle(1000);
  rack = "";
  for (const r of pending) r();
  await idle;
  await tick();
  assert.equal(wp.inFlightCount, 0);
  assert.deepEqual(sent, ["CAT", "DOG"]);
});

test("words: chooseWords throwing is logged, not fatal", () => {
  const logs: Record<string, unknown>[] = [];
  const wp = new WordPlayer({
    agent: {
      name: "t",
      quickBid: () => 0,
      chooseWords: () => {
        throw new Error("dictionary missing");
      },
    },
    transport: { dry: false, submitWord: async () => {} },
    view: () => view("CAT"),
    log: (_t, r) => logs.push(r),
    human: () => {},
  });
  assert.doesNotThrow(() => wp.check(7n));
  assert.equal(logs[0]!.err, "dictionary missing");
});
