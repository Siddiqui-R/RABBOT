// Clock offset, latency and the bid-deadline arithmetic.
//
// The server checks `ctx.timestamp < auction.closes_at` when our bid
// reducer starts, so a bid counts only if it ARRIVES before closes_at in
// server time. We see two kinds of samples:
//   lag = localReceipt - serverTimestamp  (= offset + server work + downlink)
//   rtt = reducer ack time - send time
// offset is local minus server. We estimate it as a low percentile of lag
// minus half the RTT. Server work makes that an overestimate, so deadlines
// use min(offset, 0): never assume the local clock is ahead, since that
// would push our idea of the deadline later.

export interface ClockOptions {
  /** One-way latency assumed before any RTT sample (ms). */
  defaultOneWayMs: number;
  /** Samples kept for the percentile estimates. */
  window: number;
}

const DEFAULTS: ClockOptions = { defaultOneWayMs: 45, window: 64 };

function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i]!;
}

export class ClockSync {
  readonly opts: ClockOptions;
  private lags: number[] = [];
  private rtts: number[] = [];
  private lagEwma: number | null = null;
  lagCount = 0;
  rttCount = 0;

  constructor(opts: Partial<ClockOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  private push(buf: number[], x: number) {
    buf.push(x);
    if (buf.length > this.opts.window) buf.shift();
  }

  /** A server-stamped row (auction opens_at, result closed_at) just arrived. */
  observeLag(serverMs: number, localMs: number) {
    const lag = localMs - serverMs;
    if (!Number.isFinite(lag) || Math.abs(lag) > 60_000) return;
    this.push(this.lags, lag);
    this.lagEwma = this.lagEwma === null ? lag : this.lagEwma + 0.1 * (lag - this.lagEwma);
    this.lagCount++;
  }

  observeRtt(ms: number) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 30_000) return;
    this.push(this.rtts, ms);
    this.rttCount++;
  }

  get rttP50(): number {
    return percentile(this.rtts, 0.5);
  }

  /** Expected one-way (uplink) latency for a bid. */
  get oneWayMs(): number {
    return this.rtts.length > 0 ? this.rttP50 / 2 : this.opts.defaultOneWayMs;
  }

  /** Robust low lag: 10th percentile, so one slow frame doesn't move it. */
  get lagLowMs(): number {
    return percentile(this.lags, 0.1);
  }

  /** Measured local - server offset (ms); 0 until there is a lag sample. */
  get offsetMs(): number {
    if (this.lags.length === 0) return 0;
    const down = this.rtts.length > 0 ? percentile(this.rtts, 0.1) / 2 : this.opts.defaultOneWayMs;
    return this.lagLowMs - down;
  }

  /** The offset deadlines use: never later than the measured one, never > 0. */
  get deadlineOffsetMs(): number {
    return Math.min(this.offsetMs, 0);
  }

  /** Server time now, as best we know it (conservatively late). */
  serverNow(localMs: number): number {
    return localMs - this.deadlineOffsetMs;
  }

  snapshot() {
    const r = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
    return {
      offsetMs: r(this.offsetMs),
      deadlineOffsetMs: r(this.deadlineOffsetMs),
      oneWayMs: r(this.oneWayMs),
      rttP50: r(this.rttP50),
      rttP90: r(percentile(this.rtts, 0.9)),
      lagLowMs: r(this.lagLowMs),
      lagP50: r(percentile(this.lags, 0.5)),
      lagEwma: this.lagEwma === null ? null : r(this.lagEwma),
      lagSamples: this.lagCount,
      rttSamples: this.rttCount,
    };
  }
}

/**
 * Remembers when synchronous agent code blocked the event loop. A reducer
 * ack that arrives while refineBid is thinking is only read afterwards, so
 * an RTT sample spanning a busy stretch measures our thinking, not the
 * network, and is dropped.
 */
export class BusyTracker {
  private spans: Array<[number, number]> = [];

  mark(fromMs: number, toMs: number) {
    if (toMs - fromMs < 2) return;
    this.spans.push([fromMs, toMs]);
    if (this.spans.length > 32) this.spans.shift();
  }

  overlaps(fromMs: number, toMs: number): boolean {
    return this.spans.some(([a, b]) => a < toMs && b > fromMs);
  }
}

export interface BudgetInput {
  closesAtServerMs: number;
  nowLocalMs: number;
  /** local - server; use ClockSync.deadlineOffsetMs. */
  offsetMs: number;
  oneWayMs: number;
  safetyMarginMs: number;
}

/** Local time by which a bid must leave to arrive before the close. */
export function sendDeadlineLocal(closesAtServerMs: number, offsetMs: number, oneWayMs: number): number {
  return closesAtServerMs + offsetMs - oneWayMs;
}

/**
 * Thinking time left for refineBid: time until the bid must be sent, minus
 * the safety margin. Negative means don't refine.
 */
export function refineBudgetMs(b: BudgetInput): number {
  return sendDeadlineLocal(b.closesAtServerMs, b.offsetMs, b.oneWayMs) - b.nowLocalMs - b.safetyMarginMs;
}

/**
 * Whatever an agent returns, the server only accepts an integer in
 * [0, balance]. NaN, Infinity, negatives and junk become 0; fractions are
 * floored; anything above the balance is capped.
 */
export function sanitizeBid(raw: unknown, balance: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(raw), Math.floor(balance)));
}
