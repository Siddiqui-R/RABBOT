// RABBOT live bot.
//
//   npm run bot                         play as the bot whose token is in .token-<BOT_NAME>
//   BOT_TOKEN=<jwt> npm run bot         first run with a token from the team page
//   BOT_NONCE=<code> npm run bot        first run with a nonce from mint_credential_nonce
//   TOURNAMENT_ID=<id> npm run bot      also register for that tournament
//                                       (not needed: RABBOT registers for every tournament
//                                       that opens; RABBOT_AUTO_TOURNAMENT=0 turns that off)
//   npm run bot -- --agent starter      play the official starter strategy
//   npm run bot -- --dry-run            follow a live match anonymously; no reducer calls
//
// Env: BOT_NAME (default rabbot; names the token file only), BOT_TOKEN,
// BOT_NONCE, TOURNAMENT_ID, STDB_HOST, STDB_DB, RABBOT_MARGIN_MS (safety
// margin, default 250), RABBOT_LOG_DIR (default logs), RABBOT_AUTO_TOURNAMENT
// (default 1: auto-register for tournaments), RABBOT_TELEMETRY (0 = off),
// RABBOT_STALL_MS (mid-match feed silence that forces a reconnect; default
// 5 auctions / at least 6 s, 0 = off).
// Flags: --agent rabbot|starter|clone:<botId>, --dry-run, --as <botId>,
// --match <matchId>, --matches <n>, --margin <ms>, --max-refine <ms>,
// --test-disconnect <s> (drop the connection once, to exercise reconnects).
// Exit codes: 0 done, 2 dry run found nothing to follow, 78 bad credentials.

import * as fs from "node:fs";
import * as path from "node:path";
import { setGlobalLogLevel } from "spacetimedb";
import { emptyCounts } from "./core/rules.js";
import type { Agent, MatchView } from "./core/types.js";
import { loadAgent } from "./live/agents.js";
import { DEFAULT_BIDDER_OPTIONS } from "./live/bidder.js";
import { pickMatchToFollow } from "./live/follow.js";
import { DecisionLog, errMsg } from "./live/log.js";
import { Session } from "./live/session.js";

const ROOT = path.join(import.meta.dirname, "..");

interface Args {
  agent: string;
  dryRun: boolean;
  as?: bigint;
  match?: bigint;
  matches?: number;
  margin?: number;
  maxRefine?: number;
  testDisconnect?: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { agent: "rabbot", dryRun: false };
  const next = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    if (f === "--dry-run") a.dryRun = true;
    else if (f === "--agent") a.agent = next(i++, f);
    else if (f === "--as") a.as = BigInt(next(i++, f));
    else if (f === "--match") a.match = BigInt(next(i++, f));
    else if (f === "--matches") a.matches = Number(next(i++, f));
    else if (f === "--margin") a.margin = Number(next(i++, f));
    else if (f === "--max-refine") a.maxRefine = Number(next(i++, f));
    else if (f === "--test-disconnect") a.testDisconnect = Number(next(i++, f));
    else if (f.startsWith("--agent=")) a.agent = f.slice(8);
    else throw new Error(`unknown flag ${f}`);
  }
  return a;
}

/** Load the dictionary and JIT the agent before the first real auction. */
function warmUp(agent: Agent, log: DecisionLog) {
  const view: MatchView = {
    matchId: 0,
    myBotId: 1,
    auctionType: "Vickrey",
    round: 1,
    bagTotal: 67,
    startingRackSize: 5,
    participants: [
      { botId: 1, balance: 100, score: 0, isSim: false },
      { botId: 2, balance: 100, score: 0, isSim: true },
    ],
    myRack: emptyCounts(),
    history: [],
    nowMs: Date.now(),
  };
  for (const ch of "RETAI") view.myRack[ch.charCodeAt(0) - 65]! += 1;
  const auction = { auctionId: 0, letter: "S", opensAtMs: Date.now(), closesAtMs: Date.now() + 1000 };
  const t0 = performance.now();
  try {
    agent.quickBid(view, auction);
    agent.refineBid?.(view, auction, 50);
    agent.chooseWords(view);
  } catch (e) {
    log.warn(`warm-up threw: ${errMsg(e)}`);
  }
  log.human(`agent warmed up in ${Math.round(performance.now() - t0)} ms`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
  const db = process.env.STDB_DB ?? "scrabblebot";
  const botName = process.env.BOT_NAME ?? "rabbot";
  const tokenPath = path.join(ROOT, `.token-${botName}`);
  const logDir = process.env.RABBOT_LOG_DIR ?? path.join(ROOT, "logs");
  const log = new DecisionLog(logDir, args.dryRun ? "dryrun" : "decisions", args.dryRun ? "dry" : "RABBOT");
  setGlobalLogLevel("warn");

  // A thrown error anywhere must not kill a bot that's mid-match.
  process.on("uncaughtException", (e) => {
    log.write("error", { where: "uncaught", err: errMsg(e) });
    log.warn(`uncaught: ${errMsg(e)}`);
  });
  process.on("unhandledRejection", (e) => {
    log.write("error", { where: "unhandledRejection", err: errMsg(e) });
    log.warn(`unhandled rejection: ${errMsg(e)}`);
  });

  let token: string | undefined;
  if (!args.dryRun) {
    token = process.env.BOT_TOKEN?.trim() || readToken(tokenPath);
    if (!token && !process.env.BOT_NONCE) {
      log.warn(`no token: set BOT_TOKEN or BOT_NONCE (token file ${path.basename(tokenPath)} not found)`);
      process.exit(78);
    }
  }

  const loaded = await loadAgent(args.agent, "live");
  const label = loaded.fallback ? `${loaded.agent.name} (fallback from ${args.agent})` : loaded.agent.name;
  if (loaded.fallback) {
    const bar = "!".repeat(72);
    console.warn(`${bar}\n!! Agent '${args.agent}' unavailable: ${loaded.notes.join("; ")}\n!! FALLING BACK TO THE STARTER AGENT\n${bar}`);
  } else if (loaded.notes.length) log.human(`agent ${label}: ${loaded.notes.join("; ")}`);
  warmUp(loaded.agent, log);

  let asBotId: bigint | undefined;
  if (args.dryRun) {
    const pick = await pickMatchToFollow(host, db, { matchId: args.match, botId: args.as });
    if (!pick) {
      log.warn("dry run: no running match found to follow; try again in a minute or pass --match/--as");
      process.exit(2);
    }
    asBotId = pick.botId;
    log.human(`dry run: following match ${pick.matchId} (round ${pick.round}) as bot ${pick.botId} '${pick.name}'`);
  }

  let tournamentId: bigint | undefined;
  try {
    tournamentId = process.env.TOURNAMENT_ID?.trim() ? BigInt(process.env.TOURNAMENT_ID.trim()) : undefined;
  } catch {
    log.warn(`TOURNAMENT_ID '${process.env.TOURNAMENT_ID}' is not a number: ignored (auto-registration still on unless RABBOT_AUTO_TOURNAMENT=0)`);
  }
  const autoTournament = process.env.RABBOT_AUTO_TOURNAMENT !== "0";
  const margin = args.margin ?? (process.env.RABBOT_MARGIN_MS ? Number(process.env.RABBOT_MARGIN_MS) : undefined);
  const session = new Session({
    host,
    db,
    token,
    nonce: process.env.BOT_NONCE?.trim() || undefined,
    saveToken: (t) => saveToken(tokenPath, t, log),
    tournamentId,
    autoTournament,
    stallMs: process.env.RABBOT_STALL_MS !== undefined && Number.isFinite(Number(process.env.RABBOT_STALL_MS)) ? Number(process.env.RABBOT_STALL_MS) : undefined,
    dryRun: args.dryRun,
    asBotId,
    maxMatches: args.matches ?? (args.dryRun ? 1 : 0),
    idleExitMs: args.dryRun ? 5 * 60_000 : undefined,
    agent: loaded.agent,
    agentLabel: label,
    bidder: {
      ...DEFAULT_BIDDER_OPTIONS,
      ...(margin !== undefined && Number.isFinite(margin) ? { safetyMarginMs: margin } : {}),
      ...(args.maxRefine !== undefined ? { maxRefineMs: args.maxRefine } : {}),
    },
    log,
    rejoinMs: 60_000,
    probeMs: args.dryRun ? 10_000 : 60_000,
    testDisconnectS: args.testDisconnect,
    onFinish: (s) => {
      if (args.dryRun) console.log(JSON.stringify(s, null, 2));
    },
  });
  log.write("start", {
    agent: label,
    dryRun: args.dryRun,
    botName,
    tournament: tournamentId,
    autoTournament,
    asBot: asBotId,
    marginMs: margin ?? DEFAULT_BIDDER_OPTIONS.safetyMarginMs,
    pid: process.pid,
  });

  let shuttingDown = false;
  const shutdown = (sig: string) => {
    // A second signal, or a close that hangs (log flush, telemetry), must not keep the process alive.
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    setTimeout(() => process.exit(0), 5000).unref();
    log.human(`${sig}: shutting down${session.current !== null ? ` (match ${session.current} still running)` : ""}`);
    void session.stop(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  session.start();
}

function readToken(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function saveToken(p: string, token: string, log: DecisionLog) {
  try {
    if (readToken(p) === token) return;
    fs.writeFileSync(p, token, { mode: 0o600 });
    log.human(`token saved to ${path.basename(p)}`);
  } catch (e) {
    log.warn(`could not save token: ${errMsg(e)}`);
  }
}

main().catch((e) => {
  console.error(`[RABBOT] fatal: ${errMsg(e)}`);
  process.exit(1);
});
