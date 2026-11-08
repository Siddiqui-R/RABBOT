// The bot's subscription queries. Named tables only, never
// subscribeToAllTables() and never visible_auction_top_bids.
//
// auction_result and word_play hold hundreds of thousands of rows, so the
// per-match tables are joined through our own match_participant rows and
// anchored: only matches with id > K. K moves forward after each match
// ends (subscribe the new set, then drop the old), so the cache holds the
// current match and nothing older. Because the joins follow our seat, a
// new match's first auction arrives in the same transaction as the seat.
//
// The other seats of a match are NOT joined: a self-join of
// match_participant only streams updates for the joining side's own row
// (measured live: opponents' balance and score never changed). They come
// from a per-match subscription instead, opened when we're seated.

/** Identity literal as SpacetimeDB SQL accepts it: 0x<64 hex>. */
export function identityLiteral(hex: string): string {
  const h = hex.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("bad identity hex");
  return `0x${h}`;
}

function id(n: bigint): string {
  if (n < 0n) throw new Error("negative id");
  return n.toString();
}

/** Who we are, and the small public tables a view needs. */
export function baseQueries(identityHex: string | null): string[] {
  const q = ["SELECT * FROM bot", "SELECT * FROM tournament"];
  if (identityHex) q.unshift(`SELECT * FROM bot_credential WHERE identity = ${identityLiteral(identityHex)}`);
  return q;
}

/** Once the bot id is known: our tournament entries (kept for the session). */
export function botQueries(botId: bigint): string[] {
  return [`SELECT * FROM tournament_entry WHERE bot_id = ${id(botId)}`];
}

/**
 * Every tournament's entries and match list: small public tables. Needed to
 * see a tournament we are not yet entered in (auto-registration) and to
 * build MatchView.tournament (standings of every entrant, which match is
 * which stage).
 */
export function tournamentQueries(): string[] {
  return ["SELECT * FROM tournament_entry", "SELECT * FROM tournament_match"];
}

/** Every seat we ever had, only to find the anchor; dropped once anchored. */
export function seatHistoryQuery(botId: bigint): string {
  return `SELECT * FROM match_participant WHERE bot_id = ${id(botId)}`;
}

/** A cheap query whose subscribe round trip measures RTT (the table is tiny). */
export const PROBE_QUERY = "SELECT * FROM matchmaker_config";

/** Everything about our matches with id > after. */
export function anchoredQueries(botId: bigint, after: bigint): string[] {
  const b = id(botId);
  const k = id(after);
  const via = (t: string, alias: string, col: string) =>
    `SELECT ${alias}.* FROM ${t} ${alias} JOIN match_participant p ON ${alias}.${col} = p.match_id WHERE p.bot_id = ${b} AND p.match_id > ${k}`;
  return [
    `SELECT * FROM match_participant WHERE bot_id = ${b} AND match_id > ${k}`,
    via("match_state", "m", "id"),
    via("auction", "a", "match_id"),
    via("auction_result", "r", "match_id"),
    via("word_play", "w", "match_id"),
  ];
}

/**
 * Our own tiles. Old matches keep their leftovers in my_rack, so it is
 * anchored too; it has its own handle so that, should the server ever
 * refuse a filter on a view, the bot can fall back to ALL_RACK.
 */
export function rackQuery(after: bigint): string {
  return `SELECT * FROM my_rack WHERE match_id > ${id(after)}`;
}

export const ALL_RACK = "SELECT * FROM my_rack";

/** Every seat of one match, with live balance and score. */
export function rosterQuery(matchId: bigint): string {
  return `SELECT * FROM match_participant WHERE match_id = ${id(matchId)}`;
}

/** Anchor that covers our latest seat (it may still be running). */
export function anchorFor(seatMatchIds: Iterable<bigint>): bigint {
  let max = 0n;
  for (const m of seatMatchIds) if (m > max) max = m;
  return max > 0n ? max - 1n : 0n;
}

export const FORBIDDEN_TABLES = ["visible_auction_top_bids"];

/** Guard: refuse to subscribe to anything on the forbidden list. */
export function assertAllowed(queries: readonly string[]) {
  for (const q of queries) {
    const lower = q.toLowerCase();
    for (const t of FORBIDDEN_TABLES) if (lower.includes(t)) throw new Error(`refusing to subscribe to ${t}`);
  }
}
