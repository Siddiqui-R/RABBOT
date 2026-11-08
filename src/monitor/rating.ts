// The rating the site shows, mirrored from the web client
// (upstream scrabblebot repo, src/rating.ts): OpenSkill mu and sigma on an
// Elo-like scale, new bots at 1500, provisional (no rank) while the +- is
// wider than 175.

export const NEW_BOT = 1500;
const ELO_SCALE = 400 / (Math.LN10 * (25 / 6) * Math.SQRT2);
export const PROVISIONAL_ABOVE = 175;

export interface Rated {
  openskillMu: number;
  openskillSigma: number;
}

export function skill(s: Rated): number {
  return Math.round(NEW_BOT + ELO_SCALE * (s.openskillMu - 25));
}

export function spread(s: Rated): number {
  return Math.round(ELO_SCALE * s.openskillSigma);
}

export function isProvisional(s: Rated): boolean {
  return spread(s) > PROVISIONAL_ABOVE;
}

/**
 * Competition rank among non-provisional entries (1, 2, 2, 4), as the
 * leaderboard shows it; null while provisional.
 */
export function rankOf<T extends Rated>(me: T, all: readonly T[]): number | null {
  if (isProvisional(me)) return null;
  const mine = skill(me);
  return 1 + all.filter((s) => !isProvisional(s) && skill(s) > mine).length;
}
