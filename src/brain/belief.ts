// What RackForge believes about the tiles it can't see, rebuilt
// incrementally from the public history of one match.
//
// Every tile is in exactly one place: auctioned already (won or discarded;
// unsold tiles are thrown away, not returned), in my starting rack, in an
// opponent's starting rack, or still in the bag. Auctioned letters and my
// own rack are known. An opponent's starting rack is revealed only when it
// plays a letter more often than it bought it. So the unseen pool = bag +
// opponents' unrevealed starting tiles, and future auction letters are draws
// from that pool (the bag is a uniform subset of it by symmetry; the live
// server's skewed RNG is ignored here).

import { DEFAULT_BAG, emptyCounts, idx, type Counts } from "../core/rules.js";
import type { MatchView } from "../core/types.js";

export interface OpponentRack {
  botId: number;
  /** Tiles it holds now: start + bought - played (exact). */
  size: number;
  /** Letters it surely holds: bought and not played since (a lower bound). */
  known: Counts;
  /** Starting tiles never revealed: they sit in the unseen pool for us. */
  hiddenLeft: number;
}

export class Belief {
  private matchId = -1;
  private seen = 0;
  readonly auctioned: Counts = emptyCounts();
  private bought = new Map<number, Counts>();
  private played = new Map<number, Counts>();
  /** Tiles each bot has won, and played, in total. */
  private wonN = new Map<number, number>();
  private playedN = new Map<number, number>();
  /** Auctions closed so far (sold or not). */
  auctions = 0;
  startRack = 5;
  myBotId = -1;

  /** Folds in history events not seen yet. Resets on a new match. */
  update(view: MatchView): void {
    if (view.matchId !== this.matchId || view.history.length < this.seen) this.reset(view);
    for (; this.seen < view.history.length; this.seen++) {
      const e = view.history[this.seen]!;
      if (e.kind === "auction") {
        const i = idx(e.letter);
        if (i < 0 || i >= 26) continue;
        this.auctioned[i]!++;
        this.auctions++;
        if (e.winnerBotId !== null) {
          this.get(this.bought, e.winnerBotId)[i]!++;
          this.wonN.set(e.winnerBotId, (this.wonN.get(e.winnerBotId) ?? 0) + 1);
        }
      } else {
        const c = this.get(this.played, e.botId);
        for (let k = 0; k < e.word.length; k++) {
          const i = e.word.charCodeAt(k) - 65;
          if (i >= 0 && i < 26) c[i]!++;
        }
        this.playedN.set(e.botId, (this.playedN.get(e.botId) ?? 0) + e.word.length);
      }
    }
  }

  private reset(view: MatchView): void {
    this.matchId = view.matchId;
    this.myBotId = view.myBotId;
    this.startRack = view.startingRackSize;
    this.seen = 0;
    this.auctioned.fill(0);
    this.bought.clear();
    this.played.clear();
    this.wonN.clear();
    this.playedN.clear();
    this.auctions = 0;
  }

  private get(m: Map<number, Counts>, id: number): Counts {
    let c = m.get(id);
    if (!c) m.set(id, (c = emptyCounts()));
    return c;
  }

  boughtBy(botId: number): Counts {
    return this.get(this.bought, botId);
  }

  playedBy(botId: number): Counts {
    return this.get(this.played, botId);
  }

  /** Tiles a bot holds now (exact from public data). */
  rackSize(botId: number): number {
    return Math.max(0, this.startRack + (this.wonN.get(botId) ?? 0) - (this.playedN.get(botId) ?? 0));
  }

  /** Starting tiles of `botId` revealed by its plays (a lower bound per letter). */
  revealed(botId: number): Counts {
    const p = this.get(this.played, botId);
    const b = this.get(this.bought, botId);
    const r = emptyCounts();
    for (let i = 0; i < 26; i++) r[i] = Math.max(0, p[i]! - b[i]!);
    return r;
  }

  opponent(botId: number): OpponentRack {
    const p = this.get(this.played, botId);
    const b = this.get(this.bought, botId);
    const known = emptyCounts();
    let rev = 0;
    for (let i = 0; i < 26; i++) {
      known[i] = Math.max(0, b[i]! - p[i]!);
      rev += Math.max(0, p[i]! - b[i]!);
    }
    return { botId, size: this.rackSize(botId), known, hiddenLeft: Math.max(0, this.startRack - rev) };
  }

  /** My starting rack, recovered from what I hold, played and bought. */
  myStart(view: MatchView): Counts {
    const p = this.get(this.played, view.myBotId);
    const b = this.get(this.bought, view.myBotId);
    const s = emptyCounts();
    for (let i = 0; i < 26; i++) s[i] = Math.max(0, view.myRack[i]! + p[i]! - b[i]!);
    return s;
  }

  /**
   * Tiles I can't place: the bag plus opponents' unrevealed starting tiles.
   * `current` is the letter on the block now; it is out of the pool too.
   */
  unseen(view: MatchView, current?: string): Counts {
    const start = this.myStart(view);
    const pool = emptyCounts();
    const rev = emptyCounts();
    for (const id of this.played.keys()) {
      if (id === view.myBotId) continue;
      const r = this.revealed(id);
      for (let i = 0; i < 26; i++) rev[i]! += r[i]!;
    }
    const cur = current ? idx(current) : -1;
    for (let i = 0; i < 26; i++) {
      pool[i] = Math.max(0, DEFAULT_BAG[i]! - this.auctioned[i]! - start[i]! - rev[i]! - (i === cur ? 1 : 0));
    }
    return pool;
  }
}
