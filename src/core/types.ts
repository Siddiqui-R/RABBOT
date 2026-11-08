// The contract between the brain, the live bot and the simulator. The live
// bot builds a MatchView from its SpacetimeDB subscription; the simulator
// builds the same view from its own state. A strategy that only reads a
// MatchView behaves identically in both.
//
// IDs are plain numbers: the server's u64 ids stay far below 2^53.

import type { Counts } from "./rules.js";

export type AuctionType = "Vickrey" | "FirstPrice";

export interface ParticipantView {
  botId: number;
  balance: number;
  score: number;
  /** Server-run simulated bot (Cheapskate / ValueBidder / Aggressive). */
  isSim: boolean;
}

export interface AuctionView {
  auctionId: number;
  letter: string;
  /** Server timestamps, ms since epoch. */
  opensAtMs: number;
  closesAtMs: number;
}

/** Everything public that happened in this match, in server order. */
export type PublicEvent =
  | {
      kind: "auction";
      auctionId: number;
      letter: string;
      /** null when nobody bid; the tile is discarded, NOT returned to the bag. */
      winnerBotId: number | null;
      /** Vickrey: runner-up's bid (or 1 if alone). FirstPrice: winner's bid. */
      paid: number;
    }
  | {
      kind: "word";
      botId: number;
      word: string;
      /** Total reward (score and coins) the word earned. */
      reward: number;
    };

export interface MatchView {
  matchId: number;
  myBotId: number;
  auctionType: AuctionType;
  /** match_state.current_round */
  round: number;
  /**
   * Tiles still in the bag, NOT counting the letter currently up for
   * auction. When this is 0 the current auction is the last one: the match
   * ends the instant it closes, and a live bot can't play afterwards.
   */
  bagTotal: number;
  startingRackSize: number;
  participants: ParticipantView[];
  myRack: Counts;
  history: PublicEvent[];
  /** Local clock, ms since epoch, corrected toward server time if known. */
  nowMs: number;
  /**
   * Set only when this match belongs to a tournament (built by
   * src/brain/tournament.ts's tournamentContext). Absent: a ladder match.
   */
  tournament?: TournamentView;
}

export type TournamentStage = "Swiss" | "Bracket" | "Final";

export interface TournamentStanding {
  botId: number;
  swissPoints: number;
  /** Score summed over the bot's finished tournament matches (tiebreak). */
  totalScore: number;
  eliminated: boolean;
}

export interface TournamentView {
  phase: TournamentStage;
  /** tournament_match.round of this match (Final: game number 1..3). */
  round: number;
  matchSize: number;
  topCut: number;
  swissRoundsTotal: number;
  /** Every entrant, before this match's result. */
  standings: TournamentStanding[];
  /** Final only: my and the opponent's totals over the earlier final games. */
  finalTotals?: { botId: number; total: number }[];
}

export interface Agent {
  readonly name: string;
  /**
   * An auction just opened. Must return within ~20 ms. 0 = don't bid.
   * The bid can't exceed the bot's balance (the server rejects it).
   */
  quickBid(view: MatchView, auction: AuctionView): number;
  /**
   * Optional second pass with up to `budgetMs` of thinking. Return a
   * replacement bid (the server keeps only the latest), or null to keep the
   * quick bid.
   */
  refineBid?(view: MatchView, auction: AuctionView, budgetMs: number): number | null;
  /**
   * The rack or match state changed. Return words to play right now, in
   * order; each must be spellable from what's left after the ones before it.
   */
  chooseWords(view: MatchView): string[];
  onMatchEnd?(view: MatchView): void;
}
