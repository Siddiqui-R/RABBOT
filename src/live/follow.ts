// Dry run: pick a live match to follow and a seat to watch it from, with
// anonymous read-only SQL. Prefers the freshest running match (most
// auctions left) and a real (non-simulated) bot's seat.

import { sql } from "./http.js";

export interface FollowPick {
  matchId: bigint;
  botId: bigint;
  name: string;
  round: number;
}

export async function pickMatchToFollow(
  host: string,
  db: string,
  want: { matchId?: bigint; botId?: bigint } = {},
): Promise<FollowPick | null> {
  let matchId = want.matchId;
  let round = 0;
  if (matchId === undefined && want.botId === undefined) {
    const since = new Date(Date.now() - 3 * 60_000).toISOString();
    const recent = await sql(host, db, `SELECT id, status, current_round FROM match_state WHERE created_at > '${since}'`);
    const running = recent
      .filter((m) => m.status === "running")
      .sort((a, b) => Number(a.current_round) - Number(b.current_round));
    if (!running.length) return null;
    matchId = BigInt(running[0]!.id as number);
    round = Number(running[0]!.current_round);
  }

  const bots = new Map<string, { name: string; sim: boolean }>();
  for (const b of await sql(host, db, "SELECT id, name, is_simulated FROM bot")) {
    bots.set(String(b.id), { name: String(b.name), sim: b.is_simulated === true });
  }

  if (want.botId !== undefined && matchId === undefined) {
    const b = bots.get(String(want.botId));
    return { matchId: 0n, botId: want.botId, name: b?.name ?? "?", round: 0 };
  }

  const seats = await sql(host, db, `SELECT bot_id FROM match_participant WHERE match_id = ${matchId}`);
  const ids = seats.map((s) => String(s.bot_id));
  if (!ids.length) return null;
  const chosen =
    want.botId !== undefined ? String(want.botId) : (ids.find((id) => !bots.get(id)?.sim) ?? ids[0]!);
  if (round === 0) {
    const m = await sql(host, db, `SELECT current_round FROM match_state WHERE id = ${matchId}`);
    round = Number(m[0]?.current_round ?? 0);
  }
  return { matchId: matchId!, botId: BigInt(chosen), name: bots.get(chosen)?.name ?? "?", round };
}
