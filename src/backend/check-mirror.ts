// Is RackForge's backend tracking the game? Prints the backend's newest mirrored
// auction against maincloud's (anonymous, read-only SQL), and, with
// --sqlite <path>, every table's row count against the miner's SQLite copy.
//
//   npx tsx src/backend/check-mirror.ts [--sqlite data/miner.sqlite] [--watch <seconds>]

import { createRequire } from "node:module";
import { sql } from "./client.js";

const MAINCLOUD = { uri: process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com", db: process.env.STDB_DB ?? "scrabblebot" };
const args = process.argv.slice(2);
const flag = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

async function backendMaxAuction(): Promise<number> {
  // No MAX() / ORDER BY in SpacetimeDB SQL: narrow from the newest match.
  const matches = await sql("SELECT match_id FROM g_match_mined");
  const top = Math.max(0, ...matches.map((r) => Number(r.match_id)));
  const rows = await sql(`SELECT auction_id FROM g_auction WHERE match_id >= ${Math.max(0, top - 50)}`);
  return Math.max(0, ...rows.map((r) => Number(r.auction_id)));
}

async function once(): Promise<void> {
  const bmax = await backendMaxAuction();
  const mc = await sql(`SELECT auction_id FROM auction_result WHERE auction_id > ${bmax}`, MAINCLOUD);
  const mmax = Math.max(bmax, ...mc.map((r) => Number(r.auction_id)));
  console.log(
    `${new Date().toISOString().slice(11, 19)} backend max auction_id ${bmax}; maincloud ${mmax}; behind by ${mc.length} auctions`,
  );
}

const sqlitePath = flag("--sqlite");
if (sqlitePath) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (p: string, o: { readOnly: boolean }) => { prepare(s: string): { all(): Record<string, unknown>[] } };
  };
  const lite = new DatabaseSync(sqlitePath, { readOnly: true });
  const PAIRS: [string, string][] = [
    ["bot", "g_bot"], ["bot_stats", "g_bot_stats"], ["retired_bot_stats", "g_retired_bot_stats"],
    ["bot_version", "g_bot_version"], ["match_state", "g_match"], ["match_participant", "g_participant"],
    ["auction_result", "g_auction"], ["auction_top_bid_archive", "g_top_bid"], ["word_play", "g_word"],
    ["rating_history", "g_rating"], ["match_mined", "g_match_mined"], ["match_info", "d_match_info"],
    ["match_seat", "d_match_seat"], ["auction_ctx", "d_auction_ctx"], ["bid_obs", "d_bid_obs"],
    ["play_obs", "d_play_obs"], ["bid_model", "bid_model"],
  ];
  for (const [lt, bt] of PAIRS) {
    const want = Number(lite.prepare(`SELECT COUNT(*) AS n FROM ${lt}`).all()[0]?.n ?? 0);
    const have = Number((await sql(`SELECT COUNT(*) AS n FROM ${bt}`))[0]?.n ?? 0);
    console.log(`  ${bt.padEnd(16)} sqlite ${String(want).padStart(9)}  backend ${String(have).padStart(9)}  ${have === want ? "ok" : `diff ${have - want}`}`);
  }
}
const watch = Number(flag("--watch") ?? 0);
await once();
if (watch > 0) {
  for (;;) {
    await new Promise((r) => setTimeout(r, watch * 1000));
    await once().catch((e) => console.log("check failed:", e instanceof Error ? e.message : e));
  }
}
process.exit(0);
