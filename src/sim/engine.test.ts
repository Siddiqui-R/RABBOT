// Rule-level checks against the server's behaviour (game.ts / index.ts),
// one test per rule in ARCHITECTURE.md plus the driver's timing model.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BAG_SIZE, DEFAULT_BAG, LETTERS, STARTING_BALANCE, countsOf, letterValue, totalTiles, wordReward } from "../core/rules.js";
import type { Agent, AuctionView, MatchView } from "../core/types.js";
import { countsToMap, findBestPlayable } from "./dictionary.js";
import { Engine, decideBid, runMatch, type EngineSeat, type MatchSeat, type SimStrategy } from "./engine.js";
import { ServerRandom } from "./rng.js";

const idle = (n: number): EngineSeat[] => Array.from({ length: n }, (_, i) => ({ botId: 101 + i, isSim: false }));
const sims = (...s: SimStrategy[]): EngineSeat[] => s.map((strategy, i) => ({ botId: 1 + i, isSim: true, strategy }));

function started(seats: EngineSeat[], seed = 1, extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}): Engine {
  const e = new Engine({ seats, seed, ...extra });
  assert.deepEqual(e.start(), { ok: undefined });
  return e;
}

function setRack(e: Engine, botId: number, letters: string) {
  const p = e.participant(botId)!;
  p.rack.splice(0, 26, ...countsOf(letters));
}

function lastAuction(e: Engine) {
  const ev = e.history.filter((h) => h.kind === "auction").at(-1);
  assert.ok(ev && ev.kind === "auction");
  return ev;
}

// ---------- dealing and the bag ----------

test("start deals 5 tiles each and opens the first auction", () => {
  const e = started(idle(6));
  for (const p of e.participants) {
    assert.equal(totalTiles(p.rack), 5);
    assert.equal(p.balance, STARTING_BALANCE);
    assert.equal(p.score, 0);
  }
  assert.equal(e.round, 1);
  assert.equal(e.status, "Running");
  // bagTotal doesn't count the letter up for auction.
  assert.equal(e.bagTotal, BAG_SIZE - 30 - 1);
  assert.equal(totalTiles(e.bag), e.bagTotal);
  assert.equal(e.viewFor(101).bagTotal, BAG_SIZE - 31);
});

test("a full match has 98 - 5n auctions and every tile is accounted for", () => {
  for (const n of [2, 4, 6]) {
    const e = started(sims(...(["Aggressive", "ValueBidder", "Cheapskate", "Aggressive", "ValueBidder", "Cheapskate"] as SimStrategy[]).slice(0, n)), n);
    let closes = 0;
    while (!e.closeAuction()) closes++;
    closes++;
    assert.equal(closes, BAG_SIZE - 5 * n);
    assert.equal(e.round, BAG_SIZE - 5 * n);
    assert.equal(e.status, "Ended");
    const held = e.participants.reduce((s, p) => s + totalTiles(p.rack), 0);
    const played = e.history.reduce((s, h) => s + (h.kind === "word" ? h.word.length : 0), 0);
    const unsold = e.history.filter((h) => h.kind === "auction" && h.winnerBotId === null).length;
    assert.equal(held + played + unsold, BAG_SIZE);
  }
});

test("balances equal start minus spend plus score (both auction types)", () => {
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    const e = started(sims("Aggressive", "ValueBidder", "Cheapskate", "Aggressive"), 9, { auctionType });
    while (!e.closeAuction());
    for (const p of e.participants) {
      const spent = e.history.reduce((s, h) => s + (h.kind === "auction" && h.winnerBotId === p.botId ? h.paid : 0), 0);
      const rewards = e.history.reduce((s, h) => s + (h.kind === "word" && h.botId === p.botId ? h.reward : 0), 0);
      assert.equal(p.score, rewards);
      assert.equal(p.balance, STARTING_BALANCE - spent + p.score, `${auctionType} bot ${p.botId}`);
      assert.ok(p.balance >= 0);
    }
  }
});

test("streams rng: letters are drawn in proportion to what's left in the bag", () => {
  const counts = new Array<number>(26).fill(0);
  for (let seed = 0; seed < 3000; seed++) {
    const e = started(idle(2), seed, { rng: "streams" });
    counts[e.auction!.letter.charCodeAt(0) - 65]!++;
  }
  // E is 12/98 of the bag, Q 1/98; 3000 draws: E ~367, Q ~31.
  assert.ok(counts[4]! > 290 && counts[4]! < 450, `E drawn ${counts[4]}`);
  assert.ok(counts[16]! > 10 && counts[16]! < 60, `Q drawn ${counts[16]}`);
});

// The bag walk of the server's drawLetter, over a copy, for hand replays.
function replayDraw(r: ServerRandom, bag: number[], total: { n: number }): string {
  let i = r.int(0, total.n - 1);
  for (let s = 0; s < 26; s++) {
    if (bag[s]! <= 0) continue;
    if (i < bag[s]!) {
      bag[s]!--;
      total.n--;
      return LETTERS[s]!;
    }
    i -= bag[s]!;
  }
  throw new Error("bag walk fell off the end");
}

test("server rng: the start transaction deals, draws the first letter, then jitters sims, from one ctx.random", () => {
  // Regression: the simulator used fair independent streams; the live
  // server draws all of a transaction's randomness from one flawed ctx.random.
  const startUs = 1_790_000_000_000_022; // a degenerate seed (-1), the commonest one live
  const seats: EngineSeat[] = [{ botId: 101, isSim: false }, ...sims("Aggressive", "Cheapskate")];
  const e = started(seats, 4, { rng: "server", startUs });
  const r = new ServerRandom(startUs);
  const bag = DEFAULT_BAG.slice();
  const total = { n: BAG_SIZE };
  for (const s of seats) {
    const rack = Array.from({ length: 5 }, () => replayDraw(r, bag, total)).join("");
    assert.deepEqual(e.participant(s.botId)!.rack, countsOf(rack), `rack of ${s.botId}`);
  }
  const letter = replayDraw(r, bag, total);
  assert.equal(e.auction!.letter, letter);
  for (const s of seats.filter((x) => x.isSim)) {
    assert.equal(e.pending.get(s.botId), decideBid(s.strategy!, letter, 100, r.int(-2, 2)), `sim ${s.botId}`);
  }
  assert.deepEqual(e.bag, bag);
});

test("server rng: a close shuffles the positive bids, then draws the next letter, then jitters sims", () => {
  for (let seed = 0; seed < 25; seed++) {
    const e = started([...idle(3), ...sims("ValueBidder")], seed, { rng: "server" });
    const v = decideBid("ValueBidder", e.auction!.letter, 100, 0);
    e.submitBid(101, v);
    e.submitBid(102, v);
    e.submitBid(103, 0);
    const bids = [...e.pending].filter(([, a]) => a > 0).map(([botId, amount]) => ({ botId, amount }));
    const bag = e.bag.slice();
    const total = { n: e.bagTotal };
    e.closeAuction();
    const r = new ServerRandom(e.lastTxUs!);
    r.shuffle(bids);
    bids.sort((a, b) => b.amount - a.amount);
    assert.equal(lastAuction(e).winnerBotId, bids[0]!.botId, `seed ${seed}: tie winner`);
    const letter = replayDraw(r, bag, total);
    assert.equal(e.auction!.letter, letter, `seed ${seed}: next letter`);
    const sim = e.participant(1)!;
    assert.equal(e.pending.get(1), decideBid("ValueBidder", letter, sim.balance, r.int(-2, 2)), `seed ${seed}: jitter`);
  }
});

// ---------- bids ----------

test("the latest bid replaces an earlier one", () => {
  const e = started(idle(2));
  assert.ok("ok" in e.submitBid(101, 9));
  assert.ok("ok" in e.submitBid(101, 2));
  assert.ok("ok" in e.submitBid(102, 1));
  e.closeAuction();
  const r = lastAuction(e);
  assert.equal(r.winnerBotId, 101);
  assert.equal(r.paid, 1);
});

test("a bid above the balance is refused and the previous bid stays", () => {
  const e = started(idle(2));
  e.submitBid(101, 7);
  assert.deepEqual(e.submitBid(101, STARTING_BALANCE + 1), { err: "Insufficient balance" });
  assert.equal(e.participant(101)!.bidRejections, 1);
  assert.equal(e.pending.get(101), 7);
  // Exactly the balance is fine.
  assert.ok("ok" in e.submitBid(102, STARTING_BALANCE));
});

test("negative, fractional and outsider bids are refused", () => {
  const e = started(idle(2));
  assert.deepEqual(e.submitBid(101, -1), { err: "Bid must be non-negative" });
  assert.deepEqual(e.submitBid(101, 1.5), { err: "Bid must be an integer" });
  assert.deepEqual(e.submitBid(101, Number.NaN), { err: "Bid must be an integer" });
  assert.deepEqual(e.submitBid(999, 1), { err: "Not in this match" });
  assert.equal(e.pending.size, 0);
  assert.equal(e.rejections.length, 4);
});

test("zero bids are ignored, and a zero withdraws an earlier bid", () => {
  const e = started(idle(2));
  e.submitBid(101, 0);
  e.submitBid(102, 4);
  e.submitBid(102, 0);
  const bagBefore = e.bagTotal;
  const letter = e.auction!.letter;
  e.closeAuction();
  const r = lastAuction(e);
  assert.equal(r.winnerBotId, null);
  assert.equal(r.paid, 0);
  assert.equal(r.letter, letter);
  // Unsold tile is discarded: the bag only shrinks by the next draw.
  assert.equal(e.bagTotal, bagBefore - 1);
  for (const p of e.participants) assert.equal(p.balance, STARTING_BALANCE);
});

test("vickrey: the winner pays the runner-up's bid", () => {
  const e = started(idle(3));
  e.submitBid(101, 3);
  e.submitBid(102, 8);
  e.submitBid(103, 5);
  const slot = e.auction!.letter.charCodeAt(0) - 65;
  const before = e.participant(102)!.rack[slot]!;
  e.closeAuction();
  const r = lastAuction(e);
  assert.equal(r.winnerBotId, 102);
  assert.equal(r.paid, 5);
  assert.equal(e.participant(102)!.balance, STARTING_BALANCE - 5);
  assert.equal(e.participant(102)!.rack[slot], before + 1);
});

test("vickrey: a lone bidder pays min(1, bid)", () => {
  const e = started(idle(2));
  e.submitBid(101, 40);
  e.closeAuction();
  assert.equal(lastAuction(e).paid, 1);
  assert.equal(e.participant(101)!.balance, STARTING_BALANCE - 1);
});

test("first price: the winner pays their own bid", () => {
  const e = started(idle(2), 1, { auctionType: "FirstPrice" });
  e.submitBid(101, 3);
  e.submitBid(102, 8);
  e.closeAuction();
  const r = lastAuction(e);
  assert.equal(r.winnerBotId, 102);
  assert.equal(r.paid, 8);
});

test("ties are broken at random and the winner pays the tied amount", () => {
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    const e = started(idle(2), 5, { auctionType });
    const wins = new Map<number, number>();
    for (let i = 0; i < 60; i++) {
      e.submitBid(102, 1);
      e.submitBid(101, 1);
      e.closeAuction();
      const r = lastAuction(e);
      assert.equal(r.paid, 1);
      wins.set(r.winnerBotId!, (wins.get(r.winnerBotId!) ?? 0) + 1);
    }
    assert.ok((wins.get(101) ?? 0) > 15 && (wins.get(102) ?? 0) > 15, `${auctionType}: ${[...wins]}`);
  }
  const e = started(idle(3));
  e.submitBid(101, 6);
  e.submitBid(102, 6);
  e.submitBid(103, 2);
  e.closeAuction();
  assert.equal(lastAuction(e).paid, 6);
});

// ---------- sims ----------

test("decideBid matches the server's strategies", () => {
  // letter, value: E 1 (vowel), K 5, Q 10
  assert.equal(decideBid("Cheapskate", "K", 100, 0), 4);
  assert.equal(decideBid("ValueBidder", "K", 100, 0), 5);
  assert.equal(decideBid("Aggressive", "K", 100, 0), 7);
  assert.equal(decideBid("Aggressive", "E", 100, 0), 5);
  // Clamped to at least 1, at most the balance, never negative.
  assert.equal(decideBid("Cheapskate", "E", 100, -2), 1);
  assert.equal(decideBid("Aggressive", "Q", 6, 2), 6);
  assert.equal(decideBid("Aggressive", "Q", 0, 2), 0);
  assert.equal(decideBid("Human", "Q", 100, 2), 0);
});

test("sims bid at auction open within base -2..+2, uniformly", () => {
  const strategies: SimStrategy[] = ["Cheapskate", "ValueBidder", "Aggressive"];
  const e = started(sims(...strategies), 3);
  const offsets = new Map<number, number>();
  for (let i = 0; e.status === "Running" && i < 80; i++) {
    const letter = e.auction!.letter;
    for (const p of e.participants) {
      const lo = decideBid(p.strategy!, letter, p.balance, -2);
      const hi = decideBid(p.strategy!, letter, p.balance, 2);
      const bid = e.pending.get(p.botId);
      if (lo === 0) {
        assert.equal(bid, undefined, "a sim with no coins doesn't bid");
        continue;
      }
      assert.ok(bid !== undefined && bid >= lo && bid <= hi, `${p.strategy} bid ${bid} on ${letter}, outside ${lo}..${hi}`);
      // Unclamped cases reveal the jitter itself.
      const base = decideBid(p.strategy!, letter, 1e9, 0);
      if (base - 2 >= 1 && base + 2 <= p.balance) offsets.set(bid - base, (offsets.get(bid - base) ?? 0) + 1);
    }
    e.closeAuction();
  }
  assert.deepEqual([...offsets.keys()].sort((a, b) => a - b), [-2, -1, 0, 1, 2]);
});

test("a sim that wins plays findBestPlayable(rack, 3): longest, then alphabetical", () => {
  const e = started([{ botId: 101, isSim: false }, { botId: 2, isSim: true, strategy: "ValueBidder" }], 1, {
    literalSimWords: true,
  });
  e.pending.clear();
  setRack(e, 2, "CA");
  e.auction!.letter = "T";
  e.submitBid(2, 1);
  e.closeAuction();
  const sim = e.participant(2)!;
  // ACT and CAT both fit; ACT comes first alphabetically.
  const word = e.history.find((h) => h.kind === "word");
  assert.deepEqual(word, { kind: "word", botId: 2, word: "ACT", reward: 5 });
  assert.equal(totalTiles(sim.rack), 0);
  assert.equal(sim.score, 5);
  assert.equal(sim.balance, STARTING_BALANCE - 1 + 5);
  // The sim's word comes right after the auction it won, before the next one opens.
  assert.equal(e.history[e.history.length - 1]!.kind, "word");
});

test("a sim only plays words of 3+ letters, and only after winning", () => {
  const e = started([{ botId: 101, isSim: false }, { botId: 2, isSim: true, strategy: "ValueBidder" }], 1);
  e.pending.clear();
  setRack(e, 2, "QJV");
  e.auction!.letter = "O";
  // Only 2-letter words in QJVO (JO), so no play.
  assert.equal(findBestPlayable(countsToMap(countsOf("QJVO")), 3), undefined);
  assert.equal(findBestPlayable(countsToMap(countsOf("QJVO")), 2), "JO");
  e.submitBid(2, 1);
  e.closeAuction();
  assert.equal(e.participant(2)!.wordsPlayed, 0);
  assert.equal(totalTiles(e.participant(2)!.rack), 4);
  // Losing an auction never triggers a play, even with a playable rack.
  setRack(e, 2, "CAT");
  e.pending.clear();
  e.submitBid(101, 5);
  e.closeAuction();
  assert.equal(e.participant(2)!.wordsPlayed, 0);
});

// ---------- words ----------

test("words are validated like submit_word", () => {
  const e = started(idle(2));
  setRack(e, 101, "CATSZ");
  assert.deepEqual(e.submitWord(101, "A"), { err: "Word must be at least 2 letters" });
  assert.deepEqual(e.submitWord(101, "CA T"), { err: "Word must be A-Z only" });
  assert.deepEqual(e.submitWord(101, "TSAC"), { err: "'TSAC' is not in the dictionary" });
  assert.deepEqual(e.submitWord(101, "CATTS"), { err: "'CATTS' is not in the dictionary" });
  assert.deepEqual(e.submitWord(101, "TACT"), { err: "Not enough 'T': need 2, have 1" });
  assert.equal(totalTiles(e.participant(101)!.rack), 5, "refused words use no tiles");
  // Lowercase is uppercased first, as the server does.
  assert.deepEqual(e.submitWord(101, "cats"), { ok: 9 });
  assert.deepEqual(e.participant(101)!.rack, countsOf("Z"));
  assert.equal(e.participant(101)!.wordRejections, 5);
  assert.deepEqual(e.history.at(-1), { kind: "word", botId: 101, word: "CATS", reward: 9 });
});

test("word reward is floor(sum of values x length multiplier), to balance and score", () => {
  const cases: [string, number][] = [
    ["OX", 9], // 9 x 1
    ["ZAX", 19], // 19 x 1
    ["ZEST", 19], // 13 x 1.5 = 19.5
    ["QUIZ", 33], // 22 x 1.5
    ["JOKED", 34], // 17 x 2
    ["JOKERS", 42], // 17 x 2.5 = 42.5
    ["ZEROTH", 45], // 18 x 2.5
    ["JUKEBOX", 81], // 27 x 3
    ["QUIZZES", 102], // 34 x 3 (two Zs)
  ];
  for (const [word, reward] of cases) {
    assert.equal(wordReward(word), reward, word);
    const e = started(idle(2));
    setRack(e, 101, word);
    assert.deepEqual(e.submitWord(101, word), { ok: reward }, word);
    assert.equal(e.participant(101)!.score, reward);
    assert.equal(e.participant(101)!.balance, STARTING_BALANCE + reward);
  }
});

test("the match ends at the last close; nobody can play after it", () => {
  const e = started(idle(2));
  while (e.bagTotal > 0) e.closeAuction();
  // Last auction: 101 wins the tile but the match ends in the same step.
  const letter = e.auction!.letter;
  setRack(e, 101, "");
  e.submitBid(101, 1);
  assert.equal(e.closeAuction(), true);
  assert.equal(e.status, "Ended");
  assert.equal(e.auction, undefined);
  assert.deepEqual(e.participant(101)!.rack, countsOf(letter));
  setRack(e, 101, "CAT");
  assert.deepEqual(e.submitWord(101, "CAT"), { err: "Match not running" });
  assert.deepEqual(e.submitBid(101, 1), { err: "Auction closed" });
  assert.equal(e.closeAuction(), false);
});

test("a sim still plays the last tile inside the final close", () => {
  const e = started([{ botId: 101, isSim: false }, { botId: 2, isSim: true, strategy: "Aggressive" }], 2);
  while (e.bagTotal > 0) e.closeAuction();
  e.pending.clear();
  setRack(e, 2, "CA");
  e.auction!.letter = "T";
  e.submitBid(2, 3);
  assert.equal(e.closeAuction(), true);
  assert.deepEqual(e.history.at(-1), { kind: "word", botId: 2, word: "ACT", reward: 5 });
});

// ---------- views ----------

test("views show only what a live bot can see", () => {
  const e = started([...idle(2), ...sims("Aggressive")], 4);
  e.submitBid(102, 3);
  const v = e.viewFor(101);
  assert.deepEqual(Object.keys(v).sort(), [
    "auctionType", "bagTotal", "history", "matchId", "myBotId", "myRack", "nowMs", "participants", "round", "startingRackSize",
  ]);
  for (const p of v.participants) assert.deepEqual(Object.keys(p).sort(), ["balance", "botId", "isSim", "score"]);
  assert.deepEqual(v.myRack, e.participant(101)!.rack);
  assert.equal(v.bagTotal, e.bagTotal);
  assert.equal(v.round, 1);
  assert.equal(v.history.length, 0);
  // Nothing in the view mentions the pending bids, other racks or the bag.
  const text = JSON.stringify(v);
  assert.ok(!text.includes("pending") && !text.includes("rack\"") && !text.includes("bag\""));
  // Views are copies: scribbling on one can't change the match.
  v.myRack[0] = 99;
  v.participants[0]!.balance = 0;
  v.history.push({ kind: "word", botId: 101, word: "X", reward: 1 });
  assert.notEqual(e.participant(101)!.rack[0], 99);
  assert.equal(e.participant(101)!.balance, STARTING_BALANCE);
  assert.equal(e.history.length, 0);
});

// ---------- the driver (timing model) ----------

class Scripted implements Agent {
  readonly name = "scripted";
  calls: string[] = [];
  constructor(
    private readonly words: (v: MatchView) => string[],
    private readonly quick: (v: MatchView, a: AuctionView) => number,
    readonly refineBid?: (v: MatchView, a: AuctionView, budgetMs: number) => number | null,
  ) {}
  chooseWords(v: MatchView) {
    this.calls.push(`words:${v.round}`);
    return this.words(v);
  }
  quickBid(v: MatchView, a: AuctionView) {
    this.calls.push(`bid:${v.round}`);
    return this.quick(v, a);
  }
}

test("each round: words, then bids, then the close; no plays after the last close", () => {
  const seen: { round: number; balance: number; words: number }[] = [];
  const agent = new Scripted(
    (v) => (v.round === 1 ? ["NOTAWORD"] : []),
    (v) => {
      const me = v.participants.find((p) => p.botId === v.myBotId)!;
      seen.push({ round: v.round, balance: me.balance, words: v.history.filter((h) => h.kind === "word").length });
      return 1;
    },
  );
  const out = runMatch({ seats: [{ botId: 101, isSim: false, agent }, { botId: 102, isSim: false }], seed: 3 });
  const rounds = BAG_SIZE - 10;
  assert.equal(out.rounds, rounds);
  // chooseWords then quickBid every round, nothing after the last close.
  assert.equal(agent.calls.length, 2 * rounds);
  for (let r = 1; r <= rounds; r++) assert.deepEqual(agent.calls.slice(2 * r - 2, 2 * r), [`words:${r}`, `bid:${r}`]);
  // It was the only bidder at 1 coin each, so it won every tile...
  assert.equal(out.seats[0]!.balance, STARTING_BALANCE - rounds);
  // ...and never played, so all of them are dead at the end.
  assert.equal(out.seats[0]!.tilesLeft, 5 + rounds);
  assert.equal(out.seats[0]!.wordRejections, 1);
  assert.equal(seen[0]!.balance, STARTING_BALANCE);
});

test("words are applied before the same round's bid sees the balance", () => {
  let bidBalance = -1;
  const agent = new Scripted(
    (v) => (v.round === 1 ? ["CAT"] : []),
    (v) => {
      if (v.round === 1) bidBalance = v.participants.find((p) => p.botId === v.myBotId)!.balance;
      return 0;
    },
  );
  const seats: MatchSeat[] = [{ botId: 101, isSim: false, agent }, { botId: 102, isSim: false }];
  const rackForCat = countsOf("CAT");
  // Find a deal that gives 101 C, A and T.
  let seed = 0;
  for (; seed < 5000; seed++) {
    const probe = new Engine({ seats, seed });
    probe.start();
    const r = probe.participant(101)!.rack;
    if (rackForCat.every((n, i) => r[i]! >= n)) break;
  }
  assert.ok(seed < 5000, "found a deal with C, A, T");
  const out = runMatch({ seats, seed });
  assert.equal(bidBalance, STARTING_BALANCE + 5);
  assert.equal(out.seats[0]!.wordsPlayed, 1);
});

test("refineBid replaces the quick bid; null keeps it; 0 from quickBid sends nothing", () => {
  const mk = (quick: number, refined: number | null | undefined) =>
    new Scripted(() => [], () => quick, refined === undefined ? undefined : () => refined);
  const firstResult = (a: Agent, b: Agent) => {
    const out = runMatch({
      seats: [{ botId: 101, isSim: false, agent: a }, { botId: 102, isSim: false, agent: b }],
      seed: 1,
    });
    const first = out.engine.history.find((h) => h.kind === "auction");
    assert.ok(first && first.kind === "auction");
    return { result: [first.winnerBotId, first.paid], engine: out.engine };
  };
  // 101 raises 2 -> 9 on refine; 102's null keeps its 5. 101 wins, pays 5.
  assert.deepEqual(firstResult(mk(2, 9), mk(5, null)).result, [101, 5]);
  // A refined 0 withdraws the quick bid: 102 is alone and pays 1.
  assert.deepEqual(firstResult(mk(9, 0), mk(5, null)).result, [102, 1]);
  // Nobody bids: unsold.
  assert.deepEqual(firstResult(mk(0, undefined), mk(0, undefined)).result, [null, 0]);
  // A refine over the balance is refused and the quick bid stands.
  const over = firstResult(mk(3, 500), mk(2, null));
  assert.deepEqual(over.result, [101, 2]);
  assert.deepEqual(over.engine.rejections[0], { round: 1, botId: 101, kind: "bid", input: "500", err: "Insufficient balance" });
});

test("agent exceptions are counted, or rethrown with strict", () => {
  const boom = new Scripted(
    () => {
      throw new Error("boom");
    },
    () => 1,
  );
  const out = runMatch({ seats: [{ botId: 101, isSim: false, agent: boom }, ...sims("ValueBidder")], seed: 1 });
  assert.equal(out.seats[0]!.agentErrors, BAG_SIZE - 10);
  assert.match(out.seats[0]!.firstError!, /boom/);
  assert.throws(() => runMatch({ seats: [{ botId: 101, isSim: false, agent: boom }], seed: 1, strict: true }), /boom/);
});

test("agents act in a fresh random order each round", () => {
  const order: number[] = [];
  const mk = (id: number) => new Scripted(() => (order.push(id), []), () => 0);
  runMatch({ seats: [101, 102, 103].map((botId) => ({ botId, isSim: false, agent: mk(botId) })), seed: 8 });
  const firsts = new Set<number>();
  for (let i = 0; i < order.length; i += 3) firsts.add(order[i]!);
  assert.equal(firsts.size, 3);
});

test("letterValue and LETTERS agree with the server tables", () => {
  assert.equal(LETTERS.length, 26);
  assert.equal([...LETTERS].reduce((s, c) => s + letterValue(c), 0), 87);
});
