// Live bot telemetry into RABBOT's backend: every decision-log record goes to
// rabbot_event (lossless, via createEventSink), and the records the monitor
// needs are also projected into typed tables: `auction` -> rabbot_decision,
// `word` -> rabbot_word, `match_end` -> rabbot_match, plus a rabbot_status heartbeat.
//
// Fire-and-forget by construction: `record()` is synchronous, O(1) and never
// throws; the typed writes only go out when the sink already has a
// connection (no connect on the bid path), are capped in flight, and their
// failures are swallowed (counted). The JSONL file stays the local record.
// Never put a token in a record.

import { Timestamp } from "spacetimedb";
import {
  createEventSink,
  type Backend,
  type DecisionLog,
  type EventSink,
  type EventSinkOptions,
  type Heartbeat,
  type RABBOTMatch,
  type WordLog,
} from "./client.js";

type Rec = Record<string, unknown>;

const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const id = (v: unknown): bigint | undefined => {
  const x = typeof v === "bigint" ? Number(v) : n(v);
  return x !== undefined && Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : undefined;
};
const i64 = (v: unknown): bigint => BigInt(Math.trunc(n(v) ?? 0));
const u32 = (v: unknown): number => Math.max(0, Math.trunc(n(v) ?? 0));

/** `auction` record -> rabbot_decision row (undefined when it has no ids). */
export function decisionFrom(r: Rec): DecisionLog | undefined {
  const auctionId = id(r.auction);
  const matchId = id(r.match);
  if (auctionId === undefined || matchId === undefined) return undefined;
  const view = (r.view ?? {}) as Rec;
  const sends = Array.isArray(r.sends) ? (r.sends as Rec[]) : [];
  const okSends = sends.filter((s) => s.ok !== false);
  const last = okSends.at(-1);
  const slacks = sends.map((s) => n(s.slackMs)).filter((x): x is number => x !== undefined);
  const res = (r.result ?? undefined) as Rec | undefined;
  const reason = typeof r.reason === "string" ? r.reason : sends.length === 0 ? "no-bid" : String(last?.stage ?? "sent");
  return {
    auctionId,
    matchId,
    round: u32(view.round),
    letter: String(r.letter ?? "?").slice(0, 1) || "?",
    balance: i64(view.balance),
    quickBid: i64(r.quick),
    quickMs: n(r.quickMs) ?? 0,
    refinedBid: n(r.refined) === undefined ? undefined : i64(r.refined),
    refineMs: n(r.refineMs),
    budgetMs: n(r.budgetMs) ?? 0,
    sentBid: i64(last?.amount ?? 0),
    minSlackMs: slacks.length ? Math.min(...slacks) : 0,
    misses: u32(r.misses),
    refused: sends.length - okSends.length,
    valueEstimate: n(r.value),
    won: typeof res?.won === "boolean" ? res.won : undefined,
    paid: res && n(res.paid) !== undefined && res.won ? i64(res.paid) : undefined,
    winnerBotId: res ? id(res.winner) : undefined,
    reason: reason.slice(0, 64),
  };
}

/** `word` record -> rabbot_word row. */
export function wordFrom(r: Rec): WordLog | undefined {
  const matchId = id(r.match);
  if (matchId === undefined || typeof r.word !== "string") return undefined;
  return {
    matchId,
    round: u32(r.round),
    word: r.word.slice(0, 64),
    reward: i64(r.reward),
    rackBefore: String(r.rackBefore ?? "").slice(0, 64),
    thinkMs: n(r.thinkMs) ?? 0,
    ackMs: n(r.ackMs),
    ok: r.ok !== false,
    err: r.err === undefined || r.err === null ? undefined : String(r.err).slice(0, 500),
  };
}

/** `match_end` record -> rabbot_match row. */
export function matchFrom(r: Rec, startedUs?: number): RABBOTMatch | undefined {
  const matchId = id(r.match);
  if (matchId === undefined || r.status === undefined) return undefined;
  const standings = Array.isArray(r.standings) ? (r.standings as Rec[]) : [];
  const winner = standings.find((s) => s.place === 1);
  const words = Array.isArray(r.words) ? (r.words as unknown[]).map(String) : [];
  return {
    matchId,
    place: n(r.place) === undefined ? undefined : u32(r.place),
    seats: u32(r.seats),
    score: n(r.score) === undefined ? undefined : i64(r.score),
    balance: n(r.balance) === undefined ? undefined : i64(r.balance),
    coinsSpent: i64(r.coinsSpent),
    auctionsWon: u32(r.auctionsWon),
    auctions: u32(r.auctions),
    words: words.join(" ").slice(0, 2000),
    wordPoints: i64(r.wordPoints),
    unplayedTiles: u32(r.unplayedTiles),
    winnerScore: winner && n(winner.score) !== undefined ? i64(winner.score) : undefined,
    ratingAfter: undefined,
    agent: String(r.agent ?? "").slice(0, 64),
    startedAt: startedUs === undefined ? undefined : new Timestamp(BigInt(Math.trunc(startedUs))),
    endedAt: Timestamp.now(),
  };
}

export interface TelemetryOptions extends EventSinkOptions {
  /** Typed writes allowed in flight before new ones are dropped. */
  maxInFlight?: number;
}

export class Telemetry {
  readonly sink: EventSink;
  private inFlight = 0;
  private readonly maxInFlight: number;
  private matchStartUs = new Map<string, number>();
  readonly counts = { typed: 0, typedDropped: 0, typedFailed: 0 };
  private lastErr = 0;

  constructor(private readonly o: TelemetryOptions = {}) {
    this.sink = createEventSink(o);
    this.maxInFlight = o.maxInFlight ?? 64;
  }

  private warn(msg: string): void {
    // Rate-limited: a down backend must not flood the bot's log.
    if (Date.now() - this.lastErr < 30_000) return;
    this.lastErr = Date.now();
    try {
      this.o.onError?.(msg);
    } catch {
      /* never */
    }
  }

  private send(what: string, call: (b: Backend) => Promise<void>): void {
    const b = this.sink.backend();
    if (!b || this.inFlight >= this.maxInFlight) {
      this.counts.typedDropped++;
      return;
    }
    this.inFlight++;
    let p: Promise<void>;
    try {
      p = call(b);
    } catch (e) {
      this.inFlight--;
      this.counts.typedFailed++;
      this.warn(`telemetry ${what}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    p.then(
      () => {
        this.inFlight--;
        this.counts.typed++;
      },
      (e) => {
        this.inFlight--;
        this.counts.typedFailed++;
        this.warn(`telemetry ${what}: ${e instanceof Error ? e.message : e}`);
      },
    );
  }

  /** One decision-log record. Synchronous; never throws. */
  record(type: string, rec: Rec): void {
    try {
      this.sink.push(type, rec);
      if (type === "auction") {
        const d = decisionFrom(rec);
        if (d) this.send("decision", (b) => b.logDecision(d));
      } else if (type === "word") {
        const w = wordFrom(rec);
        if (w) this.send("word", (b) => b.logWord(w));
      } else if (type === "match_start") {
        if (rec.match !== undefined) this.matchStartUs.set(String(rec.match), Date.now() * 1000);
      } else if (type === "match_end") {
        const key = String(rec.match);
        const m = matchFrom(rec, this.matchStartUs.get(key));
        this.matchStartUs.delete(key);
        if (m) this.send("match", (b) => b.logMatch(m));
      }
    } catch (e) {
      this.warn(`telemetry record: ${e instanceof Error ? e.message : e}`);
    }
  }

  heartbeat(h: Heartbeat): void {
    try {
      this.send("heartbeat", (b) => b.heartbeat(h));
    } catch {
      /* never */
    }
  }

  stats(): Record<string, number> {
    return { ...this.sink.stats(), ...this.counts, inFlight: this.inFlight };
  }

  /** Flushes the event queue (best effort, bounded) and disconnects. */
  async close(timeoutMs = 3_000): Promise<void> {
    await Promise.race([this.sink.close().catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}

/** What `attachTelemetry` needs from the bot's DecisionLog. */
export interface TappableLog {
  setTap(tap: ((type: string, rec: Rec) => void) | null): void;
  warn(msg: string): void;
}

export interface TelemetryHandle {
  telemetry: Telemetry | null;
  /** Untaps the log, stops the heartbeat, flushes (bounded) and disconnects. Never throws. */
  close(timeoutMs?: number): Promise<void>;
}

/**
 * The one-call hook for a live bot: taps `log` so every record also goes to
 * the rabbot backend, and sends `status()` as a heartbeat every `heartbeatMs`.
 * Never throws and never blocks; with RABBOT_TELEMETRY=0, or when the sink can't
 * be built, it returns a no-op handle and the bot runs on its JSONL log alone.
 *
 *   const tel = attachTelemetry(log, () => ({ state, currentMatch, latencyMs, clockOffsetMs, version }));
 *   ...on stop: await tel.close();
 */
export function attachTelemetry(
  log: TappableLog,
  status?: () => Heartbeat,
  o: TelemetryOptions & { heartbeatMs?: number } = {},
): TelemetryHandle {
  const noop: TelemetryHandle = { telemetry: null, close: async () => {} };
  if (process.env.RABBOT_TELEMETRY === "0") return noop;
  let t: Telemetry;
  try {
    t = new Telemetry({ ...o, onError: o.onError ?? ((m) => log.warn(m)) });
    log.setTap((type, rec) => t.record(type, rec));
  } catch (e) {
    try {
      log.warn(`telemetry off: ${e instanceof Error ? e.message : e}`);
    } catch {
      /* never */
    }
    return noop;
  }
  const timer = status
    ? setInterval(() => {
        try {
          t.heartbeat(status());
        } catch {
          /* never */
        }
      }, o.heartbeatMs ?? 10_000)
    : undefined;
  timer?.unref?.();
  return {
    telemetry: t,
    close: async (timeoutMs = 3_000) => {
      if (timer) clearInterval(timer);
      try {
        log.setTap(null);
      } catch {
        /* never */
      }
      await t.close(timeoutMs).catch(() => {});
    },
  };
}
