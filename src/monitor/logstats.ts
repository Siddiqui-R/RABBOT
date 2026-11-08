// Statistics from the bot's own decision logs (logs/decisions-*.jsonl).
// Newest files first, stopping once there is enough, because a busy day
// is tens of thousands of auction lines.

import * as fs from "node:fs";
import * as path from "node:path";

export type Rec = Record<string, unknown>;

export interface MatchLine {
  t: string;
  match: number;
  place: number | null;
  seats: number | null;
  score: number | null;
  coinsSpent: number | null;
  auctionsWon: number | null;
  words: string[];
  wordPoints: number | null;
  unplayedTiles: number | null;
  winnerScore: number | null;
}

export interface Quantiles {
  n: number;
  p50: number | null;
  p99: number | null;
  max: number | null;
}

export interface LogStats {
  files: string[];
  lastEventAt: string | null;
  matches: MatchLine[];
  matchTotals: { n: number; wins: number; avgPlace: number | null; avgScore: number | null };
  auctions: number;
  quickMs: Quantiles;
  refineMs: Quantiles;
  budgetMs: Quantiles;
  deadlineMisses: number;
  lateRefines: number;
  /** refineBid ran more than 20 ms past the budget it was given. */
  refineOverruns: number;
  refusals: { bid: Record<string, number>; word: Record<string, number>; lobby: Record<string, number> };
  errors: Record<string, number>;
  disconnects: number;
  timing: Rec | null;
  agent: string | null;
}

export function quantiles(xs: number[]): Quantiles {
  if (!xs.length) return { n: 0, p50: null, p99: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]!;
  return { n: s.length, p50: at(0.5), p99: at(0.99), max: s[s.length - 1]! };
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Refusal messages carry ids and words; bucket them by their gist. */
export function reason(err: string): string {
  return err
    .replace(/'[^']*'/g, "'…'")
    .replace(/\d+/g, "N")
    .slice(0, 80);
}

function bump(m: Record<string, number>, k: string) {
  m[k] = (m[k] ?? 0) + 1;
}

/** Pure: records oldest first. */
export function computeStats(recs: readonly Rec[], lastMatches = 10, files: string[] = []): LogStats {
  const matches: MatchLine[] = [];
  const quick: number[] = [];
  const refine: number[] = [];
  const budget: number[] = [];
  let auctions = 0;
  let misses = 0;
  let late = 0;
  let overruns = 0;
  let disconnects = 0;
  const refusals = { bid: {} as Record<string, number>, word: {} as Record<string, number>, lobby: {} as Record<string, number> };
  const errors: Record<string, number> = {};
  let timing: Rec | null = null;
  let agent: string | null = null;
  let lastEventAt: string | null = null;

  for (const r of recs) {
    if (r.dryRun) continue;
    lastEventAt = typeof r.t === "string" ? r.t : lastEventAt;
    switch (r.type) {
      case "auction": {
        auctions++;
        const q = num(r.quickMs);
        if (q !== null) quick.push(q);
        const f = num(r.refineMs);
        if (f !== null) refine.push(f);
        const b = num(r.budgetMs);
        if (b !== null) budget.push(b);
        if (f !== null && b !== null && f > b + 20) overruns++;
        misses += num(r.misses) ?? 0;
        if (r.refineSkip === "late") late++;
        for (const s of (r.sends as Rec[] | undefined) ?? []) {
          if (s.ok === false && typeof s.err === "string") bump(refusals.bid, reason(s.err));
        }
        break;
      }
      case "word":
        if (r.ok === false && typeof r.err === "string") bump(refusals.word, reason(r.err));
        else if (typeof r.invalid === "string") bump(refusals.word, `invalid: ${r.invalid}`);
        break;
      case "lobby":
        if (r.ok === false && typeof r.err === "string") bump(refusals.lobby, reason(r.err));
        break;
      case "error":
        bump(errors, String(r.where ?? "?"));
        break;
      case "disconnect":
        disconnects++;
        break;
      case "timing":
        timing = r;
        break;
      case "start":
        agent = typeof r.agent === "string" ? r.agent : agent;
        break;
      case "match_end": {
        const st = (r.standings as Rec[] | undefined) ?? [];
        matches.push({
          t: String(r.t),
          match: num(r.match) ?? 0,
          place: num(r.place),
          seats: num(r.seats),
          score: num(r.score),
          coinsSpent: num(r.coinsSpent),
          auctionsWon: num(r.auctionsWon),
          words: Array.isArray(r.words) ? (r.words as string[]) : [],
          wordPoints: num(r.wordPoints),
          unplayedTiles: num(r.unplayedTiles),
          winnerScore: st.length ? num(st[0]!.score) : null,
        });
        if (r.clock && typeof r.clock === "object") timing = { t: r.t, ...(r.clock as Rec) };
        break;
      }
    }
  }
  const placed = matches.filter((m) => m.place !== null);
  const scored = matches.filter((m) => m.score !== null);
  return {
    files,
    lastEventAt,
    matches: matches.slice(-lastMatches).reverse(),
    matchTotals: {
      n: matches.length,
      wins: placed.filter((m) => m.place === 1).length,
      avgPlace: placed.length ? placed.reduce((a, m) => a + m.place!, 0) / placed.length : null,
      avgScore: scored.length ? scored.reduce((a, m) => a + m.score!, 0) / scored.length : null,
    },
    auctions,
    quickMs: quantiles(quick),
    refineMs: quantiles(refine),
    budgetMs: quantiles(budget),
    deadlineMisses: misses,
    lateRefines: late,
    refineOverruns: overruns,
    refusals,
    errors,
    disconnects,
    timing,
    agent,
  };
}

export function parseLines(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Rec);
    } catch {
      /* a line cut off by a crash */
    }
  }
  return out;
}

/** Read the newest log files until `enoughAuctions` auctions and the match window are covered. */
export function readLogStats(dir: string, opts: { prefix?: string; maxDays?: number; enoughAuctions?: number; lastMatches?: number } = {}): LogStats {
  const prefix = opts.prefix ?? "decisions";
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    /* no logs yet */
  }
  const chunks: Rec[][] = [];
  const used: string[] = [];
  let auctions = 0;
  let ends = 0;
  for (const f of names.slice(0, opts.maxDays ?? 7)) {
    const recs = parseLines(fs.readFileSync(path.join(dir, f), "utf8"));
    chunks.unshift(recs);
    used.unshift(f);
    for (const r of recs) {
      if (r.type === "auction") auctions++;
      else if (r.type === "match_end") ends++;
    }
    if (auctions >= (opts.enoughAuctions ?? 5000) && ends >= (opts.lastMatches ?? 10)) break;
  }
  return computeStats(chunks.flat(), opts.lastMatches ?? 10, used);
}
