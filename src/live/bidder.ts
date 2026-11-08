// Two-stage bidding. On auction open: quickBid, sent at once. Then, if the
// agent has refineBid, think for whatever time is left before the bid must
// leave, and send the refined bid only if it differs. The server keeps only
// the latest accepted bid, so a refused or late refinement leaves the quick
// bid standing: the worst a slow refine can do is waste a call.

import type { Agent, AuctionView, MatchView } from "../core/types.js";
import {
  BusyTracker,
  ClockSync,
  refineBudgetMs,
  sanitizeBid,
  sendDeadlineLocal,
} from "./clock.js";
import { errMsg } from "./log.js";
import { tsMs, type AuctionResultRow, type AuctionRow } from "./rows.js";
import { auctionViewOf, viewSummary } from "./view.js";

export interface BidTransport {
  /** True when nothing is really sent (dry run): acks carry no timing. */
  readonly dry: boolean;
  submitBid(auctionId: bigint, amount: number): Promise<void>;
}

export interface BidderOptions {
  /** Kept free between the end of thinking and the send deadline. */
  safetyMarginMs: number;
  /** Below this budget refineBid isn't called at all. */
  minRefineMs: number;
  /** Cap on the budget handed to refineBid. */
  maxRefineMs: number;
  /** How long refinement may wait for in-flight word acks (fresher balance). */
  wordWaitMs: number;
  /** Write an auction's record this long after its result even if acks are missing. */
  flushAfterMs: number;
}

export const DEFAULT_BIDDER_OPTIONS: BidderOptions = {
  safetyMarginMs: 250,
  minRefineMs: 15,
  maxRefineMs: 800,
  wordWaitMs: 150,
  flushAfterMs: 2500,
};

export interface BidderDeps {
  agent: Agent;
  clock: ClockSync;
  busy: BusyTracker;
  transport: BidTransport;
  myBotId: () => bigint | null;
  /** Fresh view of a match, null if we aren't seated in it. */
  view: (matchId: bigint) => MatchView | null;
  /** Resolves when in-flight word submissions are acked, or after maxMs. */
  waitWordsIdle?: (maxMs: number) => Promise<void>;
  log: (type: string, rec: Record<string, unknown>) => void;
  human: (msg: string) => void;
  opts: BidderOptions;
  now?: () => number;
  perf?: () => number;
}

interface SendRec {
  stage: "quick" | "refine";
  amount: number;
  sentAt: number;
  /** Local ms left before the send deadline when it went out (negative = late). */
  slackMs: number;
  ackMs?: number;
  ok?: boolean;
  err?: string;
}

export interface AuctionRecord {
  auctionId: bigint;
  matchId: bigint;
  letter: string;
  av: AuctionView;
  recvAt: number;
  recvLagMs: number | null;
  fresh: boolean;
  /** Clock estimates when the auction arrived (deadline offset, uplink). */
  offsetMs: number;
  oneWayMs: number;
  summary: ReturnType<typeof viewSummary>;
  balance: number;
  quick: number;
  quickRaw?: unknown;
  quickMs: number;
  refined?: number | null;
  refineRaw?: unknown;
  refineMs?: number;
  budgetMs?: number;
  refineSkip?: string;
  sends: SendRec[];
  lastSent: number;
  pendingAcks: number;
  refining: boolean;
  result?: { winner: number | null; paid: number; won: boolean; tickDelayMs: number };
  written: boolean;
  errors: string[];
}

export class Bidder {
  readonly records = new Map<bigint, AuctionRecord>();
  private readonly now: () => number;
  private readonly perf: () => number;

  constructor(private readonly d: BidderDeps) {
    this.now = d.now ?? Date.now;
    this.perf = d.perf ?? (() => performance.now());
  }

  /** An auction is open (fresh = we just received it, not a resync). */
  onOpen(a: AuctionRow, recvAt: number, fresh: boolean): AuctionRecord | null {
    if (this.records.has(a.id)) return null;
    const av = auctionViewOf(a);
    if (fresh) this.d.clock.observeLag(av.opensAtMs, recvAt);
    // Found on a resync after it already closed by our clock: nothing to do.
    if (!fresh && this.now() >= av.closesAtMs + this.d.clock.offsetMs) return null;
    const view = this.d.view(a.matchId);
    const me = view?.participants.find((p) => p.botId === view.myBotId);
    if (!view || !me) return null;
    view.nowMs = this.d.clock.serverNow(this.now());

    const rec: AuctionRecord = {
      auctionId: a.id,
      matchId: a.matchId,
      letter: a.letter,
      av,
      recvAt,
      recvLagMs: fresh ? Math.round((recvAt - av.opensAtMs) * 10) / 10 : null,
      fresh,
      offsetMs: round1(this.d.clock.deadlineOffsetMs),
      oneWayMs: round1(this.d.clock.oneWayMs),
      summary: viewSummary(view),
      balance: me.balance,
      quick: 0,
      quickMs: 0,
      sends: [],
      lastSent: 0,
      pendingAcks: 0,
      refining: false,
      written: false,
      errors: [],
    };
    this.records.set(a.id, rec);

    let raw: unknown = 0;
    const t0 = this.perf();
    try {
      raw = this.d.agent.quickBid(view, av);
    } catch (e) {
      rec.errors.push(`quickBid: ${errMsg(e)}`);
    }
    const t1 = this.perf();
    this.d.busy.mark(t0, t1);
    rec.quickMs = round1(t1 - t0);
    rec.quick = sanitizeBid(raw, me.balance);
    if (raw !== rec.quick) rec.quickRaw = typeof raw === "number" ? raw : String(raw);
    if (rec.quick > 0) this.send(rec, "quick", rec.quick);

    if (this.d.agent.refineBid) {
      rec.refining = true;
      // A macrotask, so the quick bid and any words reach the socket before
      // refineBid blocks the loop.
      setTimeout(() => {
        this.refine(rec)
          .catch((e) => rec.errors.push(`refine: ${errMsg(e)}`))
          .finally(() => {
            rec.refining = false;
            this.maybeWrite(rec);
          });
      }, 0);
    }
    return rec;
  }

  private budgetNow(rec: AuctionRecord): number {
    const c = this.d.clock;
    return refineBudgetMs({
      closesAtServerMs: rec.av.closesAtMs,
      nowLocalMs: this.now(),
      offsetMs: c.deadlineOffsetMs,
      oneWayMs: c.oneWayMs,
      safetyMarginMs: this.d.opts.safetyMarginMs,
    });
  }

  private async refine(rec: AuctionRecord): Promise<void> {
    const { opts, agent } = this.d;
    if (!agent.refineBid) return;
    if (this.d.waitWordsIdle) {
      const pre = this.budgetNow(rec);
      if (pre > opts.minRefineMs * 2) await this.d.waitWordsIdle(Math.min(opts.wordWaitMs, pre / 2));
    }
    if (rec.result) {
      rec.refineSkip = "closed";
      return;
    }
    const budget = Math.min(opts.maxRefineMs, this.budgetNow(rec));
    rec.budgetMs = round1(budget);
    if (budget < opts.minRefineMs) {
      rec.refineSkip = "budget";
      return;
    }
    const view = this.d.view(rec.matchId);
    const me = view?.participants.find((p) => p.botId === view.myBotId);
    if (!view || !me) {
      rec.refineSkip = "unseated";
      return;
    }
    view.nowMs = this.d.clock.serverNow(this.now());

    let raw: unknown = null;
    const t0 = this.perf();
    try {
      raw = agent.refineBid(view, rec.av, budget);
    } catch (e) {
      rec.errors.push(`refineBid: ${errMsg(e)}`);
      raw = null;
    }
    const t1 = this.perf();
    this.d.busy.mark(t0, t1);
    rec.refineMs = round1(t1 - t0);
    if (raw === null || raw === undefined) {
      rec.refined = null;
      return;
    }
    const amount = sanitizeBid(raw, me.balance);
    if (raw !== amount) rec.refineRaw = typeof raw === "number" ? raw : String(raw);
    rec.refined = amount;
    if (amount === rec.lastSent) return;
    // Past our best estimate of the close it can only be refused.
    const closeLocal = rec.av.closesAtMs + this.d.clock.offsetMs;
    if (this.now() >= closeLocal) {
      rec.refineSkip = "late";
      return;
    }
    this.send(rec, "refine", amount);
  }

  private send(rec: AuctionRecord, stage: "quick" | "refine", amount: number) {
    const c = this.d.clock;
    const sentAt = this.now();
    const s: SendRec = {
      stage,
      amount,
      sentAt,
      slackMs: round1(sendDeadlineLocal(rec.av.closesAtMs, c.deadlineOffsetMs, c.oneWayMs) - sentAt),
    };
    rec.sends.push(s);
    rec.lastSent = amount;
    rec.pendingAcks++;
    const p0 = this.perf();
    let p: Promise<void>;
    try {
      p = this.d.transport.submitBid(rec.auctionId, amount);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      () => {
        s.ok = true;
      },
      (e) => {
        s.ok = false;
        s.err = errMsg(e);
      },
    ).finally(() => {
      const p1 = this.perf();
      s.ackMs = round1(p1 - p0);
      // A refusal is still a server round trip; a disconnect isn't.
      const answered = s.ok || (s.err !== undefined && !/connect/i.test(s.err));
      if (!this.d.transport.dry && answered && !this.d.busy.overlaps(p0, p1)) c.observeRtt(p1 - p0);
      rec.pendingAcks--;
      this.maybeWrite(rec);
    });
  }

  onResult(r: AuctionResultRow, recvAt: number, fresh: boolean) {
    const closedAt = tsMs(r.closedAt);
    if (fresh) this.d.clock.observeLag(closedAt, recvAt);
    const rec = this.records.get(r.auctionId);
    if (!rec || rec.result) return;
    const me = this.d.myBotId();
    const winner = r.winnerBotId === undefined ? null : Number(r.winnerBotId);
    rec.result = {
      winner,
      paid: Number(r.paid),
      won: me !== null && r.winnerBotId === me,
      tickDelayMs: round1(closedAt - rec.av.closesAtMs),
    };
    this.maybeWrite(rec);
    setTimeout(() => this.write(rec), this.d.opts.flushAfterMs).unref?.();
  }

  private maybeWrite(rec: AuctionRecord) {
    if (rec.result && rec.pendingAcks === 0 && !rec.refining) this.write(rec);
  }

  /** The standing bid: the last one the server accepted (dry run: the last sent). */
  static standing(rec: AuctionRecord, dry: boolean): number {
    for (let i = rec.sends.length - 1; i >= 0; i--) {
      const s = rec.sends[i]!;
      if (dry || s.ok) return s.amount;
    }
    return 0;
  }

  private write(rec: AuctionRecord, note?: string) {
    if (rec.written) return;
    rec.written = true;
    const dry = this.d.transport.dry;
    const misses = rec.sends.filter((s) => (s.err ? /expired|closed/i.test(s.err) : dry && s.slackMs < 0)).length;
    this.d.log("auction", {
      match: rec.matchId,
      auction: rec.auctionId,
      letter: rec.letter,
      view: rec.summary,
      opensAt: rec.av.opensAtMs,
      closesAt: rec.av.closesAtMs,
      recvAt: rec.recvAt,
      recvLagMs: rec.recvLagMs,
      fresh: rec.fresh,
      offsetMs: rec.offsetMs,
      oneWayMs: rec.oneWayMs,
      quick: rec.quick,
      quickRaw: rec.quickRaw,
      quickMs: rec.quickMs,
      refined: rec.refined,
      refineRaw: rec.refineRaw,
      refineMs: rec.refineMs,
      budgetMs: rec.budgetMs,
      refineSkip: rec.refineSkip,
      sends: rec.sends,
      standing: Bidder.standing(rec, dry),
      misses,
      result: rec.result ?? null,
      errors: rec.errors.length ? rec.errors : undefined,
      note,
      dryRun: dry || undefined,
    });
    const r = rec.result;
    const refine =
      rec.refined === undefined
        ? rec.refineSkip
          ? ` refine:${rec.refineSkip}`
          : ""
        : ` -> ${rec.refined ?? "keep"} (${rec.refineMs}ms/${rec.budgetMs})`;
    const outcome = !r ? (note ?? "no result") : r.won ? `WON @${r.paid}` : r.winner === null ? "no bids" : `lost to ${r.winner} @${r.paid}`;
    const refused = rec.sends.filter((s) => s.ok === false).map((s) => `${s.stage}:${s.err}`);
    this.d.human(
      `m${rec.matchId} r${rec.summary.round} '${rec.letter}' bal ${rec.balance} quick ${rec.quick} (${rec.quickMs}ms)${refine} | ${outcome}` +
        (refused.length ? ` | REFUSED ${refused.join("; ")}` : "") +
        (rec.errors.length ? ` | ERR ${rec.errors.join("; ")}` : ""),
    );
  }

  /** Write out every record of a match (or all), e.g. at match end or disconnect. */
  flush(note: string, matchId?: bigint) {
    for (const rec of this.records.values()) {
      if (matchId !== undefined && rec.matchId !== matchId) continue;
      this.write(rec, note);
    }
    for (const [id, rec] of this.records) {
      if (rec.written && (matchId === undefined || rec.matchId === matchId)) this.records.delete(id);
    }
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
