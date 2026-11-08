// The official bot-starter strategy as an Agent: the baseline every real
// entrant began from. Bids face value (+2 for a letter it doesn't hold) and
// plays the longest word it can spell, first alphabetically on ties.
//
// The word search asks the word engine instead of scanning the dictionary:
// "longest, then alphabetical, 2+ letters" is exactly the server's
// findBestPlayable(rack, 2), which the engine replicates. legacyChooseWords
// keeps the original scan so a test can pin the two together.

import * as fs from "node:fs";
import * as path from "node:path";
import { canSpell, idx, letterValue, totalTiles } from "../core/rules.js";
import type { Agent, AuctionView, MatchView } from "../core/types.js";
import { getWordEngine } from "../core/words.js";

let longestFirst: string[] | undefined;

export function dictionaryLongestFirst(): string[] {
  if (!longestFirst) {
    const file = path.join(import.meta.dirname, "..", "..", "data", "wordlist.txt");
    longestFirst = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
      .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  }
  return longestFirst;
}

export class StarterAgent implements Agent {
  readonly name = "starter";

  quickBid(view: MatchView, auction: AuctionView): number {
    const me = view.participants.find((p) => p.botId === view.myBotId);
    const balance = me?.balance ?? 0;
    const value = letterValue(auction.letter) || 1;
    const have = view.myRack[idx(auction.letter)] ?? 0;
    const want = have === 0 ? value + 2 : Math.max(1, value);
    return Math.min(want, Math.max(0, balance));
  }

  chooseWords(view: MatchView): string[] {
    const word = getWordEngine().serverBestPlayable(view.myRack, 2);
    return word === undefined ? [] : [word];
  }
}

/** The original dictionary scan (slow); kept to pin chooseWords to it in tests. */
export function legacyChooseWords(view: MatchView): string[] {
  const tiles = totalTiles(view.myRack);
  for (const word of dictionaryLongestFirst()) {
    if (word.length <= tiles && canSpell(word, view.myRack)) return [word];
  }
  return [];
}
