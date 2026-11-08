// Tournament stages: what a point is worth, to me and to each rival, when
// the match is part of a tournament (server: spacetimedb/src/tournament.ts).
//
//   Swiss    Swiss points = max(matchSize - place, 0), place = rivals strictly
//            ahead (ties share the higher place); total score breaks ties.
//            So the objective is E[points] = sum over rivals of
//            P(o not ahead), counted only while my place can still earn a
//            point (an oversized table, e.g. 11 at size 6, pays nothing past
//            6th): beating o is worth 1 Swiss point iff fewer than
//            matchSize - 1 OTHER rivals are ahead. Plus `scoreTiebreak`
//            Swiss points per point of my own score.
//   Bracket  The last place is knocked out. Objective P(not last) =
//            1 - prod_o P(o ahead). Rival o matters as much as it is the one
//            I might end up under while everyone else is already ahead.
//   Final    Three heads-up games, the champion by total score. Objective
//            P(my series total > theirs), with the running difference from
//            the earlier games and the variance of the games still to come.
//            Heads-up, a point to the opponent costs exactly one of mine.
//
// Every stage reuses place.ts's picture: the final gap to rival o is normal
// with mean (my equity - its equity) and spread sigma, f_o its density at 0,
// q_o = P(o ends ahead). The output has place.ts's PlaceView shape (weights
// in rival order, relative to one of MY points; tilt > 0 = take variance),
// so the brain integrates it by swapping placeView for stageView.
//
// tournamentContext builds MatchView.tournament from the rows of the
// public tournament, tournament_entry, tournament_match and
// match_participant tables (src/module_bindings shapes).

import type { MatchView, TournamentStage, TournamentStanding, TournamentView } from "../core/types.js";
import type { Params } from "./params.js";
import { equity, placeView, type PlaceView, type Standing } from "./place.js";

/** Games in the final (server FINAL_GAMES). */
export const FINAL_GAMES = 3;
/** Swiss points one point of my own tournament score is worth (tiebreak only). */
export const DEFAULT_SCORE_TIEBREAK = 0.001;
/**
 * Bracket: once P(last) is negligible nothing at stake moves, so rival
 * weights fade to 0 (just score) below this share of a fully contested
 * rival's density phi(0) / sigma.
 */
export const BRACKET_SAFE_FLOOR = 1e-3;

// ---------- context builder ----------

type Id = bigint | number;
type Tag = { tag: string };

/** Structural subsets of the generated row types (bigint ids, as the SDK delivers them). */
export interface TournamentRow {
  id: Id;
  status: Tag;
  swissRoundsTotal: number;
  currentRound: number;
  topCut: number;
  matchSize: number;
}
export interface TournamentEntryRow {
  tournamentId: Id;
  botId: Id;
  swissPoints: number;
  eliminated: boolean;
  totalScore: Id;
}
export interface TournamentMatchRow {
  tournamentId: Id;
  matchId: Id;
  round: number;
  phase: Tag;
}
export interface MatchParticipantRow {
  matchId: Id;
  botId: Id;
  score: Id;
}

export interface TournamentRows {
  tournaments: Iterable<TournamentRow>;
  entries: Iterable<TournamentEntryRow>;
  matches: Iterable<TournamentMatchRow>;
  /**
   * Participant rows of this match and, for a Final, of the earlier final
   * games (the live bot must subscribe to match_participant for those
   * match ids, not only its current match).
   */
  participants: Iterable<MatchParticipantRow>;
}

const num = (x: Id): number => Number(x);
const isStage = (s: string): s is TournamentStage => s === "Swiss" || s === "Bracket" || s === "Final";

/**
 * MatchView.tournament for match `matchId`, or undefined when the match is
 * not a tournament match (a ladder game) or the rows are incomplete.
 * Pure; never throws on odd rows.
 */
export function tournamentContext(matchId: Id, myBotId: Id, rows: TournamentRows): TournamentView | undefined {
  const mid = num(matchId);
  const me = num(myBotId);
  const tms = [...rows.matches];
  const tm = tms.find((m) => num(m.matchId) === mid);
  if (!tm || !isStage(tm.phase.tag)) return undefined;
  const tid = num(tm.tournamentId);
  const t = [...rows.tournaments].find((x) => num(x.id) === tid);
  if (!t) return undefined;
  const standings: TournamentStanding[] = [...rows.entries]
    .filter((e) => num(e.tournamentId) === tid)
    .map((e) => ({
      botId: num(e.botId),
      swissPoints: e.swissPoints,
      totalScore: num(e.totalScore),
      eliminated: e.eliminated,
    }))
    .sort((a, b) => b.swissPoints - a.swissPoints || b.totalScore - a.totalScore || a.botId - b.botId);
  const view: TournamentView = {
    phase: tm.phase.tag,
    round: tm.round,
    matchSize: t.matchSize,
    topCut: t.topCut,
    swissRoundsTotal: t.swissRoundsTotal,
    standings,
  };
  if (tm.phase.tag === "Final") {
    const parts = [...rows.participants];
    const here = parts.filter((p) => num(p.matchId) === mid).map((p) => num(p.botId));
    const seated = here.length > 0 ? here : standings.filter((s) => !s.eliminated).map((s) => s.botId);
    if (!seated.includes(me)) seated.push(me);
    const earlier = new Set(
      tms
        .filter((m) => num(m.tournamentId) === tid && m.phase.tag === "Final" && num(m.matchId) !== mid && m.round < tm.round)
        .map((m) => num(m.matchId)),
    );
    view.finalTotals = seated.map((botId) => ({
      botId,
      total: parts
        .filter((p) => earlier.has(num(p.matchId)) && num(p.botId) === botId)
        .reduce((s, p) => s + num(p.score), 0),
    }));
  }
  return view;
}

// ---------- stage objectives ----------

const phi = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

// Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf; |error| < 1.5e-7).
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

const clampTilt = (x: number) => Math.max(-2, Math.min(2, x));

export interface StageOptions {
  /** Swiss points per point of my own score (Swiss tiebreak). */
  scoreTiebreak?: number;
}

/** Per rival: z (my lead over sigma), f (density of the gap at 0), q = P(rival ends ahead). */
interface Gap {
  z: number;
  f: number;
  q: number;
}

function gaps(mine: number, rivals: readonly Standing[], lambda: number, sigma: number, p: Params): Gap[] {
  return rivals.map((r) => {
    const z = (mine - equity(r, lambda, p)) / sigma;
    return { z, f: phi(z) / sigma, q: normCdf(-z) };
  });
}

/** P(at most k of the Bernoulli(q_i), i != skip, come up), by the Poisson-binomial DP. */
function atMost(qs: readonly number[], skip: number, k: number): number {
  if (k < 0) return 0;
  let dist = [1];
  qs.forEach((q, i) => {
    if (i === skip) return;
    const next = new Array<number>(dist.length + 1).fill(0);
    for (let j = 0; j < dist.length; j++) {
      next[j]! += dist[j]! * (1 - q);
      next[j + 1]! += dist[j]! * q;
    }
    dist = next;
  });
  let s = 0;
  for (let j = 0; j <= Math.min(k, dist.length - 1); j++) s += dist[j]!;
  return s;
}

function sigmaFor(remaining: number, extraGames: number, p: Params): number {
  const r = Math.max(0, Math.min(1, remaining)) + Math.max(0, extraGames);
  return Math.sqrt(p.placeSigmaMin ** 2 + p.placeSigma0 ** 2 * r);
}

/**
 * Tilt from per-rival marginal values v_o (each already carrying f_o):
 * d objective / d sigma = sum_o v_o (-z_o), normalised by sum v_o, as in
 * place.ts (where v_o = f_o).
 */
function tiltOf(g: readonly Gap[], v: readonly number[]): number {
  let num0 = 0;
  let den = 0;
  g.forEach((x, i) => {
    num0 += v[i]! * -x.z;
    den += v[i]!;
  });
  return den > 0 ? clampTilt(num0 / den) : 0;
}

/** Swiss: E[Swiss points] + scoreTiebreak * my score. */
export function swissView(
  me: Standing,
  rivals: readonly Standing[],
  lambda: number,
  remaining: number,
  matchSize: number,
  p: Params,
  opts: StageOptions = {},
): PlaceView {
  const sigma = sigmaFor(remaining, 0, p);
  const g = gaps(equity(me, lambda, p), rivals, lambda, sigma, p);
  const qs = g.map((x) => x.q);
  const size = matchSize > 0 ? matchSize : rivals.length + 1;
  // Beating o earns a point iff fewer than size - 1 others are ahead.
  const live = g.map((_, i) => atMost(qs, i, size - 2));
  const val = g.map((x, i) => x.f * live[i]!);
  const mine = val.reduce((a, b) => a + b, 0) + (opts.scoreTiebreak ?? DEFAULT_SCORE_TIEBREAK);
  return { weights: val.map((v) => v / mine), tilt: tiltOf(g, val), sigma };
}

/** Bracket: P(not last). */
export function bracketView(me: Standing, rivals: readonly Standing[], lambda: number, remaining: number, p: Params, opts: StageOptions = {}): PlaceView {
  const sigma = sigmaFor(remaining, 0, p);
  const g = gaps(equity(me, lambda, p), rivals, lambda, sigma, p);
  // prod_{k != o} q_k: everyone else is already ahead, so o decides.
  const others = g.map((_, o) => g.reduce((acc, x, k) => (k === o ? acc : acc * x.q), 1));
  const val = g.map((x, o) => x.f * others[o]!);
  // A tie for last goes out on total tournament score: a sliver for my own
  // points, plus the floor that fades rivals out once I'm safe.
  const pLast = g.reduce((acc, x) => acc * x.q, 1);
  const mine =
    val.reduce((a, b) => a + b, 0) +
    (opts.scoreTiebreak ?? DEFAULT_SCORE_TIEBREAK) * pLast +
    BRACKET_SAFE_FLOOR * phi(0) / sigma;
  const weights = mine > 0 ? val.map((v) => v / mine) : val.map(() => 0);
  return { weights, tilt: tiltOf(g, val), sigma };
}

/**
 * Final: P(series total > opponent's). `lead` = my total minus the opponent's
 * over the earlier games; `gamesAfter` = games still to play after this one.
 * Heads-up and zero-sum, so the opponent's points weigh 1 against mine.
 */
export function finalView(me: Standing, rivals: readonly Standing[], lambda: number, remaining: number, lead: number, gamesAfter: number, p: Params): PlaceView {
  const sigma = sigmaFor(remaining, gamesAfter, p);
  const shifted: Standing = { ...me, score: me.score + lead };
  const g = gaps(equity(shifted, lambda, p), rivals, lambda, sigma, p);
  if (g.length === 1) return { weights: [1], tilt: clampTilt(-g[0]!.z), sigma };
  // More than two seated in a final can't happen on the server; fall back to place.
  const pv = placeView(shifted, rivals, lambda, remaining, p);
  return { ...pv, sigma };
}

/**
 * The stage-aware replacement for placeView: the same inputs plus the view.
 * No view.tournament (a ladder match) returns placeView unchanged.
 */
export function stageView(
  view: Pick<MatchView, "tournament" | "myBotId">,
  me: Standing,
  rivals: readonly Standing[],
  lambda: number,
  remaining: number,
  p: Params,
  opts: StageOptions = {},
): PlaceView {
  const t = view.tournament;
  if (!t || rivals.length === 0) return placeView(me, rivals, lambda, remaining, p);
  switch (t.phase) {
    case "Swiss":
      return swissView(me, rivals, lambda, remaining, t.matchSize, p, opts);
    case "Bracket":
      return bracketView(me, rivals, lambda, remaining, p, opts);
    case "Final": {
      const { lead, gamesAfter } = finalSeries(t, view.myBotId);
      return finalView(me, rivals, lambda, remaining, lead, gamesAfter, p);
    }
  }
}

/** My running lead over the opponent from the earlier final games, and the games left after this one. */
export function finalSeries(t: TournamentView, myBotId: number): { lead: number; gamesAfter: number } {
  const totals = t.finalTotals ?? [];
  const mine = totals.find((x) => x.botId === myBotId)?.total ?? 0;
  const theirs = totals.filter((x) => x.botId !== myBotId).reduce((m, x) => Math.max(m, x.total), Number.NEGATIVE_INFINITY);
  const lead = Number.isFinite(theirs) ? mine - theirs : 0;
  const round = Math.max(1, Math.min(FINAL_GAMES, t.round));
  return { lead, gamesAfter: FINAL_GAMES - round };
}

/** Convenience for callers with only scores: rival weights and tilt for the current stage. */
export function stageWeights(
  view: Pick<MatchView, "tournament" | "myBotId" | "participants">,
  lambda: number,
  remaining: number,
  p: Params,
  rackSizes: ReadonlyMap<number, number> = new Map(),
): { rivalIds: number[]; rivalWeights: number[]; tilt: number } {
  const st = (botId: number, score: number, balance: number): Standing => ({ botId, score, balance, rackSize: rackSizes.get(botId) ?? 0 });
  const meP = view.participants.find((x) => x.botId === view.myBotId);
  const me = st(view.myBotId, meP?.score ?? 0, meP?.balance ?? 0);
  const rivals = view.participants.filter((x) => x.botId !== view.myBotId).map((x) => st(x.botId, x.score, x.balance));
  const pv = stageView(view, me, rivals, lambda, remaining, p);
  return { rivalIds: rivals.map((r) => r.botId), rivalWeights: pv.weights, tilt: pv.tilt };
}
