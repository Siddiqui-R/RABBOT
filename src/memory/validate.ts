// Out-of-time check of the bid model: fit on the oldest 80% of matches,
// score the newest 20%.
//
//   npx tsx src/memory/validate.ts [--holdout 0.2] [--half-life 12] [--old-version 0.3]
//                                  [--prior-scale 1] [--market-share 0.05] [--no-store]
//
// Reports, on held-out data:
//  - log-likelihood per observation, bot model vs market-only baseline;
//  - calibration of predicted quantiles against observed winning bids. A
//    winner's bid is selected (it beat everyone), so raw coverage is
//    expected to sit high; the selection-aware check conditions on
//    bid >= paid and should be uniform if the model is right;
//  - reliability of the predicted win probability given the best rival
//    bid (others' max: paid if it won, the winner's top bid if it lost).

import { DEFAULT_DB_PATH, num, openDb, setMeta } from "./db.js";
import { BOT_PRIOR, KIND_EQ, bidPmf, rawLogLik, type BidParams, type PriorScales } from "./fit.js";
import { DEFAULT_CONFIG, fitAll, type ModelConfig } from "./train.js";
import { isMain, rng32 } from "./util.js";

export interface ValidationReport {
  at: string;
  config: { halfLifeHours: number; oldVersionFactor: number; marketMaxShare: number; priorScale: number; emRounds: number };
  trainMatches: number;
  testMatches: number;
  cutoffUs: number;
  trainObs: number;
  testObs: number;
  fitSeconds: number;
  logLik: { model: number; market: number; n: number; byData: { bucket: string; n: number; model: number; market: number }[] };
  winners: {
    n: number;
    coverage: { p: number; model: number; market: number }[];
    conditionalPitDeciles: { model: number[]; market: number[] };
    conditionalKs: { model: number; market: number };
  };
  winProb: {
    n: number;
    brier: { model: number; market: number };
    logLoss: { model: number; market: number };
    bins: { lo: number; hi: number; n: number; predicted: number; observed: number }[];
  };
}

function scalePrior(p: PriorScales, k: number): PriorScales {
  return { delta: p.delta * k, zeta: p.zeta * k, e: p.e * k, f: p.f * k, g: p.g * k, h: p.h * k, cov: p.cov * k, s: p.s * k };
}

export function validate(dbPath: string, cfg: ModelConfig, holdout = 0.2, priorScale = 1): ValidationReport {
  const db = openDb(dbPath);
  try {
    const ends = db.prepare("SELECT ended_us FROM match_info ORDER BY ended_us").all().map((r) => num(r.ended_us));
    const cut = ends[Math.floor(ends.length * (1 - holdout)) - 1]!;
    const t0 = Date.now();
    const fit = fitAll(db, cfg, { beforeUs: cut });
    const fitSeconds = (Date.now() - t0) / 1000;
    const market = fit.market;
    const paramsOf = (bot: number): BidParams => fit.bots.get(bot)?.params ?? market;
    const trainN = (bot: number) => fit.bots.get(bot)?.nObs ?? 0;

    let llM = 0;
    let llK = 0;
    let n = 0;
    const byData = new Map<string, { n: number; model: number; market: number }>();
    const bucketOf = (k: number) => (k < 500 ? "<500" : k < 5000 ? "500-5k" : k < 20000 ? "5k-20k" : "20k+");
    const ps = [0.1, 0.25, 0.5, 0.75, 0.9];
    const cov = { model: ps.map(() => 0), market: ps.map(() => 0) };
    const pit = { model: new Array(10).fill(0), market: new Array(10).fill(0) };
    const pitVals = { model: [] as number[], market: [] as number[] };
    let nWin = 0;
    const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0, predicted: 0, observed: 0 }));
    let brierM = 0;
    let brierK = 0;
    let lossM = 0;
    let lossK = 0;
    let nProb = 0;
    const rng = rng32(12345);

    const rows = db
      .prepare(
        `SELECT bot_id, letter, phase, balance, cap, rack_size, kind, value, won, others_max
         FROM bid_obs WHERE ended_us > ?`,
      )
      .iterate(cut);
    for (const r of rows) {
      const bot = num(r.bot_id);
      const letter = String(r.letter).charCodeAt(0) - 65;
      const o = {
        letter,
        phase: Number(r.phase),
        balance: num(r.balance),
        cap: num(r.cap),
        rack: num(r.rack_size),
        kind: num(r.kind),
        value: num(r.value),
        weight: 1,
      };
      const p = paramsOf(bot);
      const a = rawLogLik(p, o);
      const b = rawLogLik(market, o);
      if (a !== null && b !== null) {
        llM += a;
        llK += b;
        n++;
        const key = bucketOf(trainN(bot));
        const e = byData.get(key) ?? { n: 0, model: 0, market: 0 };
        e.n++;
        e.model += a;
        e.market += b;
        byData.set(key, e);
      }

      const won = num(r.won) === 1;
      const om = r.others_max === null ? null : num(r.others_max);
      // Calibration needs the full predicted distribution; subsample the
      // (many) losing rows to keep this quick.
      // The win-probability sample is drawn independently of the outcome.
      const inProb = om !== null && rng() < 0.25;
      const needPmf = (won && o.kind === KIND_EQ) || inProb;
      if (!needPmf) continue;
      const pmfs = { model: bidPmf(p, letter, o.phase, o.cap, o.rack), market: bidPmf(market, letter, o.phase, o.cap, o.rack) };
      const cdf = (pmf: Float64Array, x: number) => {
        let s = 0;
        for (let i = 0; i <= Math.min(x, pmf.length - 1); i++) s += pmf[i]!;
        return x < 0 ? 0 : s;
      };
      if (won && o.kind === KIND_EQ) {
        nWin++;
        const x = o.value;
        const M = om ?? 0;
        const u = rng();
        for (const which of ["model", "market"] as const) {
          const pmf = pmfs[which];
          const Fx = cdf(pmf, x);
          const Fx1 = cdf(pmf, x - 1);
          ps.forEach((q, i) => {
            // Coverage: share of winning bids at or below the predicted q-quantile.
            if (Fx1 < q) cov[which][i]! += 1;
          });
          // Conditional on bid >= M (it won): randomized PIT.
          const FM1 = cdf(pmf, M - 1);
          const denom = 1 - FM1;
          const v = denom > 1e-12 ? (Fx1 - FM1 + u * (Fx - Fx1)) / denom : u;
          const c = Math.max(0, Math.min(0.999999, v));
          pit[which][Math.floor(c * 10)]! += 1;
          pitVals[which].push(c);
        }
      }
      if (inProb && om !== null) {
        // Win if bid > rival max; an exact tie is a coin flip (two-way).
        const pw = (pmf: Float64Array) => 1 - cdf(pmf, om) + 0.5 * (om >= 1 && om < pmf.length ? pmf[om]! : 0);
        const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
        const pm = clamp01(pw(pmfs.model));
        const pk = clamp01(pw(pmfs.market));
        const y = won ? 1 : 0;
        brierM += (pm - y) ** 2;
        brierK += (pk - y) ** 2;
        const ll = (p: number) => -Math.log(Math.max(1e-6, y ? p : 1 - p));
        lossM += ll(pm);
        lossK += ll(pk);
        nProb++;
        const bin = bins[Math.min(9, Math.floor(pm * 10))]!;
        bin.n++;
        bin.predicted += pm;
        bin.observed += y;
      }
    }
    const ks = (v: number[]) => {
      v.sort((a, b) => a - b);
      let d = 0;
      v.forEach((x, i) => (d = Math.max(d, Math.abs(x - (i + 0.5) / v.length))));
      return d;
    };
    const testMatches = ends.filter((e) => e > cut).length;
    return {
      at: new Date().toISOString(),
      config: {
        halfLifeHours: cfg.halfLifeHours,
        oldVersionFactor: cfg.oldVersionFactor,
        marketMaxShare: cfg.marketMaxShare,
        priorScale,
        emRounds: cfg.emRounds,
      },
      trainMatches: ends.length - testMatches,
      testMatches,
      cutoffUs: cut,
      trainObs: fit.obs,
      testObs: n,
      fitSeconds,
      logLik: {
        model: llM / n,
        market: llK / n,
        n,
        byData: [...byData].map(([bucket, e]) => ({ bucket, n: e.n, model: e.model / e.n, market: e.market / e.n })),
      },
      winners: {
        n: nWin,
        coverage: ps.map((p, i) => ({ p, model: cov.model[i]! / nWin, market: cov.market[i]! / nWin })),
        conditionalPitDeciles: { model: pit.model.map((x) => x / nWin), market: pit.market.map((x) => x / nWin) },
        conditionalKs: { model: ks(pitVals.model), market: ks(pitVals.market) },
      },
      winProb: {
        n: nProb,
        brier: { model: brierM / nProb, market: brierK / nProb },
        logLoss: { model: lossM / nProb, market: lossK / nProb },
        bins: bins.map((b) => ({ ...b, predicted: b.n ? b.predicted / b.n : 0, observed: b.n ? b.observed / b.n : 0 })),
      },
    };
  } finally {
    db.close();
  }
}

export function formatValidation(v: ValidationReport): string {
  const f = (x: number, d = 3) => x.toFixed(d);
  const lines: string[] = [];
  lines.push(
    `Holdout: newest ${v.testMatches} matches (${v.testObs} bid observations); trained on ${v.trainMatches} matches (${v.trainObs} obs), fit ${f(v.fitSeconds, 1)}s.`,
    `Config: half-life ${v.config.halfLifeHours}h, old-version weight ${v.config.oldVersionFactor}, market share cap ${v.config.marketMaxShare}, prior scale ${v.config.priorScale} x BOT_PRIOR, runner-up EM rounds ${v.config.emRounds}.`,
    "",
    `Log-likelihood per observation: model ${f(v.logLik.model, 4)} vs market-only ${f(v.logLik.market, 4)} (gain ${f(v.logLik.model - v.logLik.market, 4)} nats/obs).`,
    "",
    "| bot training obs | test obs | model ll | market ll | gain |",
    "|---|---:|---:|---:|---:|",
    ...v.logLik.byData
      .sort((a, b) => a.bucket.localeCompare(b.bucket))
      .map((b) => `| ${b.bucket} | ${b.n} | ${f(b.model, 4)} | ${f(b.market, 4)} | ${f(b.model - b.market, 4)} |`),
    "",
    `Winning bids (${v.winners.n}): share at or below the predicted quantile. Winners are selected from the top, so raw coverage runs high by construction.`,
    "",
    "| quantile | model | market |",
    "|---:|---:|---:|",
    ...v.winners.coverage.map((c) => `| q${Math.round(c.p * 100)} | ${f(c.model)} | ${f(c.market)} |`),
    "",
    `Selection-aware check (PIT of the winning bid given bid >= paid; uniform = calibrated): KS distance model ${f(v.winners.conditionalKs.model)} vs market ${f(v.winners.conditionalKs.market)}.`,
    `Deciles (model): ${v.winners.conditionalPitDeciles.model.map((x) => f(x, 2)).join(" ")}`,
    `Deciles (market): ${v.winners.conditionalPitDeciles.market.map((x) => f(x, 2)).join(" ")}`,
    "",
    `Win probability given the best rival bid (${v.winProb.n} sampled bot-auctions): Brier model ${f(v.winProb.brier.model, 4)} vs market ${f(v.winProb.brier.market, 4)}; log-loss model ${f(v.winProb.logLoss?.model ?? NaN, 4)} vs market ${f(v.winProb.logLoss?.market ?? NaN, 4)}.`,
    "",
    "| predicted | n | mean predicted | observed |",
    "|---|---:|---:|---:|",
    ...v.winProb.bins.filter((b) => b.n > 0).map((b) => `| ${f(b.lo, 1)}-${f(b.hi, 1)} | ${b.n} | ${f(b.predicted)} | ${f(b.observed)} |`),
  );
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string, d: number) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1]) : d;
  };
  const priorScale = arg("--prior-scale", 1);
  const cfg: ModelConfig = {
    halfLifeHours: arg("--half-life", DEFAULT_CONFIG.halfLifeHours),
    oldVersionFactor: arg("--old-version", DEFAULT_CONFIG.oldVersionFactor),
    marketMaxShare: arg("--market-share", DEFAULT_CONFIG.marketMaxShare),
    botPrior: scalePrior(BOT_PRIOR, priorScale),
    emRounds: arg("--em", DEFAULT_CONFIG.emRounds),
  };
  const dbPath = argv.includes("--db") ? argv[argv.indexOf("--db") + 1]! : DEFAULT_DB_PATH;
  const v = validate(dbPath, cfg, arg("--holdout", 0.2), priorScale);
  console.log(formatValidation(v));
  if (!argv.includes("--no-store")) {
    const db = openDb(dbPath);
    setMeta(db, "validation", JSON.stringify(v));
    db.close();
  }
}

if (isMain(import.meta.url)) main();
