// Structural subsets of the generated row types (src/module_bindings). The
// live code only reads these fields, and tests can build rows by hand
// without a connection. The generated rows satisfy these shapes as is.

export interface TsLike {
  readonly microsSinceUnixEpoch: bigint;
}

export interface Tagged {
  readonly tag: string;
}

export interface MatchRow {
  id: bigint;
  status: Tagged;
  currentRound: number;
  currentAuctionId: bigint | undefined;
  bagTotal: number;
  auctionType: Tagged;
  startingRackSize: number;
  auctionDurationMs?: bigint;
  endedAt?: TsLike | undefined;
}

export interface ParticipantRow {
  id: bigint;
  matchId: bigint;
  botId: bigint;
  balance: bigint;
  score: bigint;
}

export interface RackRow {
  id: bigint;
  matchId: bigint;
  botId: bigint;
  letter: string;
  count: number;
}

export interface AuctionRow {
  id: bigint;
  matchId: bigint;
  letter: string;
  opensAt: TsLike;
  closesAt: TsLike;
  status: Tagged;
}

export interface AuctionResultRow {
  auctionId: bigint;
  matchId: bigint;
  letter: string;
  winnerBotId: bigint | undefined;
  paid: bigint;
  closedAt: TsLike;
}

export interface WordPlayRow {
  id: bigint;
  matchId: bigint;
  botId: bigint;
  word: string;
  totalReward: bigint;
  playedAt: TsLike;
}

export interface BotRow {
  id: bigint;
  name: string;
  isSimulated: boolean;
}

/** Server timestamp as fractional ms since the epoch (keeps the micros). */
export function tsMs(t: TsLike): number {
  return Number(t.microsSinceUnixEpoch) / 1000;
}
