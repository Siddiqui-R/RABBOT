// Live tests against a throwaway `rackforge-test-<pid>` database on the local rackforge
// server (rackforge-stdb.service must be running):
//   node --import tsx --test src/backend/backend.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Timestamp } from "spacetimedb";
// The model's own bucketing: the module's sums must agree with it.
import { phaseBucket } from "../memory/fit.js";
import {
  createEventSink,
  type Backend,
  type DAuctionCtx,
  type DBidObs,
  type DerivedMatch,
  type DMatchSeat,
  type GBot,
  type GRating,
} from "./client.js";
import {
  connectTestAnon,
  connectTestWriter,
  deleteTestDb,
  identityJson,
  ownerCall,
  publishTestDb,
  serverUp,
  settle,
  TEST_DB,
} from "./testdb.js";

// Needs rackforge-stdb.service and the writer token; skip cleanly elsewhere.
const skip = (await serverUp()) ? false : "integration test: set RACKFORGE_IT=1 with the local rackforge server (127.0.0.1:3013) and a writer token";

const ts = (us: number) => new Timestamp(BigInt(us));

// ---------- independent oracle for the module's sums ----------

type Agg = Record<string, bigint>;
function bump(m: Map<string, Agg>, k: string, f: string, v: bigint) {
  const r = m.get(k) ?? {};
  r[f] = (r[f] ?? 0n) + v;
  m.set(k, r);
}
function expectedSums(ms: readonly DerivedMatch[]) {
  const market = new Map<string, Agg>();
  const opp = new Map<string, Agg>();
  const seat = new Map<string, Agg>();
  for (const m of ms) {
    for (const a of m.auctions) {
      const k = `${a.letter}|${phaseBucket(a.phase)}`;
      bump(market, k, "n", 1n);
      if (a.winnerBotId !== undefined) {
        bump(market, k, "nSold", 1n);
        bump(market, k, "sumPaid", a.paid);
        bump(market, k, "sumsqPaid", a.paid * a.paid);
        if (a.winnerIsSim) bump(market, k, "nSimWin", 1n);
      }
      if (a.topBid !== undefined) {
        bump(market, k, "nTop", 1n);
        bump(market, k, "sumTop", a.topBid);
        bump(market, k, "sumsqTop", a.topBid * a.topBid);
      }
    }
    for (const b of m.bids) {
      const k = `${b.botId}|${b.letter}|${phaseBucket(b.phase)}`;
      bump(opp, k, "nObs", 1n);
      if (b.won) bump(opp, k, "nWon", 1n);
      const f = ["Eq", "Le", "Ge"][b.kind]!;
      bump(opp, k, `n${f}`, 1n);
      bump(opp, k, `sum${f}`, b.value);
      if (b.kind !== 2) bump(opp, k, `sumsq${f}`, b.value * b.value);
      if (b.kind === 0 && b.value === 0n) bump(opp, k, "nZero", 1n);
    }
    for (const s of m.seats) {
      const k = String(s.botId);
      bump(seat, k, "matches", 1n);
      if (s.place === 1) bump(seat, k, "wins", 1n);
      bump(seat, k, "sumPlace", BigInt(s.place));
      bump(seat, k, "sumScore", s.finalScore);
      bump(seat, k, "sumWonTiles", BigInt(s.wonTiles));
      bump(seat, k, "sumPaid", s.paidTotal);
      bump(seat, k, "sumWords", BigInt(s.words));
      bump(seat, k, "sumLettersPlayed", BigInt(s.lettersPlayed));
      bump(seat, k, "sumTilesLeft", BigInt(s.tilesLeft));
    }
  }
  return { market, opp, seat };
}

function assertSame(label: string, got: Map<string, Record<string, unknown>>, want: Map<string, Agg>, fields: string[]) {
  assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort(), `${label} keys`);
  for (const [k, e] of want) {
    const g = got.get(k)!;
    for (const f of fields) assert.equal(g[f], e[f] ?? 0n, `${label} ${k}.${f}`);
  }
}

function assertSums(b: Backend, ms: readonly DerivedMatch[]): void {
  const want = expectedSums(ms);
  const db = b.conn.db;
  assertSame("market_stat", new Map([...db.marketStat.iter()].map((r) => [r.key, r])), want.market,
    ["n", "nSold", "nSimWin", "sumPaid", "sumsqPaid", "nTop", "sumTop", "sumsqTop"]);
  assertSame("opp_stat", new Map([...db.oppStat.iter()].map((r) => [r.key, r])), want.opp,
    ["nObs", "nWon", "nEq", "nZero", "sumEq", "sumsqEq", "nLe", "sumLe", "sumsqLe", "nGe", "sumGe"]);
  assertSame("seat_stat", new Map([...db.seatStat.iter()].map((r) => [String(r.botId), r])), want.seat,
    ["matches", "wins", "sumPlace", "sumScore", "sumWonTiles", "sumPaid", "sumWords", "sumLettersPlayed", "sumTilesLeft"]);
}

// ---------- synthetic derived matches ----------

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function synthMatch(matchId: bigint, r: () => number): DerivedMatch {
  const bots = new Set<bigint>();
  while (bots.size < 6) bots.add(BigInt(1 + Math.floor(r() * 12)));
  const seatsBots = [...bots];
  const sim = new Set(seatsBots.filter(() => r() < 0.3));
  const n = 60 + Math.floor(r() * 9);
  const endedAt = ts(1_700_000_000_000_000 + Number(matchId) * 100_000_000);
  const auctions: DAuctionCtx[] = [];
  const bids: DBidObs[] = [];
  for (let k = 0; k < n; k++) {
    const auctionId = matchId * 1000n + BigInt(k);
    const sold = r() > 0.1;
    const winner = sold ? seatsBots[Math.floor(r() * 6)] : undefined;
    const paid = sold ? BigInt(1 + Math.floor(r() * 12)) : 0n;
    const letter = LETTERS[Math.floor(r() * 26)]!;
    const phase = k / n;
    const topBid = sold && r() > 0.2 ? paid + BigInt(Math.floor(r() * 5)) : undefined;
    auctions.push({
      auctionId, matchId, roundIdx: k, nAuctions: n, phase, letter, winnerBotId: winner,
      winnerIsSim: winner === undefined ? undefined : sim.has(winner), paid, topBid,
      closedAt: ts(1_700_000_000_000_000 + Number(matchId) * 100_000_000 + k * 1_000_000), endedAt,
      simQ: r() > 0.5 ? r() : undefined,
    });
    for (const botId of seatsBots) {
      if (sim.has(botId)) continue;
      const won = botId === winner;
      const kind = winner === undefined ? 0 : won ? (topBid === undefined ? 2 : 0) : r() < 0.1 ? 0 : 1;
      const value = winner === undefined ? 0n : won ? (topBid ?? paid) : paid;
      bids.push({
        id: 0n, auctionId, botId, matchId, letter, roundIdx: k, phase, balance: BigInt(Math.floor(r() * 150)),
        cap: 100n, rackSize: 5, kind, value, won, othersMax: won ? paid : topBid, version: 1, endedAt,
      });
    }
  }
  const seats: DMatchSeat[] = seatsBots.map((botId, i) => ({
    id: 0n, matchId, botId, isSim: sim.has(botId), strategy: sim.has(botId) ? "ValueBidder" : "Human",
    version: 1, finalScore: BigInt(Math.floor(r() * 80)), finalBalance: BigInt(Math.floor(r() * 120)),
    place: i + 1, wonTiles: Math.floor(r() * 15), paidTotal: BigInt(Math.floor(r() * 90)),
    words: Math.floor(r() * 6), lettersPlayed: Math.floor(r() * 20), tilesLeft: Math.floor(r() * 7) - 1, endedAt,
  }));
  const plays = Array.from({ length: 1 + Math.floor(r() * 8) }, (_, i) => ({
    wordId: matchId * 100n + BigInt(i), matchId, botId: seatsBots[i % 6]!, isSim: false, word: "CAT", len: 3,
    reward: 5n, roundIdx: i * 7, phase: (i * 7) / n, rackBefore: 6, balanceBefore: 50n, endedAt,
  }));
  return {
    matchId,
    info: {
      matchId, nSeats: 6, nReal: 6 - sim.size, nAuctions: n, expectedAuctions: 68, auctionType: "Vickrey",
      createdAt: endedAt, endedAt, balanceOk: true, derivedAt: ts(1),
    },
    seats, auctions, bids, plays,
  };
}

function shuffle<T>(xs: readonly T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const bot = (id: bigint, name = `bot${id}`): GBot => ({
  id, name, teamId: id, isSimulated: false, strategy: "Human", createdAt: ts(1000), deletedAt: undefined,
});

describe("rackforge backend", { timeout: 300_000, skip }, () => {
  let w: Backend;
  let anon: Backend;

  before(async () => {
    publishTestDb();
    w = await connectTestWriter();
    anon = await connectTestAnon();
    await w.subscribeTables([
      "g_bot", "g_auction", "g_rating", "g_match_mined", "d_match_info", "d_match_seat", "d_auction_ctx",
      "d_bid_obs", "d_play_obs", "market_stat", "opp_stat", "seat_stat", "bid_model", "rackforge_event",
      "rackforge_decision", "rackforge_word", "rackforge_match", "rackforge_status", "meta",
    ]);
  });

  after(async () => {
    await w?.close();
    await anon?.close();
    deleteTestDb();
  });

  test("no write reducer accepts an anonymous caller", async () => {
    const R = anon.conn.reducers;
    const t0 = ts(1);
    // One call per reducer; the list is checked against the bindings below
    // so a new reducer without a refusal case fails this test.
    const calls: Record<string, () => Promise<void>> = {
      add_writer: () => R.addWriter({ identity: anon.identity, label: "me" }),
      remove_writer: () => R.removeWriter({ identity: w.identity }),
      rebuild_stats: () => R.rebuildStats({}),
      upsert_bots: () => R.upsertBots({ rows: [bot(1n)] }),
      upsert_bot_stats: () => R.upsertBotStats({ rows: [] }),
      upsert_retired_bot_stats: () => R.upsertRetiredBotStats({ rows: [] }),
      upsert_bot_versions: () => R.upsertBotVersions({ rows: [] }),
      upsert_matches: () => R.upsertMatches({ rows: [] }),
      upsert_participants: () => R.upsertParticipants({ rows: [] }),
      upsert_auctions: () => R.upsertAuctions({ rows: [] }),
      upsert_top_bids: () => R.upsertTopBids({ rows: [] }),
      upsert_words: () => R.upsertWords({ rows: [] }),
      upsert_ratings: () => R.upsertRatings({ rows: [] }),
      upsert_tournaments: () => R.upsertTournaments({ rows: [] }),
      upsert_tournament_entries: () => R.upsertTournamentEntries({ rows: [] }),
      upsert_tournament_matches: () => R.upsertTournamentMatches({ rows: [] }),
      upsert_match_mined: () => R.upsertMatchMined({ rows: [] }),
      replace_ratings: () => R.replaceRatings({ matchIds: [1n], rows: [] }),
      mirror_delete_rows: () => R.mirrorDeleteRows({ table: "g_bot", ids: [1n], at: t0 }),
      put_derived: () => R.putDerived({ matchIds: [1n], infos: [], seats: [], auctions: [], bids: [], plays: [] }),
      put_bid_models: () => R.putBidModels({ rows: [] }),
      delete_bid_models: () => R.deleteBidModels({ botIds: [] }),
      log_events: () => R.logEvents({ rows: [] }),
      prune_events: () => R.pruneEvents({ before: t0 }),
      log_decision: () =>
        anon.logDecision({
          auctionId: 1n, matchId: 1n, round: 0, letter: "A", balance: 1n, quickBid: 1n, quickMs: 1, budgetMs: 1,
          sentBid: 1n, minSlackMs: 1, misses: 0, refused: 0, reason: "",
        }),
      log_word: () =>
        anon.logWord({ matchId: 1n, round: 0, word: "AA", reward: 1n, rackBefore: "AA", thinkMs: 1, ok: true }),
      log_match: () =>
        anon.logMatch({
          matchId: 1n, place: 1, seats: 6, score: 1n, balance: 1n, coinsSpent: 0n, auctionsWon: 0, auctions: 0,
          words: "", wordPoints: 0n, unplayedTiles: 0, winnerScore: undefined, ratingAfter: undefined, agent: "",
          startedAt: undefined, endedAt: t0,
        }),
      heartbeat: () => anon.heartbeat({ state: "x", latencyMs: 0, clockOffsetMs: 0, version: "v" }),
      set_meta: () => anon.setMeta("k", "v"),
      delete_meta: () => anon.deleteMeta("k"),
    };
    const src = readFileSync(join(import.meta.dirname, "..", "backend_bindings", "index.ts"), "utf8");
    const all = [...src.matchAll(/__reducerSchema\("([a-z_0-9]+)"/g)].map((m) => m[1]!);
    assert.deepEqual(Object.keys(calls).sort(), all.sort(), "every reducer has an anonymous-refusal case");
    for (const [name, call] of Object.entries(calls)) {
      await assert.rejects(call(), /not an allow-listed writer|owner only/, name);
    }
    // A writer can't promote anyone or rebuild either.
    await assert.rejects(w.conn.reducers.addWriter({ identity: anon.identity, label: "me" }), /owner only/);
    await assert.rejects(w.conn.reducers.rebuildStats({}), /owner only/);
    await settle(w);
    assert.equal(w.conn.db.gBot.count(), 0n);
    assert.equal(w.conn.db.meta.count(), 0n);
    assert.equal(w.conn.db.rackforgeStatus.count(), 0n);
    // The writer list is private, even to a writer over SQL.
    await assert.rejects(w.sql("SELECT * FROM writer"), /sql 400/);
  });

  test("owner can add and remove writers", async () => {
    const hex = anon.identity.toHexString();
    ownerCall("add_writer", identityJson(hex), '"tmp"');
    await anon.setMeta("by-anon", "1");
    ownerCall("remove_writer", identityJson(hex));
    await assert.rejects(anon.setMeta("by-anon", "2"), /not an allow-listed writer/);
    await settle(w);
    assert.equal(w.getMeta("by-anon"), "1");
    await w.deleteMeta("by-anon");
    await settle(w);
    assert.equal(w.getMeta("by-anon"), undefined);
  });

  test("mirror upserts are idempotent; deletes tombstone or remove", async () => {
    const bots = [1n, 2n, 3n].map((id) => bot(id));
    await w.upsertBots(bots);
    await w.upsertBots(bots);
    await w.upsertBots([{ ...bots[0]!, name: "renamed" }]);
    await settle(w);
    assert.equal(w.conn.db.gBot.count(), 3n);
    assert.equal(w.conn.db.gBot.id.find(1n)?.name, "renamed");

    // History tables keep the row, marked; a later upsert (the server
    // re-sending it) clears the mark, as the SQLite miner does.
    await w.mirrorDelete("g_bot", [2n], ts(5));
    await w.mirrorDelete("g_bot", [2n], ts(9)); // first stamp wins
    await settle(w);
    assert.equal(w.conn.db.gBot.id.find(2n)?.deletedAt?.microsSinceUnixEpoch, 5n);
    await w.upsertBots([bots[1]!]);
    await settle(w);
    assert.equal(w.conn.db.gBot.id.find(2n)?.deletedAt, undefined);
    await assert.rejects(w.mirrorDelete("nope" as "g_bot", [1n]), /unknown table/);

    // rating_history: a match's rows are replaced as a set.
    const rating = (id: bigint, matchId: bigint): GRating => ({
      id, botId: 1n, matchId, at: ts(Number(id)), openskillMu: 25, openskillSigma: 8,
    });
    await w.upsertRatings([rating(1n, 10n), rating(2n, 10n), rating(3n, 11n)]);
    await w.replaceRatings([10n], [rating(7n, 10n)]);
    await assert.rejects(w.replaceRatings([10n], [rating(8n, 12n)]), /not in matchIds/);
    await w.mirrorDelete("g_rating", [3n]);
    await settle(w);
    assert.deepEqual([...w.conn.db.gRating.iter()].map((r) => r.id).sort(), [7n]);

    await w.upsertMatchMined([{ matchId: 10n, complete: true, minedAt: ts(3) }]);
    await settle(w);
    assert.equal(w.conn.db.gMatchMined.matchId.find(10n)?.complete, true);
  });

  test("derived sums match an independent recount through re-derives", async () => {
    const r = rng(42);
    let ms = Array.from({ length: 40 }, (_, i) => synthMatch(BigInt(i + 1), r));
    // Odd groupings, several calls in flight.
    await w.putDerived(shuffle(ms, r), { batchSize: 700, parallel: 3 });
    await settle(w);
    assertSums(w, ms);
    assert.equal(w.conn.db.dBidObs.count(), BigInt(ms.reduce((s, m) => s + m.bids.length, 0)));

    // Re-sending everything changes nothing, not even module-assigned ids.
    const ids = new Set([...w.conn.db.dBidObs.iter()].map((b) => b.id));
    await w.putDerived(ms);
    await settle(w);
    assertSums(w, ms);
    assert.deepEqual(new Set([...w.conn.db.dBidObs.iter()].map((b) => b.id)), ids, "no churn on identical re-derive");

    // Re-derive with edits: a changed bid, a dropped bid, an added bid, a
    // moved seat place, a cleared match and a match whose info vanished.
    const m0 = ms[0]!;
    const edited: DerivedMatch = {
      ...m0,
      bids: [
        { ...m0.bids[0]!, kind: 1, value: 3n },
        ...m0.bids.slice(2),
        { ...m0.bids[1]!, botId: 99n, letter: "Q", phase: 0.99 },
      ],
      seats: m0.seats.map((s, i) => ({ ...s, place: 6 - i })),
    };
    const cleared: DerivedMatch = { matchId: ms[1]!.matchId, seats: [], auctions: [], bids: [], plays: [] };
    const noInfo: DerivedMatch = { ...ms[2]!, info: undefined, auctions: ms[2]!.auctions.slice(5) };
    ms = [edited, cleared, noInfo, ...ms.slice(3)];
    await w.putDerived([edited, cleared, noInfo]);
    await settle(w);
    assertSums(w, ms);
    assert.equal(w.conn.db.dMatchInfo.matchId.find(cleared.matchId), null);
    assert.equal(w.conn.db.dMatchInfo.matchId.find(noInfo.matchId), null);
    assert.equal([...w.conn.db.dBidObs.iter()].filter((b) => b.matchId === cleared.matchId).length, 0);

    // Rows for a match not named, duplicate keys and bad kinds are refused,
    // and a refused call changes nothing.
    const call = (m: Partial<Parameters<typeof w.conn.reducers.putDerived>[0]>) =>
      w.conn.reducers.putDerived({ matchIds: [], infos: [], seats: [], auctions: [], bids: [], plays: [], ...m });
    await assert.rejects(call({ matchIds: [1n], bids: [ms[3]!.bids[0]!] }), /not in matchIds/);
    await assert.rejects(call({ matchIds: [edited.matchId], bids: [edited.bids[0]!, edited.bids[0]!] }), /duplicate/);
    await assert.rejects(call({ matchIds: [edited.matchId], bids: [{ ...edited.bids[0]!, kind: 3 }] }), /bad bid kind/);
    await settle(w);
    assertSums(w, ms);

    // The owner's full rebuild lands on the same numbers.
    ownerCall("rebuild_stats");
    await settle(w);
    assertSums(w, ms);

    // Clearing everything leaves no sum rows behind.
    await w.putDerived(ms.map((m) => ({ matchId: m.matchId, seats: [], auctions: [], bids: [], plays: [] })));
    await settle(w);
    assert.equal(w.conn.db.marketStat.count() + w.conn.db.oppStat.count() + w.conn.db.seatStat.count(), 0n);
  });

  test("telemetry, models and meta", async () => {
    const d = {
      auctionId: 77n, matchId: 5n, round: 3, letter: "Q", balance: 90n, quickBid: 4n, quickMs: 2.5, budgetMs: 600,
      sentBid: 5n, minSlackMs: 300, misses: 0, refused: 0, valueEstimate: 6.2, reason: "test",
    };
    await w.logDecision(d);
    await settle(w);
    const first = w.conn.db.rackforgeDecision.auctionId.find(77n);
    assert.ok(first);
    assert.equal(first.won, undefined);
    await w.logDecision({ ...d, refinedBid: 5n, refineMs: 40, won: true, paid: 3n, winnerBotId: 1n });
    await settle(w);
    const second = w.conn.db.rackforgeDecision.auctionId.find(77n);
    assert.equal(w.conn.db.rackforgeDecision.count(), 1n);
    assert.equal(second?.won, true);
    assert.equal(second?.paid, 3n);
    assert.equal(second?.at.microsSinceUnixEpoch, first.at.microsSinceUnixEpoch);
    await assert.rejects(w.logDecision({ ...d, letter: "q" }), /bad letter/);

    await w.logWord({ matchId: 5n, round: 4, word: "QI", reward: 11n, rackBefore: "QIE", thinkMs: 3, ok: false, err: "nope" });
    await w.logMatch({
      matchId: 5n, place: 2, seats: 6, score: 40n, balance: 60n, coinsSpent: 50n, auctionsWon: 9, auctions: 68,
      words: "QI ZAX", wordPoints: 40n, unplayedTiles: 2, winnerScore: 55n, ratingAfter: 1510, agent: "rackforge",
      startedAt: ts(10), endedAt: ts(20),
    });
    await w.heartbeat({ state: "idle", latencyMs: 90, clockOffsetMs: -3, version: "t1" });
    await w.heartbeat({ state: "playing", currentMatch: 9n, latencyMs: 91, clockOffsetMs: -2, version: "t1", rating: 1500 });
    await w.setMeta("cursor", "1");
    await w.setMeta("cursor", "2");

    const ev = (us: number, type: string, json: string) => ({ at: ts(us), type, json, matchId: 5n });
    await w.logEvents([ev(1_000, "auction", '{"a":1}'), ev(2_000, "word", "{}"), ev(3_000, "match_end", "{}")]);
    await w.pruneEvents(ts(2_500));
    const fit = { botId: 0n, fittedAt: ts(5), dataAt: ts(4), nObs: 10n, params: JSON.stringify({ tag: "x", a: Array(26).fill(1.5) }) };
    await w.putBidModels([fit, { ...fit, botId: 7n }]);
    await w.putBidModels([{ ...fit, nObs: 11n }]);
    await w.deleteBidModels([7n]);
    await settle(w);
    const db = w.conn.db;
    assert.equal(db.rackforgeWord.count(), 1n);
    assert.equal(db.rackforgeMatch.matchId.find(5n)?.winnerScore, 55n);
    assert.equal(db.rackforgeStatus.count(), 1n);
    assert.equal(db.rackforgeStatus.id.find(0)?.state, "playing");
    assert.equal(w.getMeta("cursor"), "2");
    assert.deepEqual([...db.rackforgeEvent.iter()].map((e) => e.type), ["match_end"]);
    assert.deepEqual([...db.bidModel.iter()].map((m) => [m.botId, m.nObs]), [[0n, 11n]]);
    await w.deleteBidModels();
    await settle(w);
    assert.equal(db.bidModel.count(), 0n);

    // One-off SQL over HTTP: decoded rows, options and timestamps.
    const rows = await w.sql("SELECT * FROM rackforge_status");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, "playing");
    assert.equal(rows[0]!.current_match, 9);
    assert.equal(rows[0]!.rank, null);
    assert.equal(typeof rows[0]!.heartbeat_at, "number");
    await assert.rejects(w.sql("SELECT * FROM visible_auction_top_bids"), /refusing/);
  });

  test("event sink buffers live records and never throws", async () => {
    const sink = createEventSink({ db: TEST_DB, flushMs: 50 });
    sink.push("auction", { match: 8n, auction: 801, quick: 3, sends: [{ ok: true }] });
    sink.push("error", { where: "x", err: "boom", big: "y".repeat(70_000) });
    sink.push("weird", { cyclic: undefined, n: Number.NaN });
    await sink.close();
    assert.deepEqual(sink.stats(), { queued: 0, sent: 3, dropped: 0, failures: 0 });
    await settle(w);
    const evs = [...w.conn.db.rackforgeEvent.iter()].filter((e) => e.matchId === 8n || e.type === "error");
    assert.equal(evs.length, 2);
    assert.equal(evs.find((e) => e.type === "auction")?.auctionId, 801n);
    assert.match(evs.find((e) => e.type === "error")!.json, /truncated/);

    // A sink that can't connect keeps the bot alive and counts failures.
    const dead = createEventSink({ uri: "http://127.0.0.1:9", db: TEST_DB, flushMs: 20, connectTimeoutMs: 500 });
    dead.push("auction", { match: 1 });
    await new Promise((res) => setTimeout(res, 200));
    await dead.close();
    assert.ok(dead.stats().failures >= 1);
  });

  test("refuses oversize batches and bad letters", async () => {
    const a = {
      auctionId: 1n, matchId: 1n, letter: "ab", winnerBotId: undefined, paid: 0n, closedAt: ts(1), deletedAt: undefined,
    };
    await assert.rejects(w.upsertAuctions([a]), /bad letter/);
    const many = Array.from({ length: 10_001 }, (_, i) => ({ ...a, auctionId: BigInt(10_000_000 + i), letter: "A" }));
    await assert.rejects(w.upsertAuctions(many, { batchSize: 10_001 }), /batch too large/);
    await assert.rejects(w.setMeta("big", "x".repeat(1_000_001)), /longer than/);
  });
});
