// Censored bid model: what a bot bids on a letter, learned from partial
// observations (Tobit-style).
//
// A bid is 0 with probability pi (a hurdle: the bot skips the letter);
// otherwise a latent L ~ LogNormal(mu, sigma) is rounded to an integer and
// clamped to [1, balance]. Per bot:
//   mu  = a[letter] + phi[phaseBucket] + thetaMu*xBalance + rhoMu*xRack
//   logit(pi) = c[letter] + psi[phaseBucket] + thetaPi*xBalance + rhoPi*xRack
// Observations are exact (won: top bid), at-most (lost: <= paid) or at-least.
//
// Bots shrink toward the market (the same model pooled over every real
// bot) through Gaussian priors, so thin data reads as "market plus this
// bot's overall offset" and rich data speaks for itself. Fit by L-BFGS.

export const N_LETTERS = 26;
export const N_PHASE = 5;

/** Quartiles of the match, plus the last ~2 auctions (worthless to live bots). */
export function phaseBucket(phase: number): number {
  if (phase >= 0.97) return 4;
  return Math.max(0, Math.min(3, Math.floor(phase * 4)));
}

/** Balance bucket edges (lower bounds) and the balance each stands for. */
const BAL_LO = [0, 15, 30, 50, 75, 100, 101, 130, 170, 230, 320];
const BAL_REP = [8, 22, 40, 62, 88, 100, 115, 150, 200, 275, 400];
export function balanceBucket(b: number): number {
  let k = 0;
  while (k + 1 < BAL_LO.length && b >= BAL_LO[k + 1]!) k++;
  return k;
}
export const balanceRep = (k: number) => BAL_REP[k]!;
export function xBalance(b: number): number {
  return Math.max(-2.5, Math.min(1.5, Math.log(Math.max(b, 1) / 100)));
}

const RACK_LO = [0, 4, 6, 8, 10, 13];
const RACK_REP = [3, 4.5, 6.5, 8.5, 11, 14];
export function rackBucket(r: number): number {
  let k = 0;
  while (k + 1 < RACK_LO.length && r >= RACK_LO[k + 1]!) k++;
  return k;
}
export const rackRep = (k: number) => RACK_REP[k]!;
export function xRack(r: number): number {
  return Math.max(-1.5, Math.min(3, (r - 7) / 4));
}

export interface BidParams {
  a: number[];
  c: number[];
  phi: number[];
  psi: number[];
  thetaMu: number;
  thetaPi: number;
  rhoMu: number;
  rhoPi: number;
  logSigma: number;
}

/** A broad starting point: bid about face value + 1, rarely skip. */
export function defaultParams(letterValues: readonly number[]): BidParams {
  return {
    a: letterValues.map((v) => Math.log(v + 1)),
    c: new Array(N_LETTERS).fill(-1.5),
    phi: new Array(N_PHASE).fill(0),
    psi: new Array(N_PHASE).fill(0),
    thetaMu: 0,
    thetaPi: 0,
    rhoMu: 0,
    rhoPi: 0,
    logSigma: Math.log(0.5),
  };
}

export const cloneParams = (p: BidParams): BidParams => ({
  ...p,
  a: [...p.a],
  c: [...p.c],
  phi: [...p.phi],
  psi: [...p.psi],
});

// ---------- normal distribution ----------

const SQRT1_2 = Math.SQRT1_2;
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

/** Complementary error function (Numerical Recipes erfcc, |rel err| < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}
export const normCdf = (z: number): number => (z === -Infinity ? 0 : z === Infinity ? 1 : 0.5 * erfc(-z * SQRT1_2));
export const normPdf = (z: number): number => (Number.isFinite(z) ? INV_SQRT_2PI * Math.exp(-0.5 * z * z) : 0);

/** Phi(hi) - Phi(lo) without cancellation in the upper tail. */
function normDiff(lo: number, hi: number): number {
  return lo > 0 ? normCdf(-lo) - normCdf(-hi) : normCdf(hi) - normCdf(lo);
}

// ---------- observations ----------

export const KIND_EQ = 0;
export const KIND_LE = 1;
export const KIND_GE = 2;

/** Aggregated observations: identical rows collapse into one with summed weight. */
export interface ObsSet {
  n: number;
  letter: Int8Array;
  pb: Int8Array;
  xb: Float64Array;
  xr: Float64Array;
  kind: Int8Array;
  value: Int32Array;
  /** Balance the outlier floor spreads over. */
  cap: Float64Array;
  w: Float64Array;
}

export interface RawObs {
  letter: number;
  phase: number;
  balance: number;
  cap: number;
  rack: number;
  kind: number;
  value: number;
  weight: number;
}

export class ObsBuilder {
  private map = new Map<number, number>();
  private rows: { letter: number; pb: number; bb: number; rb: number; kind: number; value: number; w: number }[] = [];
  private total = 0;

  /** Normalizes the clamp: a bid at the cap only says the latent reached it. */
  add(o: RawObs): void {
    if (o.weight <= 0) return;
    let kind = o.kind;
    let value = Math.max(0, Math.round(o.value));
    const cap = Math.max(1, Math.round(o.cap));
    if (kind === KIND_LE && value >= cap) return; // always true: no information
    if (kind === KIND_EQ && value >= 1 && value >= cap) kind = KIND_GE;
    if (kind === KIND_GE && value <= 0) return;
    value = Math.min(value, 4095);
    this.addBucketed(o.letter, phaseBucket(o.phase), balanceBucket(o.balance), rackBucket(o.rack), kind, value, o.weight);
  }

  private addBucketed(letter: number, pb: number, bb: number, rb: number, kind: number, value: number, w: number): void {
    const key = ((((letter * N_PHASE + pb) * 16 + bb) * 8 + rb) * 3 + kind) * 4096 + value;
    this.total += w;
    const at = this.map.get(key);
    if (at === undefined) {
      this.map.set(key, this.rows.length);
      this.rows.push({ letter, pb, bb, rb, kind, value, w });
    } else this.rows[at]!.w += w;
  }

  /** Adds this set's rows to `target`, weights scaled. */
  mergeInto(target: ObsBuilder, scale: number): void {
    for (const r of this.rows) target.addBucketed(r.letter, r.pb, r.bb, r.rb, r.kind, r.value, r.w * scale);
  }

  get totalWeight(): number {
    return this.total;
  }

  build(): ObsSet {
    const n = this.rows.length;
    const s: ObsSet = {
      n,
      letter: new Int8Array(n),
      pb: new Int8Array(n),
      xb: new Float64Array(n),
      xr: new Float64Array(n),
      kind: new Int8Array(n),
      value: new Int32Array(n),
      cap: new Float64Array(n),
      w: new Float64Array(n),
    };
    this.rows.forEach((r, i) => {
      s.letter[i] = r.letter;
      s.pb[i] = r.pb;
      s.xb[i] = xBalance(balanceRep(r.bb));
      s.xr[i] = xRack(rackRep(r.rb));
      s.kind[i] = r.kind;
      s.value[i] = r.value;
      s.cap[i] = balanceRep(r.bb);
      s.w[i] = r.w;
    });
    return s;
  }

  get size(): number {
    return this.rows.length;
  }
}

// ---------- likelihood ----------

/** Weight of a uniform "anything goes" component, so one wild bid can't dominate. */
export const OUTLIER = 0.01;

interface Terms {
  ll: number;
  dMu: number;
  dEta: number;
  dS: number;
}

/** Log-likelihood of one observation and its partials in (mu, logit pi, log sigma). */
export function obsTerms(kind: number, x: number, cap: number, mu: number, eta: number, logSigma: number, out: Terms): void {
  const sig = Math.exp(logSigma);
  const pi = 1 / (1 + Math.exp(-eta));
  const dpi = pi * (1 - pi);
  let P: number;
  let dPmu = 0;
  let dPeta = 0;
  let dPs = 0;
  let u: number;
  const capN = Math.max(cap, 1);
  if (kind === KIND_EQ) {
    u = 1 / (capN + 1);
    if (x <= 0) {
      P = pi;
      dPeta = dpi;
    } else {
      const zHi = (Math.log(x + 0.5) - mu) / sig;
      const zLo = x >= 2 ? (Math.log(x - 0.5) - mu) / sig : -Infinity;
      const D = Math.max(normDiff(zLo, zHi), 0);
      const fHi = normPdf(zHi);
      const fLo = normPdf(zLo);
      P = (1 - pi) * D;
      dPeta = -dpi * D;
      dPmu = ((1 - pi) * (fLo - fHi)) / sig;
      dPs = (1 - pi) * (-fHi * zHi + (Number.isFinite(zLo) ? fLo * zLo : 0));
    }
  } else if (kind === KIND_LE) {
    u = Math.min(1, (x + 1) / (capN + 1));
    const z = (Math.log(x + 0.5) - mu) / sig;
    const G = normCdf(z);
    const f = normPdf(z);
    P = pi + (1 - pi) * G;
    dPeta = dpi * (1 - G);
    dPmu = (-(1 - pi) * f) / sig;
    dPs = -(1 - pi) * f * z;
  } else {
    u = Math.max(1, capN - x + 1) / (capN + 1);
    if (x <= 1) {
      P = 1 - pi;
      dPeta = -dpi;
    } else {
      const z = (Math.log(x - 0.5) - mu) / sig;
      const S = normCdf(-z);
      const f = normPdf(z);
      P = (1 - pi) * S;
      dPeta = -dpi * S;
      dPmu = ((1 - pi) * f) / sig;
      dPs = (1 - pi) * f * z;
    }
  }
  const Pm = (1 - OUTLIER) * P + OUTLIER * u;
  const k = (1 - OUTLIER) / Pm;
  out.ll = Math.log(Pm);
  out.dMu = k * dPmu;
  out.dEta = k * dPeta;
  out.dS = k * dPs;
}

// ---------- hierarchical parameterization ----------

/** Prior scales: how far a bot may stray from the market, per parameter group. */
export interface PriorScales {
  delta: number; // bot-wide shift in log bid
  zeta: number; // bot-wide shift in logit skip
  e: number; // per-letter log bid
  f: number; // per-letter logit skip
  g: number; // phase effect on log bid
  h: number; // phase effect on logit skip
  cov: number; // balance / rack slopes
  s: number; // log sigma
}

// Tuned on an out-of-time holdout (validate.ts): tighter than intuition
// suggests, because bots change between matches and new bots drift fast.
export const BOT_PRIOR: PriorScales = { delta: 0.35, zeta: 0.7, e: 0.14, f: 0.35, g: 0.1, h: 0.25, cov: 0.14, s: 0.18 };
/** The market itself: weak pull toward a face-value default, no bot-wide offsets. */
export const MARKET_PRIOR: PriorScales = { delta: 1e-3, zeta: 1e-3, e: 2.0, f: 3.0, g: 1.0, h: 1.5, cov: 1.0, s: 1.0 };

// Flat vector: [delta, zeta, e x26, f x26, g x5, h x5, tMu, tPi, rMu, rPi, s]
const I_DELTA = 0;
const I_ZETA = 1;
const I_E = 2;
const I_F = I_E + N_LETTERS;
const I_G = I_F + N_LETTERS;
const I_H = I_G + N_PHASE;
const I_TM = I_H + N_PHASE;
const I_TP = I_TM + 1;
const I_RM = I_TP + 1;
const I_RP = I_RM + 1;
const I_S = I_RP + 1;
export const N_PARAMS = I_S + 1;

function priorSd(p: PriorScales): Float64Array {
  const sd = new Float64Array(N_PARAMS);
  sd[I_DELTA] = p.delta;
  sd[I_ZETA] = p.zeta;
  for (let i = 0; i < N_LETTERS; i++) {
    sd[I_E + i] = p.e;
    sd[I_F + i] = p.f;
  }
  for (let k = 0; k < N_PHASE; k++) {
    sd[I_G + k] = p.g;
    sd[I_H + k] = p.h;
  }
  sd[I_TM] = sd[I_TP] = sd[I_RM] = sd[I_RP] = p.cov;
  sd[I_S] = p.s;
  return sd;
}

/** Effective parameters: base (market) plus this bot's deviations. */
export function compose(base: BidParams, v: ArrayLike<number>): BidParams {
  return {
    a: base.a.map((x, i) => x + v[I_DELTA]! + v[I_E + i]!),
    c: base.c.map((x, i) => x + v[I_ZETA]! + v[I_F + i]!),
    phi: base.phi.map((x, k) => x + v[I_G + k]!),
    psi: base.psi.map((x, k) => x + v[I_H + k]!),
    thetaMu: base.thetaMu + v[I_TM]!,
    thetaPi: base.thetaPi + v[I_TP]!,
    rhoMu: base.rhoMu + v[I_RM]!,
    rhoPi: base.rhoPi + v[I_RP]!,
    logSigma: base.logSigma + v[I_S]!,
  };
}

/** Deviation vector that reproduces `p` exactly on top of `base` (warm starts). */
function decompose(base: BidParams, p: BidParams): Float64Array {
  const v = new Float64Array(N_PARAMS);
  for (let i = 0; i < N_LETTERS; i++) {
    v[I_E + i] = p.a[i]! - base.a[i]!;
    v[I_F + i] = p.c[i]! - base.c[i]!;
  }
  for (let k = 0; k < N_PHASE; k++) {
    v[I_G + k] = p.phi[k]! - base.phi[k]!;
    v[I_H + k] = p.psi[k]! - base.psi[k]!;
  }
  v[I_TM] = p.thetaMu - base.thetaMu;
  v[I_TP] = p.thetaPi - base.thetaPi;
  v[I_RM] = p.rhoMu - base.rhoMu;
  v[I_RP] = p.rhoPi - base.rhoPi;
  v[I_S] = p.logSigma - base.logSigma;
  return v;
}

/** Negative log posterior and its gradient. */
function objective(obs: ObsSet, base: BidParams, sd: Float64Array, v: Float64Array, grad: Float64Array): number {
  grad.fill(0);
  const p = compose(base, v);
  const t: Terms = { ll: 0, dMu: 0, dEta: 0, dS: 0 };
  let nll = 0;
  for (let j = 0; j < obs.n; j++) {
    const l = obs.letter[j]!;
    const k = obs.pb[j]!;
    const xb = obs.xb[j]!;
    const xr = obs.xr[j]!;
    const mu = p.a[l]! + p.phi[k]! + p.thetaMu * xb + p.rhoMu * xr;
    const eta = p.c[l]! + p.psi[k]! + p.thetaPi * xb + p.rhoPi * xr;
    obsTerms(obs.kind[j]!, obs.value[j]!, obs.cap[j]!, mu, eta, p.logSigma, t);
    const w = obs.w[j]!;
    nll -= w * t.ll;
    const gm = -w * t.dMu;
    const ge = -w * t.dEta;
    grad[I_DELTA]! += gm;
    grad[I_E + l]! += gm;
    grad[I_G + k]! += gm;
    grad[I_TM]! += gm * xb;
    grad[I_RM]! += gm * xr;
    grad[I_ZETA]! += ge;
    grad[I_F + l]! += ge;
    grad[I_H + k]! += ge;
    grad[I_TP]! += ge * xb;
    grad[I_RP]! += ge * xr;
    grad[I_S]! -= w * t.dS;
  }
  for (let i = 0; i < N_PARAMS; i++) {
    const s2 = sd[i]! * sd[i]!;
    nll += (0.5 * v[i]! * v[i]!) / s2;
    grad[i]! += v[i]! / s2;
  }
  return nll;
}

/** Mean log-likelihood per unit weight of `obs` under fixed params (no prior). */
export function logLik(obs: ObsSet, p: BidParams): { ll: number; w: number } {
  const t: Terms = { ll: 0, dMu: 0, dEta: 0, dS: 0 };
  let ll = 0;
  let w = 0;
  for (let j = 0; j < obs.n; j++) {
    const l = obs.letter[j]!;
    const k = obs.pb[j]!;
    const mu = p.a[l]! + p.phi[k]! + p.thetaMu * obs.xb[j]! + p.rhoMu * obs.xr[j]!;
    const eta = p.c[l]! + p.psi[k]! + p.thetaPi * obs.xb[j]! + p.rhoPi * obs.xr[j]!;
    obsTerms(obs.kind[j]!, obs.value[j]!, obs.cap[j]!, mu, eta, p.logSigma, t);
    ll += obs.w[j]! * t.ll;
    w += obs.w[j]!;
  }
  return { ll, w };
}

// ---------- L-BFGS ----------

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Minimizes f with L-BFGS and a backtracking (Armijo) line search. */
export function lbfgs(
  f: (x: Float64Array, g: Float64Array) => number,
  x0: Float64Array,
  opts: { maxIter?: number; m?: number; tol?: number } = {},
): { x: Float64Array; fx: number; iters: number } {
  const maxIter = opts.maxIter ?? 200;
  const m = opts.m ?? 8;
  const tol = opts.tol ?? 1e-7;
  const nP = x0.length;
  let x = Float64Array.from(x0);
  let g = new Float64Array(nP);
  let fx = f(x, g);
  const S: Float64Array[] = [];
  const Y: Float64Array[] = [];
  const rho: number[] = [];
  const dir = new Float64Array(nP);
  const xn = new Float64Array(nP);
  const gn = new Float64Array(nP);
  let it = 0;
  for (; it < maxIter; it++) {
    // Two-loop recursion: dir = -H g.
    dir.set(g);
    const alpha: number[] = [];
    for (let i = S.length - 1; i >= 0; i--) {
      const a = rho[i]! * dot(S[i]!, dir);
      alpha[i] = a;
      for (let j = 0; j < nP; j++) dir[j]! -= a * Y[i]![j]!;
    }
    if (S.length > 0) {
      const last = S.length - 1;
      const gamma = dot(S[last]!, Y[last]!) / dot(Y[last]!, Y[last]!);
      for (let j = 0; j < nP; j++) dir[j]! *= gamma;
    } else {
      const gn0 = Math.sqrt(dot(g, g)) || 1;
      for (let j = 0; j < nP; j++) dir[j]! /= gn0;
    }
    for (let i = 0; i < S.length; i++) {
      const b = rho[i]! * dot(Y[i]!, dir);
      for (let j = 0; j < nP; j++) dir[j]! += S[i]![j]! * (alpha[i]! - b);
    }
    for (let j = 0; j < nP; j++) dir[j] = -dir[j]!;
    let slope = dot(g, dir);
    if (slope >= 0) {
      // Not a descent direction: restart from steepest descent.
      S.length = Y.length = rho.length = 0;
      for (let j = 0; j < nP; j++) dir[j] = -g[j]!;
      slope = dot(g, dir);
    }
    let step = 1;
    let fn = Infinity;
    for (let ls = 0; ls < 30; ls++) {
      for (let j = 0; j < nP; j++) xn[j] = x[j]! + step * dir[j]!;
      fn = f(xn, gn);
      if (Number.isFinite(fn) && fn <= fx + 1e-4 * step * slope) break;
      step *= 0.5;
    }
    if (!Number.isFinite(fn) || fn > fx) break;
    const s = new Float64Array(nP);
    const y = new Float64Array(nP);
    for (let j = 0; j < nP; j++) {
      s[j] = xn[j]! - x[j]!;
      y[j] = gn[j]! - g[j]!;
    }
    const sy = dot(s, y);
    if (sy > 1e-12) {
      S.push(s);
      Y.push(y);
      rho.push(1 / sy);
      if (S.length > m) {
        S.shift();
        Y.shift();
        rho.shift();
      }
    }
    const done = Math.abs(fx - fn) <= tol * Math.max(1, Math.abs(fx));
    x = Float64Array.from(xn);
    g = Float64Array.from(gn);
    fx = fn;
    if (done) break;
  }
  return { x, fx, iters: it };
}

export interface FitResult {
  params: BidParams;
  nll: number;
  iters: number;
}

/**
 * Fits one bot (or, with MARKET_PRIOR and the pooled data, the market) on
 * top of `base`. `warm` restarts from earlier params to save iterations.
 */
export function fitBidModel(
  obs: ObsSet,
  base: BidParams,
  prior: PriorScales = BOT_PRIOR,
  opts: { warm?: BidParams; maxIter?: number } = {},
): FitResult {
  const sd = priorSd(prior);
  const x0 = opts.warm ? decompose(base, opts.warm) : new Float64Array(N_PARAMS);
  const r = lbfgs((v, g) => objective(obs, base, sd, v, g), x0, { maxIter: opts.maxIter ?? 300 });
  return { params: compose(base, r.x), nll: r.fx, iters: r.iters };
}

// ---------- prediction ----------

/** Probability of every bid 0..cap for one context. */
export function bidPmf(
  p: BidParams,
  letter: number,
  phase: number,
  balance: number,
  rackSize: number,
): Float64Array {
  const cap = Math.max(0, Math.floor(balance));
  const pmf = new Float64Array(cap + 1);
  const k = phaseBucket(phase);
  const xb = xBalance(balance);
  const xr = xRack(rackSize);
  const mu = p.a[letter]! + p.phi[k]! + p.thetaMu * xb + p.rhoMu * xr;
  const eta = p.c[letter]! + p.psi[k]! + p.thetaPi * xb + p.rhoPi * xr;
  const sig = Math.exp(p.logSigma);
  const pi = 1 / (1 + Math.exp(-eta));
  if (cap === 0) {
    pmf[0] = 1;
    return pmf;
  }
  pmf[0] = pi;
  let prev = 0; // P(L < x - 0.5)
  for (let x = 1; x <= cap; x++) {
    const hi = x === cap ? 1 : normCdf((Math.log(x + 0.5) - mu) / sig);
    pmf[x] = (1 - pi) * Math.max(0, hi - prev);
    prev = hi;
  }
  return pmf;
}

/** mu and logit(pi) for one exact context. */
export function linear(p: BidParams, letter: number, phase: number, balance: number, rack: number): { mu: number; eta: number } {
  const k = phaseBucket(phase);
  const xb = xBalance(balance);
  const xr = xRack(rack);
  return {
    mu: p.a[letter]! + p.phi[k]! + p.thetaMu * xb + p.rhoMu * xr,
    eta: p.c[letter]! + p.psi[k]! + p.thetaPi * xb + p.rhoPi * xr,
  };
}

/** Log-likelihood of one raw observation (null when it carries no information). */
export function rawLogLik(p: BidParams, o: RawObs): number | null {
  let kind = o.kind;
  const value = Math.max(0, Math.round(o.value));
  const cap = Math.max(1, Math.round(o.cap));
  if (kind === KIND_LE && value >= cap) return null;
  if (kind === KIND_EQ && value >= 1 && value >= cap) kind = KIND_GE;
  if (kind === KIND_GE && value <= 0) return null;
  const { mu, eta } = linear(p, o.letter, o.phase, o.balance, o.rack);
  const t: Terms = { ll: 0, dMu: 0, dEta: 0, dS: 0 };
  obsTerms(kind, value, cap, mu, eta, p.logSigma, t);
  return t.ll;
}

/** P(bid <= x) in one exact context, with the clamp at `cap`. */
export function bidCdf(p: BidParams, letter: number, phase: number, balance: number, rack: number, cap: number, x: number): number {
  if (x < 0) return 0;
  if (x >= cap) return 1;
  const { mu, eta } = linear(p, letter, phase, balance, rack);
  const pi = 1 / (1 + Math.exp(-eta));
  if (x < 1) return pi;
  return pi + (1 - pi) * normCdf((Math.log(x + 0.5) - mu) / Math.exp(p.logSigma));
}
