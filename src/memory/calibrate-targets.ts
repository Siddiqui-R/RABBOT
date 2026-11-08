// Calibration targets: what the real bots did in recent real matches, per
// seat-match, on the same STAT_KEYS that calibrate-sim.ts measures in clone
// replays, plus the seat compositions to replay and the live field.
//
//   loadTables(db, 3000)  ->  recent complete matches, oldest first, with
//                             every seat's real stats vector
//   targetsFor(tables)    ->  per-bot aggregated numbers (ratio of sums)
//   buildField(db)        ->  data/field.json contents

import { letterValue } from "../core/rules.js";
import { placesAndWins } from "../sim/stats.js";
import { num, openDb, type Db } from "./db.js";
import { HISTORY_DB } from "./calibrate-legacy.js";
import { S, STAT_KEYS } from "./calibrate-sim.js";
import { letterClass } from "./clones.js";

export interface RealTable {
  matchId: number;
  endedUs: number;
  /** Seat order as in the match; sims carry their server strategy. */
  seats: { botId: number; isSim: boolean; strategy: string | null }[];
  /** STAT_KEYS vector per seat, same order. */
  stats: number[][];
}

/** Recent complete matches (all auctions closed), oldest first. */
export function loadTables(db: Db, limit = 3000): RealTable[] {
  const ids = db
    .prepare(
      `SELECT match_id, ended_us FROM match_info WHERE n_auctions = expected_auctions AND ended_us IS NOT NULL
       ORDER BY match_id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({ id: num(r.match_id), ended: num(r.ended_us) }))
    .reverse();
  if (ids.length === 0) return [];
  const lo = ids[0]!.id;
  const want = new Set(ids.map((x) => x.id));
  const seatsBy = new Map<number, { botId: number; isSim: boolean; strategy: string | null; score: number; balance: number; tiles: number; paid: number; left: number }[]>();
  for (const r of db
    .prepare(
      `SELECT match_id, bot_id, is_sim, strategy, final_score, final_balance, won_tiles, paid_total, tiles_left
       FROM match_seat WHERE match_id >= ? ORDER BY match_id, bot_id`,
    )
    .all(lo)) {
    const m = num(r.match_id);
    if (!want.has(m)) continue;
    let a = seatsBy.get(m);
    if (!a) seatsBy.set(m, (a = []));
    a.push({
      botId: num(r.bot_id),
      isSim: num(r.is_sim) === 1,
      strategy: (r.strategy as string | null) ?? null,
      score: num(r.final_score),
      balance: num(r.final_balance),
      tiles: num(r.won_tiles),
      paid: num(r.paid_total),
      left: num(r.tiles_left),
    });
  }
  // Auctions: closing times (for play timing) and class counts of tiles won.
  const closes = new Map<number, number[]>();
  const won = new Map<string, { vowel: number; high: number }>();
  for (const r of db
    .prepare(`SELECT match_id, letter, winner_bot_id, closed_us FROM auction_result WHERE match_id >= ? AND deleted_us IS NULL ORDER BY match_id, closed_us`)
    .all(lo)) {
    const m = num(r.match_id);
    if (!want.has(m)) continue;
    let c = closes.get(m);
    if (!c) closes.set(m, (c = []));
    c.push(num(r.closed_us));
    if (r.winner_bot_id === null) continue;
    const key = `${m}:${num(r.winner_bot_id)}`;
    let w = won.get(key);
    if (!w) won.set(key, (w = { vowel: 0, high: 0 }));
    const k = letterClass(String(r.letter));
    if (k === 0) w.vowel++;
    else if (k === 3) w.high++;
  }
  const plays = new Map<string, { len: number; at: number }[]>();
  for (const r of db
    .prepare(`SELECT match_id, bot_id, word, played_us FROM word_play WHERE match_id >= ? AND deleted_us IS NULL`)
    .all(lo)) {
    const m = num(r.match_id);
    if (!want.has(m)) continue;
    const key = `${m}:${num(r.bot_id)}`;
    let p = plays.get(key);
    if (!p) plays.set(key, (p = []));
    p.push({ len: String(r.word).length, at: num(r.played_us) });
  }
  const out: RealTable[] = [];
  for (const { id, ended } of ids) {
    const seats = seatsBy.get(id);
    const cl = closes.get(id);
    if (!seats || seats.length < 2 || !cl) continue;
    const n = cl.length;
    const { place, winShare } = placesAndWins(seats.map((s) => s.score));
    const stats = seats.map((s, i) => {
      const v = new Array<number>(STAT_KEYS.length).fill(0);
      v[S.score] = s.score;
      v[S.place] = place[i]!;
      v[S.win] = winShare[i]!;
      v[S.tiles] = s.tiles;
      v[S.paid] = s.paid;
      v[S.coins] = s.balance;
      v[S.left] = s.left;
      const w = won.get(`${id}:${s.botId}`);
      v[S.vowel] = w?.vowel ?? 0;
      v[S.high] = w?.high ?? 0;
      for (const p of plays.get(`${id}:${s.botId}`) ?? []) {
        v[S.words]++;
        v[S.letters] += p.len;
        // Auctions closed before the play, as a fraction (binary search).
        let a = 0;
        let b = n;
        while (a < b) {
          const mid = (a + b) >> 1;
          if (cl[mid]! <= p.at) a = mid + 1;
          else b = mid;
        }
        v[S.phaseSum] += Math.min(1, a / n);
        const L = p.len;
        v[L >= 7 ? S.bingos : L === 6 ? S.l6 : L === 5 ? S.l5 : L === 4 ? S.l4 : S.l23]++;
      }
      return v;
    });
    out.push({ matchId: id, endedUs: ended, seats: seats.map(({ botId, isSim, strategy }) => ({ botId, isSim, strategy })), stats });
  }
  return out;
}

export function loadRecentTables(limit = 3000, dbPath = HISTORY_DB): RealTable[] {
  const db = openDb(dbPath, { readOnly: true });
  try {
    return loadTables(db, limit);
  } finally {
    db.close();
  }
}

/** Summary numbers reported and fitted, from summed stat vectors. */
export const SUMMARY_KEYS = ["score", "place", "win", "tiles", "price", "coins", "words", "wordLen", "bingos", "playPhase", "vowelShare", "highShare", "left"] as const;
export type SummaryKey = (typeof SUMMARY_KEYS)[number];

export interface Acc {
  n: number;
  sum: number[];
}
export const newAcc = (): Acc => ({ n: 0, sum: new Array<number>(STAT_KEYS.length).fill(0) });
export function addTo(a: Acc, v: readonly number[]): void {
  a.n++;
  for (let i = 0; i < v.length; i++) a.sum[i]! += v[i]!;
}

export function summarize(a: Acc): Record<SummaryKey, number> {
  const n = Math.max(1, a.n);
  const s = a.sum;
  const ratio = (x: number, y: number, d: number) => (y > 0 ? x / y : d);
  return {
    score: s[S.score]! / n,
    place: s[S.place]! / n,
    win: s[S.win]! / n,
    tiles: s[S.tiles]! / n,
    price: ratio(s[S.paid]!, s[S.tiles]!, 0),
    coins: s[S.coins]! / n,
    words: s[S.words]! / n,
    wordLen: ratio(s[S.letters]!, s[S.words]!, 0),
    bingos: s[S.bingos]! / n,
    playPhase: ratio(s[S.phaseSum]!, s[S.words]!, 0.5),
    vowelShare: ratio(s[S.vowel]!, s[S.tiles]!, 0),
    highShare: ratio(s[S.high]!, s[S.tiles]!, 0),
    left: s[S.left]! / n,
  };
}

/** Per real bot: accumulated stats over its seats in these tables. */
export function accumulate(tables: readonly RealTable[], stats: (t: RealTable, i: number) => number[][] = (t) => t.stats): Map<number, Acc> {
  const out = new Map<number, Acc>();
  tables.forEach((t, ti) => {
    const st = stats(t, ti);
    t.seats.forEach((s, i) => {
      if (s.isSim) return;
      let a = out.get(s.botId);
      if (!a) out.set(s.botId, (a = newAcc()));
      addTo(a, st[i]!);
    });
  });
  return out;
}

export const isHigh = (l: string) => letterValue(l) >= 5;

// ---------- the live field ----------

export interface FieldFile {
  note: string;
  generatedAt: string;
  /** Newest match in the source data, and the window and half-life used. */
  dataUntil: string;
  windowHours: number;
  halfLifeHours: number;
  /** Bots seen in the last activeHours; tables with anyone else are dropped. */
  activeHours: number;
  bots: Record<string, { name: string; seats: number; weight: number }>;
  /** Seat compositions (real bot ids; sims as 0) with recency weights summing to 1. */
  tables: { bots: number[]; weight: number }[];
  /**
   * Likely tournament entrants: active bots ranked by recent strength, the
   * recency-weighted share of real opponents they outscored (ties half) over
   * the window. Tournaments have no sims, so sims do not count here.
   */
  entrants?: Entrant[];
}

export interface Entrant {
  id: number;
  name: string;
  /** Real-opponent seats in the window. */
  seats: number;
  /** Recency-weighted share of real opponents outscored, 0..1. */
  beatShare: number;
  meanScore: number;
  meanPlace: number;
  /** Site rating (bot_stats), current version. */
  rating: number | null;
  /** Set by calibrate.ts: true when data/clones.json has fitted params for it. */
  fitted?: boolean;
}

/**
 * Ranks bots by recency-weighted share of real opponents outscored. Only bots
 * seen in the last activeHours with at least minSeats real-opponent seats.
 */
export function rankEntrants(
  rows: readonly { matchId: number; botId: number; isSim: boolean; score: number; place: number; ended: number }[],
  until: number,
  opts: { halfLifeHours: number; activeHours: number; minSeats: number; top: number; exclude?: ReadonlySet<number> },
): Omit<Entrant, "name" | "rating">[] {
  const byMatch = new Map<number, typeof rows[number][]>();
  for (const r of rows) {
    let m = byMatch.get(r.matchId);
    if (!m) byMatch.set(r.matchId, (m = []));
    m.push(r);
  }
  const acc = new Map<number, { n: number; w: number; beat: number; score: number; place: number; last: number }>();
  for (const seats of byMatch.values()) {
    const real = seats.filter((s) => !s.isSim);
    if (real.length < 2) continue;
    for (const s of real) {
      let beat = 0;
      for (const o of real) if (o !== s) beat += s.score > o.score ? 1 : s.score === o.score ? 0.5 : 0;
      const w = 0.5 ** ((until - s.ended) / (opts.halfLifeHours * 3600e6));
      let a = acc.get(s.botId);
      if (!a) acc.set(s.botId, (a = { n: 0, w: 0, beat: 0, score: 0, place: 0, last: 0 }));
      a.n++;
      a.w += w;
      a.beat += (w * beat) / (real.length - 1);
      a.score += s.score;
      a.place += s.place;
      a.last = Math.max(a.last, s.ended);
    }
  }
  return [...acc.entries()]
    .filter(([id, a]) => a.n >= opts.minSeats && a.last >= until - opts.activeHours * 3600e6 && !opts.exclude?.has(id))
    .map(([id, a]) => ({
      id,
      seats: a.n,
      beatShare: Number((a.beat / a.w).toFixed(4)),
      meanScore: Number((a.score / a.n).toFixed(1)),
      meanPlace: Number((a.place / a.n).toFixed(2)),
    }))
    .sort((x, y) => y.beatShare - x.beatShare || x.id - y.id)
    .slice(0, opts.top);
}

export function buildField(
  db: Db,
  windowHours = 24,
  halfLifeHours = 6,
  activeHours = 6,
  entrantOpts: { top?: number; minSeats?: number; exclude?: ReadonlySet<number> } = {},
): FieldFile {
  const until = num(db.prepare(`SELECT max(ended_us) AS t FROM match_info`).get()?.t ?? 0);
  const from = until - windowHours * 3600e6;
  const names = new Map<number, string>();
  for (const r of db.prepare(`SELECT id, name FROM bot`).all()) names.set(num(r.id), String(r.name));
  const rows = db
    .prepare(
      `SELECT s.match_id, s.bot_id, s.is_sim, s.final_score, s.place, i.ended_us FROM match_seat s JOIN match_info i ON i.match_id = s.match_id
       WHERE i.ended_us >= ? AND i.n_auctions = i.expected_auctions ORDER BY s.match_id, s.bot_id`,
    )
    .all(from);
  const byMatch = new Map<number, { ended: number; bots: number[] }>();
  const lastSeen = new Map<number, number>();
  for (const r of rows) {
    const m = num(r.match_id);
    const ended = num(r.ended_us);
    let t = byMatch.get(m);
    if (!t) byMatch.set(m, (t = { ended, bots: [] }));
    const id = num(r.is_sim) === 1 ? 0 : num(r.bot_id);
    t.bots.push(id);
    if (id) lastSeen.set(id, Math.max(lastSeen.get(id) ?? 0, ended));
  }
  const active = (id: number) => id === 0 || (lastSeen.get(id) ?? 0) >= until - activeHours * 3600e6;
  const tables: { bots: number[]; weight: number }[] = [];
  for (const t of byMatch.values()) {
    if (!t.bots.every(active)) continue;
    tables.push({ bots: t.bots, weight: 0.5 ** ((until - t.ended) / (halfLifeHours * 3600e6)) });
  }
  const total = tables.reduce((a, t) => a + t.weight, 0) || 1;
  const bots: FieldFile["bots"] = {};
  for (const t of tables) {
    t.weight = Number((t.weight / total).toPrecision(4));
    for (const id of t.bots) {
      if (!id) continue;
      const b = (bots[String(id)] ??= { name: names.get(id) ?? `#${id}`, seats: 0, weight: 0 });
      b.seats++;
      b.weight += t.weight;
    }
  }
  for (const b of Object.values(bots)) b.weight = Number(b.weight.toFixed(4));
  const ratings = new Map<number, number | null>();
  for (const r of db.prepare(`SELECT bot_id, rating FROM bot_stats`).all()) ratings.set(num(r.bot_id), r.rating === null ? null : num(r.rating));
  const entrants = rankEntrants(
    rows.map((r) => ({
      matchId: num(r.match_id),
      botId: num(r.bot_id),
      isSim: num(r.is_sim) === 1,
      score: num(r.final_score),
      place: num(r.place),
      ended: num(r.ended_us),
    })),
    until,
    { halfLifeHours: halfLifeHours * 2, activeHours, minSeats: entrantOpts.minSeats ?? 30, top: entrantOpts.top ?? 16, exclude: entrantOpts.exclude },
  ).map((e) => ({ ...e, name: names.get(e.id) ?? `#${e.id}`, rating: ratings.get(e.id) ?? null }));
  return {
    note: "Recent real seat compositions (bot ids; 0 = server sim). Replace one seat with RackForge to test against the field as it plays now.",
    generatedAt: new Date().toISOString(),
    dataUntil: new Date(until / 1000).toISOString(),
    windowHours,
    halfLifeHours,
    activeHours,
    bots,
    tables,
    entrants,
  };
}

/** Weighted sample of field tables (deterministic for a seed). */
export function sampleField(f: FieldFile, n: number, rng: () => number): number[][] {
  const cum: number[] = [];
  let acc = 0;
  for (const t of f.tables) cum.push((acc += t.weight));
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const x = rng() * acc;
    let a = 0;
    let b = cum.length - 1;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (cum[mid]! < x) a = mid + 1;
      else b = mid;
    }
    out.push(f.tables[a]!.bots);
  }
  return out;
}
