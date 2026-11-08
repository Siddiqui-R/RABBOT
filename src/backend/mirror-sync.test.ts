// MirrorSync (miner SQLite -> backend) against a throwaway `rackforge-test-<pid>`
// database on the local rackforge server.
//   node --import tsx --test src/backend/mirror-sync.test.ts

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { openDb, type Db } from "../memory/db.js";
import { sql, type Backend } from "./client.js";
import { MirrorSync } from "./mirror-sync.js";
import { connectTestWriter, deleteTestDb, publishTestDb, serverUp, TEST_DB } from "./testdb.js";

const skip = (await serverUp()) ? false : "integration test: set RACKFORGE_IT=1 with the local rackforge server (127.0.0.1:3013) and a writer token";

describe("mirror sync", { skip }, () => {
  let writer: Backend;
  let db: Db;
  let file: string;
  let sync: MirrorSync;
  const q = (s: string) => sql(s, { db: TEST_DB });
  const count = async (t: string) => Number((await q(`SELECT COUNT(*) AS n FROM ${t}`))[0]!.n);

  before(async () => {
    publishTestDb();
    writer = await connectTestWriter();
    file = path.join(os.tmpdir(), `mirror-sync-${process.pid}.sqlite`);
    fs.rmSync(file, { force: true });
    db = openDb(file);
    sync = new MirrorSync(db, { db: TEST_DB, fullEveryMs: 0, log: () => {} });
  });
  after(async () => {
    await sync?.stop();
    await writer?.close();
    db?.close();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    deleteTestDb();
  });

  test("running match, then ended + derived, then a server-side delete", async () => {
    const run = (s: string) => db.exec(s);
    run(`INSERT INTO bot (id, name, team_id, is_simulated, strategy, created_us) VALUES (1, 'a', 1, 0, 'Human', 1000), (2, 'b', 2, 1, 'Cheapskate', 1000)`);
    run(`INSERT INTO bot_stats (bot_id, rating, matches_played, wins, total_score, last_played_us, mu, sigma) VALUES (1, 1500, 1, 1, 50, 5000, 25, 8), (2, 1500, 1, 0, 10, 5000, 25, 8)`);
    run(`INSERT INTO match_state (id, status, current_round, bag_total, auction_type, created_us, started_us) VALUES (10, 'Running', 1, 68, 'Vickrey', 2000, 2100)`);
    run(`INSERT INTO match_participant (id, match_id, bot_id, balance, score) VALUES (100, 10, 1, 100, 0), (101, 10, 2, 100, 0)`);
    run(`INSERT INTO auction_result (auction_id, match_id, letter, winner_bot_id, paid, closed_us) VALUES (1000, 10, 'E', 1, 3, 3000)`);
    assert.equal(await sync.tick(), true);
    // A running match is mirrored live, but not marked mined.
    assert.equal(await count("g_auction"), 1);
    assert.equal(await count("g_participant"), 2);
    assert.equal(await count("g_match_mined"), 0);
    assert.equal((await q("SELECT status FROM g_match WHERE id = 10"))[0]!.status, "Running");

    run(`UPDATE match_state SET status = 'Ended', ended_us = 4000 WHERE id = 10`);
    run(`INSERT INTO auction_top_bid_archive (auction_id, match_id, top_bid) VALUES (1000, 10, 5)`);
    run(`INSERT INTO rating_history (id, bot_id, match_id, at_us, mu, sigma) VALUES (7, 1, 10, 4000, 26, 7.5)`);
    run(`INSERT INTO match_mined (match_id, complete, mined_us) VALUES (10, 1, 4100)`);
    run(`INSERT INTO match_info (match_id, n_seats, n_real, n_auctions, expected_auctions, auction_type, created_us, ended_us, balance_ok, derived_us) VALUES (10, 2, 1, 1, 68, 'Vickrey', 2000, 4000, 1, 4200)`);
    run(`INSERT INTO match_seat (match_id, bot_id, is_sim, strategy, version, final_score, final_balance, place, won_tiles, paid_total, words, letters_played, tiles_left, ended_us) VALUES (10, 1, 0, 'Human', 1, 0, 97, 1, 1, 3, 0, 0, 6, 4000), (10, 2, 1, 'Cheapskate', 1, 0, 100, 1, 0, 0, 0, 0, 5, 4000)`);
    run(`INSERT INTO auction_ctx (auction_id, match_id, round_idx, n_auctions, phase, letter, winner_bot_id, winner_is_sim, paid, top_bid, closed_us, ended_us, sim_q) VALUES (1000, 10, 0, 1, 0, 'E', 1, 0, 3, 5, 3000, 4000, 1)`);
    run(`INSERT INTO bid_obs (auction_id, bot_id, match_id, letter, round_idx, phase, balance, cap, rack_size, kind, value, won, others_max, version, ended_us) VALUES (1000, 1, 10, 'E', 0, 0, 100, 100, 5, 0, 5, 1, 3, 1, 4000)`);
    run(`INSERT INTO bid_model (bot_id, fitted_us, data_us, n_obs, params) VALUES (0, 5000, 4000, 1, '{}')`);
    assert.equal(await sync.tick(), true);
    assert.equal(await count("g_match_mined"), 1);
    assert.equal(await count("g_top_bid"), 1);
    assert.equal(await count("g_rating"), 1);
    assert.equal(await count("d_match_info"), 1);
    assert.equal(await count("d_match_seat"), 2);
    assert.equal(await count("d_auction_ctx"), 1);
    assert.equal(await count("d_bid_obs"), 1);
    assert.equal(await count("bid_model"), 1);
    assert.equal(Number((await q("SELECT n FROM market_stat"))[0]!.n), 1);

    // The server rebuilt ratings (new id) and dropped a bot's stats.
    run(`DELETE FROM rating_history WHERE id = 7`);
    run(`INSERT INTO rating_history (id, bot_id, match_id, at_us, mu, sigma) VALUES (8, 1, 10, 4000, 26, 7.5)`);
    run(`UPDATE match_mined SET mined_us = 4500 WHERE match_id = 10`);
    run(`DELETE FROM bot_stats WHERE bot_id = 2`);
    run(`UPDATE bot SET deleted_us = 6000 WHERE id = 2`);
    assert.equal(await sync.tick(), true);
    assert.deepEqual((await q("SELECT id FROM g_rating")).map((r) => Number(r.id)), [8]);
    assert.equal(await count("g_bot_stats"), 1);
    assert.equal(Number((await q("SELECT deleted_at FROM g_bot WHERE id = 2"))[0]!.deleted_at), 6000);

    // A pass with nothing new writes nothing and still succeeds.
    assert.equal(await sync.tick(), true);
  });
});
