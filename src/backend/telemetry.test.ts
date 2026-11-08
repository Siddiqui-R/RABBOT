// Live bot telemetry: record projections (pure), resilience with no server,
// and a round trip into a throwaway `rackforge-test-<pid>` database.
//   node --import tsx --test src/backend/telemetry.test.ts

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sql, type Backend } from "./client.js";
import { attachTelemetry, decisionFrom, matchFrom, Telemetry, wordFrom } from "./telemetry.js";
import { connectTestWriter, deleteTestDb, publishTestDb, serverUp, TEST_DB } from "./testdb.js";

// Shapes as the live bot logs them (logs/decisions-*.jsonl).
const AUCTION = {
  match: 14551, auction: 773421, letter: "D",
  view: { match: 14551, round: 1, bagTotal: 67, balance: 100, score: 0, rack: "EGLRY", seats: [], events: 0 },
  quick: 10, quickMs: 16.3, refined: 12, refineMs: 185.9, budgetMs: 405.2,
  sends: [
    { stage: "quick", amount: 10, sentAt: 1, slackMs: 666.2, ok: true, ackMs: 198 },
    { stage: "refine", amount: 12, sentAt: 2, slackMs: 468.2, ok: true, ackMs: 123.3 },
  ],
  standing: 12, misses: 0, result: { winner: 129, paid: 16, won: false, tickDelayMs: 2 },
};
const WORD = { match: 14541, round: 68, rackBefore: "AAEILRTVW", word: "AIRWAVE", reward: 39, thinkMs: 0.6, ackMs: 79.6, ok: true };
const END = {
  match: 14541, me: 127, status: "Ended", place: 4, seats: 6, score: 87, balance: 51, coinsSpent: 136,
  auctionsWon: 11, auctions: 68, words: ["JUNIPER", "AIRWAVE"], wordPoints: 87, unplayedTiles: 2,
  standings: [{ botId: 74, score: 105, place: 1 }, { botId: 127, score: 87, place: 4 }], agent: "rackforge",
};

describe("projections", () => {
  test("auction -> rackforge_decision", () => {
    const d = decisionFrom(AUCTION)!;
    assert.equal(d.auctionId, 773421n);
    assert.equal(d.matchId, 14551n);
    assert.equal(d.round, 1);
    assert.equal(d.letter, "D");
    assert.equal(d.balance, 100n);
    assert.equal(d.quickBid, 10n);
    assert.equal(d.refinedBid, 12n);
    assert.equal(d.sentBid, 12n);
    assert.equal(d.minSlackMs, 468.2);
    assert.equal(d.refused, 0);
    assert.equal(d.won, false);
    assert.equal(d.paid, undefined);
    assert.equal(d.winnerBotId, 129n);
    assert.equal(d.reason, "refine");
    assert.equal(decisionFrom({ type: "auction" }), undefined);
  });
  test("no-bid auction", () => {
    const d = decisionFrom({ ...AUCTION, sends: [], refined: null, result: null })!;
    assert.equal(d.sentBid, 0n);
    assert.equal(d.refinedBid, undefined);
    assert.equal(d.reason, "no-bid");
    assert.equal(d.won, undefined);
  });
  test("word and match_end", () => {
    const w = wordFrom(WORD)!;
    assert.equal(w.word, "AIRWAVE");
    assert.equal(w.reward, 39n);
    assert.equal(w.ok, true);
    const m = matchFrom(END, 1_000_000)!;
    assert.equal(m.place, 4);
    assert.equal(m.score, 87n);
    assert.equal(m.winnerScore, 105n);
    assert.equal(m.words, "JUNIPER AIRWAVE");
    assert.equal(m.startedAt?.microsSinceUnixEpoch, 1_000_000n);
    assert.equal(matchFrom({ match: 1, note: "rows gone before end was seen" }), undefined);
  });
});

describe("no server", () => {
  test("record never throws, queue stays bounded, close returns", async () => {
    const errors: string[] = [];
    const t = new Telemetry({ uri: "http://127.0.0.1:9", db: "nope", flushMs: 50, maxQueue: 100, onError: (m) => errors.push(m) });
    const t0 = performance.now();
    for (let i = 0; i < 1_000; i++) t.record("auction", { ...AUCTION, auction: i });
    t.heartbeat({ state: "lobby", latencyMs: 1, clockOffsetMs: 0, version: "test" });
    const perRecordUs = ((performance.now() - t0) * 1000) / 1_000;
    assert.ok(perRecordUs < 200, `record took ${perRecordUs.toFixed(1)} µs`);
    await new Promise((r) => setTimeout(r, 300));
    const s = t.stats();
    assert.ok(s.queued! <= 100, `queue ${s.queued}`);
    assert.ok(s.dropped! >= 900);
    const c0 = performance.now();
    await t.close(1_000);
    assert.ok(performance.now() - c0 < 1_500);
  });
});

describe("attachTelemetry (no server)", () => {
  test("taps the log, heartbeats, never throws, close untaps", async () => {
    type Tap = ((type: string, rec: Record<string, unknown>) => void) | null;
    const box: { tap: Tap } = { tap: null };
    const warns: string[] = [];
    const log = { setTap: (t: Tap) => void (box.tap = t), warn: (m: string) => void warns.push(m) };
    let beats = 0;
    const h = attachTelemetry(log, () => (beats++, { state: "lobby", latencyMs: 1, clockOffsetMs: 0, version: "test" }), {
      uri: "http://127.0.0.1:9", db: "nope", flushMs: 50, maxQueue: 10, heartbeatMs: 20,
    });
    assert.ok(h.telemetry);
    const tap = box.tap;
    assert.ok(tap);
    for (let i = 0; i < 100; i++) tap("auction", { ...AUCTION, auction: i });
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(beats >= 2, `beats ${beats}`);
    assert.ok(h.telemetry!.stats().queued! <= 10);
    const c0 = performance.now();
    await h.close(500);
    assert.ok(performance.now() - c0 < 1_000);
    assert.equal(box.tap, null);
    const b = beats;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(beats, b);
  });

  test("RACKFORGE_TELEMETRY=0 gives a no-op handle", async () => {
    const prev = process.env.RACKFORGE_TELEMETRY;
    process.env.RACKFORGE_TELEMETRY = "0";
    try {
      let tapped = false;
      const h = attachTelemetry({ setTap: () => void (tapped = true), warn: () => {} });
      assert.equal(h.telemetry, null);
      assert.equal(tapped, false);
      await h.close();
    } finally {
      if (prev === undefined) delete process.env.RACKFORGE_TELEMETRY;
      else process.env.RACKFORGE_TELEMETRY = prev;
    }
  });
});

const skip = (await serverUp()) ? false : "integration test: set RACKFORGE_IT=1 with the local rackforge server (127.0.0.1:3013) and a writer token";

describe("round trip", { skip }, () => {
  let writer: Backend;
  before(async () => {
    publishTestDb();
    writer = await connectTestWriter(); // allow-lists the writer identity
  });
  after(async () => {
    await writer?.close();
    deleteTestDb();
  });

  test("records land in rackforge_event and the typed tables", async () => {
    const t = new Telemetry({ db: TEST_DB, flushMs: 100 });
    const q = (s: string) => sql(s, { db: TEST_DB });
    t.record("start", { agent: "rackforge" });
    // The sink connects on its first flush; typed writes need the connection.
    for (let i = 0; i < 100 && !t.sink.backend(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(t.sink.backend(), "sink connected");
    const t0 = performance.now();
    t.record("match_start", { match: 14541 });
    t.record("auction", AUCTION);
    t.record("word", WORD);
    t.record("match_end", END);
    t.heartbeat({ state: "match", currentMatch: 14541n, latencyMs: 80, clockOffsetMs: 99, version: "rackforge@test" });
    let rt = -1;
    for (let i = 0; i < 100; i++) {
      const [d, w, m, s] = await Promise.all([
        q("SELECT * FROM rackforge_decision"), q("SELECT * FROM rackforge_word"), q("SELECT * FROM rackforge_match"), q("SELECT * FROM rackforge_status"),
      ]);
      if (d.length && w.length && m.length && s.length) {
        rt = performance.now() - t0;
        assert.equal(Number(d[0]!.sent_bid), 12);
        assert.equal(w[0]!.word, "AIRWAVE");
        assert.equal(Number(m[0]!.place), 4);
        assert.equal(s[0]!.state, "match");
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(rt >= 0, "typed rows arrived");
    await t.close();
    const ev = await q("SELECT * FROM rackforge_event");
    assert.deepEqual(new Set(ev.map((e) => e.type)), new Set(["start", "match_start", "auction", "word", "match_end"]));
    const auction = ev.find((e) => e.type === "auction")!;
    assert.equal(Number(auction.auction_id), 773421);
    assert.deepEqual(JSON.parse(String(auction.json)), JSON.parse(JSON.stringify(AUCTION)));
    console.log(`telemetry round trip (record -> rows readable over SQL): ${rt.toFixed(0)} ms`);
  });
});
