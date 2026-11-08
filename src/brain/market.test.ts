import assert from "node:assert/strict";
import { test } from "node:test";
import { decideBid } from "../sim/engine.js";
import { chooseBid, rivalCut } from "./bid.js";
import {
  Market,
  cdfOf,
  genericPmf,
  letterMarket,
  maxCdf,
  pmfOfCdf,
  projected,
  scalePmf,
  secondCdf,
  simPmf,
  solveLambda,
  type BidModel,
} from "./market.js";
import { DEFAULT_PARAMS, type Params } from "./params.js";
import { mulberry32 } from "./value.js";

const P: Params = { ...DEFAULT_PARAMS };

function sampleFrom(pmf: Float64Array, r: number): number {
  let acc = 0;
  for (let x = 0; x < pmf.length; x++) {
    acc += pmf[x]!;
    if (r < acc) return x;
  }
  return pmf.length - 1;
}

test("simPmf is the server's decideBid with uniform jitter", () => {
  for (const kind of ["Cheapskate", "ValueBidder", "Aggressive"] as const) {
    for (const letter of ["A", "E", "Q", "Z", "K", "D"]) {
      for (const balance of [0, 1, 3, 8, 100]) {
        const pmf = simPmf(kind, letter, balance, 120);
        const want = new Float64Array(120);
        for (let j = -2; j <= 2; j++) want[decideBid(kind, letter, balance, j)]! += 0.2;
        for (let x = 0; x < 120; x++) assert.ok(Math.abs(pmf[x]! - want[x]!) < 1e-12, `${kind} ${letter} ${balance} @${x}`);
      }
    }
  }
});

test("max and second-highest CDFs match Monte Carlo", () => {
  const len = 40;
  const pmfs = [genericPmf(P, "E", 30, len), genericPmf(P, "K", 39, len), simPmf("Aggressive", "E", 25, len)];
  const cdfs = pmfs.map(cdfOf);
  const G = maxCdf(cdfs, len);
  const H = secondCdf(cdfs, len);
  const rand = mulberry32(5);
  const N = 200_000;
  const cm = new Float64Array(len);
  const cs = new Float64Array(len);
  for (let i = 0; i < N; i++) {
    const xs = pmfs.map((p) => sampleFrom(p, rand())).sort((a, b) => b - a);
    cm[xs[0]!]!++;
    cs[xs[1]!]!++;
  }
  let am = 0;
  let as = 0;
  for (let x = 0; x < len; x++) {
    am += cm[x]! / N;
    as += cs[x]! / N;
    assert.ok(Math.abs(am - G[x]!) < 0.006, `max cdf @${x}: ${am} vs ${G[x]}`);
    assert.ok(Math.abs(as - H[x]!) < 0.006, `second cdf @${x}: ${as} vs ${H[x]}`);
  }
  const g = pmfOfCdf(G);
  assert.ok(Math.abs(g.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("scalePmf keeps mass, zero stays zero, caps at balance", () => {
  const p = genericPmf(P, "Z", 60, 80);
  const s = scalePmf(p, 1.5, 60);
  assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(s[0], p[0]);
  for (let x = 61; x < 80; x++) assert.equal(s[x], 0);
  const mean = (q: Float64Array) => q.reduce((a, b, x) => a + b * x, 0);
  assert.ok(mean(scalePmf(p, 0.5, 60)) < mean(p));
});

test("Vickrey without rivals bids about value / lambda", () => {
  const len = 101;
  const pmfs = [genericPmf(P, "E", 100, len), genericPmf(P, "R", 100, len)];
  const cdfs = pmfs.map(cdfOf);
  for (const [v, lam] of [
    [5, 0.5],
    [12, 0.4],
    [3, 0.25],
  ] as const) {
    const c = chooseBid({ value: v, lambda: lam, balance: 100, firstPrice: false, pmfs, cdfs, weights: [0, 0], tieShare: 0.5, maxOverbid: 0 });
    assert.ok(Math.abs(c.bid - v / lam) <= 1, `v=${v} lam=${lam} bid=${c.bid}`);
    assert.equal(c.bid, c.selfBid);
  }
  // Never above the balance; no higher than it takes to win for sure.
  const c = chooseBid({ value: 50, lambda: 0.1, balance: 37, firstPrice: false, pmfs, cdfs, weights: [0, 0], tieShare: 0.5, maxOverbid: 5 });
  assert.ok(c.bid <= 37 && c.pWin > 0.999, `bid ${c.bid} pWin ${c.pWin}`);
  const poor = chooseBid({ value: 50, lambda: 0.1, balance: 9, firstPrice: false, pmfs, cdfs, weights: [0, 0], tieShare: 0.5, maxOverbid: 5 });
  assert.equal(poor.bid, 9);
});

test("FirstPrice shades below the truthful bid", () => {
  const len = 101;
  const pmfs = [genericPmf(P, "E", 100, len), genericPmf(P, "R", 100, len)];
  const cdfs = pmfs.map(cdfOf);
  const v = 10;
  const lam = 0.4;
  const fp = chooseBid({ value: v, lambda: lam, balance: 100, firstPrice: true, pmfs, cdfs, weights: [0, 0], tieShare: 0.5, maxOverbid: 0 });
  assert.ok(fp.bid < v / lam && fp.bid > 0, `first price bid ${fp.bid}`);
});

test("rival weight only raises the bid, within maxOverbid", () => {
  const len = 101;
  const pmfs = [genericPmf({ ...P, mktBase: 20 }, "Z", 100, len), genericPmf(P, "E", 100, len)];
  const cdfs = pmfs.map(cdfOf);
  const base = { value: 3, lambda: 0.5, balance: 100, firstPrice: false, pmfs, cdfs, tieShare: 0.5 };
  const selfish = chooseBid({ ...base, weights: [0, 0], maxOverbid: 10 });
  const driven = chooseBid({ ...base, weights: [1, 0], maxOverbid: 10 });
  assert.ok(driven.bid >= selfish.bid);
  assert.ok(driven.bid <= selfish.selfBid + 10);
  const capped = chooseBid({ ...base, weights: [1, 0], maxOverbid: 0 });
  assert.equal(capped.bid, capped.selfBid);
});

test("lambda solve: spending matches the budget and falls as lambda rises", () => {
  const len = 120;
  const markets = Array.from({ length: 26 }, (_, i) => {
    const L = String.fromCharCode(65 + i);
    const cdfs = [0, 1, 2, 3, 4].map(() => cdfOf(genericPmf(P, L, 100, len)));
    return letterMarket(maxCdf(cdfs, len), 0.5);
  });
  const values = Float64Array.from({ length: 26 }, (_, i) => 2 + (i % 7));
  const counts = Float64Array.from({ length: 26 }, () => 1.5);
  let prev = Infinity;
  for (const lam of [0.05, 0.1, 0.2, 0.4, 0.8, 1.6]) {
    const s = projected({ values, counts, markets, budget: 0, p: P }, lam).spend;
    assert.ok(s <= prev + 1e-9);
    prev = s;
  }
  for (const budget of [30, 100, 200]) {
    const r = solveLambda({ values, counts, markets, budget, p: P });
    assert.ok(r.lambda > P.lambdaMin && r.lambda < P.lambdaMax);
    assert.ok(Math.abs(r.spend - budget) / budget < 0.15, `budget ${budget}: spend ${r.spend}`);
  }
  // Nothing worth buying: coins are worthless.
  const none = solveLambda({ values: new Float64Array(26), counts, markets, budget: 100, p: P });
  assert.equal(none.lambda, P.lambdaMin);
});

test("calibration learns that bidders bid more (or less) than predicted", () => {
  const len = 101;
  const fake: BidModel = {
    strategyOf: () => "Human",
    predictBid: (_id, letter, ctx) => {
      const pmf = genericPmf(P, letter, ctx.balance, ctx.balance + 1);
      return { pmf, mean: 0 };
    },
  };
  for (const truth of [0.5, 1.8]) {
    const m = new Market({ ...P, calibRate: 0.1 }, fake);
    const rand = mulberry32(17);
    const seats = [101, 102, 103, 104, 105].map((botId) => ({ botId, isSim: false, balance: 100, rackSize: 7 }));
    for (let a = 0; a < 120; a++) {
      const L = "EAIRSTZQK"[a % 9]!;
      const pmfs = seats.map((s) => m.bidPmf(s, L, 0.3, len));
      m.expect(a, L, 0, pmfs.map(cdfOf), len);
      // True bids: the unscaled prediction times `truth`.
      const bids = seats
        .map((s) => Math.min(100, Math.round(truth * sampleFrom(genericPmf(P, L, s.balance, len), rand()))))
        .sort((x, y) => y - x);
      const winner = bids[0]! > 0 ? 101 : null;
      const paid = bids[0]! > 0 ? Math.max(bids[1]!, 1) : 0;
      m.observe(a, winner, paid, 999, false);
    }
    assert.ok(Math.abs(Math.log(m.scale / truth)) < 0.3, `truth ${truth}, learned ${m.scale}`);
  }
});

test("rival cut and its denial part match brute force", () => {
  const len = 30;
  const f = genericPmf({ ...P, mktBase: 6 }, "K", 28, len);
  const others = maxCdf([cdfOf(genericPmf(P, "E", 25, len)), cdfOf(simPmf("Aggressive", "K", 20, len))], len);
  const g = pmfOfCdf(others);
  const B = 25;
  const { denial, cut } = rivalCut(f, others, B);
  for (let b = 0; b <= B; b++) {
    let c = 0;
    let d = 0;
    for (let x = 0; x < len; x++) {
      for (let y = 0; y < len; y++) {
        const pr = f[x]! * g[y]!;
        if (pr === 0) continue;
        const s0 = Math.max(0, x - Math.max(y, 1));
        const sb = Math.max(0, x - Math.max(b, y, 1));
        c += pr * (s0 - sb);
        if (x < b && y < b) d += pr * s0;
      }
    }
    assert.ok(Math.abs(c - cut[b]!) < 1e-9, `cut @${b}: ${c} vs ${cut[b]}`);
    if (b > 0) assert.ok(Math.abs(d - denial[b]!) < 1e-9, `denial @${b}: ${d} vs ${denial[b]}`);
  }
});
