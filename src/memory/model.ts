// Opponent model: everything RABBOT knows about who it's bidding
// against, loaded from data/history.sqlite.
//
//   const model = loadOpponentModel();
//   model.predictBid(botId, "E", { phase: 0.3, balance: 140 }).quantile(0.9)
//
// Sims use the server's exact formula. Real bots use the censored bid model
// from fit.ts, shrunk toward the market; unknown or new bots get the market.
// Phase is the fraction of the match's auctions already closed:
// phaseOf(round, totalAuctions) for a live MatchView.
//
// Nothing here ever blocks on a fit inside predictBid: fits happen in
// loadOpponentModel / refresh / fitAndPersist (the miner persists them).

import * as fs from "node:fs";
import { LETTER_VALUES, SIM_BID_JITTER } from "../core/rules.js";
import { DEFAULT_DB_PATH, getMeta, num, openDb, type Db } from "./db.js";
import { backendSnapshotDb, keepOpen, parseBackendPath } from "../backend/model-source.js";
import { simBase, simBid, versionAt } from "./derive.js";
import { bidPmf, defaultParams, phaseBucket, type BidParams } from "./fit.js";
import {
  DEFAULT_CONFIG,
  fitAll,
  fitOneBot,
  loadBots,
  readStoredFits,
  type BotMeta,
  type ModelConfig,
  type StoredFit,
} from "./train.js";

export type Strategy = "Cheapskate" | "ValueBidder" | "Aggressive" | "Human" | "unknown";

export interface BidContext {
  /** Fraction of the match's auctions already closed, 0..1. */
  phase: number;
  /** The bidder's balance: a bid can't exceed it. */
  balance: number;
  rackSize?: number;
}

export interface BidDistribution {
  mean: number;
  sd: number;
  /** P(bid = 0): the bot sits this letter out. */
  pZero: number;
  /** Smallest bid b with P(bid <= b) >= p. */
  quantile(p: number): number;
  sample(rng: () => number): number;
  /** P(bid <= x). */
  cdf(x: number): number;
  /** P(bid = x) for x = 0..balance. */
  pmf: Float64Array;
  /** Where the prediction came from. */
  source: "sim" | "bot" | "market";
}

export interface PriceDistribution {
  letter: string;
  phase: number;
  /** Auctions this is built from (sold or not). */
  n: number;
  /** Share of auctions where nobody bid (the tile is discarded). */
  pUnsold: number;
  /** Clearing price (what the winner paid), over sold auctions. */
  mean: number;
  sd: number;
  quantile(p: number): number;
  /** Winning (top) bids, over sold auctions with an archived top bid. */
  topBid: { mean: number; quantile(p: number): number };
}

export interface BotSummary {
  botId: number;
  name: string;
  strategy: Strategy;
  isSim: boolean;
  version: number;
  /** Site rating (OpenSkill mu on the Elo-like scale) and its +-. */
  rating: number | null;
  ratingSpread: number | null;
  matches: number;
  matchesCurrentVersion: number;
  wins: number;
  winRate: number;
  meanPlace: number;
  meanScore: number;
  lastPlayedUs: number | null;
  bidObs: number;
  exactBids: number;
  censoredBids: number;
  wordsPlayed: number;
  meanWordLength: number;
  wordsPerMatch: number;
  /** Mean tiles still on the rack at match end (held, never scored). */
  tilesLeftAtEnd: number;
  /** Share of tiles it won that it later played. */
  playThrough: number;
  meanRackBeforePlay: number;
  /** Mean predicted bid / market's, over all letters at a reference context. */
  aggressiveness: number;
  /** Mean winning bid / market clearing price on the letters it won. */
  paidVsMarket: number;
  hasFit: boolean;
}

export interface PlayHabits {
  /** P(word length = L), L = 2..15 (index = length). */
  lengthDist: number[];
  /** Rack sizes just before the bot played, as a sorted sample. */
  rackBeforePlay: number[];
  wordsPerMatch: number;
  tilesLeftAtEnd: number;
  /** Phase of its plays, sorted sample. */
  playPhases: number[];
  /** Recent plays, newest first: word length, rack size just before, phase. */
  plays: { len: number; rack: number; phase: number }[];
  matches: number;
}

export interface OpponentModel {
  strategyOf(botId: number): Strategy;
  predictBid(botId: number, letter: string, ctx: BidContext): BidDistribution;
  marketPrice(letter: string, phase: number): PriceDistribution;
  botSummary(botId: number): BotSummary;
  playHabits(botId: number): PlayHabits;
  /** Reload from the DB, refitting stale bots within a time budget. */
  refresh(opts?: { budgetMs?: number; botIds?: number[] }): void;
  /** Newest observation the model has seen (server micros). */
  readonly dataUs: number;
  knownBots(): number[];
}

export const phaseOf = (round: number, totalAuctions: number): number =>
  totalAuctions > 0 ? Math.max(0, Math.min(1, (round - 1) / totalAuctions)) : 0;

const letterIdx = (l: string) => l.toUpperCase().charCodeAt(0) - 65;

// ---------- discrete distributions ----------

export function distFromPmf(pmf: Float64Array, source: BidDistribution["source"]): BidDistribution {
  let total = 0;
  for (const p of pmf) total += p;
  if (!(total > 0)) {
    pmf = Float64Array.of(1);
    total = 1;
  }
  const cum = new Float64Array(pmf.length);
  let acc = 0;
  let mean = 0;
  let m2 = 0;
  for (let x = 0; x < pmf.length; x++) {
    const p = pmf[x]! / total;
    acc += p;
    cum[x] = acc;
    mean += x * p;
    m2 += x * x * p;
  }
  const quantile = (p: number) => {
    const t = Math.max(0, Math.min(1, p)) * acc;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! >= t - 1e-12 && cum[mid]! > 1e-15) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  return {
    mean,
    sd: Math.sqrt(Math.max(0, m2 - mean * mean)),
    pZero: pmf[0]! / total,
    quantile,
    sample: (rng) => quantile(rng()),
    cdf: (x) => (x < 0 ? 0 : x >= cum.length - 1 ? 1 : cum[Math.floor(x)]! / acc),
    pmf,
    source,
  };
}

/** The server's sim bid distribution: clamp(base + U{-2..2}, 1, balance). */
export function simBidDist(strategy: string, letter: string, balance: number): BidDistribution {
  const cap = Math.max(0, Math.floor(balance));
  const pmf = new Float64Array(cap + 1);
  const base = simBase(strategy, letter.toUpperCase());
  if (base === null || cap === 0) pmf[0] = 1;
  else {
    const n = 2 * SIM_BID_JITTER + 1;
    for (let j = -SIM_BID_JITTER; j <= SIM_BID_JITTER; j++) pmf[simBid(base, j, cap)]! += 1 / n;
  }
  return distFromPmf(pmf, "sim");
}

function empirical(values: number[]): { mean: number; sd: number; quantile(p: number): number } {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  const mean = n ? v.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / n) : 0;
  return {
    mean,
    sd,
    quantile: (p) => (n ? v[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]! : 0),
  };
}

export { DEFAULT_CONFIG, fitAndPersist, type ModelConfig } from "./train.js";

// ---------- the model ----------

const ELO_SCALE = 400 / (Math.LN10 * (25 / 6) * Math.SQRT2);
const skill = (mu: number) => Math.round(1500 + ELO_SCALE * (mu - 25));
const spread = (sigma: number) => Math.round(ELO_SCALE * sigma);

const REF_CTX: BidContext = { phase: 0.3, balance: 100 };

class Model implements OpponentModel {
  private bots = new Map<number, BotMeta>();
  private fits = new Map<number, StoredFit>();
  private market: BidParams = defaultParams(LETTER_VALUES);
  private hasMarket = false;
  private marketDataUs = 0;
  private priceCache = new Map<string, PriceDistribution>();
  private summaryCache = new Map<number, BotSummary>();
  private habitCache = new Map<number, PlayHabits>();
  private predictCache = new Map<string, BidDistribution>();
  dataUs = 0;
  /** dbPath "stdb:[db[@uri]]": an in-memory copy of the backend's tables. */
  private mem?: Db;

  constructor(
    private dbPath: string,
    private cfg: ModelConfig,
  ) {}

  private open(): Db | undefined {
    const be = parseBackendPath(this.dbPath);
    if (be) {
      if (!this.mem) {
        try {
          this.mem = keepOpen(backendSnapshotDb(be));
        } catch (e) {
          console.warn(`[memory] backend model data unavailable: ${e instanceof Error ? e.message : e}`);
          return undefined;
        }
      }
      return this.mem;
    }
    if (!fs.existsSync(this.dbPath)) return undefined;
    try {
      return openDb(this.dbPath, { readOnly: true });
    } catch {
      return undefined;
    }
  }

  refresh(opts: { budgetMs?: number; botIds?: number[] } = {}): void {
    this.mem = undefined; // backend source: reload the snapshot
    const db = this.open();
    this.priceCache.clear();
    this.summaryCache.clear();
    this.habitCache.clear();
    this.predictCache.clear();
    if (!db) return;
    try {
      this.bots = loadBots(db);
      const stored = readStoredFits(db);
      for (const [id, f] of stored.bots) {
        const mine = this.fits.get(id);
        if (!mine || mine.dataUs <= f.dataUs) this.fits.set(id, f);
      }
      // The miner refits and persists periodically: adopt newer fits.
      if (stored.market && stored.market.dataUs >= this.marketDataUs) {
        this.market = stored.market.params;
        this.marketDataUs = stored.market.dataUs;
        this.hasMarket = true;
      }
      const latest = new Map<number, { n: number; maxUs: number }>();
      for (const r of db.prepare("SELECT bot_id, COUNT(*) AS n, MAX(ended_us) AS m FROM bid_obs GROUP BY bot_id").all()) {
        latest.set(num(r.bot_id), { n: num(r.n), maxUs: num(r.m) });
      }
      for (const v of latest.values()) this.dataUs = Math.max(this.dataUs, v.maxUs);
      if (!this.hasMarket && latest.size > 0) {
        // No persisted fit at all: fit the market now (a few seconds).
        const r = fitAll(db, { ...this.cfg, emRounds: Math.min(this.cfg.emRounds, 1) });
        this.market = r.market;
        this.marketDataUs = r.refUs;
        this.hasMarket = true;
        for (const [id, f] of r.bots) this.fits.set(id, f);
        return;
      }
      // Refit bots whose data grew a lot since their fit, priority first.
      const stale: number[] = [];
      for (const [id, v] of latest) {
        if (this.bots.get(id)?.isSim) continue;
        const f = this.fits.get(id);
        if (!f || v.n - f.nObs >= Math.max(150, 0.15 * f.nObs)) stale.push(id);
      }
      const prio = new Set(opts.botIds ?? []);
      stale.sort((a, b) => Number(prio.has(b)) - Number(prio.has(a)) || (latest.get(b)!.maxUs - latest.get(a)!.maxUs));
      const budget = opts.budgetMs ?? 2000;
      const t0 = Date.now();
      for (const id of stale) {
        if (Date.now() - t0 > budget) break;
        this.fitOne(db, id);
      }
    } finally {
      db.close();
    }
  }

  private fitOne(db: Db, botId: number): void {
    const f = fitOneBot(
      db,
      botId,
      this.bots,
      this.cfg,
      this.market,
      (id) => this.fits.get(id)?.params ?? this.market,
      this.fits.get(botId)?.params,
    );
    if (f) this.fits.set(botId, f);
  }

  knownBots(): number[] {
    return [...this.bots.keys()];
  }

  strategyOf(botId: number): Strategy {
    const b = this.bots.get(botId);
    if (!b) return "unknown";
    if (!b.isSim) return "Human";
    return (["Cheapskate", "ValueBidder", "Aggressive", "Human"] as const).find((s) => s === b.strategy) ?? "unknown";
  }

  predictBid(botId: number, letter: string, ctx: BidContext): BidDistribution {
    const L = letter.toUpperCase();
    const balance = Math.max(0, Math.floor(ctx.balance));
    const b = this.bots.get(botId);
    const pb = phaseBucket(ctx.phase);
    const key = `${botId}|${L}|${pb}|${balance}|${ctx.rackSize ?? -1}`;
    const hit = this.predictCache.get(key);
    if (hit) return hit;
    let d: BidDistribution;
    if (b?.isSim) d = simBidDist(b.strategy, L, balance);
    else {
      const f = this.fits.get(botId);
      const params = f?.params ?? this.market;
      const rack = ctx.rackSize ?? f?.meanRack[pb] ?? 7;
      d = distFromPmf(bidPmf(params, letterIdx(L), ctx.phase, balance, rack), f ? "bot" : "market");
    }
    if (this.predictCache.size > 50_000) this.predictCache.clear();
    this.predictCache.set(key, d);
    return d;
  }

  /** The market's own bid distribution (what an unknown real bot would bid). */
  marketBid(letter: string, ctx: BidContext): BidDistribution {
    return distFromPmf(
      bidPmf(this.market, letterIdx(letter), ctx.phase, Math.max(0, Math.floor(ctx.balance)), ctx.rackSize ?? 7),
      "market",
    );
  }

  marketPrice(letter: string, phase: number): PriceDistribution {
    const L = letter.toUpperCase();
    const pb = phaseBucket(phase);
    const key = `${L}|${pb}`;
    const hit = this.priceCache.get(key);
    if (hit) return hit;
    const paid: number[] = [];
    const tops: number[] = [];
    let n = 0;
    let unsold = 0;
    const db = this.open();
    if (db) {
      try {
        // The newest ~1500 matches: a moving picture of today's market.
        const since = num(
          db.prepare("SELECT ended_us FROM match_info ORDER BY ended_us DESC LIMIT 1 OFFSET 1500").get()?.ended_us,
        );
        for (const r of db
          .prepare("SELECT phase, winner_bot_id, paid, top_bid FROM auction_ctx WHERE letter = ? AND ended_us >= ?")
          .iterate(L, since)) {
          if (phaseBucket(Number(r.phase)) !== pb) continue;
          n++;
          if (r.winner_bot_id === null) {
            unsold++;
            continue;
          }
          paid.push(num(r.paid));
          if (r.top_bid !== null) tops.push(num(r.top_bid));
        }
      } finally {
        db.close();
      }
    }
    const e = empirical(paid);
    const t = empirical(tops);
    const out: PriceDistribution = {
      letter: L,
      phase,
      n,
      pUnsold: n ? unsold / n : 0,
      mean: e.mean,
      sd: e.sd,
      quantile: e.quantile,
      topBid: { mean: t.mean, quantile: t.quantile },
    };
    this.priceCache.set(key, out);
    return out;
  }

  playHabits(botId: number): PlayHabits {
    const hit = this.habitCache.get(botId);
    if (hit) return hit;
    const lengthDist = new Array<number>(16).fill(0);
    const rackBeforePlay: number[] = [];
    const playPhases: number[] = [];
    const plays: PlayHabits["plays"] = [];
    let matches = 0;
    let words = 0;
    let tilesLeft = 0;
    const db = this.open();
    if (db) {
      try {
        // Recent behaviour only: bots change between versions.
        const rows = db
          .prepare("SELECT len, rack_before, phase FROM play_obs WHERE bot_id = ? ORDER BY word_id DESC LIMIT 4000")
          .all(botId);
        for (const r of rows) {
          lengthDist[Math.min(15, num(r.len))]! += 1;
          rackBeforePlay.push(num(r.rack_before));
          playPhases.push(Number(r.phase));
          plays.push({ len: num(r.len), rack: num(r.rack_before), phase: Number(r.phase) });
        }
        words = rows.length;
        const s = db
          .prepare(
            "SELECT COUNT(*) AS n, SUM(words) AS w, AVG(tiles_left) AS t FROM (SELECT words, tiles_left FROM match_seat WHERE bot_id = ? ORDER BY ended_us DESC LIMIT 400)",
          )
          .get(botId);
        matches = num(s?.n);
        tilesLeft = Number(s?.t ?? 0);
        words = matches ? num(s?.w) : words;
      } finally {
        db.close();
      }
    }
    const tot = lengthDist.reduce((a, b) => a + b, 0);
    const out: PlayHabits = {
      lengthDist: tot ? lengthDist.map((x) => x / tot) : lengthDist,
      rackBeforePlay: rackBeforePlay.sort((a, b) => a - b),
      wordsPerMatch: matches ? words / matches : 0,
      tilesLeftAtEnd: tilesLeft,
      playPhases: playPhases.sort((a, b) => a - b),
      plays,
      matches,
    };
    this.habitCache.set(botId, out);
    return out;
  }

  botSummary(botId: number): BotSummary {
    const hit = this.summaryCache.get(botId);
    if (hit) return hit;
    const b = this.bots.get(botId);
    const s: BotSummary = {
      botId,
      name: b?.name ?? `bot ${botId}`,
      strategy: this.strategyOf(botId),
      isSim: b?.isSim ?? false,
      version: b ? versionAt(b.versions, Number.MAX_SAFE_INTEGER) : 1,
      rating: null,
      ratingSpread: null,
      matches: 0,
      matchesCurrentVersion: 0,
      wins: 0,
      winRate: 0,
      meanPlace: 0,
      meanScore: 0,
      lastPlayedUs: null,
      bidObs: 0,
      exactBids: 0,
      censoredBids: 0,
      wordsPlayed: 0,
      meanWordLength: 0,
      wordsPerMatch: 0,
      tilesLeftAtEnd: 0,
      playThrough: 0,
      meanRackBeforePlay: 0,
      aggressiveness: 1,
      paidVsMarket: 1,
      hasFit: this.fits.has(botId),
    };
    const db = this.open();
    if (db) {
      try {
        const st = db.prepare("SELECT mu, sigma, last_played_us FROM bot_stats WHERE bot_id = ?").get(botId);
        if (st) {
          s.rating = skill(Number(st.mu));
          s.ratingSpread = spread(Number(st.sigma));
          s.lastPlayedUs = st.last_played_us === null ? null : num(st.last_played_us);
        }
        const m = db
          .prepare(
            `SELECT COUNT(*) AS n, SUM(place = 1) AS wins, AVG(place) AS place, AVG(final_score) AS score,
             SUM(version = ?) AS cur, SUM(won_tiles) AS won, SUM(letters_played) AS played,
             AVG(tiles_left) AS left, SUM(words) AS words, MAX(ended_us) AS last
             FROM match_seat WHERE bot_id = ?`,
          )
          .get(s.version, botId);
        s.matches = num(m?.n);
        s.wins = num(m?.wins);
        s.winRate = s.matches ? s.wins / s.matches : 0;
        s.meanPlace = Number(m?.place ?? 0);
        s.meanScore = Number(m?.score ?? 0);
        s.matchesCurrentVersion = num(m?.cur);
        s.tilesLeftAtEnd = Number(m?.left ?? 0);
        s.wordsPerMatch = s.matches ? num(m?.words) / s.matches : 0;
        const won = num(m?.won);
        // Starting tiles count as tiles it had to play through.
        s.playThrough = won + 5 * s.matches > 0 ? num(m?.played) / (won + 5 * s.matches) : 0;
        if (s.lastPlayedUs === null && m?.last !== null) s.lastPlayedUs = num(m?.last);
        const o = db
          .prepare(
            "SELECT COUNT(*) AS n, SUM(kind = 0) AS eq, SUM(kind = 1) AS le FROM bid_obs WHERE bot_id = ?",
          )
          .get(botId);
        s.bidObs = num(o?.n);
        s.exactBids = num(o?.eq);
        s.censoredBids = num(o?.le);
        const p = db
          .prepare("SELECT COUNT(*) AS n, AVG(len) AS len, AVG(rack_before) AS rack FROM play_obs WHERE bot_id = ?")
          .get(botId);
        s.wordsPlayed = num(p?.n);
        s.meanWordLength = Number(p?.len ?? 0);
        s.meanRackBeforePlay = Number(p?.rack ?? 0);
        // What it paid on letters it won vs the going rate for that letter.
        const pv = db
          .prepare(
            `SELECT AVG(a.top_bid * 1.0 / mk.avg_paid) AS r FROM auction_ctx a
             JOIN (SELECT letter, AVG(paid) AS avg_paid FROM auction_ctx WHERE winner_bot_id IS NOT NULL GROUP BY letter) mk
               ON mk.letter = a.letter
             WHERE a.winner_bot_id = ? AND a.top_bid IS NOT NULL`,
          )
          .get(botId);
        s.paidVsMarket = Number(pv?.r ?? 1) || 1;
      } finally {
        db.close();
      }
    }
    if (!s.isSim) s.aggressiveness = this.aggressiveness(botId);
    this.summaryCache.set(botId, s);
    return s;
  }

  /** Mean predicted bid / market's, averaged over letters in `letters`. */
  aggressiveness(botId: number, letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", ctx: BidContext = REF_CTX): number {
    let r = 0;
    let n = 0;
    for (const L of letters) {
      const mine = this.predictBid(botId, L, ctx).mean;
      const mkt = this.marketBid(L, ctx).mean;
      if (mkt > 0) {
        r += mine / mkt;
        n++;
      }
    }
    return n ? r / n : 1;
  }

  fitted(botId: number): boolean {
    return this.fits.has(botId);
  }

  marketParams(): BidParams {
    return this.market;
  }
}

export type RABBOTModel = Model;

/**
 * Where loadOpponentModel() reads when called without a path: a SQLite file
 * (RABBOT_MODEL_DB, default data/history.sqlite; rabbot-miner.service keeps
 * data/miner.sqlite current), or with RABBOT_MODEL_SOURCE=backend RABBOT's
 * SpacetimeDB backend, same as passing "stdb:" (src/backend/model-source.ts).
 * The backend source loads in ~3.3 s instead of ~0.25 s and never refits at
 * load, so it is not the default.
 */
export const DEFAULT_MODEL_SOURCE =
  process.env.RABBOT_MODEL_SOURCE === "backend" ? "stdb:" : (process.env.RABBOT_MODEL_DB ?? DEFAULT_DB_PATH);

/**
 * Loads the opponent model. Never throws: with no database it still knows
 * nothing but the market default, and sims are unknown until mined.
 * `dbPath` is a SQLite file, or "stdb:[db[@uri]]" for RABBOT's backend.
 */
export function loadOpponentModel(
  dbPath: string = DEFAULT_MODEL_SOURCE,
  cfg: ModelConfig = DEFAULT_CONFIG,
): OpponentModel & RABBOTModel {
  const m = new Model(dbPath, cfg);
  try {
    m.refresh({ budgetMs: 5000 });
  } catch (e) {
    console.warn(`[memory] model load failed: ${e instanceof Error ? e.message : e}`);
  }
  return m;
}

/** Stored validation results (written by validate.ts), if any. */
export function storedValidation(dbPath: string = DEFAULT_DB_PATH): unknown {
  if (!fs.existsSync(dbPath)) return undefined;
  const db = openDb(dbPath, { readOnly: true });
  try {
    const v = getMeta(db, "validation");
    return v ? JSON.parse(v) : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

