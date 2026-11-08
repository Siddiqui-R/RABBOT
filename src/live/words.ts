// Word submission. The agent is asked after every rack or match-state
// change; what it returns is checked (A-Z, 2+ letters, spellable in order
// from the rack) and sent in order without waiting for acks. A word is
// never sent twice from the same rack state, so a refused word isn't
// retried until the rack changes, and a check that comes in while words are
// in flight waits for their acks (the rack it would see is stale).

import { canSpell, countsOf, wordReward, type Counts } from "../core/rules.js";
import type { Agent, MatchView } from "../core/types.js";
import type { BusyTracker, ClockSync } from "./clock.js";
import { errMsg } from "./log.js";
import { rackString } from "./view.js";

export interface WordTransport {
  readonly dry: boolean;
  submitWord(matchId: bigint, word: string): Promise<void>;
}

export interface WordDeps {
  agent: Agent;
  transport: WordTransport;
  view: (matchId: bigint) => MatchView | null;
  log: (type: string, rec: Record<string, unknown>) => void;
  human: (msg: string) => void;
  clock?: ClockSync;
  busy?: BusyTracker;
  now?: () => number;
  perf?: () => number;
}

export type Checked = { word: string; rackBefore: string } | { invalid: string; why: string };

/** Validate an agent's word list against the rack, in order. */
export function checkWords(words: unknown, rack: Counts): Checked[] {
  if (!Array.isArray(words)) return [];
  const left = [...rack];
  const out: Checked[] = [];
  for (const w of words) {
    if (typeof w !== "string") {
      out.push({ invalid: String(w), why: "not a string" });
      continue;
    }
    const word = w.trim().toUpperCase();
    if (!/^[A-Z]{2,}$/.test(word)) {
      out.push({ invalid: word, why: "not 2+ letters A-Z" });
      continue;
    }
    if (!canSpell(word, left)) {
      out.push({ invalid: word, why: `not spellable from ${rackString(left)}` });
      continue;
    }
    out.push({ word, rackBefore: rackString(left) });
    const need = countsOf(word);
    for (let i = 0; i < 26; i++) left[i]! -= need[i]!;
  }
  return out;
}

export class WordPlayer {
  private inFlight = 0;
  private pending: bigint | null = null;
  private scheduled: bigint | null = null;
  private idleWaiters: Array<() => void> = [];
  /** `${matchId}|${rackBefore}|${word}` already sent. */
  private sent = new Set<string>();
  private readonly now: () => number;
  private readonly perf: () => number;

  constructor(private readonly d: WordDeps) {
    this.now = d.now ?? Date.now;
    this.perf = d.perf ?? (() => performance.now());
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  /** Coalesce: many row callbacks in one transaction -> one check. */
  schedule(matchId: bigint) {
    if (this.scheduled === matchId) return;
    this.scheduled = matchId;
    setImmediate(() => {
      this.scheduled = null;
      this.check(matchId);
    });
  }

  check(matchId: bigint) {
    if (this.inFlight > 0) {
      this.pending = matchId;
      return;
    }
    const view = this.d.view(matchId);
    if (!view) return;
    let tiles = 0;
    for (const n of view.myRack) tiles += n;
    if (tiles < 2) return;

    let words: unknown = [];
    const t0 = this.perf();
    try {
      words = this.d.agent.chooseWords(view);
    } catch (e) {
      this.d.log("error", { where: "chooseWords", match: matchId, err: errMsg(e) });
      return;
    } finally {
      this.d.busy?.mark(t0, this.perf());
    }
    const thinkMs = Math.round((this.perf() - t0) * 10) / 10;
    for (const c of checkWords(words, view.myRack)) {
      if ("invalid" in c) {
        this.d.log("word", { match: matchId, word: c.invalid, invalid: c.why, rack: rackString(view.myRack) });
        continue;
      }
      const key = `${matchId}|${c.rackBefore}|${c.word}`;
      if (this.sent.has(key)) continue;
      this.sent.add(key);
      this.submit(matchId, c.word, c.rackBefore, thinkMs, view.round);
    }
  }

  private submit(matchId: bigint, word: string, rackBefore: string, thinkMs: number, round: number) {
    this.inFlight++;
    const sentAt = this.now();
    const p0 = this.perf();
    let p: Promise<void>;
    try {
      p = this.d.transport.submitWord(matchId, word);
    } catch (e) {
      p = Promise.reject(e);
    }
    // An ack that never comes must not block every later word.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((_res, rej) => {
      timer = setTimeout(() => rej(new Error("no ack within 5 s")), 5000);
    });
    Promise.race([p, timeout]).finally(() => clearTimeout(timer)).then(
      () => ({ ok: true as const, err: undefined }),
      (e) => ({ ok: false as const, err: errMsg(e) }),
    ).then(({ ok, err }) => {
      const p1 = this.perf();
      const ackMs = Math.round((p1 - p0) * 10) / 10;
      if (!this.d.transport.dry && (ok || !/connect/i.test(err ?? "")) && !this.d.busy?.overlaps(p0, p1)) {
        this.d.clock?.observeRtt(p1 - p0);
      }
      const reward = ok ? wordReward(word) : 0;
      this.d.log("word", { match: matchId, round, rackBefore, word, reward, thinkMs, sentAt, ackMs, ok, err, dryRun: this.d.transport.dry || undefined });
      this.d.human(`m${matchId} word ${word} from ${rackBefore}: ${ok ? `+${reward}` : `REFUSED ${err}`} (${ackMs}ms)`);
      this.settle();
    });
  }

  private settle() {
    this.inFlight--;
    if (this.inFlight > 0) return;
    for (const w of this.idleWaiters.splice(0)) w();
    if (this.pending !== null) {
      const m = this.pending;
      this.pending = null;
      this.schedule(m);
    }
  }

  /** Resolves once nothing is in flight, or after maxMs. */
  waitIdle(maxMs: number): Promise<void> {
    if (this.inFlight === 0 || maxMs <= 0) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, maxMs);
      this.idleWaiters.push(() => {
        clearTimeout(t);
        res();
      });
    });
  }

  /** Forget a finished match's dedup keys. */
  forget(matchId: bigint) {
    const prefix = `${matchId}|`;
    for (const k of this.sent) if (k.startsWith(prefix)) this.sent.delete(k);
    if (this.pending === matchId) this.pending = null;
  }
}
