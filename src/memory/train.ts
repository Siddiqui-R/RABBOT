// Training the bid models from bid_obs: weighting, the runner-up EM step,
// and persistence.
//
// Weights: an observation loses half its weight every halfLifeHours, and
// observations from a bot's earlier versions count oldVersionFactor as much
// (bots are rebuilt often; their old selves are weaker evidence).
//
// Runner-up EM: in a Vickrey auction with paid >= 2, the losers all bid
// <= paid AND at least one bid exactly paid. Plain Tobit drops the second
// half and so underestimates loser bids. Given every loser's current
// model, loser i bid exactly paid with probability
//   r_i = (1 - q_i) / (1 - prod_j q_j),   q_j = F_j(paid - 1) / F_j(paid)
// (sims' factors come from their formula, precomputed as auction_ctx.sim_q).
// The M-step then sees "= paid" with weight r_i and "<= paid - 1" with
// weight 1 - r_i, which is EM for the exact per-bot likelihood with the
// other bidders held at their current fits.

import { LETTER_VALUES } from "../core/rules.js";
import { DEFAULT_DB_PATH, num, openDb, tx, type Db } from "./db.js";
import { versionAt } from "./derive.js";
import {
  BOT_PRIOR,
  KIND_EQ,
  KIND_LE,
  MARKET_PRIOR,
  N_PHASE,
  ObsBuilder,
  bidCdf,
  defaultParams,
  fitBidModel,
  phaseBucket,
  type BidParams,
  type PriorScales,
} from "./fit.js";

export interface ModelConfig {
  /** Observations lose half their weight every this many hours. */
  halfLifeHours: number;
  /** Weight multiplier for observations from a bot's earlier versions. */
  oldVersionFactor: number;
  /** No single bot may supply more than this share of the market's weight. */
  marketMaxShare: number;
  botPrior: PriorScales;
  /** Runner-up EM rounds after the plain censored fit. */
  emRounds: number;
}

// Chosen on the out-of-time holdout (see validate.ts and the field report):
// a short half-life and a steep old-version discount beat longer memories,
// and a second EM round adds nothing measurable over the first.
export const DEFAULT_CONFIG: ModelConfig = {
  halfLifeHours: 4,
  oldVersionFactor: 0.1,
  marketMaxShare: 0.05,
  botPrior: BOT_PRIOR,
  emRounds: 1,
};

/** Bump when the parameterization changes so stale stored fits are ignored. */
export const CONFIG_TAG = "v3";

export interface BotMeta {
  name: string;
  isSim: boolean;
  strategy: string;
  versions: { version: number; startedUs: number }[];
}

export function loadBots(db: Db): Map<number, BotMeta> {
  const bots = new Map<number, BotMeta>();
  for (const r of db.prepare("SELECT id, name, is_simulated, strategy FROM bot").all()) {
    bots.set(num(r.id), {
      name: String(r.name),
      isSim: num(r.is_simulated) === 1,
      strategy: String(r.strategy),
      versions: [],
    });
  }
  for (const r of db.prepare("SELECT bot_id, version, started_us FROM bot_version").all()) {
    bots.get(num(r.bot_id))?.versions.push({ version: num(r.version), startedUs: num(r.started_us) });
  }
  return bots;
}

/** Every bid observation, column-wise, grouped by auction. */
export interface FitData {
  n: number;
  auction: Float64Array;
  bot: Int32Array;
  letter: Int8Array;
  phase: Float32Array;
  balance: Int32Array;
  cap: Int32Array;
  rack: Int16Array;
  kind: Int8Array;
  value: Int32Array;
  version: Int16Array;
  ended: Float64Array;
  paid: Int32Array;
  simQ: Float32Array;
  vickrey: Uint8Array;
}

export function loadFitData(db: Db, opts: { beforeUs?: number; auctionsOfBot?: number } = {}): FitData {
  const where: string[] = [];
  const args: number[] = [];
  if (opts.beforeUs !== undefined) {
    where.push("o.ended_us <= ?");
    args.push(opts.beforeUs);
  }
  if (opts.auctionsOfBot !== undefined) {
    where.push("o.auction_id IN (SELECT auction_id FROM bid_obs WHERE bot_id = ?)");
    args.push(opts.auctionsOfBot);
  }
  const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = num(db.prepare(`SELECT COUNT(*) AS n FROM bid_obs o${w}`).get(...args)?.n);
  const d: FitData = {
    n: 0,
    auction: new Float64Array(total),
    bot: new Int32Array(total),
    letter: new Int8Array(total),
    phase: new Float32Array(total),
    balance: new Int32Array(total),
    cap: new Int32Array(total),
    rack: new Int16Array(total),
    kind: new Int8Array(total),
    value: new Int32Array(total),
    version: new Int16Array(total),
    ended: new Float64Array(total),
    paid: new Int32Array(total),
    simQ: new Float32Array(total),
    vickrey: new Uint8Array(total),
  };
  const sql = `SELECT o.auction_id, o.bot_id, o.letter, o.phase, o.balance, o.cap, o.rack_size, o.kind, o.value,
      o.version, o.ended_us, a.paid, a.sim_q, mi.auction_type
    FROM bid_obs o JOIN auction_ctx a ON a.auction_id = o.auction_id
    JOIN match_info mi ON mi.match_id = o.match_id${w} ORDER BY o.auction_id`;
  let i = 0;
  for (const r of db.prepare(sql).iterate(...args)) {
    if (i >= total) break; // rows arrived between the count and the scan
    d.auction[i] = num(r.auction_id);
    d.bot[i] = num(r.bot_id);
    d.letter[i] = String(r.letter).charCodeAt(0) - 65;
    d.phase[i] = Number(r.phase);
    d.balance[i] = num(r.balance);
    d.cap[i] = num(r.cap);
    d.rack[i] = num(r.rack_size);
    d.kind[i] = num(r.kind);
    d.value[i] = num(r.value);
    d.version[i] = num(r.version);
    d.ended[i] = num(r.ended_us);
    d.paid[i] = num(r.paid);
    d.simQ[i] = r.sim_q === null ? 1 : Number(r.sim_q);
    d.vickrey[i] = String(r.auction_type) === "FirstPrice" ? 0 : 1;
    i++;
  }
  d.n = i;
  return d;
}

export interface Sets {
  perBot: Map<number, ObsBuilder>;
  market: ObsBuilder;
  counts: Map<number, number>;
  maxUs: Map<number, number>;
  meanRack: Map<number, number[]>;
  total: number;
}

/**
 * Turns raw observations into weighted, aggregated per-bot sets (plus the
 * pooled market). With `paramsOf`, losers' "<= paid" rows are split by the
 * runner-up EM responsibilities.
 */
export function buildSets(
  d: FitData,
  bots: Map<number, BotMeta>,
  cfg: ModelConfig,
  refUs: number,
  paramsOf?: (botId: number) => BidParams,
  only?: number,
): Sets {
  const halfUs = cfg.halfLifeHours * 3600e6;
  const curVersion = new Map<number, number>();
  for (const [id, b] of bots) curVersion.set(id, versionAt(b.versions, refUs));
  const perBot = new Map<number, ObsBuilder>();
  const counts = new Map<number, number>();
  const maxUs = new Map<number, number>();
  const rackSum = new Map<number, number[]>();
  const resp = new Float64Array(16);
  let total = 0;

  const weightOf = (i: number) => {
    const age = Math.max(0, refUs - d.ended[i]!);
    let w = halfUs > 0 && Number.isFinite(halfUs) ? Math.pow(0.5, age / halfUs) : 1;
    if (d.version[i]! < (curVersion.get(d.bot[i]!) ?? 1)) w *= cfg.oldVersionFactor;
    return w;
  };

  for (let g0 = 0; g0 < d.n; ) {
    let g1 = g0 + 1;
    while (g1 < d.n && d.auction[g1] === d.auction[g0]) g1++;
    const paid = d.paid[g0]!;
    // Responsibilities of each "<= paid" loser for being the runner-up.
    let em = false;
    if (paramsOf && paid >= 2 && d.vickrey[g0] && g1 - g0 <= resp.length) {
      let qAll = d.simQ[g0]!;
      let losers = 0;
      for (let i = g0; i < g1; i++) {
        if (d.kind[i] !== KIND_LE || d.value[i] !== paid) {
          resp[i - g0] = -1;
          continue;
        }
        const p = paramsOf(d.bot[i]!);
        const args = [d.letter[i]!, d.phase[i]!, d.balance[i]!, d.rack[i]!, d.cap[i]!] as const;
        const Fp = bidCdf(p, ...args, paid);
        const q = Fp > 1e-12 ? bidCdf(p, ...args, paid - 1) / Fp : 1;
        resp[i - g0] = q;
        qAll *= q;
        losers++;
      }
      if (losers > 0) {
        em = true;
        const denom = 1 - qAll;
        for (let i = g0; i < g1; i++) {
          const q = resp[i - g0]!;
          if (q < 0) continue;
          resp[i - g0] = denom > 1e-9 ? Math.min(1, Math.max(0, (1 - q) / denom)) : 1 / losers;
        }
      }
    }
    for (let i = g0; i < g1; i++) {
      const botId = d.bot[i]!;
      if (only !== undefined && botId !== only) continue;
      const w = weightOf(i);
      let b = perBot.get(botId);
      if (!b) perBot.set(botId, (b = new ObsBuilder()));
      const base = {
        letter: d.letter[i]!,
        phase: d.phase[i]!,
        balance: d.balance[i]!,
        cap: d.cap[i]!,
        rack: d.rack[i]!,
      };
      const r = em ? resp[i - g0]! : -1;
      if (r >= 0) {
        if (r > 0) b.add({ ...base, kind: KIND_EQ, value: paid, weight: w * r });
        if (r < 1) b.add({ ...base, kind: KIND_LE, value: paid - 1, weight: w * (1 - r) });
      } else b.add({ ...base, kind: d.kind[i]!, value: d.value[i]!, weight: w });
      counts.set(botId, (counts.get(botId) ?? 0) + 1);
      maxUs.set(botId, Math.max(maxUs.get(botId) ?? 0, d.ended[i]!));
      let rs = rackSum.get(botId);
      if (!rs) rackSum.set(botId, (rs = new Array(2 * N_PHASE).fill(0)));
      const k = phaseBucket(d.phase[i]!);
      rs[k]! += d.rack[i]!;
      rs[N_PHASE + k]! += 1;
      total++;
    }
    g0 = g1;
  }

  // Pool into the market, capping any one bot's share of the weight.
  const market = new ObsBuilder();
  let sumW = 0;
  for (const b of perBot.values()) sumW += b.totalWeight;
  const cap = cfg.marketMaxShare * sumW;
  for (const [id, b] of perBot) {
    if (bots.get(id)?.isSim) continue;
    const scale = b.totalWeight > cap && cap > 0 ? cap / b.totalWeight : 1;
    b.mergeInto(market, scale);
  }
  const meanRack = new Map<number, number[]>();
  for (const [id, rs] of rackSum) {
    meanRack.set(
      id,
      Array.from({ length: N_PHASE }, (_, k) => (rs[N_PHASE + k]! > 0 ? rs[k]! / rs[N_PHASE + k]! : 7)),
    );
  }
  return { perBot, market, counts, maxUs, meanRack, total };
}

export interface StoredFit {
  params: BidParams;
  meanRack: number[];
  nObs: number;
  dataUs: number;
}

export interface FitAllResult {
  market: BidParams;
  bots: Map<number, StoredFit>;
  obs: number;
  refUs: number;
}

/** Fits the market, then every real bot with data; then the EM rounds. */
export function fitAll(
  db: Db,
  cfg: ModelConfig = DEFAULT_CONFIG,
  opts: { beforeUs?: number; warm?: Map<number, StoredFit>; warmMarket?: BidParams; maxIter?: number } = {},
): FitAllResult {
  const bots = loadBots(db);
  const data = loadFitData(db, { beforeUs: opts.beforeUs });
  let refUs = opts.beforeUs ?? 0;
  if (!refUs) for (let i = 0; i < data.n; i++) refUs = Math.max(refUs, data.ended[i]!);
  if (!refUs) refUs = Date.now() * 1000;
  return fitFromData(data, bots, cfg, refUs, opts);
}

export function fitFromData(
  data: FitData,
  bots: Map<number, BotMeta>,
  cfg: ModelConfig,
  refUs: number,
  opts: { warm?: Map<number, StoredFit>; warmMarket?: BidParams; maxIter?: number } = {},
): FitAllResult {
  let market = opts.warmMarket;
  const out = new Map<number, StoredFit>();
  const warm = (id: number) => out.get(id)?.params ?? opts.warm?.get(id)?.params;
  let sets: Sets | undefined;
  for (let round = 0; round <= cfg.emRounds; round++) {
    const m = market;
    sets = buildSets(data, bots, cfg, refUs, round === 0 ? undefined : (id) => out.get(id)?.params ?? m!);
    market = fitBidModel(sets.market.build(), defaultParams(LETTER_VALUES), MARKET_PRIOR, {
      warm: market,
      maxIter: opts.maxIter ?? (round === 0 ? 400 : 150),
    }).params;
    for (const [botId, b] of sets.perBot) {
      if (bots.get(botId)?.isSim) continue;
      const fit = fitBidModel(b.build(), market, cfg.botPrior, {
        warm: warm(botId),
        maxIter: opts.maxIter ?? (round === 0 ? 300 : 120),
      });
      out.set(botId, {
        params: fit.params,
        meanRack: sets.meanRack.get(botId) ?? new Array(N_PHASE).fill(7),
        nObs: sets.counts.get(botId) ?? 0,
        dataUs: sets.maxUs.get(botId) ?? 0,
      });
    }
  }
  return { market: market!, bots: out, obs: sets?.total ?? 0, refUs };
}

/**
 * Refits one bot against the market and the other bots' current fits,
 * using only the auctions it played in (fast enough between matches).
 */
export function fitOneBot(
  db: Db,
  botId: number,
  bots: Map<number, BotMeta>,
  cfg: ModelConfig,
  market: BidParams,
  paramsOf: (id: number) => BidParams,
  warm?: BidParams,
): StoredFit | undefined {
  const data = loadFitData(db, { auctionsOfBot: botId });
  let refUs = 0;
  for (let i = 0; i < data.n; i++) refUs = Math.max(refUs, data.ended[i]!);
  const sets = buildSets(data, bots, cfg, refUs || Date.now() * 1000, cfg.emRounds > 0 ? paramsOf : undefined, botId);
  const b = sets.perBot.get(botId);
  if (!b) return undefined;
  const fit = fitBidModel(b.build(), market, cfg.botPrior, { warm, maxIter: 150 });
  return {
    params: fit.params,
    meanRack: sets.meanRack.get(botId) ?? new Array(N_PHASE).fill(7),
    nObs: sets.counts.get(botId) ?? 0,
    dataUs: sets.maxUs.get(botId) ?? 0,
  };
}

export function readStoredFits(db: Db): { market?: StoredFit; bots: Map<number, StoredFit> } {
  const bots = new Map<number, StoredFit>();
  let market: StoredFit | undefined;
  let rows: Record<string, unknown>[] = [];
  try {
    rows = db.prepare("SELECT bot_id, data_us, n_obs, params FROM bid_model").all();
  } catch {
    return { bots }; // no table yet
  }
  for (const r of rows) {
    try {
      const j = JSON.parse(String(r.params)) as { tag: string; params: BidParams; meanRack: number[] };
      if (j.tag !== CONFIG_TAG) continue;
      const f: StoredFit = {
        params: j.params,
        meanRack: j.meanRack,
        nObs: Number(r.n_obs),
        dataUs: Number(r.data_us),
      };
      if (Number(r.bot_id) === 0) market = f;
      else bots.set(Number(r.bot_id), f);
    } catch {
      /* unreadable row: it gets refit */
    }
  }
  return { market, bots };
}

/** Full fit, persisted to bid_model (bot_id 0 = market). The miner runs this. */
export function fitAndPersist(
  dbPath: string = DEFAULT_DB_PATH,
  cfg: ModelConfig = DEFAULT_CONFIG,
): { bots: number; obs: number } {
  const db = openDb(dbPath);
  try {
    const prev = readStoredFits(db);
    const r = fitAll(db, cfg, { warm: prev.bots, warmMarket: prev.market?.params });
    const nowUs = Date.now() * 1000;
    tx(db, () => {
      const st = db.prepare(
        "INSERT INTO bid_model (bot_id, fitted_us, data_us, n_obs, params) VALUES (?,?,?,?,?) " +
          "ON CONFLICT(bot_id) DO UPDATE SET fitted_us = excluded.fitted_us, data_us = excluded.data_us, " +
          "n_obs = excluded.n_obs, params = excluded.params",
      );
      st.run(0, nowUs, r.refUs, r.obs, JSON.stringify({ tag: CONFIG_TAG, params: r.market, meanRack: [] }));
      for (const [id, f] of r.bots) {
        st.run(id, nowUs, f.dataUs, f.nObs, JSON.stringify({ tag: CONFIG_TAG, params: f.params, meanRack: f.meanRack }));
      }
    });
    return { bots: r.bots.size, obs: r.obs };
  } finally {
    db.close();
  }
}
