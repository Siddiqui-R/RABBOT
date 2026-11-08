// Full local tournament rehearsal on RackForge's own SpacetimeDB (127.0.0.1:3013).
//
//   npx tsx scripts/rehearse/run.ts --tree <bot tree> [--swiss 2] [--cut 3] [--size 4]
//       [--auction Vickrey|FirstPrice] [--fillers clone:59,clone:12,...] [--rack 5]
//       [--auction-ms 1000] [--register tid|auto] [--db sbrehearsalXXXX]
//       [--filler-tree <dir>] [--timeout-min 30] [--finals-delay-ms 2000] [--keep]
//
// What it does, in order:
//   1. Copies the real game module (the upstream scrabblebot repo's
//      spacetimedb/, from RACKFORGE_UPSTREAM, default ../scrabblebot/spacetimedb) to a
//      work dir, empties its hardcoded seed-admin list (the only change; it is
//      what lets bootstrap_admin work on a fresh database), and publishes it as
//      a fresh database `sbrehearsal*` with a scratch CLI config that has its
//      own server-issued login (never the global config, never maincloud).
//   2. Connects an admin identity (bootstrap_admin), sets the matchmaker config
//      (rack size, auction length, a lobby too big for the entrants to fill so
//      no casual match starts by itself), creates the tournament.
//   3. One fresh human identity per team: create_team + mint_credential_nonce.
//   4. Launches RackForge from --tree (nice 5) and every filler from --filler-tree
//      (same bot code, --agent <spec>, nice 15) with BOT_NONCE, telemetry OFF.
//      Fillers register with TOURNAMENT_ID; RackForge too unless --register auto.
//   5. Starts the tournament once everyone is registered, starts each finals
//      match (start_next_finals_match) until a champion, and reports every
//      stage, RackForge's results, deadline misses, refusals, crashes, stalls.
//   6. Tears down: kills only the process groups it spawned, deletes the
//      database, removes its replica dir and the token files it caused.
//
// Output: <out>/report.md, <out>/summary.json, <out>/<bot>/ (bot logs).
//
// Env: RACKFORGE_UPSTREAM (upstream game module dir), SPACETIME_BIN (default
// ~/.local/bin/spacetime), RACKFORGE_STDB_DATA (the local server's data dir,
// default ~/.local/share/rackforge/stdb), RACKFORGE_PROTECTED_TREES (colon-separated bot
// trees the kit must never launch from, e.g. the deployed bot's directory).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setGlobalLogLevel, type Identity } from "spacetimedb";
import { DbConnection } from "../../src/module_bindings/index.js";

const REPO = path.join(import.meta.dirname, "..", "..");
const UPSTREAM = process.env.RACKFORGE_UPSTREAM
  ? path.resolve(process.env.RACKFORGE_UPSTREAM)
  : path.join(REPO, "..", "scrabblebot", "spacetimedb");
const SPACETIME = process.env.SPACETIME_BIN ?? path.join(os.homedir(), ".local", "bin", "spacetime");
const HOST = "127.0.0.1:3013";
const URI = `http://${HOST}`;
const REPLICAS = path.join(process.env.RACKFORGE_STDB_DATA ?? path.join(os.homedir(), ".local", "share", "rackforge", "stdb"), "replicas");
const PROTECTED_TREES = (process.env.RACKFORGE_PROTECTED_TREES ?? "").split(":").filter(Boolean).map((t) => path.resolve(t));
const DEFAULT_FILLERS = "clone:59,clone:12,clone:67,clone:45,clone:102,clone:115,clone:69";

// ---------- args ----------

interface Args {
  tree: string;
  fillerTree: string;
  swiss: number;
  cut: number;
  size: number;
  auction: "Vickrey" | "FirstPrice";
  fillers: string[];
  rack: number;
  auctionMs: number;
  register: "tid" | "auto";
  db: string;
  work: string;
  out: string;
  timeoutMin: number;
  finalsDelayMs: number;
  regTimeoutS: number;
  keep: boolean;
  rackforgeArgs: string[];
}

function parseArgs(argv: string[]): Args {
  const m = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    if (!f.startsWith("--")) throw new Error(`unexpected argument ${f}`);
    const eq = f.indexOf("=");
    if (eq > 0) m.set(f.slice(2, eq), f.slice(eq + 1));
    else if (f === "--keep") flags.add("keep");
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${f} needs a value`);
      m.set(f.slice(2), v);
    }
  }
  const known = ["tree", "filler-tree", "swiss", "cut", "size", "auction", "fillers", "rack", "auction-ms", "register", "db", "work", "out", "timeout-min", "finals-delay-ms", "reg-timeout", "rackforge-args"];
  for (const k of m.keys()) if (!known.includes(k)) throw new Error(`unknown flag --${k}`);
  const tree = m.get("tree");
  if (!tree) throw new Error("--tree <bot tree dir> is required");
  const num = (k: string, d: number) => {
    const v = m.has(k) ? Number(m.get(k)) : d;
    if (!Number.isFinite(v)) throw new Error(`--${k} must be a number`);
    return v;
  };
  const auction = m.get("auction") ?? "Vickrey";
  if (auction !== "Vickrey" && auction !== "FirstPrice") throw new Error("--auction must be Vickrey or FirstPrice");
  const register = m.get("register") ?? "tid";
  if (register !== "tid" && register !== "auto") throw new Error("--register must be tid or auto");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 12); // MMDDHHMM
  const db = m.get("db") ?? `sbrehearsal${stamp}${Math.floor(Math.random() * 90 + 10)}`;
  if (!/^sbrehearsal[a-z0-9-]*$/.test(db)) throw new Error("--db must start with sbrehearsal (lowercase letters, digits, dashes)");
  return {
    tree: path.resolve(tree),
    fillerTree: path.resolve(m.get("filler-tree") ?? tree),
    swiss: num("swiss", 2),
    cut: num("cut", 3),
    size: num("size", 4),
    auction,
    fillers: (m.get("fillers") ?? DEFAULT_FILLERS).split(",").map((s) => s.trim()).filter(Boolean),
    rack: num("rack", 5),
    auctionMs: num("auction-ms", 1000),
    register,
    db,
    work: path.resolve(m.get("work") ?? path.join(os.tmpdir(), "rackforge-rehearse", db)),
    out: path.resolve(m.get("out") ?? path.join(REPO, "logs", "rehearse", db)),
    timeoutMin: num("timeout-min", 30),
    finalsDelayMs: num("finals-delay-ms", 2000),
    regTimeoutS: num("reg-timeout", 180),
    keep: flags.has("keep"),
    rackforgeArgs: (m.get("rackforge-args") ?? "").split(/\s+/).filter(Boolean),
  };
}

// ---------- reporting ----------

const t0 = Date.now();
const events: string[] = [];
const problems: string[] = [];
const utc = () => new Date().toISOString().slice(11, 19);
function say(msg: string) {
  const line = `${utc()} +${Math.round((Date.now() - t0) / 1000)}s ${msg}`;
  events.push(line);
  console.log(`[rehearse] ${line}`);
}
function problem(msg: string) {
  problems.push(`${utc()} ${msg}`);
  say(`PROBLEM: ${msg}`);
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- CLI (scratch config only) ----------

function cli(config: string, args: string[], timeout = 180_000): string {
  return execFileSync(SPACETIME, ["--config-path", config, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    // Never from inside the upstream checkout: its spacetime.json would
    // make the CLI resolve a different database.
    cwd: path.dirname(config),
  });
}

function makeCliConfig(file: string) {
  fs.writeFileSync(file, `default_server = "rackforge"\n\n[[server_configs]]\nnickname = "rackforge"\nhost = "${HOST}"\nprotocol = "http"\n`, { mode: 0o600 });
  cli(file, ["login", "--server-issued-login", "rackforge"], 30_000);
  fs.chmodSync(file, 0o600);
}

function prepareModule(work: string): string {
  const dir = path.join(work, "module");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("rsync", ["-a", "--exclude", "node_modules", "--exclude", "dist", `${UPSTREAM}/`, `${dir}/`]);
  fs.symlinkSync(path.join(UPSTREAM, "node_modules"), path.join(dir, "node_modules"));
  const game = path.join(dir, "src", "game.ts");
  const src = fs.readFileSync(game, "utf8");
  const patched = src.replace(/(export const SEED_ADMIN_HEX: readonly string\[\] = \[)[\s\S]*?(\];)/, "$1\n  // rehearsal copy: no seed admins, so bootstrap_admin works\n$2");
  if (patched === src) throw new Error("could not find SEED_ADMIN_HEX in the module copy");
  fs.writeFileSync(game, patched);
  return dir;
}

function listReplicas(): Set<string> {
  try {
    return new Set(fs.readdirSync(REPLICAS));
  } catch {
    return new Set();
  }
}

/** The replica dir our publish created: new, locked during the publish, and holding this module's tables. */
function findOurReplica(before: Set<string>, fromMs: number, toMs: number): string | undefined {
  const hits: string[] = [];
  for (const d of listReplicas()) {
    if (before.has(d)) continue;
    try {
      const lock = fs.readFileSync(path.join(REPLICAS, d, "db.lock"), "utf8");
      const ts = Date.parse(/timestamp_utc=([^\s;]+)/.exec(lock)?.[1] ?? "");
      if (!(ts >= fromMs - 2000 && ts <= toMs + 2000)) continue;
      const logs = path.join(REPLICAS, d, "module_logs");
      const text = fs.readdirSync(logs).map((f) => fs.readFileSync(path.join(logs, f), "utf8").slice(0, 200_000)).join("");
      if (text.includes("Creating table `credential_nonce`")) hits.push(d);
    } catch {
      /* not ours or unreadable */
    }
  }
  return hits.length === 1 ? hits[0] : undefined;
}

// ---------- SDK ----------

interface Conn {
  conn: DbConnection;
  identity: Identity;
  token: string;
}

function connect(db: string, token?: string): Promise<Conn> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("connect timeout")), 20_000);
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(db)
      .withToken(token)
      .withCompression("none")
      .onConnect((conn, identity, tok) => {
        clearTimeout(timer);
        res({ conn, identity, token: tok });
      })
      .onConnectError((_c, e) => {
        clearTimeout(timer);
        rej(e);
      })
      .build();
  });
}

function subscribe(conn: DbConnection, queries: string[]): Promise<void> {
  return new Promise((res, rej) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => res())
      .onError((ctx) => rej(new Error(`subscribe failed: ${ctx.event ? errMsg(ctx.event) : "?"}`)))
      .subscribe(queries);
  });
}

async function waitFor<T>(what: string, ms: number, f: () => T | undefined | null | false): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// ---------- bots ----------

interface BotRun {
  name: string;
  agent: string;
  rackforge: boolean;
  botId?: bigint;
  tree: string;
  logDir: string;
  child?: ChildProcess;
  exited?: { code: number | null; signal: string | null; at: string };
  startedAt?: number;
}

function launch(b: BotRun, a: Args, nonce: string, tournamentId: bigint) {
  fs.mkdirSync(b.logDir, { recursive: true });
  const out = fs.openSync(path.join(b.logDir, "stdout.log"), "a");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STDB_HOST: URI,
    STDB_DB: a.db,
    BOT_NAME: b.name,
    BOT_NONCE: nonce,
    RACKFORGE_LOG_DIR: b.logDir,
    RACKFORGE_TELEMETRY: "0",
    RACKFORGE_REHEARSAL: "1",
  };
  delete env.BOT_TOKEN;
  delete env.TOURNAMENT_ID;
  if (!b.rackforge || a.register === "tid") env.TOURNAMENT_ID = String(tournamentId);
  const tsx = path.join(b.tree, "node_modules", ".bin", "tsx");
  const args = ["-n", b.rackforge ? "5" : "15", tsx, "src/bot.ts", "--agent", b.agent, ...(b.rackforge ? a.rackforgeArgs : [])];
  const child = spawn("nice", args, { cwd: b.tree, env, detached: true, stdio: ["ignore", out, out] });
  fs.closeSync(out);
  b.child = child;
  b.startedAt = Date.now();
  child.on("exit", (code, signal) => {
    b.exited = { code, signal, at: utc() };
    if (!stopping) problem(`bot ${b.name} (${b.agent}) exited: code ${code} signal ${signal}; tail: ${tail(path.join(b.logDir, "stdout.log"), 3)}`);
  });
}

function tail(file: string, n: number): string {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").slice(-n).join(" | ");
  } catch {
    return "";
  }
}

let stopping = false;

async function killAll(bots: BotRun[]) {
  stopping = true;
  for (const b of bots) {
    if (b.child?.pid && !b.exited) {
      try {
        process.kill(-b.child.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
  const end = Date.now() + 6000;
  while (Date.now() < end && bots.some((b) => b.child && !b.exited)) await sleep(200);
  for (const b of bots) {
    if (b.child?.pid && !b.exited) {
      try {
        process.kill(-b.child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

// ---------- RackForge log analysis ----------

interface RACKFORGEStats {
  auctions: number;
  misses: number;
  noSendAuctions: number;
  refusedSends: Record<string, number>;
  minSlackMs: number | null;
  quickMsP99: number | null;
  refineMsP99: number | null;
  wordsOk: number;
  wordsRefused: Record<string, number>;
  lobbyJoinsOk: number;
  lobbyRefused: Record<string, number>;
  register: string[];
  errors: string[];
  warnings: number;
  matchStarts: number[];
  matchEnds: { match: number; place: number; seats: number; score: number }[];
  auctionsByMatch: Record<number, number>;
}

function pctl(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10;
}

function analyseRACKFORGE(dir: string): RACKFORGEStats {
  const st: RACKFORGEStats = {
    auctions: 0, misses: 0, noSendAuctions: 0, refusedSends: {}, minSlackMs: null, quickMsP99: null, refineMsP99: null,
    wordsOk: 0, wordsRefused: {}, lobbyJoinsOk: 0, lobbyRefused: {}, register: [], errors: [], warnings: 0,
    matchStarts: [], matchEnds: [], auctionsByMatch: {},
  };
  const quick: number[] = [];
  const refine: number[] = [];
  const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  } catch {
    /* none */
  }
  for (const f of files) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      switch (r.type) {
        case "auction": {
          st.auctions++;
          const m = Number(r.match);
          st.auctionsByMatch[m] = (st.auctionsByMatch[m] ?? 0) + 1;
          st.misses += Number(r.misses ?? 0);
          if (typeof r.quickMs === "number") quick.push(r.quickMs);
          if (typeof r.refineMs === "number") refine.push(r.refineMs);
          const sends = (r.sends as { ok?: boolean; err?: string; slackMs?: number }[] | undefined) ?? [];
          if (!sends.length) st.noSendAuctions++;
          for (const s of sends) {
            if (s.ok === false) bump(st.refusedSends, String(s.err ?? "?").slice(0, 80));
            if (typeof s.slackMs === "number") st.minSlackMs = st.minSlackMs === null ? s.slackMs : Math.min(st.minSlackMs, s.slackMs);
          }
          break;
        }
        case "word":
          if (r.ok === false) bump(st.wordsRefused, String(r.err ?? "?").slice(0, 80));
          else st.wordsOk++;
          break;
        case "lobby":
          if (r.ok === false) bump(st.lobbyRefused, String(r.err ?? "?").slice(0, 100));
          else st.lobbyJoinsOk++;
          break;
        case "tournament":
          st.register.push(`${r.action} ${r.ok ? "ok" : `refused: ${r.err}`}`);
          break;
        case "error":
          st.errors.push(`${r.where}: ${String(r.err).slice(0, 160)}`);
          break;
        case "match_start":
          st.matchStarts.push(Number(r.match));
          break;
        case "match_end":
          st.matchEnds.push({ match: Number(r.match), place: Number(r.place), seats: Number(r.seats), score: Number(r.score) });
          break;
      }
    }
  }
  st.quickMsP99 = pctl(quick, 0.99);
  st.refineMsP99 = pctl(refine, 0.99);
  try {
    st.warnings = fs.readFileSync(path.join(dir, "stdout.log"), "utf8").split("\n").filter((l) => /WARN|uncaught|unhandled|fatal/i.test(l)).length;
  } catch {
    /* none */
  }
  return st;
}

// ---------- main ----------

interface MatchReport {
  matchId: number;
  phase: string;
  round: number;
  seats: { name: string; score: number; place: number; rackforge: boolean }[];
  auctions: number;
  rackforgeWords7: number;
  durationS: number;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  setGlobalLogLevel("warn");
  fs.mkdirSync(a.work, { recursive: true, mode: 0o700 });
  fs.chmodSync(a.work, 0o700);
  fs.mkdirSync(a.out, { recursive: true });
  for (const t of [a.tree, a.fillerTree]) {
    if (!fs.existsSync(path.join(t, "src", "bot.ts"))) throw new Error(`${t} has no src/bot.ts`);
    if (PROTECTED_TREES.some((p) => path.resolve(t).startsWith(p))) {
      throw new Error("refusing to run bots from a protected (deployed) tree (they write token files); rsync a copy first");
    }
  }
  say(`db ${a.db}, tree ${a.tree}, ${a.fillers.length} fillers, swiss ${a.swiss}, cut ${a.cut}, size ${a.size}, ${a.auction}, rack ${a.rack}, ${a.auctionMs} ms`);

  const tag = a.db.replace(/^sbrehearsal/, "").slice(-6) || "x";
  const bots: BotRun[] = [
    { name: `RACKFORGE-${tag}`, agent: "rackforge", rackforge: true, tree: a.tree, logDir: path.join(a.out, `RACKFORGE-${tag}`) },
    ...a.fillers.map((f, i) => {
      const name = `f${i + 1}-${f.replace(/[^a-z0-9]/gi, "")}-${tag}`.slice(0, 32);
      return { name, agent: f, rackforge: false, tree: a.fillerTree, logDir: path.join(a.out, name) };
    }),
  ];
  const rackforge = bots[0]!;
  let admin: Conn | undefined;
  let published = false;
  let replica: string | undefined;
  const cliConfig = path.join(a.work, "publisher.toml");
  const reports: MatchReport[] = [];
  let summary: Record<string, unknown> = {};

  const teardown = async () => {
    say("teardown");
    await killAll(bots);
    try {
      admin?.conn.disconnect();
    } catch {
      /* ignore */
    }
    for (const b of bots) fs.rmSync(path.join(b.tree, `.token-${b.name}`), { force: true });
    if (published && !a.keep) {
      try {
        cli(cliConfig, ["delete", "-s", "rackforge", "-y", a.db], 60_000);
        say(`database ${a.db} deleted`);
      } catch (e) {
        problem(`could not delete ${a.db}: ${errMsg(e)}`);
      }
      if (replica) {
        await sleep(1000);
        try {
          fs.rmSync(path.join(REPLICAS, replica), { recursive: true, force: true });
          say(`replica dir ${replica} removed`);
        } catch (e) {
          say(`replica dir ${replica} left: ${errMsg(e)}`);
        }
      } else say("replica dir not identified uniquely; left in place");
    }
  };
  let tornDown = false;
  const onSignal = async (sig: string) => {
    if (tornDown) return;
    tornDown = true;
    problem(`${sig}: aborting`);
    await teardown();
    process.exit(130);
  };
  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));

  try {
    // 1. publish
    makeCliConfig(cliConfig);
    const moduleDir = prepareModule(a.work);
    const before = listReplicas();
    const p0 = Date.now();
    cli(cliConfig, ["publish", "-s", "rackforge", "-p", moduleDir, "-y", "--delete-data=always", a.db]);
    published = true;
    replica = findOurReplica(before, p0, Date.now());
    say(`published ${a.db} in ${Date.now() - p0} ms (replica ${replica ?? "?"})`);

    // 2. admin, config, tournament
    admin = await connect(a.db);
    fs.writeFileSync(path.join(a.work, "admin.token"), admin.token, { mode: 0o600 });
    const conn = admin.conn;
    await conn.reducers.bootstrapAdmin({});
    await subscribe(conn, [
      "SELECT * FROM tournament",
      "SELECT * FROM tournament_entry",
      "SELECT * FROM tournament_match",
      "SELECT * FROM match_state",
      "SELECT * FROM match_participant",
      "SELECT * FROM bot",
      "SELECT * FROM bot_credential",
      "SELECT * FROM lobby",
      "SELECT * FROM lobby_member",
      "SELECT * FROM auction_result",
      "SELECT * FROM word_play",
    ]);
    const lobbyMax = Math.min(12, Math.floor(97 / Math.max(a.rack, 1)));
    if (lobbyMax <= bots.length) say(`note: lobby size ${lobbyMax} <= ${bots.length} entrants; idle bots may fill a casual match`);
    await conn.reducers.setMatchmakerConfig({ startingRackSize: a.rack, lobbyMaxSize: lobbyMax, auctionDurationMs: BigInt(a.auctionMs) });
    await conn.reducers.createTournament({ swissRoundsTotal: a.swiss, topCut: a.cut, matchSize: a.size, auctionType: { tag: a.auction } });
    const tour = await waitFor("tournament row", 5000, () => [...conn.db.tournament.iter()].find((t) => t.status.tag === "Registration"));
    const tid = tour.id;
    say(`admin ${admin.identity.toHexString().slice(0, 12)}…, tournament ${tid} created (Registration)`);

    // 3. teams + nonces, one fresh human identity per team
    const nonces = new Map<string, string>();
    await Promise.all(
      bots.map(async (b) => {
        const h = await connect(a.db);
        try {
          fs.writeFileSync(path.join(a.work, `human-${b.name}.token`), h.token, { mode: 0o600 });
          await subscribe(h.conn, ["SELECT * FROM my_nonces"]);
          await h.conn.reducers.createTeam({ teamName: `team-${b.name}`, botName: b.name });
          await h.conn.reducers.mintCredentialNonce({});
          const n = await waitFor(`nonce for ${b.name}`, 10_000, () => [...h.conn.db.myNonces.iter()][0]);
          nonces.set(b.name, n.code);
          b.botId = n.botId;
        } finally {
          h.conn.disconnect();
        }
      }),
    );
    say(`teams: ${bots.map((b) => `${b.name}=#${b.botId}`).join(", ")}`);
    const byId = new Map(bots.map((b) => [b.botId!, b]));
    const nameOf = (id: bigint) => byId.get(id)?.name ?? conn.db.bot.id.find(id)?.name ?? `#${id}`;

    // Lobby timing: bots join the casual lobby on startup; if it times out
    // before the start, they're padded with sims into a casual match and the
    // start waits for it. Launch early in a lobby's life.
    const lobbyLeft = () => {
      const l = [...conn.db.lobby.iter()].find((x) => x.status.tag === "Open");
      return l ? Number(l.closesAt.microsSinceUnixEpoch / 1000n) - Date.now() : 0;
    };
    // The open lobby keeps the size it was created with (6 at init), and six
    // real bots fill it at once, so wait for one created after the config.
    const openLobby = () => [...conn.db.lobby.iter()].find((x) => x.status.tag === "Open");
    if (lobbyLeft() < 60_000 || (openLobby()?.maxSize ?? 0) < lobbyMax) {
      say(`open lobby (size ${openLobby()?.maxSize}) closes in ${Math.round(lobbyLeft() / 1000)} s; waiting for the next one`);
      const cur = [...conn.db.lobby.iter()].find((x) => x.status.tag === "Open")?.id;
      await waitFor("a fresh lobby", 100_000, () => [...conn.db.lobby.iter()].some((x) => x.status.tag === "Open" && x.id !== cur));
    }

    // 4. launch
    for (const b of bots) launch(b, a, nonces.get(b.name)!, tid);
    say(`launched ${bots.length} bots (RackForge registers via ${a.register === "tid" ? "TOURNAMENT_ID" : "its own auto-registration"})`);
    const regAt = new Map<string, number>();
    const regEnd = Date.now() + a.regTimeoutS * 1000;
    for (;;) {
      for (const e of conn.db.tournamentEntry.iter()) {
        const b = byId.get(e.botId);
        if (b && !regAt.has(b.name)) {
          regAt.set(b.name, Date.now());
          say(`registered: ${b.name} after ${((Date.now() - b.startedAt!) / 1000).toFixed(1)} s`);
        }
      }
      if (regAt.size === bots.length) break;
      if (Date.now() > regEnd) {
        problem(`not registered after ${a.regTimeoutS} s: ${bots.filter((b) => !regAt.has(b.name)).map((b) => b.name).join(", ")}`);
        break;
      }
      await sleep(250);
    }
    // Sim-only lobby matches don't hold anything up; ones with an entrant do.
    const casual = [...conn.db.matchState.iter()].filter(
      (m) => m.status.tag === "Running" && [...conn.db.matchParticipant.mpByMatch.filter(m.id)].some((p) => byId.has(p.botId)),
    );
    if (casual.length) say(`entrants in casual matches before the start: ${casual.map((m) => m.id).join(", ")} (round 1 will wait)`);

    // 5. start and drive
    const startAt = Date.now();
    await conn.reducers.startTournament({ tournamentId: tid });
    say(`start_tournament ok with ${[...conn.db.tournamentEntry.iter()].length} entrants`);

    const seenTm = new Set<bigint>();
    const endedTm = new Set<bigint>();
    const progress = new Map<bigint, { n: number; at: number }>();
    const offlineSeen = new Set<string>();
    let lastStatus = "";
    let lastFinalsCall = 0;
    let idleSince = 0;
    let stalledRound1 = false;
    let finalDiff = 0;
    const deadline = startAt + a.timeoutMin * 60_000;
    for (;;) {
      const t = conn.db.tournament.id.find(tid);
      if (!t) {
        problem("tournament row vanished");
        break;
      }
      const status = t.status.tag;
      if (status !== lastStatus) {
        const alive = [...conn.db.tournamentEntry.iter()].filter((e) => !e.eliminated).map((e) => nameOf(e.botId));
        say(`STAGE ${status} (alive: ${alive.join(", ")})`);
        lastStatus = status;
      }
      // New tournament matches.
      for (const tm of conn.db.tournamentMatch.iter()) {
        if (seenTm.has(tm.matchId)) continue;
        seenTm.add(tm.matchId);
        const seats = [...conn.db.matchParticipant.mpByMatch.filter(tm.matchId)].map((p) => nameOf(p.botId));
        say(`match ${tm.matchId} started: ${tm.phase.tag} round ${tm.round}, ${seats.length} seats: ${seats.join(", ")}`);
        if (!seats.includes(rackforge.name) && [...conn.db.tournamentEntry.iter()].some((e) => e.botId === rackforge.botId && !e.eliminated)) {
          if (tm.phase.tag === "Swiss") say(`note: RackForge not at this table`);
        }
      }
      // Ended tournament matches.
      for (const tm of conn.db.tournamentMatch.iter()) {
        if (endedTm.has(tm.matchId)) continue;
        const ms = conn.db.matchState.id.find(tm.matchId);
        if (ms?.status.tag !== "Ended") continue;
        endedTm.add(tm.matchId);
        const parts = [...conn.db.matchParticipant.mpByMatch.filter(tm.matchId)];
        const seats = parts
          .map((p) => ({
            name: nameOf(p.botId),
            score: Number(p.score),
            place: 1 + parts.filter((q) => q.score > p.score).length,
            rackforge: p.botId === rackforge.botId,
          }))
          .sort((x, y) => x.place - y.place);
        const auctions = [...conn.db.auctionResult.resultByMatch.filter(tm.matchId)].length;
        const rackforgeWords7 = [...conn.db.wordPlay.playByMatch.filter(tm.matchId)].filter((w) => w.botId === rackforge.botId && w.word.length >= 7).length;
        const durationS = ms.startedAt && ms.endedAt ? Number(ms.endedAt.microsSinceUnixEpoch - ms.startedAt.microsSinceUnixEpoch) / 1e6 : 0;
        const rep: MatchReport = { matchId: Number(tm.matchId), phase: tm.phase.tag, round: tm.round, seats, auctions, rackforgeWords7, durationS };
        reports.push(rep);
        const me = seats.find((s) => s.rackforge);
        let extra = "";
        if (tm.phase.tag === "Final" && me) {
          const opp = seats.find((s) => !s.rackforge);
          finalDiff += me.score - (opp?.score ?? 0);
          extra = ` | final game ${tm.round}: RackForge ${me.score} vs ${opp?.score}, running diff ${finalDiff >= 0 ? "+" : ""}${finalDiff}`;
        }
        say(
          `match ${tm.matchId} ended (${tm.phase.tag} r${tm.round}, ${auctions} auctions, ${durationS.toFixed(0)} s): ` +
            seats.map((s) => `${s.place}. ${s.name} ${s.score}`).join(", ") +
            (me ? ` | RackForge place ${me.place}/${seats.length}, ${rackforgeWords7} words of 7+` : "") +
            extra,
        );
        if (tm.phase.tag === "Swiss") {
          const st = [...conn.db.tournamentEntry.iter()]
            .sort((x, y) => y.swissPoints - x.swissPoints || Number(y.totalScore - x.totalScore))
            .map((e) => `${nameOf(e.botId)} ${e.swissPoints}pt/${e.totalScore}`);
          say(`standings: ${st.join(", ")}`);
        }
      }
      // Liveness of running tournament matches.
      for (const mId of seenTm) {
        const ms = conn.db.matchState.id.find(mId);
        if (ms?.status.tag !== "Running") continue;
        const n = [...conn.db.auctionResult.resultByMatch.filter(mId)].length;
        const pr = progress.get(mId);
        if (!pr || pr.n !== n) progress.set(mId, { n, at: Date.now() });
        else if (Date.now() - pr.at > 5000 + 10 * a.auctionMs && pr.at > 0) {
          problem(`match ${mId} stuck: no auction closed for ${Math.round((Date.now() - pr.at) / 1000)} s`);
          pr.at = 0;
        }
      }
      // Registered bots offline.
      for (const b of bots) {
        const creds = b.botId !== undefined ? [...conn.db.botCredential.credByBot.filter(b.botId)] : [];
        const online = creds.some((c) => c.connected);
        if (!online && creds.length && !offlineSeen.has(b.name)) {
          offlineSeen.add(b.name);
          problem(`bot ${b.name} is offline (no connected credential)`);
        } else if (online) offlineSeen.delete(b.name);
      }
      if (status === "Swiss" && t.currentRound === 0 && !stalledRound1 && Date.now() - startAt > 120_000) {
        stalledRound1 = true;
        problem("round 1 hasn't started 120 s after start_tournament (an entrant still in a casual match?)");
      }
      // Drive the finals: the admin starts each match, a short pause after the last one ended.
      const finalsIdle = (status === "Bracket" || status === "Final") && ![...conn.db.tournamentMatch.iter()].some((m) => conn.db.matchState.id.find(m.matchId)?.status.tag === "Running");
      if (!finalsIdle) idleSince = 0;
      else if (idleSince === 0) idleSince = Date.now();
      else if (Date.now() - idleSince >= a.finalsDelayMs && Date.now() - lastFinalsCall > 3000) {
        lastFinalsCall = Date.now();
        try {
          await conn.reducers.startNextFinalsMatch({ tournamentId: tid });
        } catch (e) {
          problem(`start_next_finals_match refused: ${errMsg(e)}`);
        }
      }
      if (status === "Ended" || status === "ForceEnded") break;
      if (Date.now() > deadline) {
        problem(`tournament not finished after ${a.timeoutMin} min; force-ending`);
        try {
          await conn.reducers.forceEndTournament({ tournamentId: tid });
        } catch (e) {
          problem(`force_end_tournament refused: ${errMsg(e)}`);
        }
        break;
      }
      await sleep(500);
    }

    // 6. results
    const t = conn.db.tournament.id.find(tid);
    const entries = [...conn.db.tournamentEntry.iter()].sort(
      (x, y) => (x.finalFinishPosition ?? 99) - (y.finalFinishPosition ?? 99) || y.swissPoints - x.swissPoints || Number(y.totalScore - x.totalScore),
    );
    const champion = t?.winnerBotId !== undefined ? nameOf(t.winnerBotId) : null;
    const rackforgeEntry = entries.find((e) => e.botId === rackforge.botId);
    say(`tournament ${t?.status.tag}; champion ${champion ?? "-"}; ${Math.round((Date.now() - startAt) / 1000)} s after start`);
    // RackForge in casual matches after elimination (lobby use)
    const rackforgeMatches = [...conn.db.matchParticipant.mpByBot.filter(rackforge.botId!)].map((p) => p.matchId);
    const casualRACKFORGE = rackforgeMatches.filter((m) => !seenTm.has(m));
    await sleep(3000); // let bot logs flush
    const stats = analyseRACKFORGE(rackforge.logDir);
    for (const m of reports.filter((r) => r.seats.some((s) => s.rackforge))) {
      const logged = stats.auctionsByMatch[m.matchId] ?? 0;
      if (!stats.matchStarts.includes(m.matchId)) problem(`RackForge log has no match_start for its tournament match ${m.matchId}`);
      if (logged < m.auctions) problem(`RackForge logged ${logged} auctions of ${m.auctions} in match ${m.matchId}`);
    }
    summary = {
      db: a.db,
      args: { ...a, work: undefined },
      tournament: { id: Number(tid), status: t?.status.tag, champion },
      rackforge: {
        name: rackforge.name,
        botId: Number(rackforge.botId),
        swissPoints: rackforgeEntry?.swissPoints,
        totalScore: Number(rackforgeEntry?.totalScore ?? 0),
        finalFinishPosition: rackforgeEntry?.finalFinishPosition ?? null,
        eliminated: rackforgeEntry?.eliminated,
        finalDiff,
        casualMatchesDuringRun: casualRACKFORGE.map(Number),
        log: stats,
      },
      standings: entries.map((e) => ({
        name: nameOf(e.botId),
        swissPoints: e.swissPoints,
        totalScore: Number(e.totalScore),
        finish: e.finalFinishPosition ?? null,
        eliminated: e.eliminated,
      })),
      matches: reports,
      crashes: bots.filter((b) => b.exited).map((b) => ({ name: b.name, ...b.exited })),
      problems,
      elapsedS: Math.round((Date.now() - t0) / 1000),
    };
  } catch (e) {
    problem(`rehearsal aborted: ${errMsg(e)}`);
  } finally {
    if (!tornDown) {
      tornDown = true;
      await teardown();
    }
  }
  summary.events = events;
  fs.writeFileSync(path.join(a.out, "summary.json"), JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
  fs.writeFileSync(path.join(a.out, "report.md"), renderReport(summary));
  console.log(`[rehearse] report: ${path.join(a.out, "report.md")}`);
  process.exit(problems.some((p) => /aborted/.test(p)) ? 1 : 0);
}

function renderReport(s: Record<string, unknown>): string {
  const k = s.rackforge as Record<string, unknown> | undefined;
  const lines = [`# Tournament rehearsal ${s.db}`, ""];
  const tour = s.tournament as Record<string, unknown> | undefined;
  if (tour) lines.push(`Tournament ${tour.id}: ${tour.status}, champion ${tour.champion ?? "-"}.`, "");
  if (k) {
    lines.push(
      `RackForge (${k.name}, bot ${k.botId}): Swiss points ${k.swissPoints}, total score ${k.totalScore}, finish ${k.finalFinishPosition ?? "-"}, eliminated ${k.eliminated}, final diff ${k.finalDiff}.`,
      "",
    );
    const st = k.log as RACKFORGEStats;
    lines.push(
      "## RackForge log",
      "",
      `- auctions logged ${st.auctions}, deadline misses ${st.misses}, auctions with no bid sent ${st.noSendAuctions}, min slack ${st.minSlackMs} ms, quick p99 ${st.quickMsP99} ms, refine p99 ${st.refineMsP99} ms`,
      `- refused bids: ${JSON.stringify(st.refusedSends)}`,
      `- words ok ${st.wordsOk}, refused ${JSON.stringify(st.wordsRefused)}`,
      `- lobby joins ok ${st.lobbyJoinsOk}, refused ${JSON.stringify(st.lobbyRefused)}`,
      `- tournament: ${st.register.join("; ") || "-"}`,
      `- errors: ${st.errors.length ? st.errors.join("; ") : "none"}; WARN lines ${st.warnings}`,
      `- casual matches during the run: ${JSON.stringify(k.casualMatchesDuringRun)}`,
      "",
    );
  }
  lines.push("## Matches", "");
  for (const m of (s.matches as MatchReport[] | undefined) ?? []) {
    lines.push(`- ${m.matchId} ${m.phase} r${m.round} (${m.auctions} auctions, ${m.durationS.toFixed(0)} s): ${m.seats.map((x) => `${x.place}. ${x.rackforge ? "**" : ""}${x.name}${x.rackforge ? "**" : ""} ${x.score}`).join(", ")}`);
  }
  lines.push("", "## Standings", "");
  for (const e of (s.standings as Record<string, unknown>[] | undefined) ?? []) {
    lines.push(`- ${e.name}: ${e.swissPoints} pt, total ${e.totalScore}, finish ${e.finish ?? "-"}${e.eliminated ? ", eliminated" : ""}`);
  }
  lines.push("", "## Problems", "", ...(((s.problems as string[]) ?? []).length ? (s.problems as string[]).map((p) => `- ${p}`) : ["- none"]));
  lines.push("", "## Timeline", "", "```", ...((s.events as string[]) ?? []), "```", "");
  return lines.join("\n");
}

main().catch((e) => {
  console.error(`[rehearse] fatal: ${errMsg(e)}`);
  process.exit(1);
});
