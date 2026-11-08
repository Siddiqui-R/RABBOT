import { test } from "node:test";
import assert from "node:assert/strict";
import { LETTER_VALUES } from "../core/rules.js";
import {
  BOT_PRIOR,
  KIND_EQ,
  KIND_LE,
  MARKET_PRIOR,
  ObsBuilder,
  bidPmf,
  cloneParams,
  defaultParams,
  fitBidModel,
  logLik,
  normCdf,
  type BidParams,
} from "./fit.js";
import { rng32 } from "./util.js";
import { distFromPmf, simBidDist } from "./model.js";

function truth(): BidParams {
  const p = defaultParams(LETTER_VALUES);
  p.a = LETTER_VALUES.map((v, i) => Math.log(v + 2) + 0.15 * Math.sin(i));
  p.c = LETTER_VALUES.map((_, i) => -2 + 0.8 * Math.cos(i));
  p.phi = [0, 0.1, 0.2, -0.1, -0.8];
  p.psi = [0, 0, 0.3, 0.6, 2.0];
  p.thetaMu = 0.3;
  p.thetaPi = -0.4;
  p.rhoMu = -0.2;
  p.rhoPi = 0.5;
  p.logSigma = Math.log(0.35);
  return p;
}

function draw(pmf: Float64Array, u: number): number {
  let acc = 0;
  for (let x = 0; x < pmf.length; x++) {
    acc += pmf[x]!;
    if (u <= acc) return x;
  }
  return pmf.length - 1;
}

/**
 * Sealed bids against an independent competing max M: the winner's bid is
 * seen exactly, a loser's only as "<= M" (Vickrey: M is what was paid).
 */
function simulate(p: BidParams, n: number, seed: number): { obs: ObsBuilder; winners: ObsBuilder; exact: number } {
  const rng = rng32(seed);
  const b = new ObsBuilder();
  const winners = new ObsBuilder();
  let exact = 0;
  for (let i = 0; i < n; i++) {
    const letter = Math.floor(rng() * 26);
    const phase = rng();
    const balance = 20 + Math.floor(rng() * 200);
    const rack = 3 + Math.floor(rng() * 10);
    const bid = draw(bidPmf(p, letter, phase, balance, rack), rng());
    // Competitors: around face value + 2, with spread.
    const M = Math.max(0, Math.round(Math.exp(Math.log(LETTER_VALUES[letter]! + 2) + 0.5 * gauss(rng))));
    if (bid > M) {
      const o = { letter, phase, balance, cap: balance, rack, kind: KIND_EQ, value: bid, weight: 1 };
      b.add(o);
      winners.add(o);
      exact++;
    } else {
      b.add({ letter, phase, balance, cap: balance, rack, kind: KIND_LE, value: M, weight: 1 });
    }
  }
  return { obs: b, winners, exact };
}

function gauss(rng: () => number): number {
  return Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
}

test("normCdf matches known values", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(normCdf(-3) - 0.0013499) < 1e-6);
});

test("censored fit recovers known parameters from winner-only exact bids", () => {
  const p = truth();
  const { obs, exact } = simulate(p, 60_000, 7);
  const set = obs.build();
  assert.ok(exact > 5000 && exact < 50_000, `exact share ${exact}`);
  const fit = fitBidModel(set, defaultParams(LETTER_VALUES), MARKET_PRIOR, { maxIter: 500 }).params;

  // Sigma, slopes and the per-letter means of common letters come back.
  assert.ok(Math.abs(fit.logSigma - p.logSigma) < 0.08, `logSigma ${fit.logSigma} vs ${p.logSigma}`);
  assert.ok(Math.abs(fit.thetaMu - p.thetaMu) < 0.1, `thetaMu ${fit.thetaMu}`);
  assert.ok(Math.abs(fit.rhoMu - p.rhoMu) < 0.1, `rhoMu ${fit.rhoMu}`);
  // a and phi trade off by a constant; compare the identified sums.
  let worst = 0;
  for (let l = 0; l < 26; l++) {
    for (let k = 0; k < 4; k++) {
      worst = Math.max(worst, Math.abs(fit.a[l]! + fit.phi[k]! - (p.a[l]! + p.phi[k]!)));
    }
  }
  assert.ok(worst < 0.2, `worst mu error ${worst}`);
  // Skip probability (hurdle) per letter, mid-match context.
  for (const l of [0, 4, 8, 13, 17, 18, 19]) {
    const pz = (q: BidParams) => 1 / (1 + Math.exp(-(q.c[l]! + q.psi[1]!)));
    assert.ok(Math.abs(pz(fit) - pz(p)) < 0.06, `pZero letter ${l}: ${pz(fit)} vs ${pz(p)}`);
  }

  // A naive fit that treats censored rows as missing (winners only) is
  // biased upward; the censored fit must beat it on held-out likelihood.
  const heldOut = simulate(p, 20_000, 99).obs.build();
  const good = logLik(heldOut, fit);
  const naive = simulate(p, 60_000, 7).winners;
  const naiveFit = fitBidModel(naive.build(), defaultParams(LETTER_VALUES), MARKET_PRIOR, { maxIter: 300 }).params;
  const bad = logLik(heldOut, naiveFit);
  assert.ok(good.ll / good.w > bad.ll / bad.w + 0.05, `censored ${good.ll / good.w} vs naive ${bad.ll / bad.w}`);
});

test("thin data shrinks toward the market, rich data overrides it", () => {
  const market = truth();
  const bot = cloneParams(market);
  const Q = 16;
  const Z = 25;
  bot.a[Q] = market.a[Q]! + 1.0; // this bot loves Q and Z
  bot.a[Z] = market.a[Z]! + 1.0;
  const dev = (q: BidParams, l: number) => q.a[l]! - market.a[l]! - (q.a.reduce((s, x, i) => s + x - market.a[i]!, 0) / 26);

  const thin = fitBidModel(simulate(bot, 30, 3).obs.build(), market, BOT_PRIOR).params;
  const rich = fitBidModel(simulate(bot, 40_000, 4).obs.build(), market, BOT_PRIOR).params;
  // A handful of auctions can't move a rare letter far from the market...
  const thinDev = (dev(thin, Q) + dev(thin, Z)) / 2;
  const richDev = (dev(rich, Q) + dev(rich, Z)) / 2;
  assert.ok(thinDev < 0.6 && thinDev < richDev - 0.3, `thin ${thinDev} vs rich ${richDev}`);
  // ...while plenty of data recovers the bot's own taste.
  assert.ok(Math.abs(dev(rich, Q) - 1.0) < 0.25, `rich Q ${dev(rich, Q)}`);
  assert.ok(Math.abs(dev(rich, Z) - 1.0) < 0.25, `rich Z ${dev(rich, Z)}`);
  // Elsewhere the rich fit stays on the market.
  assert.ok(Math.abs(dev(rich, 4)) < 0.15, `rich E ${dev(rich, 4)}`);
});

test("bid distribution helpers", () => {
  const d = simBidDist("ValueBidder", "Q", 100);
  assert.equal(d.pZero, 0);
  assert.ok(Math.abs(d.mean - 10) < 1e-9);
  assert.equal(d.quantile(0), 8);
  assert.equal(d.quantile(1), 12);
  // Clamped to balance.
  const poor = simBidDist("Aggressive", "E", 3);
  assert.equal(poor.quantile(1), 3);
  assert.equal(simBidDist("Human", "E", 50).pZero, 1);

  const pmf = Float64Array.from([0.2, 0.3, 0.5]);
  const e = distFromPmf(pmf, "bot");
  assert.ok(Math.abs(e.mean - 1.3) < 1e-12);
  assert.equal(e.quantile(0.2), 0);
  assert.equal(e.quantile(0.21), 1);
  assert.equal(e.quantile(0.99), 2);
  const rng = rng32(1);
  let s = 0;
  for (let i = 0; i < 20_000; i++) s += e.sample(rng);
  assert.ok(Math.abs(s / 20_000 - 1.3) < 0.03);
});

test("runner-up EM removes the downward bias of plain censoring with many bidders", async () => {
  const { fitFromData, DEFAULT_CONFIG } = await import("./train.js");
  const p = truth();
  p.psi = [0, 0, 0, 0, 0];
  p.c = p.c.map(() => -3); // rarely skip, so most auctions have a real runner-up
  const rng = rng32(42);
  const bidders = 5;
  const auctions = 12_000;
  const n = auctions * bidders;
  const d = {
    n,
    auction: new Float64Array(n),
    bot: new Int32Array(n),
    letter: new Int8Array(n),
    phase: new Float32Array(n),
    balance: new Int32Array(n),
    cap: new Int32Array(n),
    rack: new Int16Array(n),
    kind: new Int8Array(n),
    value: new Int32Array(n),
    version: new Int16Array(n),
    ended: new Float64Array(n),
    paid: new Int32Array(n),
    simQ: new Float32Array(n),
    vickrey: new Uint8Array(n),
  };
  let i = 0;
  for (let a = 0; a < auctions; a++) {
    const letter = Math.floor(rng() * 26);
    const phase = rng() * 0.96;
    const bids = Array.from({ length: bidders }, () => draw(bidPmf(p, letter, phase, 100, 7), rng()));
    const order = bids.map((b, k) => ({ b, k, r: rng() })).sort((x, y) => y.b - x.b || x.r - y.r);
    const top = order[0]!;
    const paid = top.b === 0 ? 0 : order[1]!.b > 0 ? order[1]!.b : 1;
    for (let k = 0; k < bidders; k++) {
      d.auction[i] = a;
      d.bot[i] = k + 1;
      d.letter[i] = letter;
      d.phase[i] = phase;
      d.balance[i] = 100;
      d.cap[i] = 100;
      d.rack[i] = 7;
      d.version[i] = 1;
      d.ended[i] = 1;
      d.paid[i] = paid;
      d.simQ[i] = 1;
      d.vickrey[i] = 1;
      if (top.b === 0) {
        d.kind[i] = KIND_EQ;
        d.value[i] = 0;
      } else if (k === top.k) {
        d.kind[i] = KIND_EQ;
        d.value[i] = bids[k]!;
      } else {
        d.kind[i] = KIND_LE;
        d.value[i] = paid;
      }
      i++;
    }
  }
  const bots = new Map(Array.from({ length: bidders }, (_, k) => [k + 1, { name: `b${k}`, isSim: false, strategy: "Human", versions: [] }]));
  const cfg = { ...DEFAULT_CONFIG, halfLifeHours: Infinity, marketMaxShare: 1 };
  // Mean predicted bid over letters, mid-match, relative to the truth.
  const meanBias = (q: BidParams) => {
    let s = 0;
    for (let l = 0; l < 26; l++) {
      const mean = (pm: Float64Array) => pm.reduce((acc, v, x) => acc + v * x, 0);
      s += mean(bidPmf(q, l, 0.3, 100, 7)) / mean(bidPmf(p, l, 0.3, 100, 7)) - 1;
    }
    return s / 26;
  };
  const plain = fitFromData(d, bots, { ...cfg, emRounds: 0 }, 1).market;
  const em = fitFromData(d, bots, { ...cfg, emRounds: 3 }, 1).market;
  // Plain censoring explains "<= paid" partly with skipped letters, so it
  // reads bids low; EM's runner-up step recovers most of the gap.
  assert.ok(meanBias(plain) < -0.1, `plain censoring should read low, got ${meanBias(plain)}`);
  assert.ok(Math.abs(meanBias(em)) < Math.abs(meanBias(plain)) / 2, `em ${meanBias(em)} vs plain ${meanBias(plain)}`);
});
