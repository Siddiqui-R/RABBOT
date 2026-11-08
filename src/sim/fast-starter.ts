// The starter agent for simulation. StarterAgent.chooseWords scans the
// whole longest-first dictionary with an allocation per word, which made
// it ~90% of a starter + sims match. Its pick is by definition the
// server's findBestPlayable(rack, 2) (longest, then alphabetical; every
// dictionary word has 2+ letters), so we answer from the anagram index.
// Bidding is inherited unchanged. dictionary.test.ts pins this to the
// real StarterAgent so a change there can't silently diverge.

import { StarterAgent } from "../agents/starter.js";
import type { MatchView } from "../core/types.js";
import { bestPlayable } from "./dictionary.js";

export class FastStarterAgent extends StarterAgent {
  override chooseWords(view: MatchView): string[] {
    const word = bestPlayable(view.myRack, 2);
    return word === undefined ? [] : [word];
  }
}
