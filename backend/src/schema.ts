import { schema, t, table, type Infer } from "spacetimedb/server";

// RABBOT's backend: everything stateful the bot keeps, in one SpacetimeDB.
//   g_*         1:1 mirror of ScrabbleBot's public tables (the miner)
//   d_*         per-match facts derived from the mirror (derive.ts)
//   *_stat      sums the module maintains itself as d_* rows change
//   bid_model   fitted bid models (model.ts); bot 0 is the market
//   rabbot_*       the live bot's own telemetry and the monitor's status
//   meta        small key/value state (miner cursors, validation report)
// Everything readable is public so a dashboard can subscribe anonymously;
// every write goes through a reducer that checks the `writer` allow-list.
//
// Column names follow the SDK's camelCase -> snake_case conversion
// (`matchId` is the SQL column `match_id`). Rows keep the game server's
// primary keys so every upsert is idempotent; enum-ish columns are strings
// so a new variant on the game server can't break the mirror. History rows
// the server deletes are kept with `deletedAt` set (the SQLite miner's
// `deleted_us` tombstones); state tables mirror deletes.
//
// Adding a column later: append it at the end of the row with `.default()`
// and republish without --delete-data; anything else needs a clean publish.

// ---------- Auth ----------

// Allow-listed identities. Private: only reducers and the database owner
// (via CLI sql) read it. `role` is "owner" for the publisher, else "writer".
export const writer = table(
  {},
  t.row("Writer", {
    identity: t.identity().primaryKey(),
    role: t.string(),
    label: t.string(),
    addedAt: t.timestamp(),
    addedBy: t.option(t.identity()),
  }),
);

// ---------- Mirror of the public game tables ----------

export const gBot = table(
  {
    public: true,
    indexes: [{ accessor: "gBotByTeam", algorithm: "btree", columns: ["teamId"] }],
  },
  t.row("GBot", {
    id: t.u64().primaryKey(),
    name: t.string(),
    teamId: t.u64(),
    isSimulated: t.bool(),
    // "Human" | "Cheapskate" | "ValueBidder" | "Aggressive"
    strategy: t.string(),
    createdAt: t.timestamp(),
    deletedAt: t.option(t.timestamp()),
  }),
);
export type GBot = Infer<typeof gBot.rowType>;

export const gBotStats = table(
  { public: true },
  t.row("GBotStats", {
    botId: t.u64().primaryKey(),
    rating: t.i32(),
    matchesPlayed: t.u32(),
    wins: t.u32(),
    totalScore: t.i64(),
    lastPlayed: t.option(t.timestamp()),
    openskillMu: t.f64(),
    openskillSigma: t.f64(),
  }),
);
export type GBotStats = Infer<typeof gBotStats.rowType>;

export const gRetiredBotStats = table(
  {
    public: true,
    indexes: [{ accessor: "gRetiredByBot", algorithm: "btree", columns: ["botId"] }],
  },
  t.row("GRetiredBotStats", {
    id: t.u64().primaryKey(),
    botId: t.u64(),
    version: t.u32(),
    rating: t.i32(),
    matchesPlayed: t.u32(),
    wins: t.u32(),
    totalScore: t.i64(),
    lastPlayed: t.option(t.timestamp()),
    openskillMu: t.f64(),
    openskillSigma: t.f64(),
  }),
);
export type GRetiredBotStats = Infer<typeof gRetiredBotStats.rowType>;

export const gBotVersion = table(
  {
    public: true,
    indexes: [{ accessor: "gVersionByBot", algorithm: "btree", columns: ["botId"] }],
  },
  t.row("GBotVersion", {
    id: t.u64().primaryKey(),
    botId: t.u64(),
    version: t.u32(),
    startedAt: t.timestamp(),
  }),
);
export type GBotVersion = Infer<typeof gBotVersion.rowType>;

// The server's match_state.
export const gMatch = table(
  {
    public: true,
    indexes: [{ accessor: "gMatchByStatus", algorithm: "btree", columns: ["status"] }],
  },
  t.row("GMatch", {
    id: t.u64().primaryKey(),
    // "Lobby" | "Running" | "Ended"
    status: t.string(),
    currentRound: t.u32(),
    currentAuctionId: t.option(t.u64()),
    bagTotal: t.u32(),
    // "Vickrey" | "FirstPrice"
    auctionType: t.string(),
    createdAt: t.timestamp(),
    startedAt: t.option(t.timestamp()),
    endedAt: t.option(t.timestamp()),
    auctionDurationMs: t.u64(),
    startingRackSize: t.u32(),
    deletedAt: t.option(t.timestamp()),
  }),
);
export type GMatch = Infer<typeof gMatch.rowType>;

// The server's match_participant.
export const gParticipant = table(
  {
    public: true,
    indexes: [
      { accessor: "gPartByMatch", algorithm: "btree", columns: ["matchId"] },
      { accessor: "gPartByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("GParticipant", {
    id: t.u64().primaryKey(),
    matchId: t.u64(),
    botId: t.u64(),
    balance: t.i64(),
    score: t.i64(),
    deletedAt: t.option(t.timestamp()),
  }),
);
export type GParticipant = Infer<typeof gParticipant.rowType>;

// The server's auction_result.
export const gAuction = table(
  {
    public: true,
    indexes: [
      { accessor: "gAuctionByMatch", algorithm: "btree", columns: ["matchId"] },
      { accessor: "gAuctionByWinner", algorithm: "btree", columns: ["winnerBotId"] },
    ],
  },
  t.row("GAuction", {
    auctionId: t.u64().primaryKey(),
    matchId: t.u64(),
    letter: t.string(),
    winnerBotId: t.option(t.u64()),
    paid: t.i64(),
    closedAt: t.timestamp(),
    deletedAt: t.option(t.timestamp()),
  }),
);
export type GAuction = Infer<typeof gAuction.rowType>;

// The server's auction_top_bid_archive: winning bids, published once a match
// has ended. (Never visible_auction_top_bids: see ARCHITECTURE.md.)
export const gTopBid = table(
  {
    public: true,
    indexes: [{ accessor: "gTopBidByMatch", algorithm: "btree", columns: ["matchId"] }],
  },
  t.row("GTopBid", {
    auctionId: t.u64().primaryKey(),
    matchId: t.u64(),
    topBid: t.i64(),
    deletedAt: t.option(t.timestamp()),
  }),
);
export type GTopBid = Infer<typeof gTopBid.rowType>;

// The server's word_play.
export const gWord = table(
  {
    public: true,
    indexes: [
      { accessor: "gWordByMatch", algorithm: "btree", columns: ["matchId"] },
      { accessor: "gWordByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("GWord", {
    id: t.u64().primaryKey(),
    matchId: t.u64(),
    botId: t.u64(),
    word: t.string(),
    baseScore: t.i64(),
    bonus: t.i64(),
    totalReward: t.i64(),
    playedAt: t.timestamp(),
    deletedAt: t.option(t.timestamp()),
  }),
);
export type GWord = Infer<typeof gWord.rowType>;

// The server's rating_history. Its ids change when the server rebuilds
// ratings, so the miner replaces it per match (replace_ratings).
export const gRating = table(
  {
    public: true,
    indexes: [
      { accessor: "gRatingByBot", algorithm: "btree", columns: ["botId"] },
      { accessor: "gRatingByMatch", algorithm: "btree", columns: ["matchId"] },
    ],
  },
  t.row("GRating", {
    id: t.u64().primaryKey(),
    botId: t.u64(),
    matchId: t.u64(),
    at: t.timestamp(),
    openskillMu: t.f64(),
    openskillSigma: t.f64(),
  }),
);
export type GRating = Infer<typeof gRating.rowType>;

export const gTournament = table(
  { public: true },
  t.row("GTournament", {
    id: t.u64().primaryKey(),
    status: t.string(),
    swissRoundsTotal: t.u32(),
    currentRound: t.u32(),
    topCut: t.u32(),
    matchSize: t.u32(),
    auctionType: t.string(),
    createdAt: t.timestamp(),
    endedAt: t.option(t.timestamp()),
    winnerBotId: t.option(t.u64()),
  }),
);
export type GTournament = Infer<typeof gTournament.rowType>;

export const gTournamentEntry = table(
  {
    public: true,
    indexes: [
      { accessor: "gTeByTournament", algorithm: "btree", columns: ["tournamentId"] },
      { accessor: "gTeByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("GTournamentEntry", {
    id: t.u64().primaryKey(),
    tournamentId: t.u64(),
    botId: t.u64(),
    swissPoints: t.i32(),
    eliminated: t.bool(),
    totalScore: t.i64(),
    finalFinishPosition: t.option(t.u32()),
  }),
);
export type GTournamentEntry = Infer<typeof gTournamentEntry.rowType>;

export const gTournamentMatch = table(
  {
    public: true,
    indexes: [
      { accessor: "gTmByTournament", algorithm: "btree", columns: ["tournamentId"] },
      { accessor: "gTmByMatch", algorithm: "btree", columns: ["matchId"] },
    ],
  },
  t.row("GTournamentMatch", {
    id: t.u64().primaryKey(),
    tournamentId: t.u64(),
    matchId: t.u64(),
    round: t.u32(),
    // "Swiss" | "Final" ...
    phase: t.string(),
  }),
);
export type GTournamentMatch = Infer<typeof gTournamentMatch.rowType>;

// Miner bookkeeping: which matches had their per-match rows fetched;
// complete = fetched after the match ended, so never needs fetching again.
export const gMatchMined = table(
  { public: true },
  t.row("GMatchMined", {
    matchId: t.u64().primaryKey(),
    complete: t.bool(),
    minedAt: t.timestamp(),
  }),
);
export type GMatchMined = Infer<typeof gMatchMined.rowType>;

// ---------- Derived per-match facts (derive.ts) ----------
// Replaced a whole match at a time by put_derived, so a re-derive never
// leaves stale rows behind and the *_stat sums stay exact.

export const dMatchInfo = table(
  {
    public: true,
    indexes: [{ accessor: "dInfoByEnded", algorithm: "btree", columns: ["endedAt"] }],
  },
  t.row("DMatchInfo", {
    matchId: t.u64().primaryKey(),
    nSeats: t.u32(),
    nReal: t.u32(),
    nAuctions: t.u32(),
    expectedAuctions: t.i32(),
    auctionType: t.string(),
    createdAt: t.timestamp(),
    endedAt: t.timestamp(),
    balanceOk: t.bool(),
    derivedAt: t.timestamp(),
  }),
);
export type DMatchInfo = Infer<typeof dMatchInfo.rowType>;

// One row per (match, bot). `id` is assigned by the module; the natural key
// is (matchId, botId).
export const dMatchSeat = table(
  {
    public: true,
    indexes: [
      { accessor: "dSeatByMatch", algorithm: "btree", columns: ["matchId"] },
      { accessor: "dSeatByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("DMatchSeat", {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64(),
    botId: t.u64(),
    isSim: t.bool(),
    strategy: t.string(),
    version: t.u32(),
    finalScore: t.i64(),
    finalBalance: t.i64(),
    place: t.u32(),
    wonTiles: t.u32(),
    paidTotal: t.i64(),
    words: t.u32(),
    lettersPlayed: t.u32(),
    tilesLeft: t.i32(),
    endedAt: t.timestamp(),
  }),
);
export type DMatchSeat = Infer<typeof dMatchSeat.rowType>;

export const dAuctionCtx = table(
  {
    public: true,
    indexes: [
      { accessor: "dCtxByMatch", algorithm: "btree", columns: ["matchId"] },
      { accessor: "dCtxByLetter", algorithm: "btree", columns: ["letter"] },
      { accessor: "dCtxByWinner", algorithm: "btree", columns: ["winnerBotId"] },
      { accessor: "dCtxByEnded", algorithm: "btree", columns: ["endedAt"] },
    ],
  },
  t.row("DAuctionCtx", {
    auctionId: t.u64().primaryKey(),
    matchId: t.u64(),
    roundIdx: t.u32(),
    nAuctions: t.u32(),
    // roundIdx / nAuctions, in [0, 1).
    phase: t.f64(),
    letter: t.string(),
    winnerBotId: t.option(t.u64()),
    winnerIsSim: t.option(t.bool()),
    paid: t.i64(),
    topBid: t.option(t.i64()),
    closedAt: t.timestamp(),
    endedAt: t.timestamp(),
    // P(every sim loser bid below paid), from the sims' known formula.
    simQ: t.option(t.f64()),
  }),
);
export type DAuctionCtx = Infer<typeof dAuctionCtx.rowType>;

// One row per (auction, real bot seated): what its sealed bid is known to
// be. kind 0 = exactly value, 1 = at most value, 2 = at least value.
// Natural key (auctionId, botId); `id` is assigned by the module.
export const dBidObs = table(
  {
    public: true,
    indexes: [
      { accessor: "dBidByMatch", algorithm: "btree", columns: ["matchId"] },
      { accessor: "dBidByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("DBidObs", {
    id: t.u64().primaryKey().autoInc(),
    auctionId: t.u64(),
    botId: t.u64(),
    matchId: t.u64(),
    letter: t.string(),
    roundIdx: t.u32(),
    phase: t.f64(),
    balance: t.i64(),
    cap: t.i64(),
    rackSize: t.i32(),
    kind: t.u8(),
    value: t.i64(),
    won: t.bool(),
    othersMax: t.option(t.i64()),
    version: t.u32(),
    endedAt: t.timestamp(),
  }),
);
export type DBidObs = Infer<typeof dBidObs.rowType>;

export const dPlayObs = table(
  {
    public: true,
    indexes: [
      { accessor: "dPlayByMatch", algorithm: "btree", columns: ["matchId"] },
      { accessor: "dPlayByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("DPlayObs", {
    wordId: t.u64().primaryKey(),
    matchId: t.u64(),
    botId: t.u64(),
    isSim: t.bool(),
    word: t.string(),
    len: t.u32(),
    reward: t.i64(),
    roundIdx: t.u32(),
    phase: t.f64(),
    rackBefore: t.i32(),
    balanceBefore: t.i64(),
    endedAt: t.timestamp(),
  }),
);
export type DPlayObs = Infer<typeof dPlayObs.rowType>;

// ---------- Sums maintained by the module (see stats.ts) ----------
// Exact integer sums, so mean/variance come without scanning d_*. Phase
// buckets are fit.ts's phaseBucket (quartiles of the match + the last ~3%).

// Per letter x phase bucket, over d_auction_ctx. key = "<L>|<pb>".
export const marketStat = table(
  { public: true },
  t.row("MarketStat", {
    key: t.string().primaryKey(),
    letter: t.string(),
    phase: t.u8(),
    n: t.i64(),
    nSold: t.i64(),
    nSimWin: t.i64(),
    sumPaid: t.i64(),
    sumsqPaid: t.i64(),
    nTop: t.i64(),
    sumTop: t.i64(),
    sumsqTop: t.i64(),
    updatedAt: t.timestamp(),
  }),
);
export type MarketStat = Infer<typeof marketStat.rowType>;

// Per bot x letter x phase bucket, over d_bid_obs. key = "<bot>|<L>|<pb>".
export const oppStat = table(
  {
    public: true,
    indexes: [{ accessor: "oppStatByBot", algorithm: "btree", columns: ["botId"] }],
  },
  t.row("OppStat", {
    key: t.string().primaryKey(),
    botId: t.u64(),
    letter: t.string(),
    phase: t.u8(),
    nObs: t.i64(),
    nWon: t.i64(),
    // kind 0 (exact); nZero counts the exact zeros among them.
    nEq: t.i64(),
    nZero: t.i64(),
    sumEq: t.i64(),
    sumsqEq: t.i64(),
    // kind 1 (bid <= value)
    nLe: t.i64(),
    sumLe: t.i64(),
    sumsqLe: t.i64(),
    // kind 2 (bid >= value)
    nGe: t.i64(),
    sumGe: t.i64(),
    updatedAt: t.timestamp(),
  }),
);
export type OppStat = Infer<typeof oppStat.rowType>;

// Per bot, over d_match_seat: what botSummary needs without a scan.
export const seatStat = table(
  { public: true },
  t.row("SeatStat", {
    botId: t.u64().primaryKey(),
    matches: t.i64(),
    wins: t.i64(),
    sumPlace: t.i64(),
    sumScore: t.i64(),
    sumWonTiles: t.i64(),
    sumPaid: t.i64(),
    sumWords: t.i64(),
    sumLettersPlayed: t.i64(),
    sumTilesLeft: t.i64(),
    updatedAt: t.timestamp(),
  }),
);
export type SeatStat = Infer<typeof seatStat.rowType>;

// ---------- Fitted models (model.ts) ----------

// bot_id 0 is the market. dataAt is the newest observation the fit saw, so
// a reader knows whether it's stale. params is model.ts's JSON
// ({ tag, params, meanRack }).
export const bidModel = table(
  { public: true },
  t.row("BidModel", {
    botId: t.u64().primaryKey(),
    fittedAt: t.timestamp(),
    dataAt: t.timestamp(),
    nObs: t.u64(),
    params: t.string(),
  }),
);
export type BidModel = Infer<typeof bidModel.rowType>;

// ---------- RABBOT telemetry ----------

// Every live log record (logs/decisions-*.jsonl), losslessly: `type` is the
// record type ("auction", "word", "match_end", "error", ...), `json` the
// whole record. The typed rabbot_* tables below are convenience projections.
export const rabbotEvent = table(
  {
    name: "rabbot_event",
    public: true,
    indexes: [
      { accessor: "eventByType", algorithm: "btree", columns: ["type"] },
      { accessor: "eventByMatch", algorithm: "btree", columns: ["matchId"] },
      { accessor: "eventByAt", algorithm: "btree", columns: ["at"] },
    ],
  },
  t.row("RABBOTEvent", {
    id: t.u64().primaryKey().autoInc(),
    // Client time of the record (its `t`).
    at: t.timestamp(),
    type: t.string(),
    matchId: t.option(t.u64()),
    auctionId: t.option(t.u64()),
    json: t.string(),
  }),
);
export type RABBOTEvent = Infer<typeof rabbotEvent.rowType>;

// The fields of a decision, shared by the table and the log_decision args.
export const decisionFields = {
  auctionId: t.u64(),
  matchId: t.u64(),
  round: t.u32(),
  letter: t.string(),
  balance: t.i64(),
  quickBid: t.i64(),
  quickMs: t.f64(),
  refinedBid: t.option(t.i64()),
  refineMs: t.option(t.f64()),
  budgetMs: t.f64(),
  // The standing bid (last one the server accepted).
  sentBid: t.i64(),
  // Smallest time left before closes_at over the sends; negative = late.
  minSlackMs: t.f64(),
  misses: t.u32(),
  refused: t.u32(),
  valueEstimate: t.option(t.f64()),
  won: t.option(t.bool()),
  paid: t.option(t.i64()),
  winnerBotId: t.option(t.u64()),
  // refineSkip / flush note / free text.
  reason: t.string(),
};

const { auctionId: _auctionId, ...decisionRest } = decisionFields;

// One row per auction RABBOT saw; re-logging the same auction (e.g. to fill
// the outcome after the close) updates it in place and keeps the first `at`.
export const rabbotDecision = table(
  {
    name: "rabbot_decision",
    public: true,
    indexes: [{ accessor: "decisionByMatch", algorithm: "btree", columns: ["matchId"] }],
  },
  t.row("RABBOTDecision", {
    auctionId: t.u64().primaryKey(),
    ...decisionRest,
    at: t.timestamp(),
  }),
);
export type RABBOTDecision = Infer<typeof rabbotDecision.rowType>;

export const wordFields = {
  matchId: t.u64(),
  round: t.u32(),
  word: t.string(),
  reward: t.i64(),
  rackBefore: t.string(),
  thinkMs: t.f64(),
  ackMs: t.option(t.f64()),
  ok: t.bool(),
  err: t.option(t.string()),
};

// Every word RABBOT tried, accepted or refused.
export const rabbotWord = table(
  {
    name: "rabbot_word",
    public: true,
    indexes: [{ accessor: "rabbotWordByMatch", algorithm: "btree", columns: ["matchId"] }],
  },
  t.row("RABBOTWord", {
    id: t.u64().primaryKey().autoInc(),
    ...wordFields,
    at: t.timestamp(),
  }),
);
export type RABBOTWord = Infer<typeof rabbotWord.rowType>;

// One row per match RABBOT played (the match_end record).
export const rabbotMatch = table(
  { name: "rabbot_match", public: true },
  t.row("RABBOTMatch", {
    matchId: t.u64().primaryKey(),
    place: t.option(t.u32()),
    seats: t.u32(),
    score: t.option(t.i64()),
    balance: t.option(t.i64()),
    coinsSpent: t.i64(),
    auctionsWon: t.u32(),
    auctions: t.u32(),
    // Space-separated words played.
    words: t.string(),
    wordPoints: t.i64(),
    unplayedTiles: t.u32(),
    winnerScore: t.option(t.i64()),
    ratingAfter: t.option(t.i32()),
    agent: t.string(),
    startedAt: t.option(t.timestamp()),
    endedAt: t.timestamp(),
  }),
);
export type RABBOTMatch = Infer<typeof rabbotMatch.rowType>;

// Singleton (id = 0): the live bot's heartbeat.
export const rabbotStatus = table(
  { name: "rabbot_status", public: true },
  t.row("RABBOTStatus", {
    id: t.u32().primaryKey(),
    heartbeatAt: t.timestamp(),
    state: t.string(),
    currentMatch: t.option(t.u64()),
    latencyMs: t.f64(),
    clockOffsetMs: t.f64(),
    version: t.string(),
    rating: t.option(t.i32()),
    rank: t.option(t.u32()),
  }),
);
export type RABBOTStatus = Infer<typeof rabbotStatus.rowType>;

// Free-form key/value: miner cursors, the validation report, the monitor's
// last snapshot.
export const meta = table(
  { public: true },
  t.row("Meta", {
    key: t.string().primaryKey(),
    value: t.string(),
    updatedAt: t.timestamp(),
  }),
);
export type Meta = Infer<typeof meta.rowType>;

const spacetimedb = schema({
  writer,
  gBot,
  gBotStats,
  gRetiredBotStats,
  gBotVersion,
  gMatch,
  gParticipant,
  gAuction,
  gTopBid,
  gWord,
  gRating,
  gTournament,
  gTournamentEntry,
  gTournamentMatch,
  gMatchMined,
  dMatchInfo,
  dMatchSeat,
  dAuctionCtx,
  dBidObs,
  dPlayObs,
  marketStat,
  oppStat,
  seatStat,
  bidModel,
  rabbotEvent,
  rabbotDecision,
  rabbotWord,
  rabbotMatch,
  rabbotStatus,
  meta,
});
export default spacetimedb;
