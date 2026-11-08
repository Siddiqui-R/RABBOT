# RackForge decision engine

`createAgent()` returns `RackForgeAgent`. Use the strategy ID `rackforge` in the
live launcher and simulator. Parameters resolve from defaults, `data/params.json`,
and explicit overrides.

The engine maintains a belief about unseen letters, estimates future rack values,
models opponent bids, and solves for the current value of spendable currency.
Vickrey and first-price auctions use their respective payment rules. Word selection
compares immediate rewards with the value of holding letters for later plays.

Simulation mode uses seeded sampling. Live mode uses bounded refinement time so
bids arrive before auction deadlines. The Windows launcher disables telemetry and
lobby entry while waiting for tournaments.

Run `npm test` for offline checks. Run `npm run sim -- --table rackforge,starter --pad`
for a simulation. Use `npm run mine -- --recent 1000 --no-backend` to refresh a
limited public-history model snapshot.
