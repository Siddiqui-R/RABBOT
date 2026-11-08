# RABBOT architecture

The Node.js client connects to ScrabbleBot through generated SpacetimeDB bindings.
It subscribes to public match events and its private rack, submits sealed bids,
plays dictionary words, reconnects after interruptions, and registers for tournaments.

The strategy estimates letter value through sampled future racks, models opponent
bids, and prices bids against its balance. A typed-array dictionary index searches
playable words and partitions racks into scoring words.

`src/brain` contains decisions, `src/core` contains word search and scoring,
`src/live` handles the connection and deadlines, and `src/memory` fits public-history
models. `src/sim` provides offline simulation and evaluation. The optional local
telemetry backend is disabled by the Windows launcher.

Settings use the `RABBOT_` prefix. `BOT_NAME`, `BOT_TOKEN`, `BOT_NONCE`,
`TOURNAMENT_ID`, `STDB_HOST`, and `STDB_DB` select credentials and connection details.
