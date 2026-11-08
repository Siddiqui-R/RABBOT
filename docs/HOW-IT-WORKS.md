# How RackForge works

1. Track the rack, balance, public auctions, and word plays.
2. Reconstruct an estimate of unseen letters and each opponent's spending.
3. Sample possible future purchases to estimate a letter's scoring value.
4. Use fitted opponent-bid distributions and the auction's price rule to choose a bid.
5. Compare playing a word now with keeping its letters for longer words.
6. Spend useful remaining funds and play remaining words before the match ends.

The client sends a quick bid first and refines it when the deadline allows.
Winning bids must fit the balance; submitted words must fit the current rack.

Offline simulations and unit tests check scoring, legality, timing, and lifecycle
behavior. Single live match results do not establish expected tournament performance.
