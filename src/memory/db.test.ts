import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { num, openDb, upsertSql, type Db } from "./db.js";
import { deriveAll, KIND_EQ, KIND_LE } from "./derive.js";
import { loadOpponentModel } from "./model.js";

function tmpDb(): { db: Db; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbot-"));
  const file = path.join(dir, "h.sqlite");
  return { db: openDb(file), file };
}

const A = 10;
const B = 11;
const V = 1; // ValueBidder sim

/**
 * A short hand-made match (5 auctions) between two real bots and one sim:
 *  1 E  -> A pays 3 (top 5)
 *  2 Q  -> B pays 12 (top 20)
 *  3 A  -> V pays 2 (top 3); V plays TEA inside that close
 *  4 Z  -> A pays 15 (top 30): no sim can bid 15 on Z, so B bid exactly 15
 *  5 X  -> nobody bids; A plays ZEE during this auction's window
 */
function seed(db: Db): void {
  const ins = (table: string, cols: string[], pk: string, rows: unknown[][]) => {
    const st = db.prepare(upsertSql(table, cols, [pk]));
    for (const r of rows) st.run(...(r as never[]));
  };
  ins("bot", ["id", "name", "team_id", "is_simulated", "strategy", "created_us"], "id", [
    [A, "alpha", 1, 0, "Human", 0],
    [B, "beta", 2, 0, "Human", 0],
    [V, "Valor-sim", 0, 1, "ValueBidder", 0],
  ]);
  ins(
    "match_state",
    ["id", "status", "current_round", "bag_total", "auction_type", "created_us", "started_us", "ended_us", "starting_rack_size"],
    "id",
    [[7, "Ended", 5, 0, "Vickrey", 1000, 1000, 6000, 5]],
  );
  ins("match_participant", ["id", "match_id", "bot_id", "balance", "score"], "id", [
    [1, 7, A, 94, 12],
    [2, 7, B, 88, 0],
    [3, 7, V, 101, 3],
  ]);
  ins("auction_result", ["auction_id", "match_id", "letter", "winner_bot_id", "paid", "closed_us"], "auction_id", [
    [100, 7, "E", A, 3, 2000],
    [101, 7, "Q", B, 12, 3000],
    [102, 7, "A", V, 2, 4000],
    [103, 7, "Z", A, 15, 5000],
    [104, 7, "X", null, 0, 6000],
  ]);
  ins("auction_top_bid_archive", ["auction_id", "match_id", "top_bid"], "auction_id", [
    [100, 7, 5],
    [101, 7, 20],
    [102, 7, 3],
    [103, 7, 30],
    [104, 7, 0],
  ]);
  ins("word_play", ["id", "match_id", "bot_id", "word", "base_score", "bonus", "total_reward", "played_us"], "id", [
    [1, 7, V, "TEA", 3, 0, 3, 4000],
    [2, 7, A, "ZEE", 12, 0, 12, 5500],
  ]);
  db.prepare("INSERT OR REPLACE INTO match_mined (match_id, complete, mined_us) VALUES (7, 1, 1)").run();
}

test("db opens in WAL mode and upserts idempotently", () => {
  const { db } = tmpDb();
  assert.equal(String(db.prepare("PRAGMA journal_mode").get()!.journal_mode), "wal");
  seed(db);
  seed(db); // same rows again: no duplicates, no errors
  assert.equal(num(db.prepare("SELECT COUNT(*) AS n FROM auction_result").get()!.n), 5);
  db.prepare(upsertSql("bot", ["id", "name", "team_id", "is_simulated", "strategy", "created_us"], ["id"])).run(
    A, "alpha2", 1, 0, "Human", 0,
  );
  assert.equal(String(db.prepare("SELECT name FROM bot WHERE id = ?").get(A)!.name), "alpha2");
  db.close();
});

test("derive replays balances, racks and what each sealed bid is known to be", () => {
  const { db, file } = tmpDb();
  seed(db);
  const s = deriveAll(db);
  assert.equal(s.matches, 1);
  assert.equal(s.balanceMismatches, 0);
  assert.equal(s.simFormulaViolations, 0);
  assert.equal(s.runnerUpExact, 1);

  const obs = (auction: number, bot: number) =>
    db.prepare("SELECT kind, value, balance, cap, rack_size, won, others_max FROM bid_obs WHERE auction_id = ? AND bot_id = ?").get(auction, bot)!;
  // Winner: exact top bid. Loser: at most paid.
  assert.deepEqual([num(obs(100, A).kind), num(obs(100, A).value), num(obs(100, A).won)], [KIND_EQ, 5, 1]);
  assert.deepEqual([num(obs(100, B).kind), num(obs(100, B).value)], [KIND_LE, 3]);
  // The sim could have bid 3 on E, so B isn't pinned down there; on Z it can't reach 15.
  assert.deepEqual([num(obs(103, B).kind), num(obs(103, B).value)], [KIND_EQ, 15]);
  // Nobody bid: everyone bid 0.
  assert.deepEqual([num(obs(104, A).kind), num(obs(104, A).value)], [KIND_EQ, 0]);
  // Balance at the open of auction 5 is 100 - 3 - 15; ZEE (during it) raises the cap.
  assert.equal(num(obs(104, A).balance), 82);
  assert.equal(num(obs(104, A).cap), 94);
  assert.equal(num(obs(104, A).rack_size), 7);
  // Sims don't get bid rows.
  assert.equal(num(db.prepare("SELECT COUNT(*) AS n FROM bid_obs WHERE bot_id = ?").get(V)!.n), 0);

  const ctx = db.prepare("SELECT round_idx, phase, sim_q FROM auction_ctx WHERE auction_id = 100").get()!;
  assert.equal(num(ctx.round_idx), 0);
  assert.ok(Math.abs(Number(ctx.sim_q) - 0.8) < 1e-12); // V's E bids: 1,1,1,2,3 -> 4 of 5 below 3

  const seats = db.prepare("SELECT bot_id, place, final_balance, tiles_left FROM match_seat WHERE match_id = 7 ORDER BY place").all();
  assert.deepEqual(seats.map((r) => num(r.bot_id)), [A, V, B]);
  assert.deepEqual(seats.map((r) => num(r.final_balance)), [94, 101, 88]);

  const play = db.prepare("SELECT round_idx, rack_before, balance_before FROM play_obs WHERE word_id = 2").get()!;
  assert.deepEqual([num(play.round_idx), num(play.rack_before), num(play.balance_before)], [4, 7, 82]);

  // Deriving again replaces rather than duplicates.
  deriveAll(db, { rebuild: true });
  assert.equal(num(db.prepare("SELECT COUNT(*) AS n FROM bid_obs").get()!.n), 10);
  db.close();

  // And the model reads it back.
  const m = loadOpponentModel(file);
  assert.equal(m.strategyOf(V), "ValueBidder");
  assert.equal(m.strategyOf(A), "Human");
  assert.equal(m.strategyOf(999), "unknown");
  const q = m.predictBid(V, "Q", { phase: 0.5, balance: 100 });
  assert.equal(q.source, "sim");
  assert.equal(q.mean, 10);
  const a = m.predictBid(A, "E", { phase: 0.5, balance: 50 });
  assert.ok(a.quantile(1) <= 50 && a.mean > 0);
  assert.equal(m.botSummary(A).matches, 1);
  assert.equal(m.marketPrice("E", 0.1).n, 1);
});

test("model degrades gracefully without a database", () => {
  const m = loadOpponentModel(path.join(os.tmpdir(), "does-not-exist-rabbot.sqlite"));
  assert.equal(m.strategyOf(1), "unknown");
  const d = m.predictBid(1, "E", { phase: 0.2, balance: 30 });
  assert.equal(d.source, "market");
  assert.ok(d.mean > 0 && d.quantile(1) <= 30);
});
