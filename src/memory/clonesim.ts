// A compact match runner used only to check clones against their
// originals (the real simulator lives in src/sim). It follows the server
// rules that matter for scores: 5-tile hidden racks, one auction per tile,
// Vickrey with random tie-breaks, discarded unsold tiles, sims bidding
// their formula and playing findBestPlayable(rack, 3) inside the close,
// and live agents unable to play after the last auction.

import {
  AUCTION_DURATION_MS,
  BAG_SIZE,
  DEFAULT_BAG,
  LETTERS,
  STARTING_BALANCE,
  STARTING_RACK_SIZE,
  SIM_BID_JITTER,
  canSpell,
  emptyCounts,
  totalTiles,
  wordReward,
  type Counts,
} from "../core/rules.js";
import type { Agent, MatchView, PublicEvent } from "../core/types.js";
import { simBase, simBid } from "./derive.js";

export type SeatSpec = { botId: number; agent: Agent } | { botId: number; simStrategy: string };

export interface SeatResult {
  botId: number;
  score: number;
  place: number;
  tilesWon: number;
  paid: number[];
  topBids: number[];
  words: string[];
  tilesLeft: number;
}

let simDict: string[] | undefined;
function simWords(dictionary: () => string[]): string[] {
  // findBestPlayable order: longest first, then alphabetical.
  simDict ??= [...dictionary()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return simDict;
}

function simBestPlayable(rack: Counts, words: string[]): string | undefined {
  const tiles = totalTiles(rack);
  if (tiles < 3) return undefined;
  for (const w of words) {
    if (w.length < 3) break;
    if (w.length > tiles) continue;
    if (canSpell(w, rack)) return w;
  }
  return undefined;
}

export function runMatch(
  seats: SeatSpec[],
  rng: () => number,
  dictionary: () => string[],
  isWord: (w: string) => boolean,
): SeatResult[] {
  const bag = [...DEFAULT_BAG];
  let bagTotal = BAG_SIZE;
  const draw = (): string | undefined => {
    if (bagTotal === 0) return undefined;
    let k = Math.floor(rng() * bagTotal);
    for (let i = 0; i < 26; i++) {
      if (k < bag[i]!) {
        bag[i]!--;
        bagTotal--;
        return LETTERS[i];
      }
      k -= bag[i]!;
    }
    return undefined;
  };
  const st = seats.map((s) => ({
    spec: s,
    balance: STARTING_BALANCE,
    score: 0,
    rack: emptyCounts(),
    res: { botId: s.botId, score: 0, place: 0, tilesWon: 0, paid: [], topBids: [], words: [], tilesLeft: 0 } as SeatResult,
  }));
  for (const s of st) for (let n = 0; n < STARTING_RACK_SIZE; n++) {
    const l = draw();
    if (l) s.rack[l.charCodeAt(0) - 65]!++;
  }
  const history: PublicEvent[] = [];
  const play = (s: (typeof st)[number], w: string) => {
    if (!isWord(w) || !canSpell(w, s.rack)) return;
    for (let i = 0; i < w.length; i++) s.rack[w.charCodeAt(i) - 65]!--;
    const r = wordReward(w);
    s.balance += r;
    s.score += r;
    s.res.words.push(w);
    history.push({ kind: "word", botId: s.spec.botId, word: w, reward: r });
  };
  const viewFor = (s: (typeof st)[number], round: number, now: number): MatchView => ({
    matchId: 0,
    myBotId: s.spec.botId,
    auctionType: "Vickrey",
    round,
    bagTotal,
    startingRackSize: STARTING_RACK_SIZE,
    participants: st.map((o) => ({ botId: o.spec.botId, balance: o.balance, score: o.score, isSim: "simStrategy" in o.spec })),
    myRack: [...s.rack],
    history,
    nowMs: now,
  });

  let round = 0;
  let auctionId = 0;
  for (let letter = draw(); letter !== undefined; ) {
    round++;
    auctionId++;
    const now = round * AUCTION_DURATION_MS;
    const bids: { i: number; amount: number }[] = [];
    st.forEach((s, i) => {
      let amount: number;
      if ("simStrategy" in s.spec) {
        const base = simBase(s.spec.simStrategy, letter!);
        const j = Math.floor(rng() * (2 * SIM_BID_JITTER + 1)) - SIM_BID_JITTER;
        amount = base === null ? 0 : simBid(base, j, s.balance);
      } else {
        amount = Math.floor(s.spec.agent.quickBid(viewFor(s, round, now), {
          auctionId,
          letter: letter!,
          opensAtMs: now,
          closesAtMs: now + AUCTION_DURATION_MS,
        }));
        if (!(amount >= 0) || amount > s.balance) amount = 0; // the server refuses it
      }
      if (amount > 0) bids.push({ i, amount });
    });
    // Shuffle, then stable sort descending: random tie-breaks.
    for (let k = bids.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [bids[k], bids[j]] = [bids[j]!, bids[k]!];
    }
    bids.sort((a, b) => b.amount - a.amount);
    let winner: (typeof st)[number] | undefined;
    let paid = 0;
    if (bids.length > 0) {
      winner = st[bids[0]!.i]!;
      paid = bids[1] ? bids[1].amount : Math.min(1, bids[0]!.amount);
      winner.balance -= paid;
      winner.rack[letter.charCodeAt(0) - 65]!++;
      winner.res.tilesWon++;
      winner.res.paid.push(paid);
      winner.res.topBids.push(bids[0]!.amount);
    }
    history.push({ kind: "auction", auctionId, letter, winnerBotId: winner?.spec.botId ?? null, paid });
    if (winner && "simStrategy" in winner.spec) {
      const w = simBestPlayable(winner.rack, simWords(dictionary));
      if (w) play(winner, w);
    }
    letter = draw();
    if (letter === undefined) break; // match over: live bots can't play now
    for (const s of st) {
      if ("simStrategy" in s.spec) continue;
      for (const w of s.spec.agent.chooseWords(viewFor(s, round, now))) play(s, w);
    }
  }
  for (const s of st) {
    s.res.score = s.score;
    s.res.tilesLeft = totalTiles(s.rack);
  }
  for (const s of st) s.res.place = 1 + st.filter((o) => o.score > s.score).length;
  return st.map((s) => s.res);
}
