// The live bot session: one connection at a time, rebuilt with backoff
// when it drops. Every piece of match state is re-derived from the client
// cache after each (re)sync, so a reconnect needs no bookkeeping beyond the
// subscriptions themselves.
//
// The same code follows another bot's matches in --dry-run: the identity is
// anonymous, `asBotId` stands in for our bot id, and the transports record
// what would have been sent instead of calling reducers.

import type { Identity } from "spacetimedb";
import type { Agent, MatchView } from "../core/types.js";
import { DbConnection, type EventContext, type SubscriptionHandle } from "../module_bindings/index.js";
import { Bidder, type BidderOptions, type BidTransport } from "./bidder.js";
import { BusyTracker, ClockSync } from "./clock.js";
import { errMsg, type DecisionLog } from "./log.js";
import { Telemetry } from "../backend/telemetry.js";
import { tournamentContext } from "../brain/tournament.js";
import {
  ALL_RACK,
  anchorFor,
  anchoredQueries,
  assertAllowed,
  baseQueries,
  botQueries,
  PROBE_QUERY,
  rackQuery,
  rosterQuery,
  seatHistoryQuery,
  tournamentQueries,
} from "./queries.js";
import { tsMs, type AuctionRow } from "./rows.js";
import { feedStalled, stallLimitMs } from "./watchdog.js";
import {
  finalMatchIds,
  heldBy,
  isTournamentHold,
  LOBBY_REFUSED_BACKOFF_MS,
  registerBackoffMs,
  toRegister,
} from "./tournament.js";
import { buildMatchView, rackString, standings } from "./view.js";
import { WordPlayer, type WordTransport } from "./words.js";

export interface SessionOptions {
  host: string;
  db: string;
  token?: string;
  nonce?: string;
  saveToken?: (token: string) => void;
  tournamentId?: bigint;
  dryRun: boolean;
  /** Dry run: whose seat to watch. */
  asBotId?: bigint;
  /** Stop after this many of our matches end (0 = run forever). */
  maxMatches: number;
  /** Dry run: give up if no match is seen within this long. */
  idleExitMs?: number;
  agent: Agent;
  agentLabel: string;
  bidder: BidderOptions;
  log: DecisionLog;
  /** Re-call join_lobby (idempotent) this often while idle. */
  rejoinMs: number;
  /** RTT probe (subscribe round trip) interval. */
  probeMs: number;
  onFinish?: (summary: Record<string, unknown>) => void;
  /** Test aid: drop the connection this many seconds after the first sync. */
  testDisconnectS?: number;
  /** Feed watchdog: silence (ms) mid-match that forces a reconnect; undefined = 5 auctions / 6 s, 0 = off. */
  stallMs?: number;
  /** Register for every tournament that opens (default on; RACKFORGE_AUTO_TOURNAMENT=0 in bot.ts turns it off). */
  autoTournament?: boolean;
}

type Handle = SubscriptionHandle;

/** The other seats of the current match come from their own subscription. */
interface Roster {
  matchId: bigint;
  handle: Handle | null;
  ready: boolean;
  /** Auctions that opened before the roster landed. */
  queued: Array<{ a: AuctionRow; recv: number; fresh: boolean }>;
  resumed: boolean;
}

const isLive = (ctx: EventContext) => ctx.event.tag === "Transaction" || ctx.event.tag === "Reducer";

export class Session {
  conn: DbConnection | null = null;
  identity: Identity | null = null;
  botId: bigint | null = null;
  current: bigint | null = null;
  ready = false;
  readonly clock = new ClockSync();
  readonly busy = new BusyTracker();
  readonly bidder: Bidder;
  readonly words: WordPlayer;
  private anchor: { handle: Handle; after: bigint } | null = null;
  /** after = null: the unfiltered fallback, never re-anchored. */
  private rack: { handle: Handle; after: bigint | null } | null = null;
  private roster: Roster | null = null;
  /** The match we were in when the connection dropped. */
  private disconnectedFrom: bigint | null = null;
  private reconnectAttempt = 0;
  private stopping = false;
  private timers: NodeJS.Timeout[] = [];
  private lastJoinAt = 0;
  private joining = false;
  private heldLogged = false;
  private stealthLogged = false;
  private lastTimingAt = 0;
  private startedAt = Date.now();
  private matchesEnded = 0;
  private claimed = false;
  /** RackForge backend telemetry (live runs; RACKFORGE_TELEMETRY=0 turns it off). */
  private telemetry: Telemetry | null = null;
  /** Registration attempts per tournament id (auto or TOURNAMENT_ID). */
  private reg = new Map<bigint, { attempts: number; nextAt: number; inFlight: boolean; done: boolean }>();
  /** No join_lobby before this (set when the server says we are held for a tournament). */
  private lobbyBackoffUntil = 0;
  /** Last auction open/close of the current match seen on the feed (feed watchdog). */
  private lastFeedAt = Date.now();
  private auctionMs = 1000;
  private stalls = 0;
  /** Seat subscriptions of final games, for the running series totals. */
  private finalSeats = new Map<bigint, Handle | null>();
  /** Dry run: auction records kept for the summary. */
  readonly auctions: Record<string, unknown>[] = [];
  readonly syncs: Record<string, unknown>[] = [];

  constructor(private readonly o: SessionOptions) {
    const log = (type: string, rec: Record<string, unknown>) => {
      if (type === "auction" && o.dryRun) this.auctions.push(rec);
      o.log.write(type, rec);
    };
    const human = (m: string) => o.log.human(m);
    this.bidder = new Bidder({
      agent: o.agent,
      clock: this.clock,
      busy: this.busy,
      transport: this.bidTransport(),
      myBotId: () => this.botId,
      view: (m) => this.viewFor(m),
      waitWordsIdle: (ms) => this.words.waitIdle(ms),
      log,
      human,
      opts: o.bidder,
    });
    this.words = new WordPlayer({
      agent: o.agent,
      transport: this.wordTransport(),
      view: (m) => this.viewFor(m),
      log,
      human,
      clock: this.clock,
      busy: this.busy,
    });
  }

  // ---------- transports: the only places reducers are called ----------

  private bidTransport(): BidTransport {
    if (this.o.dryRun) return { dry: true, submitBid: () => Promise.resolve() };
    return {
      dry: false,
      submitBid: (auctionId, amount) => {
        const c = this.conn;
        if (!c) return Promise.reject(new Error("not connected"));
        return c.reducers.submitBid({ auctionId, amount: BigInt(amount) });
      },
    };
  }

  private wordTransport(): WordTransport {
    if (this.o.dryRun) return { dry: true, submitWord: () => Promise.resolve() };
    return {
      dry: false,
      submitWord: (matchId, word) => {
        const c = this.conn;
        if (!c) return Promise.reject(new Error("not connected"));
        return c.reducers.submitWord({ matchId, word });
      },
    };
  }

  // ---------- connection ----------

  start() {
    this.startTelemetry();
    this.connect();
    this.timers.push(setInterval(() => this.guard("tick", () => this.tick()), 5000));
    if (this.o.stallMs !== 0) this.timers.push(setInterval(() => this.guard("watchdog", () => this.checkFeed()), 1000));
  }

  /** Mid-match silence past the limit: the stream has stalled; drop and resync. */
  private checkFeed() {
    const conn = this.conn;
    if (!conn || !this.ready || this.current === null || this.stopping) return;
    const now = Date.now();
    if (!feedStalled(now, this.lastFeedAt, this.auctionMs, this.o.stallMs)) return;
    this.stalls++;
    const silentMs = now - this.lastFeedAt;
    this.lastFeedAt = now;
    this.o.log.write("stall", { match: this.current, silentMs, limitMs: stallLimitMs(this.auctionMs, this.o.stallMs), stalls: this.stalls });
    this.o.log.warn(`no auction updates for ${Math.round(silentMs / 100) / 10} s in match ${this.current}: feed stalled, reconnecting`);
    try {
      conn.disconnect();
    } catch {
      /* closing anyway */
    }
    this.dropConnection(conn);
  }

  private startTelemetry() {
    // Dry runs stay out of RackForge's telemetry unless forced (tests point
    // RACKFORGE_STDB_DB at a throwaway database and set RACKFORGE_TELEMETRY=force).
    const env = process.env.RACKFORGE_TELEMETRY;
    if (env === "0" || (this.o.dryRun && env !== "force")) return;
    try {
      const t = new Telemetry({ onError: (m) => this.o.log.warn(m) });
      this.telemetry = t;
      this.o.log.setTap((type, rec) => t.record(type, rec));
      this.timers.push(setInterval(() => this.guard("heartbeat", () => this.heartbeat()), 10_000));
    } catch (e) {
      this.o.log.warn(`telemetry off: ${errMsg(e)}`);
    }
  }

  private heartbeat() {
    const c = this.clock.snapshot();
    this.telemetry?.heartbeat({
      state: this.stopping ? "stopping" : !this.ready ? "connecting" : this.current !== null ? "match" : "lobby",
      currentMatch: this.current ?? undefined,
      latencyMs: c.rttP50 ?? 0,
      clockOffsetMs: c.offsetMs ?? 0,
      version: `${this.o.agentLabel}${process.env.RACKFORGE_VERSION ? `@${process.env.RACKFORGE_VERSION}` : ""}`.slice(0, 64),
    });
  }

  private connect() {
    if (this.stopping) return;
    const t0 = Date.now();
    this.o.log.human(`connecting to ${this.o.db} at ${this.o.host}${this.o.dryRun ? " (dry run, anonymous)" : ""}`);
    let built: DbConnection | null = null;
    try {
      built = DbConnection.builder()
        .withUri(this.o.host)
        .withDatabaseName(this.o.db)
        .withToken(this.o.dryRun ? undefined : this.o.token)
        .withCompression("none")
        .onConnect((conn, identity, token) =>
          this.guard("onConnect", () => {
            if (conn !== this.conn) return;
            this.identity = identity;
            if (!this.o.dryRun && token && token !== this.o.token) {
              this.o.token = token;
              this.o.saveToken?.(token);
            }
            this.o.log.write("connect", { identity: identity.toHexString().slice(0, 16), connectMs: Date.now() - t0, dryRun: this.o.dryRun });
            this.o.log.human(`connected in ${Date.now() - t0} ms as ${identity.toHexString().slice(0, 12)}…`);
            this.wire(conn);
            this.sync(conn, identity, t0).catch((e) => this.onSyncError(conn, e));
          }),
        )
        .onConnectError((_ctx, err) =>
          this.guard("onConnectError", () => {
            this.o.log.write("disconnect", { phase: "connect", err: errMsg(err) });
            this.o.log.warn(`connect error: ${errMsg(err)}`);
            this.dropConnection(built);
          }),
        )
        .onDisconnect((_ctx, err) =>
          this.guard("onDisconnect", () => {
            this.o.log.write("disconnect", { phase: "session", err: err ? errMsg(err) : null });
            this.o.log.warn(`disconnected${err ? `: ${errMsg(err)}` : ""}`);
            this.dropConnection(built);
          }),
        )
        .build();
      this.conn = built;
    } catch (e) {
      this.o.log.warn(`connection build failed: ${errMsg(e)}`);
      this.scheduleReconnect();
    }
  }

  private dropConnection(conn: DbConnection | null) {
    if (conn !== this.conn) return;
    this.conn = null;
    this.ready = false;
    this.anchor = null;
    this.rack = null;
    this.roster = null;
    this.finalSeats.clear();
    for (const r of this.reg.values()) r.inFlight = false;
    // Re-derived after the resync; remembered so an end we missed still gets logged.
    if (this.current !== null) this.disconnectedFrom = this.current;
    this.current = null;
    this.bidder.flush("disconnect");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopping) return;
    // Mid-match every second offline is an auction lost: retry fast first.
    const base = Math.min(60_000, 250 * 2 ** this.reconnectAttempt);
    const delay = Math.round(base * (0.8 + 0.4 * Math.random()));
    this.reconnectAttempt++;
    this.o.log.human(`reconnecting in ${delay} ms (attempt ${this.reconnectAttempt})`);
    const t = setTimeout(() => this.guard("reconnect", () => this.connect()), delay);
    this.timers.push(t);
  }

  private onSyncError(conn: DbConnection, e: unknown) {
    if (e instanceof FatalError) {
      this.o.log.write("fatal", { err: e.message });
      this.o.log.warn(`FATAL: ${e.message}`);
      void this.stop(78);
      return;
    }
    this.o.log.write("error", { where: "sync", err: errMsg(e) });
    this.o.log.warn(`sync failed: ${errMsg(e)}; reconnecting`);
    if (conn === this.conn) {
      try {
        conn.disconnect();
      } catch {
        /* already closed */
      }
      this.dropConnection(conn);
    }
  }

  private subscribe(conn: DbConnection, queries: string[], label: string): Promise<{ handle: Handle; ms: number }> {
    assertAllowed(queries);
    const t0 = Date.now();
    return new Promise((res, rej) => {
      const handle = conn
        .subscriptionBuilder()
        .onApplied(() => res({ handle, ms: Date.now() - t0 }))
        .onError((ctx) => rej(new Error(`subscription '${label}' failed: ${ctx.event ? errMsg(ctx.event) : "unknown"}`)))
        .subscribe(queries);
    });
  }

  private async sync(conn: DbConnection, identity: Identity, t0: number) {
    const timing: Record<string, number> = { connectMs: Date.now() - t0 };
    const base = await this.subscribe(conn, baseQueries(this.o.dryRun ? null : identity.toHexString()), "base");
    timing.baseMs = base.ms;

    let botId: bigint | undefined;
    if (this.o.dryRun) botId = this.o.asBotId;
    else {
      botId = conn.db.botCredential.identity.find(identity)?.botId;
      if (botId === undefined) botId = await this.claim(conn, identity);
    }
    if (botId === undefined) throw new FatalError("no bot id to act as");
    this.botId = botId;
    const bot = conn.db.bot.id.find(botId);

    const [mine, history, tour] = await Promise.all([
      this.subscribe(conn, botQueries(botId), "bot"),
      this.subscribe(conn, [seatHistoryQuery(botId)], "seats"),
      // Not fatal: without it the bot still plays, registers via TOURNAMENT_ID and reads its own entries.
      this.subscribe(conn, tournamentQueries(), "tournaments").catch((e: unknown) => {
        this.o.log.write("error", { where: "tournament subscription", err: errMsg(e) });
        this.o.log.warn(`tournament tables unavailable (${errMsg(e)}): auto-registration and stage context off for this connection`);
        return null;
      }),
    ]);
    timing.tournamentMs = tour?.ms ?? -1;
    timing.botMs = mine.ms;
    timing.seatsMs = history.ms;
    const seatRows = [...conn.db.matchParticipant.mpByBot.filter(botId)].length;
    const after = anchorFor([...conn.db.matchParticipant.mpByBot.filter(botId)].map((p) => p.matchId));
    const [anchored, rack] = await Promise.all([
      this.subscribe(conn, anchoredQueries(botId, after), "anchor"),
      this.subscribeRack(conn, after),
    ]);
    timing.anchorMs = anchored.ms;
    this.anchor = { handle: anchored.handle, after };
    this.rack = rack;
    history.handle.unsubscribe();
    timing.totalMs = Date.now() - t0;

    const rows = {
      bot: Number(conn.db.bot.count()),
      tournament: Number(conn.db.tournament.count()),
      tournamentEntry: Number(conn.db.tournamentEntry.count()),
      tournamentMatch: Number(conn.db.tournamentMatch.count()),
      seatHistory: seatRows,
      participants: Number(conn.db.matchParticipant.count()),
      matchState: Number(conn.db.matchState.count()),
      auction: Number(conn.db.auction.count()),
      auctionResult: Number(conn.db.auctionResult.count()),
      wordPlay: Number(conn.db.wordPlay.count()),
      myRack: Number(conn.db.myRack.count()),
    };
    const rec = { bot: Number(botId), name: bot?.name ?? null, anchor: Number(after), ...timing, rows };
    this.syncs.push(rec);
    this.o.log.write("sync", rec);
    this.o.log.human(
      `synced in ${timing.totalMs} ms (connect ${timing.connectMs}, base ${timing.baseMs}, seats ${timing.seatsMs}, anchor ${timing.anchorMs}) ` +
        `as bot ${botId} '${bot?.name ?? "?"}', anchor m>${after}`,
    );

    if (conn !== this.conn) return;
    this.ready = true;
    this.reconnectAttempt = 0;
    this.lastFeedAt = Date.now();
    const missed = this.disconnectedFrom;
    this.refreshCurrent();
    if (missed !== null && missed !== this.current) this.onMatchOver(missed);
    this.disconnectedFrom = null;
    this.reconcile();
    this.registerTournaments();
    this.syncFinalSeats();
    void this.maybeJoinLobby("startup");
    void this.probe(conn);
    if (this.o.testDisconnectS && this.syncs.length === 1) {
      const t = setTimeout(() => {
        this.o.log.human(`test: dropping the connection (in match ${this.current ?? "-"})`);
        this.conn?.disconnect();
      }, this.o.testDisconnectS * 1000);
      this.timers.push(t);
    }
  }

  private async claim(conn: DbConnection, identity: Identity): Promise<bigint> {
    if (!this.o.nonce) throw new FatalError("this token has no bot credential: set BOT_TOKEN or BOT_NONCE and re-run");
    if (this.claimed) throw new FatalError("credential claim did not stick");
    this.claimed = true;
    this.o.log.human("claiming credential with nonce…");
    try {
      await conn.reducers.claimCredential({ code: this.o.nonce });
    } catch (e) {
      throw new FatalError(`claim_credential refused: ${errMsg(e)}`);
    }
    // The reducer's own update lands in the cache before its promise resolves.
    for (let i = 0; i < 30; i++) {
      const id = conn.db.botCredential.identity.find(identity)?.botId;
      if (id !== undefined) {
        this.o.log.write("claim", { ok: true, bot: Number(id) });
        this.o.log.human(`credential claimed for bot ${id}`);
        return id;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new FatalError("claimed, but no bot_credential row arrived");
  }

  private async subscribeRack(conn: DbConnection, after: bigint): Promise<{ handle: Handle; after: bigint | null }> {
    try {
      const r = await this.subscribe(conn, [rackQuery(after)], "rack");
      return { handle: r.handle, after };
    } catch (e) {
      this.o.log.write("error", { where: "rack subscription", err: errMsg(e), fallback: ALL_RACK });
      this.o.log.warn(`filtered my_rack refused (${errMsg(e)}); using the unfiltered view`);
      const r = await this.subscribe(conn, [ALL_RACK], "rack-all");
      return { handle: r.handle, after: null };
    }
  }

  /** Move the anchor past a finished match so the cache sheds it. */
  private async reanchor(after: bigint) {
    const conn = this.conn;
    const botId = this.botId;
    if (!conn || botId === null || !this.anchor || after <= this.anchor.after) return;
    const old = this.anchor;
    try {
      const next = await this.subscribe(conn, anchoredQueries(botId, after), "reanchor");
      if (conn !== this.conn) return;
      this.anchor = { handle: next.handle, after };
      old.handle.unsubscribe();
      const rack = this.rack;
      if (rack && rack.after !== null) {
        const nextRack = await this.subscribeRack(conn, after);
        if (conn !== this.conn) return;
        this.rack = nextRack;
        rack.handle.unsubscribe();
      }
      this.o.log.write("reanchor", { after: Number(after), ms: next.ms });
    } catch (e) {
      this.o.log.write("error", { where: "reanchor", err: errMsg(e) });
    }
  }

  /** Subscribe/unsubscribe a tiny query to sample RTT without any reducer. */
  private async probe(conn: DbConnection) {
    if (conn !== this.conn || !this.ready) return;
    try {
      const p0 = performance.now();
      const { handle } = await this.subscribe(conn, [PROBE_QUERY], "probe");
      const p1 = performance.now();
      if (!this.busy.overlaps(p0, p1)) this.clock.observeRtt(p1 - p0);
      handle.unsubscribe();
    } catch {
      /* best effort */
    }
  }

  // ---------- table events ----------

  private wire(conn: DbConnection) {
    const db = conn.db;
    db.auction.onInsert((ctx, a) =>
      this.guard("auction", () => {
        if (conn !== this.conn || !this.ready || !isLive(ctx)) return;
        const recv = Date.now();
        this.refreshCurrent();
        if (a.matchId === this.current) {
          this.lastFeedAt = recv;
          const len = tsMs(a.closesAt) - tsMs(a.opensAt);
          if (len > 0 && len < 600_000) this.auctionMs = len;
        }
        if (a.status.tag !== "Open" || a.matchId !== this.current) return;
        if (this.roster?.matchId === a.matchId && !this.roster.ready) {
          this.roster.queued.push({ a, recv, fresh: true });
          return;
        }
        this.bidder.onOpen(a, recv, true);
        this.words.schedule(a.matchId);
      }),
    );
    db.auctionResult.onInsert((ctx, r) =>
      this.guard("auction_result", () => {
        if (conn !== this.conn || !this.ready || !isLive(ctx)) return;
        this.bidder.onResult(r, Date.now(), true);
        if (r.matchId === this.current) {
          this.lastFeedAt = Date.now();
          this.words.schedule(r.matchId);
        }
      }),
    );
    db.wordPlay.onInsert((ctx, w) =>
      this.guard("word_play", () => {
        if (conn !== this.conn || !this.ready || !isLive(ctx)) return;
        if (w.matchId === this.current) this.words.schedule(w.matchId);
      }),
    );
    const onMatch = (ctx: EventContext) =>
      this.guard("match_state", () => {
        if (conn !== this.conn || !this.ready || !isLive(ctx)) return;
        this.refreshCurrent();
      });
    db.matchState.onInsert((ctx) => onMatch(ctx));
    db.matchState.onUpdate((ctx) => onMatch(ctx));
    db.matchParticipant.onInsert((ctx, p) =>
      this.guard("match_participant", () => {
        if (conn !== this.conn || !this.ready || !isLive(ctx)) return;
        if (p.botId === this.botId) this.refreshCurrent();
      }),
    );
    db.matchParticipant.onUpdate((ctx, _old, p) =>
      this.guard("match_participant", () => {
        if (conn !== this.conn || !this.ready || !isLive(ctx)) return;
        if (p.matchId === this.current) this.words.schedule(p.matchId);
      }),
    );
    const onRack = (ctx: EventContext, matchId: bigint) =>
      this.guard("my_rack", () => {
        if (conn !== this.conn || !this.ready || !isLive(ctx)) return;
        if (matchId === this.current) this.words.schedule(matchId);
      });
    db.myRack.onInsert((ctx, r) => onRack(ctx, r.matchId));
    db.myRack.onUpdate?.((ctx, _o, r) => onRack(ctx, r.matchId));
    db.myRack.onDelete((ctx, r) => onRack(ctx, r.matchId));
    // Every entrant's rows stream in (standings); only a tournament's own
    // change or one of OUR entries can change what we do.
    const onTour = (ctx: EventContext) =>
      this.guard("tournament", () => {
        if (conn !== this.conn || !this.ready || !isLive(ctx)) return;
        this.registerTournaments();
        this.syncFinalSeats();
        void this.maybeJoinLobby("tournament change");
      });
    db.tournament.onInsert((ctx) => onTour(ctx));
    db.tournament.onUpdate((ctx) => onTour(ctx));
    db.tournamentEntry.onInsert((ctx, e) => {
      if (e.botId === this.botId) onTour(ctx);
    });
    db.tournamentEntry.onUpdate((ctx, _o, e) => {
      if (e.botId === this.botId) onTour(ctx);
    });
    db.tournamentEntry.onDelete((ctx, e) => {
      if (e.botId === this.botId) onTour(ctx);
    });
    db.tournamentMatch.onInsert((ctx) =>
      this.guard("tournament_match", () => {
        if (conn !== this.conn || !this.ready || !isLive(ctx)) return;
        this.syncFinalSeats();
      }),
    );
  }

  // ---------- match tracking ----------

  viewFor(matchId: bigint): MatchView | null {
    const conn = this.conn;
    const me = this.botId;
    if (!conn || me === null) return null;
    if (this.roster?.matchId === matchId && !this.roster.ready) return null;
    const match = conn.db.matchState.id.find(matchId);
    if (!match) return null;
    const participants = [...conn.db.matchParticipant.mpByMatch.filter(matchId)];
    if (!participants.some((p) => p.botId === me)) return null;
    const view = buildMatchView(
      {
        match,
        participants,
        rack: conn.db.myRack.iter(),
        results: conn.db.auctionResult.resultByMatch.filter(matchId),
        words: conn.db.wordPlay.playByMatch.filter(matchId),
        isSim: (id) => conn.db.bot.id.find(id)?.isSimulated ?? false,
      },
      me,
      this.clock.serverNow(Date.now()),
    );
    const tournament = this.tournamentFor(conn, matchId, me);
    if (tournament) view.tournament = tournament;
    return view;
  }

  /** MatchView.tournament when `matchId` is a tournament match; never throws. */
  private tournamentFor(conn: DbConnection, matchId: bigint, me: bigint): MatchView["tournament"] {
    try {
      const tm = [...conn.db.tournamentMatch.tmByMatch.filter(matchId)];
      if (!tm.length) return undefined;
      const tid = tm[0]!.tournamentId;
      return tournamentContext(matchId, me, {
        tournaments: conn.db.tournament.iter(),
        entries: conn.db.tournamentEntry.teByTournament.filter(tid),
        matches: conn.db.tournamentMatch.tmByTournament.filter(tid),
        participants: conn.db.matchParticipant.iter(),
      });
    } catch (e) {
      this.o.log.write("error", { where: "tournamentContext", match: matchId, err: errMsg(e) });
      return undefined;
    }
  }

  private botName(id: number | bigint): string {
    return this.conn?.db.bot.id.find(BigInt(id))?.name ?? `#${id}`;
  }

  /** Which running match are we seated in? Fires start/end transitions. */
  private refreshCurrent() {
    const conn = this.conn;
    const me = this.botId;
    if (!conn || me === null) return;
    let running: bigint | null = null;
    for (const p of conn.db.matchParticipant.mpByBot.filter(me)) {
      const m = conn.db.matchState.id.find(p.matchId);
      if (m?.status.tag === "Running" && (running === null || p.matchId > running)) running = p.matchId;
    }
    if (running === this.current) return;
    const prev = this.current;
    this.current = running;
    if (prev !== null) this.onMatchOver(prev);
    if (running !== null) this.onMatchStart(running);
    else void this.maybeJoinLobby("idle");
  }

  /** After a (re)sync: bid on an auction that is already open, check words. */
  private reconcile() {
    const conn = this.conn;
    if (!conn || this.current === null) return;
    for (const a of conn.db.auction.auctionByMatch.filter(this.current)) {
      if (a.status.tag !== "Open") continue;
      if (this.roster?.matchId === a.matchId && !this.roster.ready) this.roster.queued.push({ a, recv: Date.now(), fresh: false });
      else this.bidder.onOpen(a, Date.now(), false);
    }
    this.words.schedule(this.current);
  }

  /** Seated: subscribe to the match's seats, then bid on whatever opened meanwhile. */
  private onMatchStart(matchId: bigint) {
    const conn = this.conn;
    if (!conn) return;
    const roster: Roster = { matchId, handle: null, ready: false, queued: [], resumed: this.disconnectedFrom === matchId };
    this.lastFeedAt = Date.now();
    this.roster = roster;
    const t0 = Date.now();
    const done = (handle: Handle | null, err?: unknown) =>
      this.guard("roster", () => {
        if (conn !== this.conn || this.roster !== roster) {
          handle?.unsubscribe();
          return;
        }
        roster.handle = handle;
        roster.ready = true;
        if (err) this.o.log.write("error", { where: "roster", match: matchId, err: errMsg(err) });
        this.logMatchStart(matchId, Date.now() - t0, roster.resumed);
        for (const q of roster.queued.splice(0)) {
          if (conn.db.auction.id.find(q.a.id)?.status.tag === "Open") this.bidder.onOpen(q.a, q.recv, q.fresh);
        }
        this.words.schedule(matchId);
      });
    this.subscribe(conn, [rosterQuery(matchId)], "roster").then(
      ({ handle }) => done(handle),
      (e) => done(null, e),
    );
  }

  private logMatchStart(matchId: bigint, rosterMs: number, resumed: boolean) {
    const view = this.viewFor(matchId);
    const seats = view?.participants.map((p) => ({ bot: p.botId, name: this.botName(p.botId), sim: p.isSim })) ?? [];
    this.o.log.write("match_start", {
      match: matchId,
      me: this.botId,
      auctionType: view?.auctionType,
      round: view?.round,
      bagTotal: view?.bagTotal,
      seats,
      agent: this.o.agentLabel,
      rosterMs,
      tournament: view?.tournament
        ? { phase: view.tournament.phase, round: view.tournament.round, entrants: view.tournament.standings.length, finalTotals: view.tournament.finalTotals }
        : undefined,
      resumed: resumed || undefined,
      dryRun: this.o.dryRun || undefined,
    });
    this.o.log.human(
      `${resumed ? "back in" : "seated in"} ${view?.tournament ? `TOURNAMENT ${view.tournament.phase} round ${view.tournament.round} ` : ""}` +
        `match ${matchId} (${view?.auctionType ?? "?"}, round ${view?.round ?? "?"}) vs ` +
        seats.filter((s) => BigInt(s.bot) !== this.botId).map((s) => `${s.name}${s.sim ? "*" : ""}`).join(", "),
    );
  }

  private onMatchOver(matchId: bigint) {
    // The final result shares a transaction with the end; its callback may not have run yet.
    const conn = this.conn;
    if (conn) {
      for (const rec of this.bidder.records.values()) {
        if (rec.matchId !== matchId || rec.result) continue;
        const r = conn.db.auctionResult.auctionId.find(rec.auctionId);
        if (r) this.bidder.onResult(r, Date.now(), false);
      }
    }
    this.bidder.flush("match end", matchId);
    const view = this.viewFor(matchId);
    if (view) {
      const st = standings(view.participants);
      const me = view.myBotId;
      const mine = st.find((s) => s.botId === me);
      let spent = 0;
      let won = 0;
      const myWords: string[] = [];
      let wordPoints = 0;
      for (const ev of view.history) {
        if (ev.kind === "auction" && ev.winnerBotId === me) {
          spent += ev.paid;
          won++;
        } else if (ev.kind === "word" && ev.botId === me) {
          myWords.push(ev.word);
          wordPoints += ev.reward;
        }
      }
      let unplayed = 0;
      for (const n of view.myRack) unplayed += n;
      const ended = this.conn?.db.matchState.id.find(matchId);
      this.o.log.write("match_end", {
        match: matchId,
        me,
        status: ended?.status.tag,
        place: mine?.place ?? null,
        seats: st.length,
        score: mine?.score ?? null,
        balance: mine?.balance ?? null,
        coinsSpent: spent,
        auctionsWon: won,
        auctions: view.history.filter((e) => e.kind === "auction").length,
        words: myWords,
        wordPoints,
        unplayedTiles: unplayed,
        unplayedRack: rackString(view.myRack),
        standings: st.map((s) => ({ ...s, name: this.botName(s.botId) })),
        clock: this.clock.snapshot(),
        agent: this.o.agentLabel,
        dryRun: this.o.dryRun || undefined,
      });
      this.o.log.human(
        `match ${matchId} over: place ${mine?.place ?? "?"}/${st.length}, score ${mine?.score ?? "?"}, ` +
          `spent ${spent} on ${won} tiles, words ${myWords.join(" ") || "-"}, ${unplayed} tiles unplayed | ` +
          st.map((s) => `${s.place}. ${this.botName(s.botId)} ${s.score}`).join(", "),
      );
      try {
        this.o.agent.onMatchEnd?.(view);
      } catch (e) {
        this.o.log.write("error", { where: "onMatchEnd", err: errMsg(e) });
      }
    } else {
      this.o.log.write("match_end", { match: matchId, me: this.botId, note: "rows gone before end was seen" });
    }
    this.words.forget(matchId);
    if (this.roster?.matchId === matchId) {
      this.roster.handle?.unsubscribe();
      this.roster = null;
    }
    this.matchesEnded++;
    void this.reanchor(matchId);
    if (this.o.maxMatches > 0 && this.matchesEnded >= this.o.maxMatches) {
      setTimeout(() => void this.stop(0), 300);
      return;
    }
  }

  // ---------- lobby, tournaments ----------

  private heldForTournament(): boolean {
    const conn = this.conn;
    if (!conn || this.botId === null) return false;
    return heldBy(conn.db.tournament.iter(), conn.db.tournamentEntry.teByBot.filter(this.botId), this.botId) !== null;
  }

  private async maybeJoinLobby(reason: string) {
    const conn = this.conn;
    if (this.o.dryRun || !conn || !this.ready || this.stopping || this.current !== null || this.joining) return;
    // Tournament-only mode (RACKFORGE_NO_LADDER): ladder matches publish our bids and words for rivals to model.
    // Tournament matches need no lobby: the server seats entrants directly.
    if (process.env.RACKFORGE_NO_LADDER === "1") {
      if (!this.stealthLogged) this.o.log.human("stealth: RACKFORGE_NO_LADDER=1, not joining the ladder (tournaments only)");
      this.stealthLogged = true;
      return;
    }
    if (this.heldForTournament()) {
      if (!this.heldLogged) this.o.log.human("RackForge is in a tournament under way: waiting to be seated, not joining the lobby");
      this.heldLogged = true;
      return;
    }
    const now = Date.now();
    // The server said we're held (our rows may lag): don't ask again every tick.
    if (now < this.lobbyBackoffUntil) return;
    this.heldLogged = false;
    if (reason === "watchdog" && now - this.lastJoinAt < this.o.rejoinMs) return;
    this.joining = true;
    this.lastJoinAt = now;
    const p0 = performance.now();
    try {
      await conn.reducers.joinLobby({});
      this.o.log.write("lobby", { action: "join", reason, ok: true, ackMs: Math.round(performance.now() - p0) });
      if (reason !== "watchdog") this.o.log.human(`in the lobby (${reason})`);
    } catch (e) {
      const err = errMsg(e);
      this.o.log.write("lobby", { action: "join", reason, ok: false, err });
      if (isTournamentHold(err)) {
        this.lobbyBackoffUntil = Date.now() + LOBBY_REFUSED_BACKOFF_MS;
        this.o.log.human(`join_lobby refused (tournament under way): waiting to be seated; next try in ${LOBBY_REFUSED_BACKOFF_MS / 1000} s`);
      } else this.o.log.human(`join_lobby refused: ${err}`);
      if (/running match/i.test(err)) this.refreshCurrent();
    } finally {
      this.joining = false;
    }
  }

  /**
   * Register for TOURNAMENT_ID and (auto mode) every tournament taking
   * registrations that RackForge is not entered in. One call at a time per
   * tournament, retried with backoff while refused; never unregisters.
   */
  private registerTournaments() {
    const conn = this.conn;
    const me = this.botId;
    if (this.o.dryRun || this.stopping || !conn || !this.ready || me === null) return;
    const want = new Set<bigint>();
    if (this.o.tournamentId !== undefined) want.add(this.o.tournamentId);
    if (this.o.autoTournament !== false) for (const id of toRegister(conn.db.tournament.iter(), conn.db.tournamentEntry.iter(), me)) want.add(id);
    const now = Date.now();
    for (const id of want) {
      const t = conn.db.tournament.id.find(id);
      const entered = [...conn.db.tournamentEntry.teByBot.filter(me)].some((e) => e.tournamentId === id);
      let st = this.reg.get(id);
      if (entered) {
        if (st && !st.done) {
          st.done = true;
          this.o.log.human(`RackForge is entered in tournament ${id} (${t?.status.tag ?? "?"})`);
        }
        continue;
      }
      // Explicit TOURNAMENT_ID: try even if the row is missing (it may lag); auto: Registration only.
      if (t && t.status.tag !== "Registration") continue;
      if (!t && id !== this.o.tournamentId) continue;
      if (!st) {
        st = { attempts: 0, nextAt: 0, inFlight: false, done: false };
        this.reg.set(id, st);
        this.o.log.human(`!! TOURNAMENT ${id} is open for registration: registering RackForge`);
      }
      if (st.inFlight || st.done || now < st.nextAt) continue;
      void this.registerTournament(conn, id, st);
    }
  }

  private async registerTournament(conn: DbConnection, id: bigint, st: { attempts: number; nextAt: number; inFlight: boolean; done: boolean }) {
    st.inFlight = true;
    st.attempts++;
    try {
      await conn.reducers.registerForTournament({ tournamentId: id });
      st.done = true;
      this.o.log.write("tournament", { action: "register", tournament: id, ok: true, attempt: st.attempts, auto: id !== this.o.tournamentId });
      this.o.log.human(`!! REGISTERED RackForge for tournament ${id} (attempt ${st.attempts})`);
    } catch (e) {
      const wait = registerBackoffMs(st.attempts);
      st.nextAt = Date.now() + wait;
      this.o.log.write("tournament", { action: "register", tournament: id, ok: false, attempt: st.attempts, err: errMsg(e), retryMs: wait });
      this.o.log.warn(`tournament ${id} registration refused (attempt ${st.attempts}): ${errMsg(e)}; retry in ${Math.round(wait / 1000)} s`);
    } finally {
      st.inFlight = false;
    }
  }

  /** Subscribe to the seats of our tournaments' final games (running series totals). */
  private syncFinalSeats() {
    const conn = this.conn;
    const me = this.botId;
    if (!conn || !this.ready || me === null) return;
    // Only tournaments in their final: older ones' games are history.
    const inFinal = [...conn.db.tournamentEntry.teByBot.filter(me)].filter((e) => conn.db.tournament.id.find(e.tournamentId)?.status.tag === "Final");
    for (const matchId of finalMatchIds(conn.db.tournamentMatch.iter(), inFinal, me)) {
      if (this.finalSeats.has(matchId)) continue;
      this.finalSeats.set(matchId, null);
      this.subscribe(conn, [rosterQuery(matchId)], "final seats").then(
        ({ handle }) => {
          if (conn !== this.conn) handle.unsubscribe();
          else this.finalSeats.set(matchId, handle);
        },
        (e) => {
          this.o.log.write("error", { where: "final seats", match: matchId, err: errMsg(e) });
          if (conn === this.conn) this.finalSeats.delete(matchId);
        },
      );
    }
  }

  // ---------- housekeeping ----------

  private tick() {
    const now = Date.now();
    this.registerTournaments();
    void this.maybeJoinLobby("watchdog");
    if (this.conn && this.ready && now - this.lastTimingAt >= this.o.probeMs) {
      this.lastTimingAt = now;
      void this.probe(this.conn).then(() => this.o.log.write("timing", { ...this.clock.snapshot(), current: this.current }));
    }
    if (this.o.dryRun && this.o.idleExitMs && this.matchesEnded === 0 && this.current === null && now - this.startedAt > this.o.idleExitMs) {
      this.o.log.warn(`dry run: no match to follow after ${Math.round(this.o.idleExitMs / 1000)} s`);
      void this.stop(2);
    }
  }

  /** Never let one bad callback take the process down. */
  private guard(where: string, fn: () => void) {
    try {
      fn();
    } catch (e) {
      this.o.log.write("error", { where, err: errMsg(e), stack: e instanceof Error ? e.stack?.split("\n").slice(0, 4).join(" | ") : undefined });
      this.o.log.warn(`${where}: ${errMsg(e)}`);
    }
  }

  async stop(code = 0) {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.bidder.flush("shutdown");
    const summary = this.summary();
    this.o.log.write("stop", { code, ...summary });
    this.o.onFinish?.(summary);
    try {
      this.conn?.disconnect();
    } catch {
      /* closing anyway */
    }
    this.conn = null;
    await this.o.log.close();
    await this.telemetry?.close();
    process.exit(code);
  }

  summary(): Record<string, unknown> {
    return {
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      matchesEnded: this.matchesEnded,
      clock: this.clock.snapshot(),
      syncs: this.syncs,
      ...(this.o.dryRun ? { dryRun: dryRunStats(this.auctions) } : {}),
    };
  }

  /** For tests and the dry-run report. */
  get anchorAfter(): bigint | null {
    return this.anchor?.after ?? null;
  }
}

export class FatalError extends Error {}

function pct(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]!;
}

/** What a dry run measured, per auction record. */
export function dryRunStats(recs: Record<string, unknown>[]) {
  const num = (k: string) => recs.map((r) => r[k]).filter((x): x is number => typeof x === "number");
  const sends = recs.flatMap((r) => (r.sends as Array<{ stage: string; slackMs: number }>) ?? []);
  const slack = (stage: string) => sends.filter((s) => s.stage === stage).map((s) => s.slackMs);
  return {
    auctions: recs.length,
    fresh: recs.filter((r) => r.fresh).length,
    withResult: recs.filter((r) => r.result).length,
    recvLagMs: { p10: pct(num("recvLagMs"), 0.1), p50: pct(num("recvLagMs"), 0.5), p90: pct(num("recvLagMs"), 0.9), max: pct(num("recvLagMs"), 1) },
    quickMs: { p50: pct(num("quickMs"), 0.5), p99: pct(num("quickMs"), 0.99), max: pct(num("quickMs"), 1) },
    refineMs: { n: num("refineMs").length, p50: pct(num("refineMs"), 0.5), p99: pct(num("refineMs"), 0.99), max: pct(num("refineMs"), 1) },
    budgetMs: { p10: pct(num("budgetMs"), 0.1), p50: pct(num("budgetMs"), 0.5), min: pct(num("budgetMs"), 0) },
    quickSlackMs: { min: pct(slack("quick"), 0), p50: pct(slack("quick"), 0.5) },
    refineSlackMs: { n: slack("refine").length, min: pct(slack("refine"), 0), p50: pct(slack("refine"), 0.5) },
    wouldMiss: sends.filter((s) => s.slackMs < 0).length,
    tickDelayMs: {
      p50: pct(recs.map((r) => (r.result as { tickDelayMs?: number } | null)?.tickDelayMs).filter((x): x is number => typeof x === "number"), 0.5),
    },
    refineSkips: recs.map((r) => r.refineSkip).filter(Boolean),
  };
}
