// Game constants and scoring, mirrored exactly from the server module
// (upstream scrabblebot repo, spacetimedb/src/{game,letters}.ts). If the server
// changes, change these too: the simulator and the live bot both rely on them.

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const STARTING_BALANCE = 100;
export const STARTING_RACK_SIZE = 5;
export const LOBBY_MAX_SIZE = 6;
export const AUCTION_DURATION_MS = 1000;
// Vickrey with a single bidder: the winner pays min(AUCTION_RESERVE, bid).
export const AUCTION_RESERVE = 1;
// Simulated bots bid their strategy's base +/- this, uniformly.
export const SIM_BID_JITTER = 2;

// Standard Scrabble values, no blanks. Index 0 = 'A'.
export const LETTER_VALUES: readonly number[] = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];

// Standard Scrabble distribution, no blanks, 98 tiles. Index 0 = 'A'.
export const DEFAULT_BAG: readonly number[] = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];
export const BAG_SIZE = 98;

/** 26 letter counts, index 0 = 'A'. */
export type Counts = number[];

export function idx(letter: string): number {
  return letter.charCodeAt(0) - 65;
}

export function letterValue(letter: string): number {
  const i = idx(letter);
  return i >= 0 && i < 26 ? LETTER_VALUES[i]! : 0;
}

export function emptyCounts(): Counts {
  return new Array<number>(26).fill(0);
}

export function countsOf(word: string): Counts {
  const c = emptyCounts();
  for (let i = 0; i < word.length; i++) c[word.charCodeAt(i) - 65]!++;
  return c;
}

export function countsFromMap(m: Map<string, number>): Counts {
  const c = emptyCounts();
  for (const [letter, n] of m) {
    const i = idx(letter);
    if (i >= 0 && i < 26) c[i]! += n;
  }
  return c;
}

export function totalTiles(c: Counts): number {
  let t = 0;
  for (let i = 0; i < 26; i++) t += c[i]!;
  return t;
}

export function canSpell(word: string, rack: Counts): boolean {
  const need = countsOf(word);
  for (let i = 0; i < 26; i++) if (need[i]! > rack[i]!) return false;
  return true;
}

/** Server's length multiplier as an exact fraction [num, den]. */
export function lengthMultiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

export function baseScore(word: string): number {
  let s = 0;
  for (let i = 0; i < word.length; i++) s += LETTER_VALUES[word.charCodeAt(i) - 65]!;
  return s;
}

/**
 * Points (and coins) a word earns. The server computes
 * `(baseScore * num) / denom` in bigint, which truncates; for positive
 * values that's floor.
 */
export function wordReward(word: string): number {
  const [num, den] = lengthMultiplier(word.length);
  return Math.floor((baseScore(word) * num) / den);
}

/**
 * Auctions in a match: the bag minus every starting rack. The last of these
 * is worthless to a live bot: the match ends the instant it closes.
 */
export function auctionsPerMatch(
  players: number,
  rackSize = STARTING_RACK_SIZE,
): number {
  return BAG_SIZE - players * rackSize;
}
