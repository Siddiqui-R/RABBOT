// RackForgeAgent: RackForge's decisions for one seat. See README.md for the
// strategy and the evidence; each piece lives in its own module:
//   belief.ts  unseen tiles and opponents' racks from public history
//   value.ts   letter values by simulated futures (CRN sampling)
//   market.ts  opponents' predicted bids, in-match calibration, lambda
//   bid.ts     value -> bid by expected utility (denial, price-driving, FirstPrice)
//   place.ts   finishing place: how much each rival's points matter
// Per round: sync the belief, make sure the letter table for my rack has
// enough samples, solve lambda, then bid / play from those.

import { auctionsPerMatch, letterValue, totalTiles, type Counts } from "../core/rules.js";
import type { Agent, AuctionView, MatchView, TournamentView } from "../core/types.js";
import type { WordEngine } from "../core/words.js";
import { Belief } from "./belief.js";
import { chooseBid } from "./bid.js";
import {
  Market,
  cdfOf,
  letterMarket,
  maxCdf,
  solveLambda,
  type BidModel,
  type LetterMarket,
  type Seat,
} from "./market.js";
import type { Params } from "./params.js";
import { placeView, type PlaceView, type Standing } from "./place.js";
import { stageView } from "./tournament.js";
import { LetterTable, Partitioner, mulberry32, rackKey, type Rand } from "./value.js";

export type Mode = "live" | "sim";

/** Why the last bid was what it was (logs, tests, tuning). */
export interface BidTrace {
  round: number;
  letter: string;
  value: number;
  se: number;
  lambda: number;
  k: number;
  samples: number;
  bid: number;
  selfBid: number;
  pWin: number;
  price: number;
  scale: number;
  stage: "quick" | "refine" | "last";
}

interface RoundCtx {
  key: string;
  phase: number;
  totalAuctions: number;
  /** Useful auctions after the current one (the last is worthless). */
  future: number;
  /** Expected count of each letter among those auctions. */
  counts: Float64Array;
  opps: Seat[];
  /** Same order as opps. */
  rivals: Standing[];
  me: Standing;
  pool: Counts;
  lambda: number;
  wins: number;
  /** Table size when lambda was solved. */
  solvedAt: number;
  markets?: (LetterMarket | undefined)[];
  place?: PlaceView;
  /** Seats at the table, me included. */
  seats: number;
  /** Set in a tournament match (MatchView.tournament). */
  tournament?: TournamentView;
}

class MatchState {
  readonly belief = new Belief();
  readonly market: Market;
  readonly rand: Rand;
  table: LetterTable | undefined;
  k = -1;
  /** Per-letter weight of a future tile: how likely I am to win that letter. */
  acquire: Float64Array | undefined;
  /** The last solved lambda and place view, for decisions that can't wait for a solve. */
  lastLambda: number | undefined;
  lastPlace: PlaceView | undefined;
  round: RoundCtx | undefined;
  calibSeen = 0;
  bids = new Map<number, number>();
  playCache = new Map<string, string[]>();

  constructor(
    readonly matchId: number,
    p: Params,
    model: BidModel | undefined,
    seed: number,
  ) {
    this.market = new Market(p, model);
    this.rand = mulberry32((seed ^ Math.imul(matchId + 1, 0x9e3779b1)) >>> 0);
  }
}

export interface RackForgeOptions {
  params: Params;
  mode: Mode;
  seed: number;
  engine: WordEngine;
  model?: BidModel & { refresh?: (o?: { budgetMs?: number; botIds?: number[] }) => void };
}

export class RackForgeAgent implements Agent {
  readonly name = "rackforge";
  readonly p: Params;
  readonly mode: Mode;
  private readonly seed: number;
  private readonly engine: WordEngine;
  private readonly model: RackForgeOptions["model"];
  private readonly part: Partitioner;
  private st: MatchState | undefined;
  /** Why the latest bid was what it was. */
  lastTrace: BidTrace | undefined;

  constructor(o: RackForgeOptions) {
    this.p = o.params;
    this.mode = o.mode;
    this.seed = o.seed >>> 0;
    this.engine = o.engine;
    this.model = o.model;
    this.part = new Partitioner(o.engine, Math.max(1, Math.floor(o.params.searchTopK)));
    const scale = o.mode === "live" ? Math.max(1, Math.min(64, o.params.liveCompute || 1)) : 1;
    this.maxSamples = Math.max(1, Math.floor(o.params.maxSamples * scale));
  }

  /** maxSamples, scaled by liveCompute in live mode. */
  private readonly maxSamples: number;

  // ---------- state ----------

  private sync(view: MatchView): MatchState {
    if (!this.st || this.st.matchId !== view.matchId) {
      // Partition values don't depend on the match: the cache carries over.
      this.st = new MatchState(view.matchId, this.p, this.model, this.seed);
    }
    const st = this.st;
    st.belief.update(view);
    // Calibrate the opponent model on auctions that closed since last time.
    const fp = view.auctionType === "FirstPrice";
    for (; st.calibSeen < view.history.length; st.calibSeen++) {
      const e = view.history[st.calibSeen]!;
      if (e.kind === "auction") st.market.observe(e.auctionId, e.winnerBotId, e.paid, view.myBotId, fp);
    }
    return st;
  }

  private ctx(view: MatchView, st: MatchState, current?: string): RoundCtx {
    let who = "";
    for (const x of view.participants) who += `${x.botId}:${x.balance}:${x.score}:${x.isSim ? 1 : 0},`;
    const key = `${view.round}|${view.bagTotal}|${rackKey(view.myRack)}|${current ?? ""}|${who}`;
    if (st.round?.key === key) return st.round;
    const meP = view.participants.find((x) => x.botId === view.myBotId);
    const totalAuctions = auctionsPerMatch(view.participants.length, view.startingRackSize);
    const others = view.participants.filter((x) => x.botId !== view.myBotId);
    const opps: Seat[] = others.map((x) => ({
      botId: x.botId,
      isSim: x.isSim,
      balance: Math.max(0, x.balance),
      rackSize: st.belief.rackSize(x.botId),
    }));
    const rivals: Standing[] = others.map((x, j) => ({
      botId: x.botId,
      score: x.score,
      balance: opps[j]!.balance,
      rackSize: opps[j]!.rackSize,
    }));
    const prev = st.round;
    const future = Math.max(0, view.bagTotal - 1);
    const pool = st.belief.unseen(view, current);
    let U = 0;
    for (let i = 0; i < 26; i++) U += pool[i]!;
    const counts = new Float64Array(26);
    if (U > 0) for (let i = 0; i < 26; i++) counts[i] = (future * pool[i]!) / U;
    const c: RoundCtx = {
      key,
      phase: totalAuctions > 0 ? Math.max(0, Math.min(1, (view.round - 1) / totalAuctions)) : 0,
      totalAuctions,
      future,
      counts,
      opps,
      rivals,
      me: {
        botId: view.myBotId,
        score: meP?.score ?? 0,
        balance: Math.max(0, meP?.balance ?? 0),
        rackSize: totalTiles(view.myRack),
      },
      pool,
      lambda: prev?.lambda ?? 0.5,
      wins: prev?.wins ?? 0,
      solvedAt: -1,
      seats: view.participants.length,
      tournament: view.tournament,
    };
    if (st.k < 0) st.k = Math.min(this.p.kMax, c.future, (this.p.futureScale * c.me.balance) / Math.max(1, this.p.kInitPrice));
    st.round = c;
    return c;
  }

  /**
   * Future tiles aren't random: I win the letters I bid high on. Weight each
   * letter by its win chance at my bid (value / lambda), blended with
   * uniform by selectFuture, normalised to mean 1 over the pool.
   */
  private acquireWeights(
    values: Float64Array,
    pool: Counts,
    markets: (LetterMarket | undefined)[],
    lambda: number,
  ): Float64Array | undefined {
    const sel = Math.max(0, Math.min(1, this.p.selectFuture));
    if (sel === 0) return undefined;
    const win = new Float64Array(26);
    let num = 0;
    let den = 0;
    for (let i = 0; i < 26; i++) {
      const m = markets[i];
      if (!m || pool[i]! <= 0) continue;
      const b = Math.min(m.win.length - 1, Math.max(0, Math.floor((Math.max(0, values[i]!) * this.p.futureValueScale) / lambda)));
      win[i] = m.win[b]!;
      num += pool[i]! * win[i]!;
      den += pool[i]!;
    }
    const avg = den > 0 ? num / den : 0;
    if (!(avg > 1e-6)) return undefined;
    const w = new Float64Array(26);
    for (let i = 0; i < 26; i++) w[i] = 1 - sel + (sel * win[i]!) / avg;
    return w;
  }

  private ensureTable(view: MatchView, st: MatchState, c: RoundCtx, n: number, deadline = Infinity): LetterTable {
    const key = rackKey(view.myRack);
    if (!st.table || st.table.key !== key) st.table = new LetterTable(view.myRack, this.part);
    const t = st.table;
    t.prune(view.round, st.k, this.p.sampleMaxAge);
    const want = Math.min(n, this.maxSamples);
    if (t.size < want) t.add(c.pool, st.k, want - t.size, st.rand, view.round, st.acquire, deadline);
    return t;
  }

  /** Live mode only: a deadline `ms` from now. Sim mode never looks at the clock. */
  private deadline(ms: number): number {
    return this.mode === "live" ? performance.now() + Math.max(0, ms) : Infinity;
  }

  /** Opponents' bid pmfs (and CDFs) for `letter` at `phase`, one length for all. */
  private oppDists(st: MatchState, c: RoundCtx, letter: string, phase: number) {
    let top = c.me.balance;
    for (const o of c.opps) top = Math.max(top, o.balance);
    const len = Math.floor(top) + 2;
    const pmfs = c.opps.map((o) => st.market.bidPmf(o, letter, phase, len));
    return { len, pmfs, cdfs: pmfs.map(cdfOf) };
  }

  /** Solves lambda (and the expected future wins) from the current table. */
  private solve(st: MatchState, c: RoundCtx, t: LetterTable): void {
    if (c.solvedAt === t.size) return;
    const p = this.p;
    if (c.future <= 0) {
      c.lambda = p.lambdaMin;
      c.wins = 0;
    } else if (p.lambdaFixed > 0) {
      c.lambda = p.lambdaFixed;
      c.wins = Math.min(c.future * p.maxWinShare, c.me.balance / Math.max(1, p.kInitPrice));
    } else {
      const counts = c.counts;
      if (!c.markets) {
        // A typical future auction: halfway through what's left of the match.
        const phaseF = c.phase + (1 - c.phase) / 2;
        c.markets = [];
        for (let i = 0; i < 26; i++) {
          if (counts[i]! <= 0) {
            c.markets.push(undefined);
            continue;
          }
          const { len, cdfs } = this.oppDists(st, c, String.fromCharCode(65 + i), phaseF);
          c.markets.push(letterMarket(cdfs.length ? maxCdf(cdfs, len) : new Float64Array(len).fill(1), p.tieShare));
        }
      }
      const income = p.incomeShare * t.baseValue() * (c.future / Math.max(1, c.totalAuctions));
      const budget = c.me.balance + income;
      const values = t.deltas(counts);
      const r = solveLambda({ values, counts, markets: c.markets, budget, p });
      const scale = p.lambdaScaleBig > 0 && c.seats >= p.bigTableSeats ? p.lambdaScaleBig : p.lambdaScale;
      c.lambda = Math.min(p.lambdaMax, Math.max(p.lambdaMin, r.lambda * scale));
      st.acquire = this.acquireWeights(values, c.pool, c.markets, c.lambda);
      // Tiles the budget buys at the going price. Not the projected wins
      // themselves: with an empty rack every letter is worth 0 to a table
      // that imagines 0 future tiles, which would project 0 wins forever.
      const price = r.wins > 0.5 ? Math.max(1, r.spend / r.wins) : p.kInitPrice;
      c.wins = Math.min(c.future * p.maxWinShare, budget / price);
    }
    c.solvedAt = t.size;
    st.k = Math.max(0, Math.min(p.kMax, c.future, p.futureScale * c.wins));
    // Rival weights depend on lambda (coins count toward a rival's position).
    // In a tournament match (stageAware) the stage's objective replaces place.
    const remaining = c.future / Math.max(1, c.totalAuctions);
    c.place =
      p.stageAware > 0 && c.tournament
        ? stageView({ tournament: c.tournament, myBotId: c.me.botId }, c.me, c.rivals, c.lambda, remaining, p)
        : placeView(c.me, c.rivals, c.lambda, remaining, p);
    st.lastLambda = c.lambda;
    st.lastPlace = c.place;
  }

  /** Last round's lambda if there is one (cheap), else a fresh solve. */
  private lambdaSoon(st: MatchState, c: RoundCtx, t: LetterTable): void {
    if (c.solvedAt >= 0) return;
    if (st.lastLambda !== undefined) {
      c.lambda = st.lastLambda;
      c.place = st.lastPlace;
    } else this.solve(st, c, t);
  }

  // ---------- bidding ----------

  private decide(view: MatchView, auction: AuctionView, stage: "quick" | "refine"): number {
    const st = this.sync(view);
    const c = this.ctx(view, st, auction.letter);
    const p = this.p;
    const balance = Math.floor(c.me.balance);
    if (balance <= 0) return 0;

    if (view.bagTotal <= 0) {
      // The match ends at this close: the tile is dead for every live bot,
      // and coins are worthless, so outbidding a sim that could still play
      // it costs nothing.
      const bid = p.lastTileDeny && c.opps.some((o) => o.isSim) ? balance : 0;
      this.trace(st, view, auction, { value: 0, se: 0, lambda: 0, bid, selfBid: 0, pWin: 0, price: 0, stage: "last", samples: 0 });
      return bid;
    }

    let t: LetterTable;
    if (stage === "quick" && this.mode === "live") {
      // Answer fast; refineBid does the full solve.
      t = this.ensureTable(view, st, c, p.quickSamples, this.deadline(p.quickBudgetMs));
      this.lambdaSoon(st, c, t);
    } else {
      t = this.ensureTable(view, st, c, p.quickSamples);
      this.solve(st, c, t);
    }
    const li = auction.letter.charCodeAt(0) - 65;
    const { mean: value, se } = t.letter(li);
    const { len, pmfs, cdfs } = this.oppDists(st, c, auction.letter, c.phase);
    const weights = c.opps.map((_, j) => p.rivalWeight * (c.place?.weights[j] ?? 0));
    const choice = chooseBid({
      value,
      lambda: c.lambda,
      balance,
      firstPrice: view.auctionType === "FirstPrice",
      pmfs,
      cdfs,
      weights,
      tieShare: p.tieShare,
      maxOverbid: p.maxOverbid,
      denialWeight: p.denialWeight,
      driveWeight: p.driveWeight,
    });
    const bid = Math.max(0, Math.min(balance, Math.floor(choice.bid)));
    if (stage === "quick") st.market.expect(auction.auctionId, auction.letter, bid, cdfs, len);
    else st.market.setMyBid(auction.auctionId, bid);
    st.bids.set(auction.auctionId, bid);
    this.trace(st, view, auction, {
      value,
      se,
      lambda: c.lambda,
      bid,
      selfBid: choice.selfBid,
      pWin: choice.pWin,
      price: choice.price,
      stage,
      samples: t.size,
    });
    return bid;
  }

  private trace(
    st: MatchState,
    view: MatchView,
    auction: AuctionView,
    x: Omit<BidTrace, "round" | "letter" | "k" | "scale">,
  ): void {
    const tr: BidTrace = { round: view.round, letter: auction.letter, k: st.k, scale: st.market.scale, ...x };
    this.lastTrace = tr;
  }

  // Live, a bug must never cost a bid or the final dump: fall back to
  // something simple and count it. In sim mode errors propagate, so tests
  // and strict runs see them.
  errors = 0;

  private guard<T>(fn: () => T, fallback: () => T): T {
    if (this.mode === "sim") return fn();
    try {
      return fn();
    } catch {
      this.errors++;
      return fallback();
    }
  }

  quickBid(view: MatchView, auction: AuctionView): number {
    return this.guard(
      () => this.decide(view, auction, "quick"),
      () => {
        if (view.bagTotal <= 0) return 0;
        const me = view.participants.find((x) => x.botId === view.myBotId);
        return Math.max(0, Math.min(Math.floor(me?.balance ?? 0), 2 * (letterValue(auction.letter) + 4)));
      },
    );
  }

  refineBid(view: MatchView, auction: AuctionView, budgetMs: number): number | null {
    return this.guard(
      () => this.refine(view, auction, budgetMs),
      () => null,
    );
  }

  chooseWords(view: MatchView): string[] {
    return this.guard(
      () => this.words(view),
      () => (view.bagTotal <= this.p.dumpAtBag ? this.engine.bestPartition(view.myRack, { timeBudgetMs: 40 }).words : []),
    );
  }

  private refine(view: MatchView, auction: AuctionView, budgetMs: number): number | null {
    if (view.bagTotal <= 0) return null;
    const st = this.sync(view);
    const c = this.ctx(view, st, auction.letter);
    const t = this.ensureTable(view, st, c, this.p.quickSamples);
    const p = this.p;
    if (this.mode === "sim") {
      const add = Math.min(p.refineSamplesSim, this.maxSamples - t.size);
      if (add > 0) t.add(c.pool, st.k, add, st.rand, view.round, st.acquire);
    } else {
      // One sample at a time, values included, so the final solve is cheap;
      // leave room for it and the bid search.
      const deadline = performance.now() + Math.max(0, budgetMs - p.refineMarginMs);
      const li = auction.letter.charCodeAt(0) - 65;
      while (t.size < this.maxSamples && performance.now() < deadline) {
        t.add(c.pool, st.k, 1, st.rand, view.round, st.acquire);
        t.deltas(c.counts);
        t.letter(li);
      }
    }
    const before = st.bids.get(auction.auctionId);
    const bid = this.decide(view, auction, "refine");
    return bid === before ? null : bid;
  }

  // ---------- words ----------

  private words(view: MatchView): string[] {
    const st = this.sync(view);
    const rack = view.myRack;
    if (totalTiles(rack) < 2) return [];
    const p = this.p;
    if (view.bagTotal <= p.dumpAtBag) {
      // Last chance: the match ends at this auction's close.
      return this.engine.bestPartition(rack, { timeBudgetMs: this.mode === "sim" ? 250 : 40 }).words;
    }
    const key = `${view.round}|${view.bagTotal}|${rackKey(rack)}`;
    const hit = st.playCache.get(key);
    if (hit) return hit;
    const c = this.ctx(view, st);
    const t = this.ensureTable(view, st, c, Math.max(p.playSamples, p.quickSamples), this.deadline(p.wordsBudgetMs));
    this.lambdaSoon(st, c, t);

    const out: string[] = [];
    if (p.holdRule > 0) {
      const left = rack.slice();
      for (let n = 0; n < p.maxPlays; n++) {
        const h = this.engine.best(left, { minLen: p.holdRule });
        if (!h) break;
        out.push(h.word);
        for (let i = 0; i < h.word.length; i++) left[h.word.charCodeAt(i) - 65]!--;
      }
      st.playCache.set(key, out);
      return out;
    }
    let table = t;
    let left = rack.slice();
    for (let n = 0; n < p.maxPlays; n++) {
      const w = this.bestPlay(table, left, c);
      if (!w) break;
      out.push(w);
      for (let i = 0; i < w.length; i++) left[w.charCodeAt(i) - 65]!--;
      if (totalTiles(left) < 2) break;
      table = new LetterTable(left, this.part);
      table.add(c.pool, st.k, Math.max(4, Math.floor(p.playSamples / 2)), st.rand, view.round, st.acquire, this.deadline(p.wordsBudgetMs / 2));
    }
    st.playCache.set(key, out);
    if (st.playCache.size > 64) st.playCache.clear();
    return out;
  }

  /** The word worth playing now rather than holding, if any. */
  private bestPlay(t: LetterTable, rack: Counts, c: RoundCtx): string | undefined {
    const p = this.p;
    const cands = this.engine.topK(rack, Math.max(1, Math.floor(p.playCandidates)), {
      minLen: Math.max(2, Math.floor(p.minPlayLen)),
    });
    if (cands.length === 0) return undefined;
    const lim = Math.max(1, Math.floor(p.playMaxSamples));
    const hold = t.holdSamples(lim);
    const n = hold.length;
    if (n === 0) return undefined;
    const tilt = c.place?.tilt ?? 0;
    const riskOf = (xs: number[]) => {
      if (p.riskCoef === 0 || xs.length < 2) return 0;
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
      return p.riskCoef * tilt * sd;
    };
    const holdMean = hold.reduce((a, b) => a + b, 0) / n;
    const holdQ = holdMean + riskOf(hold);
    let best: string | undefined;
    let bestQ = holdQ + p.playMargin;
    for (const h of cands) {
      const after = t.afterPlay(h.word, lim);
      const bonus = h.reward * (1 + p.coinBonus * c.lambda);
      const vals = after.map((a) => a + bonus);
      const q = vals.reduce((a, b) => a + b, 0) / n + riskOf(vals);
      if (q > bestQ) {
        bestQ = q;
        best = h.word;
      }
    }
    return best;
  }

  onMatchEnd(view: MatchView): void {
    if (this.mode !== "live" || this.p.liveRefreshMs <= 0 || !this.model?.refresh) return;
    try {
      this.model.refresh({
        budgetMs: this.p.liveRefreshMs,
        botIds: view.participants.filter((x) => !x.isSim && x.botId !== view.myBotId).map((x) => x.botId),
      });
    } catch {
      // A failed refit keeps the old fits; never let it reach the bot.
    }
  }
}
