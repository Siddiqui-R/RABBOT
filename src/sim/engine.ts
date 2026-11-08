// A faithful offline copy of one ScrabbleBot match: startMatchWith,
// drawLetter, simulateBids/decideBid, submitBid/replaceBid, closeAuction,
// simulateWordPlay and submitWord/playWord from the server's game.ts and
// index.ts, with the same checks in the same order. Numbers instead of
// bigints (every value stays far below 2^53).
//
// Timing model for non-sim agents (runMatch). Each round:
//   1. The auction opens. In the same step the server draws the letter and
//      the sims bid (simulateBids runs inside the transaction that opens
//      the auction), so sim bids are always in before anyone else's.
//   2. Every agent, in a fresh random order, gets chooseWords(view) and its
//      words are submitted in order. Each goes through submitWord's checks;
//      a refused word is logged and changes nothing, like a failed reducer.
//   3. Every agent (same order) gets quickBid; if it has refineBid, that
//      runs next with `budgetMs` and a non-null result replaces the quick
//      bid, as a second submit_bid does on the server.
//   4. The auction closes: the winner pays, gets the tile, and a winning sim
//      plays findBestPlayable(rack, 3) inside the close. Then the next
//      auction opens (back to 1), or the bag is empty and the match ends.
//
// Why this is the live game: a live bot's state only changes at a close
// (it gains a tile) or when it plays a word. The close, the sim's word, the
// next letter and the sims' bids all land in one transaction, so a live bot
// first hears of a new auction together with everything that happened at
// the close. Playing words at the start of a round is as early as the live
// bot can play them, and the bid then sees the rewarded balance, as it does
// live when the bot sends its words before its bid (assuming the server
// runs one connection's calls in the order sent). Nothing public changes
// between the plays and the close except other bots' words, and bids are
// sealed, so the order of the bids inside a round doesn't matter. The
// random agent order stands in for network jitter between bots. After the
// last close the match is over: submitWord refuses everything, so a tile
// won in the last auction is dead for live bots, while a sim still plays it
// inside the close.
//
// Randomness (rng option). "server", the default, replays the live
// server's ctx.random exactly (ServerRandom in rng.ts): one generator per
// transaction (the start, then every close), seeded from that transaction's
// timestamp, drawn in the server's order (lobby padding shuffle, deal, first
// letter, sim jitter; then per close: tie shuffle, next letter, sim jitter).
// The SDK's seeding is flawed, so these draws are NOT uniform, and live
// letter frequencies show the same skew. "streams" is the idealised game
// with independent fair streams per purpose: the letter sequence then never
// depends on bids, which gives tighter paired (--swap) comparisons but a
// letter distribution the live game doesn't have.
//
// Not modelled: a bid that misses the window (refused live; agents are
// trusted to meet their deadline), a second chooseWords within a round in
// reaction to another bot's word (one call per round), and the server's
// pending_bid row order (the tie shuffle walks bids in submission order,
// a replaced bid moving to the back; live it is the index's row order).

import {
  AUCTION_DURATION_MS,
  AUCTION_RESERVE,
  DEFAULT_BAG,
  LETTERS,
  SIM_BID_JITTER,
  STARTING_BALANCE,
  STARTING_RACK_SIZE,
  emptyCounts,
  letterValue,
  totalTiles,
  wordReward,
  type Counts,
} from "../core/rules.js";
import type {
  Agent,
  AuctionType,
  AuctionView,
  MatchView,
  PublicEvent,
  TournamentView,
} from "../core/types.js";
import {
  asciiUppercase,
  bestPlayable,
  byteLength,
  countsToMap,
  findBestPlayable,
  isAsciiUppercase,
  isValidWord,
} from "./dictionary.js";
import { Rng, ServerRandom, serverStartUs } from "./rng.js";

export type SimStrategy = "Cheapskate" | "ValueBidder" | "Aggressive";
export const SIM_STRATEGIES: readonly SimStrategy[] = ["Cheapskate", "ValueBidder", "Aggressive"];

export type Result<T = void> = { ok: T } | { err: string };

/** "server": the live server's flawed per-transaction ctx.random. "streams": fair independent streams. */
export type RngMode = "server" | "streams";

/** How long after an auction opens an agent's view says it is (virtual clock). */
export const VIEW_LAG_MS = 50;
/** Virtual epoch for match clocks, so timestamps look like real ones. */
const EPOCH_MS = 1_790_000_000_000;

// Server's decideBid: clamp(base + jitter, 1, balance), never below 0.
export function decideBid(
  strategy: SimStrategy | "Human",
  letter: string,
  balance: number,
  jitter: number,
): number {
  const c = [...letter][0] ?? "A";
  const value = letterValue(c);
  const isVowel = "AEIOU".includes(c);
  let base: number;
  switch (strategy) {
    case "Human":
      return 0;
    case "Cheapskate":
      base = value - 1;
      break;
    case "ValueBidder":
      base = value;
      break;
    case "Aggressive":
      base = value + (isVowel ? 4 : 2);
      break;
  }
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

export interface EngineSeat {
  botId: number;
  isSim: boolean;
  /** Required for sims. */
  strategy?: SimStrategy;
}

export interface EngineOptions {
  seats: EngineSeat[];
  /** Deal seed. Bag, ties and each seat's jitter draw from their own stream of it. */
  seed: number;
  matchId?: number;
  auctionType?: AuctionType;
  startingRackSize?: number;
  auctionDurationMs?: number;
  /** Use the literal 172k-word scan for sim plays instead of the index (tests). */
  literalSimWords?: boolean;
  /** Keep every sealed bid of every auction in `bidLog` (never shown to agents). */
  recordBids?: boolean;
  /** Default "server". */
  rng?: RngMode;
  /** Server mode: ctx.timestamp (µs) of the start transaction. Default serverStartUs(seed). */
  startUs?: number;
  /**
   * Server mode: how many sims the lobby timeout shuffled in the start
   * transaction before dealing (resolveLobby shuffles every available sim).
   * 0 for a lobby that filled with real bots.
   */
  lobbyShuffle?: number;
  /** Tournament context shown to every agent's view (MatchView.tournament); absent = ladder. */
  tournament?: TournamentView;
}

export interface Participant {
  position: number;
  botId: number;
  isSim: boolean;
  strategy?: SimStrategy;
  balance: number;
  score: number;
  rack: Counts;
  wordsPlayed: number;
  bidRejections: number;
  wordRejections: number;
}

export interface Rejection {
  round: number;
  botId: number;
  kind: "bid" | "word";
  input: string;
  err: string;
}

export interface BidLogEntry {
  auctionId: number;
  round: number;
  letter: string;
  /** [botId, amount] in submission order, zero bids included. */
  bids: [number, number][];
  winnerBotId: number | null;
  paid: number;
}

export type MatchStatus = "Pending" | "Running" | "Ended";

export class Engine {
  readonly matchId: number;
  readonly auctionType: AuctionType;
  readonly startingRackSize: number;
  readonly auctionDurationMs: number;
  /** MatchView.tournament for every view, if this is a tournament match. */
  readonly tournament: TournamentView | undefined;
  readonly participants: Participant[];
  readonly bag: Counts = DEFAULT_BAG.slice();
  bagTotal: number;
  status: MatchStatus = "Pending";
  /** match_state.current_round */
  round = 0;
  auction: AuctionView | undefined;
  /** Sealed bids on the open auction, botId -> amount, in submission order. */
  readonly pending = new Map<number, number>();
  /** Public record, as live bots see it. */
  readonly history: PublicEvent[] = [];
  /** Spectator-only top bid per closed auction (the post-match archive). */
  readonly topBids: { auctionId: number; topBid: number }[] = [];
  readonly bidLog: BidLogEntry[] = [];
  readonly rejections: Rejection[] = [];
  clockMs: number;

  private readonly byBot = new Map<number, Participant>();
  readonly rngMode: RngMode;
  private readonly bagRng: Rng;
  private readonly tieRng: Rng;
  private readonly jitterRng: Rng[];
  /** Server mode: ctx.random of the transaction being run. */
  private tx: ServerRandom | undefined;
  /** Server mode: ctx.timestamp (µs) of the latest transaction (start or close). */
  lastTxUs: number | undefined;
  private readonly startUs: number;
  private readonly lobbyShuffle: number;
  private readonly delayRng: Rng;
  private readonly literalSimWords: boolean;
  private readonly recordBids: boolean;
  private nextAuctionId: number;

  constructor(opts: EngineOptions) {
    this.matchId = opts.matchId ?? 1;
    this.auctionType = opts.auctionType ?? "Vickrey";
    this.startingRackSize = opts.startingRackSize ?? STARTING_RACK_SIZE;
    this.auctionDurationMs = opts.auctionDurationMs ?? AUCTION_DURATION_MS;
    this.literalSimWords = opts.literalSimWords ?? false;
    this.recordBids = opts.recordBids ?? false;
    this.tournament = opts.tournament;
    this.bagTotal = totalTiles(this.bag);
    this.bagRng = new Rng(opts.seed, "bag");
    this.tieRng = new Rng(opts.seed, "ties");
    this.jitterRng = opts.seats.map((_, i) => new Rng(opts.seed, "jitter", i));
    this.rngMode = opts.rng ?? "server";
    this.startUs = opts.startUs ?? serverStartUs(opts.seed);
    this.lobbyShuffle = opts.lobbyShuffle ?? 0;
    this.delayRng = new Rng(opts.seed, "txdelay");
    this.clockMs = EPOCH_MS + this.matchId * 1_000_000;
    this.nextAuctionId = this.matchId * 1000 + 1;
    this.participants = opts.seats.map((s, position) => {
      if (s.isSim && !s.strategy) throw new Error(`sim seat ${position} has no strategy`);
      if (this.byBot.has(s.botId)) throw new Error(`bot ${s.botId} seated twice`);
      const p: Participant = {
        position,
        botId: s.botId,
        isSim: s.isSim,
        strategy: s.strategy,
        balance: STARTING_BALANCE,
        score: 0,
        rack: emptyCounts(),
        wordsPlayed: 0,
        bidRejections: 0,
        wordRejections: 0,
      };
      this.byBot.set(s.botId, p);
      return p;
    });
  }

  participant(botId: number): Participant | undefined {
    return this.byBot.get(botId);
  }

  // ---------- startMatchWith ----------

  start(): Result {
    if (this.status !== "Pending") return { err: "Match already started" };
    if (this.participants.length === 0) return { err: "Need at least one participant" };
    if (this.rngMode === "server") {
      this.lastTxUs = this.startUs;
      this.tx = new ServerRandom(this.startUs);
      // resolveLobby's shuffle of the sim pool runs in the same transaction.
      if (this.lobbyShuffle > 1) this.tx.shuffle(new Array<number>(this.lobbyShuffle).fill(0));
    }
    // Racks are dealt in roster order, one participant at a time.
    for (const p of this.participants) {
      for (let n = 0; n < this.startingRackSize; n++) {
        const letter = this.drawLetter();
        if (letter === undefined) break;
        p.rack[letter]!++;
      }
    }
    const first = this.drawLetter();
    if (first === undefined) return { err: "Bag empty" };
    this.status = "Running";
    this.round = 1;
    this.openAuction(first);
    return { ok: undefined };
  }

  // Index into a, b, ..., z of the letters still in the bag, exactly like
  // the server walks its alphabetically sorted bag rows.
  drawLetter(): number | undefined {
    if (this.bagTotal === 0) return undefined;
    let i = this.tx ? this.tx.int(0, this.bagTotal - 1) : this.bagRng.int(0, this.bagTotal - 1);
    for (let slot = 0; slot < 26; slot++) {
      const remaining = this.bag[slot]!;
      if (remaining <= 0) continue;
      if (i < remaining) {
        this.bag[slot] = remaining - 1;
        this.bagTotal--;
        return slot;
      }
      i -= remaining;
    }
    return undefined;
  }

  private openAuction(slot: number): void {
    const opensAtMs = this.clockMs;
    this.auction = {
      auctionId: this.nextAuctionId++,
      letter: LETTERS[slot]!,
      opensAtMs,
      closesAtMs: opensAtMs + this.auctionDurationMs,
    };
    this.simulateBids();
  }

  // ---------- simulateBids ----------

  private simulateBids(): void {
    const auction = this.auction!;
    for (const p of this.participants) {
      if (!p.isSim) continue;
      const jitter = (this.tx ?? this.jitterRng[p.position]!).int(-SIM_BID_JITTER, SIM_BID_JITTER);
      const amount = decideBid(p.strategy!, auction.letter, p.balance, jitter);
      if (amount <= 0) continue;
      this.replaceBid(p.botId, amount);
    }
  }

  // Latest bid wins: delete then re-insert, so it also moves to the back.
  private replaceBid(botId: number, amount: number): void {
    this.pending.delete(botId);
    this.pending.set(botId, amount);
  }

  // ---------- submit_bid ----------

  submitBid(botId: number, amount: number): Result {
    const r = this.checkBid(botId, amount);
    if ("err" in r) {
      const p = this.byBot.get(botId);
      if (p) p.bidRejections++;
      this.rejections.push({ round: this.round, botId, kind: "bid", input: String(amount), err: r.err });
    }
    return r;
  }

  private checkBid(botId: number, amount: number): Result {
    // The client must turn the bid into an i64; a fraction or NaN never
    // reaches the server, so count it as refused.
    if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
      return { err: "Bid must be an integer" };
    }
    if (amount < 0) return { err: "Bid must be non-negative" };
    if (!this.auction || this.status !== "Running") return { err: "Auction closed" };
    const p = this.byBot.get(botId);
    if (!p) return { err: "Not in this match" };
    if (p.balance < amount) return { err: "Insufficient balance" };
    this.replaceBid(botId, amount);
    return { ok: undefined };
  }

  // ---------- submit_word ----------

  submitWord(botId: number, word: string): Result<number> {
    const r = this.checkWord(botId, word);
    if ("err" in r) {
      const p = this.byBot.get(botId);
      if (p) p.wordRejections++;
      this.rejections.push({ round: this.round, botId, kind: "word", input: String(word), err: r.err });
    }
    return r;
  }

  private checkWord(botId: number, word: string): Result<number> {
    if (this.status !== "Running") return { err: "Match not running" };
    const p = this.byBot.get(botId);
    if (!p) return { err: "Not in this match" };
    if (typeof word !== "string") return { err: "Word must be a string" };
    const wordUpper = asciiUppercase(word);
    if (byteLength(wordUpper) < 2) return { err: "Word must be at least 2 letters" };
    if (!isAsciiUppercase(wordUpper)) return { err: "Word must be A-Z only" };
    if (!isValidWord(wordUpper)) return { err: `'${wordUpper}' is not in the dictionary` };
    return this.playWord(p, wordUpper);
  }

  // Server's playWord: all-or-nothing tile check, then reward to both
  // balance and score.
  private playWord(p: Participant, wordUpper: string): Result<number> {
    const needed = emptyCounts();
    for (let i = 0; i < wordUpper.length; i++) needed[wordUpper.charCodeAt(i) - 65]!++;
    for (let i = 0; i < 26; i++) {
      if (needed[i]! > p.rack[i]!) {
        return { err: `Not enough '${LETTERS[i]}': need ${needed[i]}, have ${p.rack[i]}` };
      }
    }
    for (let i = 0; i < 26; i++) p.rack[i]! -= needed[i]!;
    const reward = wordReward(wordUpper);
    p.balance += reward;
    p.score += reward;
    p.wordsPlayed++;
    this.history.push({ kind: "word", botId: p.botId, word: wordUpper, reward });
    return { ok: reward };
  }

  // ---------- closeAuction ----------

  /** Closes the open auction. Returns true when this ended the match. */
  closeAuction(): boolean {
    if (this.status !== "Running" || !this.auction) return false;
    const auction = this.auction;
    if (this.rngMode === "server") {
      // auctionTick runs at closes_at plus scheduler lag; the exact µs only
      // matters through PCG, which scrambles it.
      const lagUs = this.delayRng.int(0, 20_000);
      this.lastTxUs = this.startUs + this.round * this.auctionDurationMs * 1000 + lagUs;
      this.tx = new ServerRandom(this.lastTxUs);
    }

    const bids = [...this.pending].map(([botId, amount]) => ({ botId, amount }));
    const sorted = bids.filter((b) => b.amount > 0);
    // Shuffle, then stable-sort by amount: equal bids land in random order.
    (this.tx ?? this.tieRng).shuffle(sorted);
    sorted.sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));

    let winner: number | undefined;
    let topBid = 0;
    let paid = 0;
    const [first, second] = sorted;
    if (first) {
      winner = first.botId;
      topBid = first.amount;
      if (this.auctionType === "FirstPrice") {
        paid = first.amount;
      } else {
        paid = second ? second.amount : Math.min(AUCTION_RESERVE, first.amount);
      }
    }

    let simWinner: Participant | undefined;
    if (winner !== undefined) {
      const p = this.byBot.get(winner);
      if (p && p.balance >= paid) {
        p.balance -= paid;
        p.rack[auction.letter.charCodeAt(0) - 65]!++;
        if (p.isSim) simWinner = p;
      }
    }

    this.history.push({
      kind: "auction",
      auctionId: auction.auctionId,
      letter: auction.letter,
      winnerBotId: winner ?? null,
      paid,
    });
    this.topBids.push({ auctionId: auction.auctionId, topBid });
    if (this.recordBids) {
      this.bidLog.push({
        auctionId: auction.auctionId,
        round: this.round,
        letter: auction.letter,
        bids: bids.map((b) => [b.botId, b.amount]),
        winnerBotId: winner ?? null,
        paid,
      });
    }
    this.pending.clear();
    this.clockMs = auction.closesAtMs;

    if (simWinner) this.simulateWordPlay(simWinner);

    const next = this.drawLetter();
    if (next === undefined) {
      this.status = "Ended";
      this.auction = undefined;
      return true;
    }
    this.round++;
    this.openAuction(next);
    return false;
  }

  // A sim plays at most one word, right after winning, inside the close.
  private simulateWordPlay(p: Participant): void {
    const word = this.literalSimWords
      ? findBestPlayable(countsToMap(p.rack), 3)
      : bestPlayable(p.rack, 3);
    if (word === undefined) return;
    this.playWord(p, word);
  }

  // ---------- views ----------

  /** What a live bot `botId` can see right now; nothing hidden leaks. */
  viewFor(botId: number): MatchView {
    const me = this.byBot.get(botId);
    return {
      matchId: this.matchId,
      myBotId: botId,
      auctionType: this.auctionType,
      round: this.round,
      bagTotal: this.bagTotal,
      startingRackSize: this.startingRackSize,
      participants: this.participants.map((p) => ({
        botId: p.botId,
        balance: p.balance,
        score: p.score,
        isSim: p.isSim,
      })),
      myRack: me ? me.rack.slice() : emptyCounts(),
      history: this.history.slice(),
      nowMs: (this.auction?.opensAtMs ?? this.clockMs) + VIEW_LAG_MS,
      ...(this.tournament ? { tournament: structuredClone(this.tournament) } : {}),
    };
  }

  auctionView(): AuctionView | undefined {
    return this.auction ? { ...this.auction } : undefined;
  }
}

// ---------- match driver ----------

export interface MatchSeat extends EngineSeat {
  /** Non-sim seats without an agent sit idle (a connected bot that never acts). */
  agent?: Agent;
}

export interface MatchOptions extends EngineOptions {
  seats: MatchSeat[];
  /** Passed to refineBid. Default: what a live bot has left of a 1 s auction. */
  budgetMs?: number;
  /** Rethrow agent exceptions instead of counting them. */
  strict?: boolean;
}

export interface SeatOutcome {
  position: number;
  botId: number;
  isSim: boolean;
  score: number;
  balance: number;
  tilesLeft: number;
  wordsPlayed: number;
  bidRejections: number;
  wordRejections: number;
  agentErrors: number;
  firstError?: string;
}

export interface MatchOutcome {
  matchId: number;
  rounds: number;
  seats: SeatOutcome[];
  engine: Engine;
}

/** Live budget for refineBid: 1000 ms window, ~90 ms RTT, 150 ms margin, slack. */
export const DEFAULT_REFINE_BUDGET_MS = 700;

export function runMatch(opts: MatchOptions): MatchOutcome {
  const engine = new Engine(opts);
  const budgetMs = opts.budgetMs ?? DEFAULT_REFINE_BUDGET_MS;
  const orderRng = new Rng(opts.seed, "order");
  const errors = opts.seats.map(() => ({ count: 0, first: undefined as string | undefined }));

  const guard = <T>(position: number, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      if (opts.strict) throw e;
      const slot = errors[position]!;
      slot.count++;
      slot.first ??= e instanceof Error ? (e.stack ?? e.message) : String(e);
      return undefined;
    }
  };

  const started = engine.start();
  if ("err" in started) throw new Error(`match ${engine.matchId} failed to start: ${started.err}`);

  const actors = opts.seats
    .map((s, position) => ({ position, botId: s.botId, agent: s.isSim ? undefined : s.agent }))
    .filter((a): a is { position: number; botId: number; agent: Agent } => a.agent !== undefined);

  while (engine.status === "Running") {
    const order = actors.slice();
    orderRng.shuffle(order);

    for (const a of order) {
      const words = guard(a.position, () => a.agent.chooseWords(engine.viewFor(a.botId)));
      if (words === undefined) continue;
      if (!Array.isArray(words)) {
        guard(a.position, () => {
          throw new Error(`chooseWords returned ${typeof words}, not an array`);
        });
        continue;
      }
      for (const w of words) engine.submitWord(a.botId, w);
    }

    for (const a of order) {
      const auction = engine.auctionView()!;
      const quick = guard(a.position, () => a.agent.quickBid(engine.viewFor(a.botId), auction));
      // 0 means "don't bid": the live bot sends nothing.
      if (quick !== undefined && quick !== 0) engine.submitBid(a.botId, quick);
      if (a.agent.refineBid) {
        const refined = guard(a.position, () =>
          a.agent.refineBid!(engine.viewFor(a.botId), engine.auctionView()!, budgetMs),
        );
        if (refined !== undefined && refined !== null) engine.submitBid(a.botId, refined);
      }
    }

    engine.closeAuction();
  }

  for (const a of actors) {
    if (a.agent.onMatchEnd) guard(a.position, () => a.agent.onMatchEnd!(engine.viewFor(a.botId)));
  }

  return {
    matchId: engine.matchId,
    rounds: engine.round,
    engine,
    seats: engine.participants.map((p) => ({
      position: p.position,
      botId: p.botId,
      isSim: p.isSim,
      score: p.score,
      balance: p.balance,
      tilesLeft: totalTiles(p.rack),
      wordsPlayed: p.wordsPlayed,
      bidRejections: p.bidRejections,
      wordRejections: p.wordRejections,
      agentErrors: errors[p.position]!.count,
      firstError: errors[p.position]!.first,
    })),
  };
}
