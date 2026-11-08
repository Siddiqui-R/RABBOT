// Tournament bookkeeping for the live session, kept pure so it can be
// tested without a connection (server: spacetimedb/src/tournament.ts and
// the tournament reducers in index.ts).
//
// - Auto-registration: every tournament in Registration that RABBOT has no
//   entry in gets one register_for_tournament call, retried with backoff
//   while it is refused. Registration is idempotent on the server. RABBOT
//   never unregisters.
// - Lobby: once a tournament RABBOT is still in has started, join_lobby is
//   refused until RABBOT is knocked out or it ends. A refusal backs the lobby
//   off instead of retrying every tick.
// - Final: the brain's context needs the earlier final games' seats, so
//   the session subscribes to those matches' match_participant rows.

type Id = bigint;
type Tag = { tag: string };

export interface TourRow {
  id: Id;
  status: Tag;
}
export interface EntryRow {
  tournamentId: Id;
  botId: Id;
  eliminated: boolean;
}
export interface TMatchRow {
  tournamentId: Id;
  matchId: Id;
  phase: Tag;
}

/** Tournaments taking registrations that `botId` is not entered in, oldest first. */
export function toRegister(tournaments: Iterable<TourRow>, entries: Iterable<EntryRow>, botId: Id): Id[] {
  const mine = new Set<Id>();
  for (const e of entries) if (e.botId === botId) mine.add(e.tournamentId);
  const out: Id[] = [];
  for (const t of tournaments) if (t.status.tag === "Registration" && !mine.has(t.id)) out.push(t.id);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Delay before retry `attempt` (1-based) of a refused registration: 2 s doubling, at most 60 s. */
export function registerBackoffMs(attempt: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, attempt - 1));
}

/** Delay before the next join_lobby after a refusal. */
export const LOBBY_REFUSED_BACKOFF_MS = 30_000;

/** join_lobby refused because RABBOT is held for a tournament under way. */
export function isTournamentHold(err: string): boolean {
  return /tournament/i.test(err);
}

const UNDER_WAY = new Set(["Swiss", "Bracket", "Final"]);

/** A tournament `botId` is still in contention in has started: stay out of the lobby. */
export function heldBy(tournaments: Iterable<TourRow>, entries: Iterable<EntryRow>, botId: Id): Id | null {
  const status = new Map<Id, string>();
  for (const t of tournaments) status.set(t.id, t.status.tag);
  for (const e of entries) {
    if (e.botId !== botId || e.eliminated) continue;
    if (UNDER_WAY.has(status.get(e.tournamentId) ?? "")) return e.tournamentId;
  }
  return null;
}

/** Final-game match ids of the tournaments `botId` is entered in (whose seats the context needs). */
export function finalMatchIds(matches: Iterable<TMatchRow>, entries: Iterable<EntryRow>, botId: Id): Id[] {
  const mine = new Set<Id>();
  for (const e of entries) if (e.botId === botId) mine.add(e.tournamentId);
  const out: Id[] = [];
  for (const m of matches) if (m.phase.tag === "Final" && mine.has(m.tournamentId)) out.push(m.matchId);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
