// Feed watchdog. Mid-match an auction opens or closes every auction length
// (1 s by default), so a long silence means the subscription stream has
// stalled while the socket stays open. This has been observed live: RABBOT
// (and a miner on the same host) got nothing from maincloud for ~60 s,
// then the whole backlog at once after the match had ended; RABBOT scored 0
// with 10 tiles in hand. A fresh connection resyncs from the
// cache in about a second, which beats waiting blind.

/** Silence that counts as a stall: `overrideMs` if set (> 0), else 5 auctions and at least 6 s. */
export function stallLimitMs(auctionMs: number, overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs;
  const a = Number.isFinite(auctionMs) && auctionMs > 0 ? auctionMs : 1000;
  return Math.max(6000, 5 * a);
}

/** True when the feed of a running match has been silent past the limit. */
export function feedStalled(nowMs: number, lastFeedMs: number, auctionMs: number, overrideMs?: number): boolean {
  return nowMs - lastFeedMs > stallLimitMs(auctionMs, overrideMs);
}
