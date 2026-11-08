// Every number the brain decides with, in one typed record, so the tuner
// can search over all of them and data/params.json can pin tuned values.
// Defaults are the tuned values (rounded), so the bot plays well even
// without data/params.json; the file overrides them field by field, and
// createAgent({ params }) overrides both.

import * as fs from "node:fs";
import * as path from "node:path";

export interface Params {
  // ---------- valuation (simulated futures) ----------
  /** Scales the expected number of future tiles imagined per sample. */
  futureScale: number;
  /** 0: imagined future tiles are uniform draws; 1: weighted by my chance of winning each letter. */
  selectFuture: number;
  /** Never imagine more future tiles than this. */
  kMax: number;
  /** Price per tile assumed when the lambda solve has no better estimate. */
  kInitPrice: number;
  /** Most of the remaining auctions I can expect to win. */
  maxWinShare: number;
  /** First words tried by the approximate partition (then greedy). */
  searchTopK: number;
  /** Samples the letter table must hold before quickBid answers from it. */
  quickSamples: number;
  /** Samples refineBid adds in sim mode (deterministic, no clock). */
  refineSamplesSim: number;
  /** Most samples the table keeps (live refine stops here too). */
  maxSamples: number;
  /** A sample drawn this many rounds ago is dropped (the unseen pool drifts). */
  sampleMaxAge: number;
  /** Live mode: time quickBid may spend sampling a new rack (it then reuses last round's lambda). */
  quickBudgetMs: number;
  /** Live mode: time chooseWords may spend sampling. */
  wordsBudgetMs: number;
  /** Live mode: refineBid stops sampling this long before its budget ends. */
  refineMarginMs: number;
  /**
   * Live mode only: multiplies maxSamples, so refineBid samples by time up
   * to that many (bids only; the play decision keeps playMaxSamples). 1 =
   * off. Sim mode ignores it, so sim runs stay deterministic. See README.md
   * "More thinking time".
   */
  liveCompute: number;

  // ---------- coins -> points (lambda) ----------
  /** Bounds of the shadow price of a coin, in points. */
  lambdaMin: number;
  lambdaMax: number;
  /** Use this lambda throughout instead of solving for it (0 = solve; ablation). */
  lambdaFixed: number;
  /** Multiplies the solved lambda (>1: thriftier, <1: freer spending). */
  lambdaScale: number;
  /**
   * Replaces lambdaScale at tables of bigTableSeats seats or more (0 = off).
   * The tuned lambdaScale was fit at 6 seats; a crowded market (tournament
   * tables of 9-11) clears higher, and the thrifty scale left coins unspent.
   * Gated on seat count, not view.tournament, so it works without the
   * tournament subscriptions. See README.md "Tournament".
   */
  lambdaScaleBig: number;
  bigTableSeats: number;
  /** Share of my expected future points that comes back as coins in time to spend. */
  incomeShare: number;
  /** Scales the current rack's letter values when projecting future auctions. */
  futureValueScale: number;
  /** Live mode: refit the opponents just met at match end, for this long (0 = off). */
  liveRefreshMs: number;

  // ---------- bidding ----------
  /** Weight of rivals' surplus in my utility (denial + price-driving). 0 = selfish. */
  rivalWeight: number;
  /** Scales the rival term's denial part (I win, the rival who would have doesn't). */
  denialWeight: number;
  /** Scales its price-driving part (the rival still wins but pays my bid). */
  driveWeight: number;
  /** Most coins the rival term may lift the bid above my own truthful value / lambda. 0 = never. */
  maxOverbid: number;
  /** Chance of winning a tie at my bid. */
  tieShare: number;
  /** Bid everything on the last tile when a sim (who could still play it) is seated. */
  lastTileDeny: boolean;
  /** Use the opponent model (false: a generic market guess for everyone). */
  useModel: boolean;
  /** Learning rate of the in-match price calibration (0 = off). */
  calibRate: number;
  calibMin: number;
  calibMax: number;
  /** Generic market guess (no model): mean bid = base + perValue * letter value; sd. */
  mktBase: number;
  mktPerValue: number;
  mktSd: number;
  /** Probability a generic bidder sits a letter out. */
  mktPZero: number;

  // ---------- finishing place ----------
  /** Spread of the final score gap with the whole match ahead, and at the end. */
  placeSigma0: number;
  placeSigmaMin: number;
  /** Points a held tile is worth when sizing up a rival's position. */
  equityPerTile: number;
  /** Variance seeking when behind (>0) / aversion when ahead, on play-vs-hold. 0 = off. */
  riskCoef: number;
  /**
   * Tournament matches (view.tournament set): weigh rivals by the stage's
   * objective (tournament.ts stageView: Swiss points, Bracket survival,
   * Final series total) instead of finishing place. 0 = off: placeView, as
   * on the ladder. Without view.tournament it changes nothing.
   */
  stageAware: number;

  // ---------- play vs hold ----------
  /** Dump the best partition once the bag holds this few tiles (0 = the last auction). */
  dumpAtBag: number;
  /** Before the dump, only words this long are weighed against holding. */
  minPlayLen: number;
  /** Candidate words weighed against holding. */
  playCandidates: number;
  /** CRN samples for the play decision. */
  playSamples: number;
  /** Most table samples the play decision weighs (its cost is candidates x samples). */
  playMaxSamples: number;
  /** Coins earned now are worth coinBonus * lambda points each on top of the points. */
  coinBonus: number;
  /** Required advantage (points) of playing over holding; also what tiny coin bonuses near the end must beat. */
  playMargin: number;
  /** Words played per chooseWords call at most. */
  maxPlays: number;
  /** 0: play vs hold by simulated value. N > 0: fixed rule, play the best word of N+ letters (ablation). */
  holdRule: number;
}

export const DEFAULT_PARAMS: Readonly<Params> = Object.freeze({
  futureScale: 1.07,
  selectFuture: 0,
  kMax: 13,
  kInitPrice: 13,
  maxWinShare: 0.5,
  searchTopK: 12,
  quickSamples: 8,
  refineSamplesSim: 8,
  maxSamples: 96,
  sampleMaxAge: 6,
  quickBudgetMs: 6,
  wordsBudgetMs: 20,
  refineMarginMs: 15,
  liveCompute: 1,

  lambdaMin: 0.02,
  lambdaMax: 4,
  lambdaFixed: 0,
  lambdaScale: 1.08,
  lambdaScaleBig: 0.8,
  bigTableSeats: 7,
  incomeShare: 0.47,
  futureValueScale: 1.14,
  liveRefreshMs: 300,

  rivalWeight: 0.9,
  denialWeight: 1,
  driveWeight: 1,
  maxOverbid: 5,
  tieShare: 0.5,
  lastTileDeny: true,
  useModel: true,
  calibRate: 0.056,
  calibMin: 0.3,
  calibMax: 3,
  mktBase: 8,
  mktPerValue: 2.5,
  mktSd: 3,
  mktPZero: 0.05,

  placeSigma0: 40,
  placeSigmaMin: 4,
  equityPerTile: 2.5,
  riskCoef: 0,
  stageAware: 0,

  dumpAtBag: 0,
  minPlayLen: 2,
  playCandidates: 8,
  playSamples: 24,
  playMaxSamples: 96,
  coinBonus: 0.32,
  playMargin: 2.7,
  maxPlays: 3,
  holdRule: 0,
});

export const PARAMS_PATH = path.join(import.meta.dirname, "..", "..", "data", "params.json");

let fileParams: Partial<Params> | undefined;

/** data/params.json, read once; unknown keys and wrong types are dropped. */
export function fileOverrides(file = PARAMS_PATH): Partial<Params> {
  if (fileParams && file === PARAMS_PATH) return fileParams;
  let out: Partial<Params> = {};
  try {
    out = sanitize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    out = {};
  }
  if (file === PARAMS_PATH) fileParams = out;
  return out;
}

/** Keeps only known keys whose type matches the default's. */
export function sanitize(raw: unknown): Partial<Params> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out as Partial<Params>;
  const src = (raw as Record<string, unknown>).params ?? raw;
  if (!src || typeof src !== "object") return out as Partial<Params>;
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    const d = (DEFAULT_PARAMS as unknown as Record<string, unknown>)[k];
    if (d === undefined) continue;
    if (typeof d === "number" && typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof d === "boolean" && typeof v === "boolean") out[k] = v;
  }
  return out as Partial<Params>;
}

/** RABBOT_PARAMS='{"liveCompute":4}' in the environment (testing a flag in a dry run); bad JSON is ignored. */
export function envOverrides(raw = process.env.RABBOT_PARAMS): Partial<Params> {
  if (!raw) return {};
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Defaults, then data/params.json, then $RABBOT_PARAMS, then `overrides`. */
export function resolveParams(overrides: Partial<Params> | Record<string, unknown> = {}): Params {
  return { ...DEFAULT_PARAMS, ...fileOverrides(), ...envOverrides(), ...sanitize(overrides) };
}
