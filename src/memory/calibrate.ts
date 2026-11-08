// Fits the clone behaviour params (clones.ts) so that clone-only replays of
// real recent tables reproduce each real bot's numbers: score, place, tiles,
// price, words, word length, 7+ words, play timing, coins and tiles left.
//
//   npx tsx src/memory/calibrate.ts fit   [--limit 3000] [--iters 240] [--workers 8] [--min-seats 30]
//   npx tsx src/memory/calibrate.ts field [--db data/history.sqlite] [--window 24] [--top 16] [--borrow]
//                                         writes data/field.json: recent seat compositions
//                                         plus the likely tournament entrants (top by strength);
//                                         --borrow gives unfitted entrants a similar bot's params
//   npx tsx src/memory/calibrate.ts holdout [--reps 2]   clone-only holdout loss of data/clones.json
//   npx tsx src/memory/calibrate.ts eval  [--matches 600] [--workers 8] [--mode field|entrants] [--size 6]
//                                         v2 ('rabbot', data/params.json) on field.json
//                                         tables, one seat swapped (field), or at a table of
//                                         --size with the rest drawn from the entrants
//                                         (entrants, no sims, as in a tournament);
//                                         paired: calibrated vs legacy clones
//
// Fit: every real seat of a fit-set table is played by its bot's clone (the
// rare bots share one "generic" param vector), on fresh seeds each round.
// All bots move at once by SPSA, an evolution-strategy gradient estimate:
// every bot's normalised params get an independent random +-c sign vector,
// the same tables and seeds are played at theta + c*d and theta - c*d, and
// each bot's own loss difference gives its gradient (the other bots'
// perturbations are independent noise to it). Adam steps, Polyak averaging
// over the last third. The newest 20% of matches is held out.

import * as fs from "node:fs";
import * as path from "node:path";
import { openDb } from "./db.js";
import { HISTORY_DB } from "./calibrate-legacy.js";
import { SimPool, paramsFromVec, paramsToVec, type MatchJob, type SeatJob } from "./calibrate-sim.js";
import {
  SUMMARY_KEYS,
  accumulate,
  buildField,
  loadRecentTables,
  sampleField,
  summarize,
  type Acc,
  type FieldFile,
  type RealTable,
  type SummaryKey,
} from "./calibrate-targets.js";
import {
  CLONES_PATH,
  DEFAULT_PARAMS,
  PARAM_BOUNDS,
  PARAM_KEYS,
  clampParams,
  cloneParamsFor,
  loadClonesFile,
  type ClonesFile,
} from "./clones.js";
import { isMain, rng32 } from "./util.js";

export const FIELD_PATH = path.join(import.meta.dirname, "..", "..", "data", "field.json");

/** Loss terms: (sim - real) / scale, squared, summed. Scales ~ what matters to a match. */
export const LOSS_SCALE: Partial<Record<SummaryKey, number>> = {
  score: 6,
  place: 0.25,
  tiles: 0.8,
  price: 0.8,
  words: 0.25,
  wordLen: 0.15,
  bingos: 0.15,
  playPhase: 0.04,
  coins: 8,
  left: 1.5,
};

export function lossOf(real: Record<SummaryKey, number>, sim: Record<SummaryKey, number>): number {
  let l = 0;
  for (const [k, s] of Object.entries(LOSS_SCALE) as [SummaryKey, number][]) l += ((sim[k] - real[k]) / s) ** 2;
  return l;
}

const GENERIC = -1;
const D = PARAM_KEYS.length;
const toUnit = (v: readonly number[]) =>
  v.map((x, i) => {
    const [lo, hi] = PARAM_BOUNDS[PARAM_KEYS[i]!];
    return (x - lo) / (hi - lo);
  });
const fromUnit = (u: readonly number[]) =>
  u.map((x, i) => {
    const [lo, hi] = PARAM_BOUNDS[PARAM_KEYS[i]!];
    return lo + Math.max(0, Math.min(1, x)) * (hi - lo);
  });

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

function sarg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1]) : def;
}

const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

/** Jobs replaying tables with every real seat a clone (params per key), sims as sims. */
function replayJobs(tables: readonly RealTable[], vecFor: (botId: number) => number[] | "legacy", seed: number): MatchJob[] {
  return tables.map((t, ti) => ({
    seed: (seed * 1_000_003 + ti * 7919 + t.matchId) >>> 0,
    seats: t.seats.map((s): SeatJob => {
      if (s.isSim) return { kind: "sim", botId: s.botId, strategy: (s.strategy ?? "ValueBidder") as "ValueBidder" };
      const v = vecFor(s.botId);
      return v === "legacy" ? { kind: "legacy", botId: s.botId } : { kind: "clone", botId: s.botId, params: v };
    }),
  }));
}

function simAcc(tables: readonly RealTable[], results: number[][][], reps = 1): Map<number, Acc> {
  const out = new Map<number, Acc>();
  for (let r = 0; r < reps; r++) {
    const part = accumulate(tables, (_t, i) => results[r * tables.length + i]!);
    for (const [b, a] of part) {
      const o = out.get(b);
      if (!o) out.set(b, a);
      else {
        o.n += a.n;
        for (let i = 0; i < a.sum.length; i++) o.sum[i]! += a.sum[i]!;
      }
    }
  }
  return out;
}

/** Folds the per-bot accumulators of non-fitted bots into GENERIC. */
function pooled(acc: Map<number, Acc>, fitted: ReadonlySet<number>): Map<number, Acc> {
  const out = new Map<number, Acc>();
  for (const [b, a] of acc) {
    const key = fitted.has(b) ? b : GENERIC;
    const o = out.get(key);
    if (!o) out.set(key, { n: a.n, sum: [...a.sum] });
    else {
      o.n += a.n;
      for (let i = 0; i < a.sum.length; i++) o.sum[i]! += a.sum[i]!;
    }
  }
  return out;
}

async function evalSet(
  pool: SimPool,
  tables: readonly RealTable[],
  vecFor: (botId: number) => number[] | "legacy",
  reps: number,
  seed: number,
): Promise<Map<number, Acc>> {
  const jobs: MatchJob[] = [];
  for (let r = 0; r < reps; r++) jobs.push(...replayJobs(tables, vecFor, seed + r));
  return simAcc(tables, await pool.run(jobs, 16), reps);
}

const round = (x: number, d = 2) => Number(x.toFixed(d));
const roundRec = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round(v, 3)]));

async function fit(): Promise<void> {
  const limit = arg("limit", 3000);
  const iters = arg("iters", 240);
  const workers = Math.min(8, arg("workers", 8));
  const minSeats = arg("min-seats", 30);
  const c = arg("c", 0.06);
  const lr0 = arg("lr", 0.03);
  log(`loading ${limit} tables from ${HISTORY_DB}`);
  const all = loadRecentTables(limit, HISTORY_DB);
  const cut = Math.floor(all.length * 0.8);
  const fitSet = all.slice(0, cut);
  const holdSet = all.slice(cut);
  log(`${all.length} tables: fit ${fitSet.length}, holdout ${holdSet.length} (newest)`);

  const realFitBot = accumulate(fitSet);
  const realHoldBot = accumulate(holdSet);
  const fittedIds = [...realFitBot.entries()].filter(([, a]) => a.n >= minSeats).sort((a, b) => b[1].n - a[1].n).map(([b]) => b);
  const fitted = new Set(fittedIds);
  const realFit = new Map([...pooled(realFitBot, fitted)].map(([b, a]) => [b, summarize(a)]));
  const realHold = new Map([...pooled(realHoldBot, fitted)].map(([b, a]) => [b, summarize(a)]));
  const keys = [...fittedIds, GENERIC];
  log(`fitting ${fittedIds.length} bots + generic`);

  const names = new Map<number, string>();
  {
    const db = openDb(HISTORY_DB, { readOnly: true });
    for (const r of db.prepare(`SELECT id, name FROM bot`).all()) names.set(Number(r.id), String(r.name));
    db.close();
  }

  const pool = new SimPool(workers);
  const theta = new Map<number, number[]>(keys.map((k) => [k, toUnit(paramsToVec(DEFAULT_PARAMS))]));
  const m1 = new Map<number, number[]>(keys.map((k) => [k, new Array<number>(D).fill(0)]));
  const m2 = new Map<number, number[]>(keys.map((k) => [k, new Array<number>(D).fill(0)]));
  const avg = new Map<number, number[]>(keys.map((k) => [k, new Array<number>(D).fill(0)]));
  let nAvg = 0;
  const avgFrom = Math.floor(iters * (2 / 3));
  const rng = rng32(12345);
  const keyOf = (b: number) => (fitted.has(b) ? b : GENERIC);

  const meanLoss = (acc: Map<number, Acc>, real: Map<number, Record<SummaryKey, number>>, onlyFitted = true) => {
    let s = 0;
    let w = 0;
    for (const [b, a] of pooled(acc, fitted)) {
      if (onlyFitted && b === GENERIC) continue;
      const r = real.get(b);
      if (!r) continue;
      s += lossOf(r, summarize(a)) * a.n;
      w += a.n;
    }
    return w ? s / w : NaN;
  };

  // Before: the legacy clones and the default-param clones.
  const t0 = Date.now();
  const legacyFit = await evalSet(pool, fitSet, () => "legacy", 1, 7);
  const legacyHold = await evalSet(pool, holdSet, () => "legacy", 2, 8);
  const defVec = paramsToVec(DEFAULT_PARAMS);
  const defHold = await evalSet(pool, holdSet, () => defVec, 2, 8);
  log(
    `before: legacy fit loss ${meanLoss(legacyFit, realFit).toFixed(2)} holdout ${meanLoss(legacyHold, realHold).toFixed(2)}; ` +
      `default-param holdout ${meanLoss(defHold, realHold).toFixed(2)} (${Date.now() - t0} ms)`,
  );

  // Multi-start: a few whole-field candidates around the defaults (holding
  // longer, bidding harder); each bot starts from the one that fits it best.
  const starts = arg("starts", 16);
  if (starts > 0) {
    const srng = rng32(99);
    const cands: number[][] = [paramsToVec(DEFAULT_PARAMS)];
    const pick = (lo: number, hi: number) => lo + srng() * (hi - lo);
    for (let s = 1; s < starts; s++) {
      cands.push(
        paramsToVec(
          clampParams({
            ...DEFAULT_PARAMS,
            bidLog: pick(-0.2, 0.5),
            highLog: pick(-0.3, 0.3),
            minLen: pick(3, 5.5),
            holdLen: pick(6.5, 9.5),
            holdRack: pick(0, 1),
            holdLate: pick(0, 4),
            endSpend: pick(0.3, 2),
            dumpAt: pick(1, 5),
          }),
        ),
      );
    }
    const best = new Map<number, { l: number; v: number[] }>();
    for (const [ci, v] of cands.entries()) {
      const acc = pooled(await evalSet(pool, fitSet, () => v, 1, 500 + ci), fitted);
      for (const k of keys) {
        const r = realFit.get(k);
        const a = acc.get(k);
        if (!r || !a) continue;
        const l = lossOf(r, summarize(a));
        if (l < (best.get(k)?.l ?? Infinity)) best.set(k, { l, v });
      }
    }
    for (const [k, b] of best) theta.set(k, toUnit(b.v));
    const startAcc = await evalSet(pool, fitSet, (b) => fromUnit(theta.get(keyOf(b))!), 1, 600);
    log(`multi-start (${cands.length} candidates): fit loss ${meanLoss(startAcc, realFit).toFixed(2)}`);
  }

  for (let it = 0; it < iters; it++) {
    const lr = lr0 * (it < iters / 2 ? 1 : 0.5 + (0.5 * (iters - it)) / (iters / 2));
    const delta = new Map<number, number[]>(keys.map((k) => [k, Array.from({ length: D }, () => (rng() < 0.5 ? -c : c))]));
    const plus = (b: number) => fromUnit(theta.get(keyOf(b))!.map((x, i) => x + delta.get(keyOf(b))![i]!));
    const minus = (b: number) => fromUnit(theta.get(keyOf(b))!.map((x, i) => x - delta.get(keyOf(b))![i]!));
    const seed = 1000 + it;
    const res = await pool.run([...replayJobs(fitSet, plus, seed), ...replayJobs(fitSet, minus, seed)], 16);
    const accP = pooled(simAcc(fitSet, res.slice(0, fitSet.length)), fitted);
    const accM = pooled(simAcc(fitSet, res.slice(fitSet.length)), fitted);
    let lp = 0;
    let lm = 0;
    let w = 0;
    for (const k of keys) {
      const r = realFit.get(k);
      const ap = accP.get(k);
      const am = accM.get(k);
      if (!r || !ap || !am) continue;
      const Lp = lossOf(r, summarize(ap));
      const Lm = lossOf(r, summarize(am));
      if (k !== GENERIC) {
        lp += Lp * ap.n;
        lm += Lm * ap.n;
        w += ap.n;
      }
      const d = delta.get(k)!;
      const th = theta.get(k)!;
      const g1 = m1.get(k)!;
      const g2 = m2.get(k)!;
      for (let i = 0; i < D; i++) {
        const g = ((Lp - Lm) / (2 * c * c)) * d[i]!; // d/c = +-1
        g1[i] = 0.9 * g1[i]! + 0.1 * g;
        g2[i] = 0.99 * g2[i]! + 0.01 * g * g;
        const mh = g1[i]! / (1 - 0.9 ** (it + 1));
        const vh = g2[i]! / (1 - 0.99 ** (it + 1));
        th[i] = Math.max(0, Math.min(1, th[i]! - (lr * mh) / (Math.sqrt(vh) + 1e-8)));
      }
    }
    if (it >= avgFrom) {
      nAvg++;
      for (const k of keys) {
        const a = avg.get(k)!;
        const th = theta.get(k)!;
        for (let i = 0; i < D; i++) a[i]! += (th[i]! - a[i]!) / nAvg;
      }
    }
    if (it % 10 === 0 || it === iters - 1) log(`iter ${it}: fit loss +${(lp / w).toFixed(2)} -${(lm / w).toFixed(2)}`);
  }

  const finalTheta = nAvg > 0 ? avg : theta;
  const vecs = new Map<number, number[]>(keys.map((k) => [k, paramsToVec(clampParams(paramsFromVec(fromUnit(finalTheta.get(k)!))))]));
  const vecFor = (b: number) => vecs.get(keyOf(b))!;
  const afterFit = await evalSet(pool, fitSet, vecFor, 2, 50);
  const afterHold = await evalSet(pool, holdSet, vecFor, 4, 60);
  await pool.close();
  log(
    `after: fit loss ${meanLoss(afterFit, realFit).toFixed(2)} holdout ${meanLoss(afterHold, realHold).toFixed(2)} ` +
      `(legacy holdout ${meanLoss(legacyHold, realHold).toFixed(2)}, default-param holdout ${meanLoss(defHold, realHold).toFixed(2)})`,
  );

  const pf = pooled(afterFit, fitted);
  const ph = pooled(afterHold, fitted);
  const lh = pooled(legacyHold, fitted);
  const out: ClonesFile & Record<string, unknown> = {
    note:
      "Clone behaviour params fitted by src/memory/calibrate.ts (SPSA on clone-only replays of real tables). " +
      "errFit/errHoldout: per-seat loss (sum of squared scaled errors, see LOSS_SCALE). real/sim: holdout numbers.",
    fittedAt: new Date().toISOString(),
    generic: paramsFromVec(vecs.get(GENERIC)!),
    bots: {},
    summary: {
      tables: { fit: fitSet.length, holdout: holdSet.length },
      iters,
      lossScale: LOSS_SCALE,
      holdoutLoss: { legacy: round(meanLoss(legacyHold, realHold), 3), defaultParams: round(meanLoss(defHold, realHold), 3), calibrated: round(meanLoss(afterHold, realHold), 3) },
      fitLoss: { legacy: round(meanLoss(legacyFit, realFit), 3), calibrated: round(meanLoss(afterFit, realFit), 3) },
    },
  };
  for (const k of keys) {
    const rH = realHold.get(k);
    const sH = ph.get(k);
    const rF = realFit.get(k)!;
    const sF = pf.get(k);
    const entry = {
      name: k === GENERIC ? "generic" : (names.get(k) ?? `#${k}`),
      params: Object.fromEntries(Object.entries(paramsFromVec(vecs.get(k)!)).map(([a, v]) => [a, round(v, 4)])) as unknown as ClonesFile["generic"],
      fit: {
        nFit: realFitBot.get(k)?.n ?? 0,
        nHoldout: realHoldBot.get(k)?.n ?? 0,
        errFit: sF ? round(lossOf(rF, summarize(sF)), 3) : NaN,
        errHoldout: rH && sH ? round(lossOf(rH, summarize(sH)), 3) : NaN,
        errHoldoutLegacy: rH && lh.get(k) ? round(lossOf(rH, summarize(lh.get(k)!)), 3) : NaN,
        real: roundRec(rH ?? rF),
        sim: roundRec(sH ? summarize(sH) : sF ? summarize(sF) : {}),
        legacy: lh.get(k) ? roundRec(summarize(lh.get(k)!)) : {},
      },
    };
    if (k === GENERIC) (out as Record<string, unknown>).genericFit = entry.fit;
    else out.bots[String(k)] = entry;
  }
  fs.writeFileSync(CLONES_PATH, JSON.stringify(out, null, 1) + "\n");
  log(`wrote ${CLONES_PATH}`);

  // Report: top 15 by seats.
  const cols: SummaryKey[] = ["score", "place", "tiles", "price", "wordLen", "bingos", "words"];
  console.log(`\nholdout, real / calibrated / legacy\n${"bot".padEnd(18)}${cols.map((c) => c.padStart(22)).join("")}`);
  for (const k of fittedIds.slice(0, 15)) {
    const e = out.bots[String(k)]!.fit! as unknown as { real: Record<string, number>; sim: Record<string, number>; legacy: Record<string, number> };
    console.log(
      `${(names.get(k) ?? String(k)).slice(0, 17).padEnd(18)}` +
        cols.map((c) => `${e.real[c]?.toFixed(2)}/${e.sim[c]?.toFixed(2)}/${e.legacy[c]?.toFixed(2)}`.padStart(22)).join(""),
    );
  }
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Likely entrants with too few seats for their own fit would otherwise play
 * the generic params, fitted mostly on weaker bots. Give each the params of
 * the fitted bot whose real (holdout) score is nearest its recent mean score,
 * and write that into data/clones.json (marked borrowedFrom).
 */
function borrowForEntrants(clones: ClonesFile, f: FieldFile): void {
  const donors = Object.entries(clones.bots)
    .filter(([, e]) => !e.borrowedFrom && e.fit && Number.isFinite(e.fit.real.score) && e.fit.nFit >= 100)
    .map(([id, e]) => ({ id: Number(id), score: e.fit!.real.score! }));
  let changed = 0;
  for (const e of f.entrants ?? []) {
    if (e.fitted) continue;
    const d = donors.reduce((a, b) => (Math.abs(b.score - e.meanScore) < Math.abs(a.score - e.meanScore) ? b : a));
    clones.bots[String(e.id)] = { name: e.name, params: { ...clones.bots[String(d.id)]!.params }, borrowedFrom: d.id };
    log(`entrant ${e.name} (#${e.id}, score ${e.meanScore}): params borrowed from ${clones.bots[String(d.id)]!.name} (#${d.id}, score ${d.score})`);
    changed++;
  }
  if (changed) fs.writeFileSync(CLONES_PATH, JSON.stringify(clones, null, 1) + "\n");
}

/** Clone-only holdout loss of data/clones.json as it stands (floorQ from the file or RABBOT_CLONE_FLOORQ). */
async function holdout(): Promise<void> {
  const all = loadRecentTables(arg("limit", 3000), HISTORY_DB);
  const cut = Math.floor(all.length * 0.8);
  const holdSet = all.slice(cut);
  const clones = loadClonesFile();
  if (!clones) throw new Error("no data/clones.json");
  const fitted = new Set(Object.entries(clones.bots).filter(([, e]) => e.fit && !e.borrowedFrom).map(([id]) => Number(id)));
  const real = new Map([...pooled(accumulate(holdSet), fitted)].map(([b, a]) => [b, summarize(a)]));
  const pool = new SimPool(Math.min(8, arg("workers", 6)));
  const vecFor = (b: number) => paramsToVec(cloneParamsFor(b, clones));
  const acc = pooled(await evalSet(pool, holdSet, vecFor, arg("reps", 2), 60), fitted);
  await pool.close();
  let s = 0;
  let w = 0;
  const bias = new Map<string, number>();
  for (const [b, a] of acc) {
    const r = real.get(b);
    if (b === GENERIC || !r) continue;
    const sm = summarize(a);
    s += lossOf(r, sm) * a.n;
    w += a.n;
    for (const k of ["score", "place", "tiles", "price", "wordLen", "bingos", "words"] as SummaryKey[])
      bias.set(k, (bias.get(k) ?? 0) + (sm[k] - r[k]) * a.n);
  }
  log(
    `holdout (${holdSet.length} tables, bidShift ${process.env.RABBOT_CLONE_SHIFT ?? clones.bidShift ?? 0}, phaseTilt ${process.env.RABBOT_CLONE_TILT ?? clones.phaseTilt ?? 0}, floorQ ${process.env.RABBOT_CLONE_FLOORQ ?? clones.floorQ ?? 0}): loss ${(s / w).toFixed(2)}; bias ` +
      [...bias].map(([k, v]) => `${k} ${(v / w >= 0 ? "+" : "") + (v / w).toFixed(2)}`).join(", "),
  );
}

function writeField(): FieldFile {
  const dbPath = sarg("db", HISTORY_DB);
  const db = openDb(dbPath, { readOnly: true });
  try {
    // RABBOT itself is not an opponent.
    const self = new Set<number>();
    for (const r of db.prepare(`SELECT id FROM bot WHERE name LIKE 'RABBOT%'`).all()) self.add(Number(r.id));
    const f = buildField(db, arg("window", 24), arg("half-life", 6), arg("active", 6), {
      top: arg("top", 16),
      minSeats: arg("min-seats", 30),
      exclude: self,
    });
    const clones = loadClonesFile();
    for (const e of f.entrants ?? []) e.fitted = !!clones?.bots[String(e.id)] && !clones.bots[String(e.id)]!.borrowedFrom;
    if (clones && hasFlag("borrow")) borrowForEntrants(clones, f);
    f.note += ` Source ${path.basename(dbPath)}. entrants: likely tournament field, see FieldFile.entrants.`;
    fs.writeFileSync(FIELD_PATH, JSON.stringify(f) + "\n");
    log(`wrote ${FIELD_PATH}: ${f.tables.length} tables, ${Object.keys(f.bots).length} bots, data until ${f.dataUntil}`);
    for (const [i, e] of (f.entrants ?? []).entries())
      console.log(
        `${String(i + 1).padStart(3)} ${e.name.slice(0, 18).padEnd(19)}#${String(e.id).padEnd(4)} beat ${e.beatShare.toFixed(3)} ` +
          `score ${e.meanScore.toFixed(1)} place ${e.meanPlace.toFixed(2)} seats ${e.seats} rating ${e.rating ?? "-"}${e.fitted ? "" : " (generic clone)"}`,
      );
    return f;
  } finally {
    db.close();
  }
}

/** Paired: same table, seat and seed with calibrated clones vs legacy clones around v2. */
async function evalField(): Promise<void> {
  const n = arg("matches", 600);
  const workers = Math.min(8, arg("workers", 8));
  const f = JSON.parse(fs.readFileSync(FIELD_PATH, "utf8")) as FieldFile;
  const rng = rng32(arg("seed", 777));
  const mode = sarg("mode", "field");
  const size = arg("size", 6);
  let tables: number[][];
  if (mode === "entrants") {
    const ids = (f.entrants ?? []).map((e) => e.id);
    if (ids.length < size - 1) throw new Error(`field.json has ${ids.length} entrants, need ${size - 1}`);
    // RABBOT in seat 0 placeholder, then size-1 distinct entrants; seat order shuffled.
    tables = Array.from({ length: n }, () => {
      const pool = [...ids];
      const t: number[] = [-1];
      for (let k = 1; k < size; k++) t.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]!);
      for (let k = t.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [t[k], t[j]] = [t[j]!, t[k]!];
      }
      return t;
    });
    console.log(`entrants mode: ${n} tables of ${size}, RABBOT + ${size - 1} of ${ids.length} entrants, no sims`);
  } else tables = sampleField(f, n, rng);
  const RABBOT = 1_000_000;
  const mk = (legacy: boolean): MatchJob[] =>
    tables.map((bots, i) => {
      const real = bots.map((b, j) => (b ? j : -1)).filter((j) => j >= 0);
      const swap = bots.indexOf(-1) >= 0 ? bots.indexOf(-1) : (real[Math.floor(rng32(i * 31 + 5)() * real.length)] ?? 0);
      return {
        seed: 900_000 + i,
        seats: bots.map((b, j): SeatJob => {
          if (j === swap) return { kind: "rabbot", botId: RABBOT };
          if (!b) return { kind: "sim", botId: 2_000_000 + j, strategy: "ValueBidder" };
          return legacy ? { kind: "legacy", botId: b } : { kind: "clone", botId: b };
        }),
      };
    });
  const pool = new SimPool(workers);
  const t0 = Date.now();
  for (const legacy of hasFlag("no-legacy") ? [false] : [false, true]) {
    const jobs = mk(legacy);
    const res = await pool.run(jobs, 4);
    const pal: number[][] = [];
    const others: number[] = [];
    // Tournament view: Swiss points = size - (seats strictly ahead); last = no one strictly behind.
    const swiss: number[] = [];
    let last = 0;
    jobs.forEach((j, i) => {
      const scores = res[i]!.map((v) => v[0]!);
      j.seats.forEach((s, k) => {
        if (s.kind === "rabbot") {
          pal.push(res[i]![k]!);
          swiss.push(Math.max(j.seats.length - scores.filter((x) => x > scores[k]!).length, 0));
          if (!scores.some((x) => x < scores[k]!)) last++;
        } else others.push(res[i]![k]![0]!);
      });
    });
    const sm = swiss.reduce((a, b) => a + b, 0) / swiss.length;
    const ssd = Math.sqrt(swiss.reduce((a, b) => a + (b - sm) ** 2, 0) / (swiss.length - 1) / swiss.length);
    const m = (k: number) => pal.reduce((a, v) => a + v[k]!, 0) / pal.length;
    const sd = (k: number) => Math.sqrt(pal.reduce((a, v) => a + (v[k]! - m(k)) ** 2, 0) / (pal.length - 1) / pal.length);
    // indexes per STAT_KEYS: score 0, place 1, win 2, tiles 3, paid 4, words 6, letters 7, bingos 8
    const tiles = m(3);
    console.log(
      `${legacy ? "legacy clones    " : "calibrated clones"} n=${pal.length}: place ${m(1).toFixed(2)} +-${(1.96 * sd(1)).toFixed(2)}, ` +
        `win ${(100 * m(2)).toFixed(1)}% +-${(196 * sd(2)).toFixed(1)}, score ${m(0).toFixed(1)} +-${(1.96 * sd(0)).toFixed(1)}, ` +
        `7+ words ${m(8).toFixed(2)}, tiles ${tiles.toFixed(1)}, price ${(m(4) / tiles).toFixed(1)}, ` +
        `field score ${(others.reduce((a, b) => a + b, 0) / others.length).toFixed(1)}, ` +
        `swiss pts ${sm.toFixed(2)} +-${(1.96 * ssd).toFixed(2)}, last ${((100 * last) / pal.length).toFixed(1)}% (${Date.now() - t0} ms)`,
    );
  }
  await pool.close();
}

if (isMain(import.meta.url)) {
  const cmd = process.argv[2];
  const run =
    cmd === "fit" ? fit : cmd === "field" ? async () => void writeField() : cmd === "eval" ? evalField : cmd === "holdout" ? holdout : null;
  if (!run) {
    console.error("usage: calibrate.ts fit|field|eval|holdout [options]");
    process.exit(2);
  }
  run().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
