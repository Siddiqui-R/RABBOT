// Field report: who's out there and how they bid.
//
//   npm run profiles [-- --validate] [-- --clones] [-- --out data/field-report.md]
//
// Prints the report and saves it to data/field-report.md. --validate reruns
// the holdout validation and --clones the clone check first; otherwise the
// last stored results are shown.

import * as fs from "node:fs";
import * as path from "node:path";
import { LETTERS, LETTER_VALUES } from "../core/rules.js";
import { DEFAULT_DB_PATH, getMeta, num, openDb, setMeta } from "./db.js";
import { loadOpponentModel, type BidContext } from "./model.js";
import { DEFAULT_CONFIG } from "./train.js";
import { cloneCheck, formatCloneCheck, type CloneRow } from "./clonecheck.js";
import { formatValidation, validate, type ValidationReport } from "./validate.js";
import { fmtUs, isMain } from "./util.js";

const CLASSES: [string, string][] = [
  ["vowels", "AEIOU"],
  ["1-pt cons.", "LNSTR"],
  ["2-4 pt", "DGBCMPFHVWY"],
  ["5+ pt", "KJXQZ"],
];

const PHASES: [string, number][] = [
  ["0-25%", 0.12],
  ["25-50%", 0.37],
  ["50-75%", 0.62],
  ["75-97%", 0.85],
  ["last 2", 0.99],
];

const ELO_SCALE = 400 / (Math.LN10 * (25 / 6) * Math.SQRT2);

export function buildReport(dbPath: string = DEFAULT_DB_PATH): string {
  const model = loadOpponentModel(dbPath);
  const db = openDb(dbPath, { readOnly: true });
  const out: string[] = [];
  const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");
  try {
    const span = db.prepare("SELECT COUNT(*) AS n, MIN(ended_us) AS a, MAX(ended_us) AS b FROM match_info").get()!;
    const asOf = num(span.b);
    const count = (t: string) => num(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n);
    let size = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        size += fs.statSync(dbPath + suffix).size;
      } catch {
        /* no wal */
      }
    }
    const q = (sql: string, ...a: number[]) => db.prepare(sql).get(...a);
    const health = q(
      "SELECT SUM(balance_ok = 0) AS bad, SUM(n_auctions != expected_auctions) AS short FROM match_info",
    )!;

    out.push(
      "# RackForge field report",
      "",
      `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. Data: ${num(span.n)} ended matches, ${fmtUs(num(span.a))} to ${fmtUs(asOf)} UTC.`,
      "",
      `Mined rows: ${count("match_state")} matches, ${count("match_participant")} seats, ${count("auction_result")} auctions, ${count("auction_top_bid_archive")} archived top bids, ${count("word_play")} words, ${count("rating_history")} rating rows, ${count("bot")} bots. Derived: ${count("bid_obs")} bid observations. Database ${f(size / 1e6, 0)} MB.`,
      `Replay check: ${num(health.bad)} matches where the reconstructed balances disagree with the server's final balance/score; ${num(health.short)} with a short auction count.`,
      "",
    );

    // ---------- top bots ----------
    const ctx: BidContext = { phase: 0.3, balance: 100 };
    const top = db
      .prepare(
        `SELECT b.id, b.name, s.mu, s.sigma FROM bot b JOIN bot_stats s ON s.bot_id = b.id
         WHERE b.is_simulated = 0 AND s.matches_played > 0 ORDER BY s.mu DESC LIMIT 25`,
      )
      .all();
    out.push(
      "## Top 25 real bots by rating",
      "",
      "Rating is the site's (OpenSkill on the Elo-like scale, current version). Aggressiveness is the bot's predicted mean bid over the market's, averaged over letters in the class, at phase 0.3 with 100 coins (1.00 = market). Score, win rate and words are over all its mined matches.",
      "",
      "| # | bot | rating | matches (this ver.) | mean score | win % | place | vowels | 1-pt cons. | 2-4 pt | 5+ pt | word len | words/match | tiles left |",
      "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    top.forEach((r, i) => {
      const id = num(r.id);
      const s = model.botSummary(id);
      const aggr = CLASSES.map(([, ls]) => f(model.aggressiveness(id, ls, ctx), 2));
      const rating = Math.round(1500 + ELO_SCALE * (Number(r.mu) - 25));
      const pm = Math.round(ELO_SCALE * Number(r.sigma));
      out.push(
        `| ${i + 1} | ${s.name} (${id}) | ${rating} ±${pm} | ${s.matches} (${s.matchesCurrentVersion}) | ${f(s.meanScore)} | ${f(100 * s.winRate, 0)} | ${f(s.meanPlace, 2)} | ${aggr.join(" | ")} | ${f(s.meanWordLength, 2)} | ${f(s.wordsPerMatch)} | ${f(s.tilesLeftAtEnd)} |`,
      );
    });
    out.push("");

    // ---------- market ----------
    out.push(
      "## Market price by letter and phase",
      "",
      "Clearing price (what the winner paid) over the newest ~1500 matches: median / 90th percentile, then the share of auctions nobody bid on (tile discarded).",
      "",
      `| letter | value | ${PHASES.map(([n]) => n).join(" | ")} | unsold % |`,
      `|---|---:|${PHASES.map(() => "---:").join("|")}|---:|`,
    );
    for (let i = 0; i < 26; i++) {
      const L = LETTERS[i]!;
      const cells = PHASES.map(([, p]) => {
        const m = model.marketPrice(L, p);
        return m.n ? `${m.quantile(0.5)} / ${m.quantile(0.9)}` : "-";
      });
      let unsold = 0;
      let n = 0;
      for (const [, p] of PHASES) {
        const m = model.marketPrice(L, p);
        unsold += m.pUnsold * m.n;
        n += m.n;
      }
      out.push(`| ${L} | ${LETTER_VALUES[i]} | ${cells.join(" | ")} | ${f(n ? (100 * unsold) / n : 0)} |`);
    }
    out.push("");

    // ---------- activity ----------
    const since = asOf - 24 * 3600e6;
    const active = db
      .prepare(
        `SELECT s.bot_id, b.name, b.is_simulated, COUNT(*) AS n, AVG(s.final_score) AS score,
           AVG(s.place = 1) AS win, MAX(s.ended_us) AS last
         FROM match_seat s JOIN bot b ON b.id = s.bot_id
         WHERE s.ended_us > ? GROUP BY s.bot_id ORDER BY n DESC`,
      )
      .all(since);
    const real = active.filter((r) => num(r.is_simulated) === 0);
    out.push(
      "## Who played in the last 24 hours",
      "",
      `${real.length} real bots and ${active.length - real.length} sims played in the 24 h before ${fmtUs(asOf)} UTC.`,
      "",
      "| bot | matches | mean score | win % | last match (UTC) |",
      "|---|---:|---:|---:|---|",
      ...real.map(
        (r) =>
          `| ${String(r.name)} (${num(r.bot_id)}) | ${num(r.n)} | ${f(Number(r.score))} | ${f(100 * Number(r.win), 0)} | ${fmtUs(num(r.last))} |`,
      ),
      "",
    );
    const comp = (fromUs: number) =>
      db
        .prepare("SELECT n_real, COUNT(*) AS n FROM match_info WHERE ended_us > ? GROUP BY n_real ORDER BY n_real")
        .all(fromUs)
        .map((r) => ({ real: num(r.n_real), n: num(r.n) }));
    const fmtComp = (rows: { real: number; n: number }[]) => {
      const tot = rows.reduce((s, r) => s + r.n, 0);
      return rows.map((r) => `${r.real} real: ${r.n} (${f((100 * r.n) / Math.max(1, tot), 0)}%)`).join(", ");
    };
    const perHour = num(q("SELECT COUNT(*) AS n FROM match_info WHERE ended_us > ?", asOf - 3600e6)?.n);
    out.push(
      "## Table composition",
      "",
      `Last 2 h: ${fmtComp(comp(asOf - 2 * 3600e6))}.`,
      `Last 24 h: ${fmtComp(comp(since))}.`,
      `Matches in the last hour: ${perHour}.`,
      "",
    );

    // ---------- model quality ----------
    const v = getMetaSafe(dbPath, "validation") as ValidationReport | undefined;
    out.push("## Bid model validation", "");
    if (v) out.push(`Run ${v.at.slice(0, 16).replace("T", " ")} UTC.`, "", formatValidation(v), "");
    else out.push("Not run yet: `npm run profiles -- --validate`.", "");
    const c = getMetaSafe(dbPath, "clone_check") as { at: string; rows: CloneRow[] } | undefined;
    out.push("## Clone check", "");
    if (c) {
      out.push(
        `Run ${c.at.slice(0, 16).replace("T", " ")} UTC. Each bot's recent real tables replayed in the clone simulator with every real seat played by its clone; real numbers are from the same matches.`,
        "",
        formatCloneCheck(c.rows),
        "",
      );
    } else out.push("Not run yet: `npm run profiles -- --clones`.", "");
    out.push(
      `Model config: half-life ${DEFAULT_CONFIG.halfLifeHours} h, old-version weight ${DEFAULT_CONFIG.oldVersionFactor}, runner-up EM rounds ${DEFAULT_CONFIG.emRounds}.`,
    );
  } finally {
    db.close();
  }
  return out.join("\n") + "\n";
}

function getMetaSafe(dbPath: string, key: string): unknown {
  const db = openDb(dbPath, { readOnly: true });
  try {
    const v = getMeta(db, key);
    return v ? JSON.parse(v) : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const outPath = argv.includes("--out")
    ? argv[argv.indexOf("--out") + 1]!
    : path.join(path.dirname(DEFAULT_DB_PATH), "field-report.md");
  if (argv.includes("--validate")) {
    const v = validate(DEFAULT_DB_PATH, DEFAULT_CONFIG);
    const db = openDb(DEFAULT_DB_PATH);
    setMeta(db, "validation", JSON.stringify(v));
    db.close();
  }
  if (argv.includes("--clones")) {
    const rows = cloneCheck(DEFAULT_DB_PATH, 12, 40);
    const db = openDb(DEFAULT_DB_PATH);
    setMeta(db, "clone_check", JSON.stringify({ at: new Date().toISOString(), rows }));
    db.close();
  }
  const report = buildReport(DEFAULT_DB_PATH);
  console.log(report);
  fs.writeFileSync(outPath, report);
  console.error(`saved ${outPath}`);
}

if (isMain(import.meta.url)) main();
