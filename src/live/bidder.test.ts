import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyCounts } from "../core/rules.js";
import type { Agent, AuctionView, MatchView } from "../core/types.js";
import { Bidder, DEFAULT_BIDDER_OPTIONS, type BidderOptions } from "./bidder.js";
import { BusyTracker, ClockSync } from "./clock.js";
import type { AuctionResultRow, AuctionRow } from "./rows.js";

const ts = (ms: number) => ({ microsSinceUnixEpoch: BigInt(Math.round(ms * 1000)) });
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function view(balance: number): MatchView {
  return {
    matchId: 7,
    myBotId: 42,
    auctionType: "Vickrey",
    round: 1,
    bagTotal: 67,
    startingRackSize: 5,
    participants: [
      { botId: 42, balance, score: 0, isSim: false },
      { botId: 1, balance: 100, score: 0, isSim: true },
    ],
    myRack: emptyCounts(),
    history: [],
    nowMs: 0,
  };
}

interface Harness {
  bidder: Bidder;
  sent: Array<{ auctionId: bigint; amount: number }>;
  logs: Array<{ type: string; rec: Record<string, unknown> }>;
  setNow: (ms: number) => void;
  refineCalls: number[];
}

function harness(
  agent: Partial<Agent> & Pick<Agent, "quickBid">,
  opts: { balance?: number; refuse?: (amount: number) => string | null; bidder?: Partial<BidderOptions>; seated?: boolean } = {},
): Harness {
  let now = 1_000_000;
  const sent: Harness["sent"] = [];
  const logs: Harness["logs"] = [];
  const refineCalls: number[] = [];
  const full: Agent = {
    name: "test",
    chooseWords: () => [],
    ...agent,
    ...(agent.refineBid
      ? {
          refineBid: (v: MatchView, a: AuctionView, budget: number) => {
            refineCalls.push(budget);
            return agent.refineBid!(v, a, budget);
          },
        }
      : {}),
  };
  // Instant fake acks would read as ~0 ms RTT; seed a realistic 90 ms.
  const clock = new ClockSync({ defaultOneWayMs: 45 });
  for (let i = 0; i < 9; i++) clock.observeRtt(90);
  const bidder = new Bidder({
    agent: full,
    clock,
    busy: new BusyTracker(),
    transport: {
      dry: false,
      submitBid: async (auctionId, amount) => {
        sent.push({ auctionId, amount });
        const why = opts.refuse?.(amount);
        if (why) throw new Error(why);
      },
    },
    myBotId: () => 42n,
    view: () => (opts.seated === false ? null : view(opts.balance ?? 100)),
    log: (type, rec) => logs.push({ type, rec }),
    human: () => {},
    opts: { ...DEFAULT_BIDDER_OPTIONS, flushAfterMs: 50, ...opts.bidder },
    now: () => now,
  });
  return { bidder, sent, logs, setNow: (ms) => (now = ms), refineCalls };
}

function auction(id: bigint, opensAt: number, letter = "Q"): AuctionRow {
  return { id, matchId: 7n, letter, opensAt: ts(opensAt), closesAt: ts(opensAt + 1000), status: { tag: "Open" } };
}

function result(id: bigint, closedAt: number, winner: bigint | undefined, paid: number): AuctionResultRow {
  return { auctionId: id, matchId: 7n, letter: "Q", winnerBotId: winner, paid: BigInt(paid), closedAt: ts(closedAt) };
}

test("bidder: quick bid goes out at once; an equal refinement isn't resent", async () => {
  const h = harness({ quickBid: () => 12, refineBid: () => 12 });
  h.bidder.onOpen(auction(1n, 1_000_000 - 90), 1_000_000, true);
  assert.deepEqual(h.sent, [{ auctionId: 1n, amount: 12 }], "quick bid sent synchronously");
  await tick();
  assert.equal(h.sent.length, 1);
  // Opened 90 ms ago, closes in 910; minus 45 uplink and 250 margin.
  assert.equal(h.refineCalls[0], 615);
});

test("bidder: a different refinement replaces the quick bid; result is logged once", async () => {
  const h = harness({ quickBid: () => 12, refineBid: () => 17 });
  h.bidder.onOpen(auction(2n, 1_000_000 - 90), 1_000_000, true);
  await tick();
  assert.deepEqual(
    h.sent.map((s) => s.amount),
    [12, 17],
  );
  h.bidder.onResult(result(2n, 1_000_000 + 912, 42n, 15), 1_000_000 + 1000, true);
  await tick();
  const recs = h.logs.filter((l) => l.type === "auction");
  assert.equal(recs.length, 1);
  const r = recs[0]!.rec;
  assert.equal(r.quick, 12);
  assert.equal(r.refined, 17);
  assert.equal(r.standing, 17);
  assert.deepEqual(r.result, { winner: 42, paid: 15, won: true, tickDelayMs: 2 });
  const sends = r.sends as Array<{ stage: string; ok: boolean; slackMs: number }>;
  assert.deepEqual(
    sends.map((s) => [s.stage, s.ok]),
    [
      ["quick", true],
      ["refine", true],
    ],
  );
  assert.ok(sends[0]!.slackMs > 800);
});

test("bidder: no refinement when the budget is gone", async () => {
  const h = harness({ quickBid: () => 5, refineBid: () => 9 });
  // Received 750 ms after it opened: 250 left, less than uplink + margin.
  h.bidder.onOpen(auction(3n, 1_000_000 - 750), 1_000_000, true);
  await tick();
  assert.deepEqual(h.refineCalls, []);
  assert.deepEqual(
    h.sent.map((s) => s.amount),
    [5],
  );
  h.bidder.onResult(result(3n, 1_000_000 + 251, 1n, 3), 1_000_000 + 300, true);
  await tick();
  assert.equal(h.logs.find((l) => l.type === "auction")!.rec.refineSkip, "budget");
});

test("bidder: bids are sanitized; agent errors never escape", async () => {
  const cases: Array<[unknown, number]> = [
    [Number.NaN, 0],
    [-4, 0],
    [3.9, 3],
    [1e9, 60],
  ];
  let id = 10n;
  for (const [raw, want] of cases) {
    const h = harness({ quickBid: () => raw as number }, { balance: 60 });
    h.bidder.onOpen(auction(id++, 1_000_000 - 90), 1_000_000, true);
    assert.deepEqual(
      h.sent.map((s) => s.amount),
      want > 0 ? [want] : [],
      `raw ${String(raw)}`,
    );
  }
  const h = harness({
    quickBid: () => {
      throw new Error("boom");
    },
    refineBid: () => {
      throw new Error("bang");
    },
  });
  assert.doesNotThrow(() => h.bidder.onOpen(auction(20n, 1_000_000 - 90), 1_000_000, true));
  await tick();
  assert.equal(h.sent.length, 0);
  h.bidder.onResult(result(20n, 1_000_000 + 910, undefined, 0), 1_000_000 + 1000, true);
  await tick();
  const r = h.logs.find((l) => l.type === "auction")!.rec;
  assert.deepEqual(r.errors, ["quickBid: boom", "refineBid: bang"]);
});

test("bidder: a refused refinement leaves the quick bid standing and counts as a miss", async () => {
  const h = harness({ quickBid: () => 6, refineBid: () => 8 }, { refuse: (a) => (a === 8 ? "Auction window expired" : null) });
  h.bidder.onOpen(auction(30n, 1_000_000 - 90), 1_000_000, true);
  await tick();
  h.bidder.onResult(result(30n, 1_000_000 + 910, 42n, 4), 1_000_000 + 1000, true);
  await tick();
  const r = h.logs.find((l) => l.type === "auction")!.rec;
  assert.equal(r.standing, 6);
  assert.equal(r.misses, 1);
});

test("bidder: not seated -> nothing sent, nothing recorded", () => {
  const h = harness({ quickBid: () => 6 }, { seated: false });
  assert.equal(h.bidder.onOpen(auction(40n, 1_000_000 - 90), 1_000_000, true), null);
  assert.equal(h.sent.length, 0);
});

test("bidder: a resync after the close by our clock is ignored", () => {
  const h = harness({ quickBid: () => 6 });
  assert.equal(h.bidder.onOpen(auction(41n, 1_000_000 - 1200), 1_000_000, false), null);
  assert.equal(h.sent.length, 0);
});

test("bidder: a zero refinement withdraws the quick bid", async () => {
  const h = harness({ quickBid: () => 6, refineBid: () => 0 });
  h.bidder.onOpen(auction(50n, 1_000_000 - 90), 1_000_000, true);
  await tick();
  assert.deepEqual(
    h.sent.map((s) => s.amount),
    [6, 0],
  );
});
