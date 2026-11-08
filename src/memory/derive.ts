// Turns mined raw rows into per-auction facts the model can learn from.
//
// For every ended match it replays the public event stream (auction results
// and word plays, in server time order) to reconstruct each seat's balance
// and rack size at every auction, then records what each real bot's sealed
// bid is known to be:
//   - it won:            bid = top_bid exactly (the archive is public);
//   - nobody won:        bid = 0 (bids of 0 don't count, so nobody bid);
//   - it lost:           bid <= paid (Vickrey: paid is the runner-up's bid);
//     and if it was the only loser who could have bid `paid` (every sim
//     loser's formula caps below it), bid = paid exactly.
//
// Balance timing: sims bid at auction open with the balance after the
// previous close (their own plays happen inside that close). Live bots can
// play mid-auction, so the bid cap is the balance just before close.

import { LETTER_VALUES, SIM_BID_JITTER, STARTING_BALANCE, BAG_SIZE } from "../core/rules.js";
import { num, numOrNull, tx, type Db, type Stmt } from "./db.js";

export const KIND_EQ = 0;
export const KIND_LE = 1;
export const KIND_GE = 2;

export type SimStrategy = "Cheapskate" | "ValueBidder" | "Aggressive" | "Human";

/** The server's sim bid before jitter (game.ts decideBid). */
export function simBase(strategy: string, letter: string): number | null {
  const value = LETTER_VALUES[letter.charCodeAt(0) - 65] ?? 0;
  switch (strategy) {
    case "Cheapskate":
      return value - 1;
    case "ValueBidder":
      return value;
    case "Aggressive":
      return value + ("AEIOU".includes(letter) ? 4 : 2);
    default:
      return null; // Human: bids 0
  }
}

/** clamp(base + jitter, 1, balance), floored at 0, as the server does. */
export function simBid(base: number, jitter: number, balance: number): number {
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

export interface DeriveStats {
  matches: number;
  bidObs: number;
  playObs: number;
  balanceMismatches: number;
  simFormulaViolations: number;
  runnerUpExact: number;
}

interface BotInfo {
  isSim: boolean;
  strategy: string;
}

interface Seat {
  botId: number;
  isSim: boolean;
  strategy: string;
  version: number;
  balance: number;
  rack: number;
  score: number;
  wonTiles: number;
  paidTotal: number;
  words: number;
  lettersPlayed: number;
}

/** Version a bot was on when a match was created (game.ts versionAt). */
export function versionAt(versions: { version: number; startedUs: number }[] | undefined, createdUs: number): number {
  let v = 1;
  for (const r of versions ?? []) if (r.startedUs <= createdUs) v = Math.max(v, r.version);
  return v;
}

export function deriveAll(db: Db, opts: { rebuild?: boolean; matchIds?: number[] } = {}): DeriveStats {
  const stats: DeriveStats = {
    matches: 0,
    bidObs: 0,
    playObs: 0,
    balanceMismatches: 0,
    simFormulaViolations: 0,
    runnerUpExact: 0,
  };
  const bots = new Map<number, BotInfo>();
  for (const r of db.prepare("SELECT id, is_simulated, strategy FROM bot").all()) {
    bots.set(num(r.id), { isSim: num(r.is_simulated) === 1, strategy: String(r.strategy) });
  }
  const versions = new Map<number, { version: number; startedUs: number }[]>();
  for (const r of db.prepare("SELECT bot_id, version, started_us FROM bot_version").all()) {
    const id = num(r.bot_id);
    if (!versions.has(id)) versions.set(id, []);
    versions.get(id)!.push({ version: num(r.version), startedUs: num(r.started_us) });
  }

  let ids: number[];
  if (opts.matchIds) ids = opts.matchIds;
  else {
    const sql = opts.rebuild
      ? `SELECT m.id FROM match_state m JOIN match_mined mm ON mm.match_id = m.id
         WHERE mm.complete = 1 AND m.status = 'Ended' ORDER BY m.id`
      : `SELECT m.id FROM match_state m JOIN match_mined mm ON mm.match_id = m.id
         LEFT JOIN match_info mi ON mi.match_id = m.id
         WHERE mm.complete = 1 AND m.status = 'Ended'
           AND (mi.match_id IS NULL OR mi.derived_us < mm.mined_us) ORDER BY m.id`;
    ids = db.prepare(sql).all().map((r) => num(r.id));
  }
  if (ids.length === 0) return stats;

  const q = {
    match: db.prepare("SELECT * FROM match_state WHERE id = ?"),
    seats: db.prepare("SELECT bot_id, balance, score FROM match_participant WHERE match_id = ? ORDER BY id"),
    results: db.prepare(
      "SELECT auction_id, letter, winner_bot_id, paid, closed_us FROM auction_result WHERE match_id = ? ORDER BY auction_id",
    ),
    archive: db.prepare("SELECT auction_id, top_bid FROM auction_top_bid_archive WHERE match_id = ?"),
    words: db.prepare(
      "SELECT id, bot_id, word, total_reward, played_us FROM word_play WHERE match_id = ? ORDER BY played_us, id",
    ),
  };
  const w = {
    // bid_obs and play_obs are keyed by auction / word, so reach them
    // through indexed parents rather than scanning for match_id.
    clear: [
      "DELETE FROM bid_obs WHERE auction_id IN (SELECT auction_id FROM auction_result WHERE match_id = ?)",
      "DELETE FROM play_obs WHERE word_id IN (SELECT id FROM word_play WHERE match_id = ?)",
      "DELETE FROM auction_ctx WHERE match_id = ?",
      "DELETE FROM match_seat WHERE match_id = ?",
      "DELETE FROM match_info WHERE match_id = ?",
    ].map((sql) => db.prepare(sql)),
    info: db.prepare(
      `INSERT INTO match_info (match_id, n_seats, n_real, n_auctions, expected_auctions, auction_type,
       created_us, ended_us, balance_ok, derived_us) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ),
    seat: db.prepare(
      `INSERT INTO match_seat (match_id, bot_id, is_sim, strategy, version, final_score, final_balance, place,
       won_tiles, paid_total, words, letters_played, tiles_left, ended_us) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    ctx: db.prepare(
      `INSERT INTO auction_ctx (auction_id, match_id, round_idx, n_auctions, phase, letter, winner_bot_id,
       winner_is_sim, paid, top_bid, closed_us, ended_us, sim_q) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    bid: db.prepare(
      `INSERT INTO bid_obs (auction_id, bot_id, match_id, letter, round_idx, phase, balance, cap, rack_size,
       kind, value, won, others_max, version, ended_us) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    play: db.prepare(
      `INSERT INTO play_obs (word_id, match_id, bot_id, is_sim, word, len, reward, round_idx, phase,
       rack_before, balance_before, ended_us) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
  };

  const nowUs = Date.now() * 1000;
  // Batches keep each write transaction short so readers never wait long.
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    tx(db, () => {
      for (const id of batch) {
        for (const c of w.clear) c.run(id);
        deriveMatch(id, q, w, bots, versions, nowUs, stats);
      }
    });
  }
  return stats;
}

function deriveMatch(
  matchId: number,
  q: Record<"match" | "seats" | "results" | "archive" | "words", Stmt>,
  w: { info: Stmt; seat: Stmt; ctx: Stmt; bid: Stmt; play: Stmt },
  bots: Map<number, BotInfo>,
  versions: Map<number, { version: number; startedUs: number }[]>,
  nowUs: number,
  stats: DeriveStats,
): void {
  const m = q.match.get(matchId);
  if (!m) return;
  const createdUs = num(m.created_us);
  const endedUs = num(m.ended_us) || num(m.created_us);
  const startUs = num(m.started_us) || createdUs;
  const rackSize = num(m.starting_rack_size) || 5;
  const vickrey = String(m.auction_type) !== "FirstPrice";

  const parts = q.seats.all(matchId);
  const seats: Seat[] = parts.map((p) => {
    const botId = num(p.bot_id);
    const info = bots.get(botId);
    return {
      botId,
      isSim: info?.isSim ?? false,
      strategy: info?.strategy ?? "Human",
      version: versionAt(versions.get(botId), createdUs),
      balance: STARTING_BALANCE,
      rack: rackSize,
      score: 0,
      wonTiles: 0,
      paidTotal: 0,
      words: 0,
      lettersPlayed: 0,
    };
  });
  const byBot = new Map(seats.map((s) => [s.botId, s]));
  const results = q.results.all(matchId);
  const top = new Map<number, number>();
  for (const r of q.archive.all(matchId)) top.set(num(r.auction_id), num(r.top_bid));
  const words = q.words.all(matchId);
  const n = results.length;
  const expected = BAG_SIZE - seats.length * rackSize;

  let wi = 0;
  const applyWordsBefore = (limitUs: number, inclusive: boolean, roundIdx: number) => {
    while (wi < words.length) {
      const wr = words[wi]!;
      const at = num(wr.played_us);
      if (inclusive ? at > limitUs : at >= limitUs) break;
      wi++;
      const s = byBot.get(num(wr.bot_id));
      if (!s) continue;
      const word = String(wr.word);
      const reward = num(wr.total_reward);
      w.play.run(
        num(wr.id), matchId, s.botId, s.isSim ? 1 : 0, word, word.length, reward, roundIdx,
        n > 0 ? Math.min(roundIdx / n, 1) : 0, s.rack, s.balance, endedUs,
      );
      stats.playObs++;
      s.balance += reward;
      s.score += reward;
      s.rack -= word.length;
      s.words++;
      s.lettersPlayed += word.length;
    }
  };

  for (let k = 0; k < n; k++) {
    const r = results[k]!;
    const auctionId = num(r.auction_id);
    const letter = String(r.letter);
    const closedUs = num(r.closed_us);
    const opensUs = k === 0 ? startUs : num(results[k - 1]!.closed_us);
    const phase = k / n;

    // Plays up to the open (sims play inside the previous close).
    applyWordsBefore(opensUs, true, k);
    const balOpen = new Map(seats.map((s) => [s.botId, s.balance]));
    const rackOpen = new Map(seats.map((s) => [s.botId, s.rack]));
    // Plays during this auction's window raise the cap on a live bid.
    applyWordsBefore(closedUs, false, k);

    const winner = numOrNull(r.winner_bot_id);
    const paid = num(r.paid);
    const topBid = top.get(auctionId);
    const ws = winner === null ? undefined : byBot.get(winner);

    // Sim bids are a known formula: use it to check our replay and to
    // tell whether a real loser must have been the runner-up.
    const simRange = (s: Seat) => {
      const base = simBase(s.strategy, letter);
      if (base === null) return [0, 0] as const;
      const bal = balOpen.get(s.botId)!;
      return [simBid(base, -SIM_BID_JITTER, bal), simBid(base, SIM_BID_JITTER, bal)] as const;
    };
    // P(every sim loser bid below paid | each bid at most paid): the sims'
    // share of the runner-up question the model's EM step asks.
    let simQ = 1;
    for (const s of seats) {
      if (!s.isSim || s.botId === winner) continue;
      const base = simBase(s.strategy, letter);
      if (base === null) continue;
      const bal = balOpen.get(s.botId)!;
      let atMost = 0;
      let below = 0;
      for (let j = -SIM_BID_JITTER; j <= SIM_BID_JITTER; j++) {
        const b = simBid(base, j, bal);
        if (b <= paid) atMost++;
        if (b < paid) below++;
      }
      if (atMost > 0) simQ *= below / atMost;
    }
    w.ctx.run(
      auctionId, matchId, k, n, phase, letter, winner, ws ? (ws.isSim ? 1 : 0) : null, paid,
      topBid ?? null, closedUs, endedUs, simQ,
    );
    if (ws?.isSim && topBid !== undefined) {
      const [lo, hi] = simRange(ws);
      if (topBid < lo || topBid > hi) stats.simFormulaViolations++;
    }
    const realLosers = seats.filter((s) => !s.isSim && s.botId !== winner);
    const simLoserMax = Math.max(0, ...seats.filter((s) => s.isSim && s.botId !== winner).map((s) => simRange(s)[1]));

    for (const s of seats) {
      if (s.isSim) continue;
      let kind: number;
      let value: number;
      let othersMax: number | null;
      if (winner === null) {
        kind = KIND_EQ;
        value = 0;
        othersMax = 0;
      } else if (s.botId === winner) {
        if (topBid !== undefined) {
          kind = KIND_EQ;
          value = topBid;
        } else {
          kind = KIND_GE;
          value = paid;
        }
        othersMax = paid;
      } else {
        othersMax = topBid ?? null;
        if (vickrey && paid >= 2 && realLosers.length === 1 && simLoserMax < paid) {
          kind = KIND_EQ;
          value = paid;
          stats.runnerUpExact++;
        } else {
          kind = KIND_LE;
          value = paid;
        }
      }
      const bal = balOpen.get(s.botId)!;
      // The cap can't be below a bid the server accepted.
      const cap = Math.max(s.balance, kind === KIND_EQ ? value : 0);
      w.bid.run(
        auctionId, s.botId, matchId, letter, k, phase, bal, cap, rackOpen.get(s.botId)!, kind, value,
        s.botId === winner ? 1 : 0, othersMax, s.version, endedUs,
      );
      stats.bidObs++;
    }

    if (ws) {
      ws.balance -= paid;
      ws.rack += 1;
      ws.wonTiles++;
      ws.paidTotal += paid;
    }
  }
  // Sims may play inside the final close; live bots can't play after it.
  applyWordsBefore(Number.MAX_SAFE_INTEGER, true, n);

  let ok = 1;
  const finalScore = new Map<number, number>();
  for (const p of parts) {
    const s = byBot.get(num(p.bot_id))!;
    finalScore.set(s.botId, num(p.score));
    if (s.balance !== num(p.balance) || s.score !== num(p.score)) ok = 0;
  }
  if (!ok) stats.balanceMismatches++;
  const nReal = seats.filter((s) => !s.isSim).length;
  w.info.run(matchId, seats.length, nReal, n, expected, String(m.auction_type), createdUs, endedUs, ok, nowUs);
  for (const s of seats) {
    const score = finalScore.get(s.botId) ?? s.score;
    let better = 0;
    for (const v of finalScore.values()) if (v > score) better++;
    w.seat.run(
      matchId, s.botId, s.isSim ? 1 : 0, s.strategy, s.version, score, s.balance, better + 1, s.wonTiles,
      s.paidTotal, s.words, s.lettersPlayed, s.rack, endedUs,
    );
  }
  stats.matches++;
}
