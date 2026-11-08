import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BAG, countsOf, emptyCounts, idx } from "../core/rules.js";
import type { MatchView, PublicEvent } from "../core/types.js";
import { Belief } from "./belief.js";

function view(history: PublicEvent[], myRack: string, bagTotal: number): MatchView {
  return {
    matchId: 7,
    myBotId: 1,
    auctionType: "Vickrey",
    round: history.filter((e) => e.kind === "auction").length + 1,
    bagTotal,
    startingRackSize: 5,
    participants: [
      { botId: 1, balance: 100, score: 0, isSim: false },
      { botId: 2, balance: 100, score: 0, isSim: false },
      { botId: 3, balance: 100, score: 0, isSim: true },
    ],
    myRack: countsOf(myRack),
    history,
    nowMs: 0,
  };
}

test("unseen pool: bag minus auctioned, my start and revealed opponent tiles", () => {
  // I started with DOGSX, bought C, played DOGS. Bot 2 bought A, then played
  // CAT: C and T must have come from its hidden starting rack.
  const h: PublicEvent[] = [
    { kind: "auction", auctionId: 1, letter: "A", winnerBotId: 2, paid: 5 },
    { kind: "auction", auctionId: 2, letter: "B", winnerBotId: null, paid: 0 },
    { kind: "auction", auctionId: 3, letter: "C", winnerBotId: 1, paid: 3 },
    { kind: "word", botId: 2, word: "CAT", reward: 5 },
    { kind: "word", botId: 1, word: "DOGS", reward: 7 },
  ];
  const v = view(h, "CX", 98 - 15 - 4);
  const b = new Belief();
  b.update(v);
  assert.deepEqual(b.myStart(v), countsOf("DOGSX"));
  const pool = b.unseen(v, "E");
  const want = DEFAULT_BAG.slice();
  for (const ch of "ABC" + "DOGSX" + "CT" + "E") want[idx(ch)]!--;
  assert.deepEqual(pool, want);
  // Pool size = bag + every unrevealed opponent starting tile.
  const total = pool.reduce((a, c) => a + c, 0);
  assert.equal(total, v.bagTotal + (5 - 2) + 5);

  const o2 = b.opponent(2);
  assert.equal(o2.size, 5 + 1 - 3);
  assert.equal(o2.hiddenLeft, 3);
  assert.deepEqual(o2.known, emptyCounts());
  assert.equal(b.rackSize(3), 5);
  assert.equal(b.rackSize(1), 2);
});

test("belief updates incrementally and resets on a new match", () => {
  const h: PublicEvent[] = [{ kind: "auction", auctionId: 1, letter: "Q", winnerBotId: 3, paid: 9 }];
  const b = new Belief();
  const v1 = view(h, "ABCDE", 70);
  b.update(v1);
  assert.equal(b.auctions, 1);
  const v2 = view([...h, { kind: "auction", auctionId: 2, letter: "Z", winnerBotId: 2, paid: 30 }], "ABCDE", 69);
  b.update(v2);
  assert.equal(b.auctions, 2);
  assert.deepEqual(b.opponent(2).known, countsOf("Z"));
  b.update({ ...view([], "ABCDE", 72), matchId: 8 });
  assert.equal(b.auctions, 0);
  assert.equal(b.rackSize(2), 5);
});
