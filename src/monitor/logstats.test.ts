import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStats, parseLines, quantiles, reason } from "./logstats.js";
import { isProvisional, rankOf, skill, spread } from "./rating.js";

test("logstats: matches, think times, misses and refusals from log records", () => {
  const recs = parseLines(
    [
      { t: "2026-10-25T00:00:00Z", type: "start", agent: "rackforge" },
      { t: "a", type: "auction", quickMs: 0.4, refineMs: 500, budgetMs: 600, misses: 0, sends: [{ ok: true }] },
      { t: "b", type: "auction", quickMs: 1.2, refineMs: 640, budgetMs: 615, misses: 1, sends: [{ ok: true }, { ok: false, err: "Auction window expired" }] },
      { t: "c", type: "auction", quickMs: 0.8, refineSkip: "late", misses: 0, sends: [{ ok: false, err: "Insufficient balance" }] },
      { t: "d", type: "word", ok: false, err: "'QI' is not in the dictionary" },
      { t: "d2", type: "word", ok: false, err: "'XU' is not in the dictionary" },
      { t: "e", type: "lobby", ok: false, err: "You're already in a running match" },
      { t: "f", type: "match_end", match: 13001, place: 2, seats: 6, score: 80, coinsSpent: 60, auctionsWon: 9, words: ["QUA", "ZEST"], unplayedTiles: 2, standings: [{ score: 95 }], clock: { offsetMs: 3 } },
      { t: "g", type: "match_end", match: 13002, place: 1, seats: 6, score: 101, coinsSpent: 70, auctionsWon: 11, words: ["JINX"], unplayedTiles: 0, standings: [{ score: 101 }] },
      { t: "h", type: "auction", quickMs: 99, dryRun: true },
      { t: "i", type: "error", where: "auction" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n{broken",
  );
  const s = computeStats(recs, 10);
  assert.equal(s.agent, "rackforge");
  assert.equal(s.auctions, 3, "dry-run lines don't count");
  assert.deepEqual(s.quickMs, { n: 3, p50: 0.8, p99: 1.2, max: 1.2 });
  assert.equal(s.refineMs.n, 2);
  assert.equal(s.deadlineMisses, 1);
  assert.equal(s.lateRefines, 1);
  assert.equal(s.refineOverruns, 1);
  assert.deepEqual(s.refusals.bid, { "Auction window expired": 1, "Insufficient balance": 1 });
  assert.deepEqual(s.refusals.word, { "'…' is not in the dictionary": 2 });
  assert.deepEqual(s.refusals.lobby, { "You're already in a running match": 1 });
  assert.deepEqual(s.errors, { auction: 1 });
  assert.equal(s.matches.length, 2);
  assert.equal(s.matches[0]!.match, 13002, "newest first");
  assert.equal(s.matches[1]!.winnerScore, 95);
  assert.deepEqual(s.matchTotals, { n: 2, wins: 1, avgPlace: 1.5, avgScore: 90.5 });
  assert.equal(s.timing?.offsetMs, 3);
});

test("logstats: quantiles and reason buckets", () => {
  assert.deepEqual(quantiles([]), { n: 0, p50: null, p99: null, max: null });
  assert.equal(quantiles([5, 1, 3]).p50, 3);
  assert.equal(reason("Unknown auction 12345"), "Unknown auction N");
});

test("rating: the site's scale, provisional cut and competition rank", () => {
  const fresh = { openskillMu: 25, openskillSigma: 25 / 3 };
  assert.equal(skill(fresh), 1500);
  assert.ok(isProvisional(fresh), "a new bot is provisional");
  const a = { openskillMu: 30, openskillSigma: 2 };
  const b = { openskillMu: 30, openskillSigma: 2.5 };
  const c = { openskillMu: 28, openskillSigma: 1 };
  const p = { openskillMu: 40, openskillSigma: 8 }; // high but provisional: no rank, doesn't push others down
  assert.ok(spread(a) <= 175);
  assert.equal(rankOf(a, [a, b, c, p]), 1);
  assert.equal(rankOf(b, [a, b, c, p]), 1, "ties share the rank");
  assert.equal(rankOf(c, [a, b, c, p]), 3);
  assert.equal(rankOf(p, [a, b, c, p]), null);
});
