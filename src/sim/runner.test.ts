// Replays, parallel runs, seat plans, stats, the registry, and a fidelity
// check against live all-sim matches.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { LETTERS } from "../core/rules.js";
import { Engine } from "./engine.js";
import { assignBotIds, importIfPresent, loadRegistry, parseSeatSpec, parseTable, SIM_POOL, SYNTHETIC_ID_BASE } from "./registry.js";
import { planGame, prepare, runMatches } from "./runner.js";
import { aggregate, clusteredEstimate, placesAndWins } from "./stats.js";
import { Rng, ServerRandom, deriveSeed, serverStartUs } from "./rng.js";

const TABLE = "starter,sim:Cheapskate,sim:ValueBidder,sim:Aggressive,starter,sim:ValueBidder";

test("rng: same keys replay, different keys differ, int() covers its range evenly", () => {
  const a = new Rng(42, "bag");
  const b = new Rng(42, "bag");
  const c = new Rng(42, "ties");
  const xs = Array.from({ length: 50 }, () => a.nextU32());
  assert.deepEqual(Array.from({ length: 50 }, () => b.nextU32()), xs);
  assert.notDeepEqual(Array.from({ length: 50 }, () => c.nextU32()), xs);
  assert.notEqual(deriveSeed(1, 2), deriveSeed(2, 1));
  assert.notEqual(deriveSeed(2 ** 32), deriveSeed(0));
  const counts = new Array<number>(5).fill(0);
  for (let i = 0; i < 50_000; i++) counts[a.int(-2, 2) + 2]!++;
  for (const n of counts) assert.ok(n > 9_500 && n < 10_500, `${counts}`);
});

test("a (seed, table) pair replays exactly; another seed doesn't", async () => {
  const run = (seed: number) => runMatches({ table: TABLE, games: 12, seed, keepRecords: true });
  const [a, b, c] = await Promise.all([run(5), run(5), run(6)]);
  assert.deepEqual(a.records, b.records);
  assert.deepEqual(a.stats, b.stats);
  assert.notDeepEqual(a.records, c.records);
});

test("an engine replays exactly from its seed", () => {
  const play = (seed: number) => {
    const e = new Engine({
      seed,
      seats: [
        { botId: 1, isSim: true, strategy: "Cheapskate" },
        { botId: 2, isSim: true, strategy: "ValueBidder" },
        { botId: 3, isSim: true, strategy: "Aggressive" },
      ],
    });
    e.start();
    while (!e.closeAuction());
    return JSON.stringify([e.history, e.participants]);
  };
  assert.equal(play(11), play(11));
  assert.notEqual(play(11), play(12));
});

test("worker threads give the same records as one thread", async () => {
  const opts = { table: TABLE, games: 24, seed: 9, keepRecords: true, swap: true };
  const one = await runMatches({ ...opts, workers: 1 });
  const three = await runMatches({ ...opts, workers: 3, chunkSize: 2 });
  assert.equal(three.workers, 3);
  assert.deepEqual(three.records, one.records);
  assert.deepEqual(three.stats, one.stats);
});

test("swap plays every deal in every rotation, on the same letters", async () => {
  const ctx = await prepare({ table: "starter,sim:Aggressive,sim:Cheapskate", games: 0, swap: true, seed: 3 });
  const plans = [0, 1, 2, 3].map((g) => planGame(ctx, g));
  assert.deepEqual(plans.map((p) => [p.deal, p.rotation]), [[0, 0], [0, 1], [0, 2], [1, 0]]);
  assert.equal(plans[0]!.dealSeed, plans[2]!.dealSeed);
  assert.notEqual(plans[0]!.dealSeed, plans[3]!.dealSeed);
  // Each spec sits in each position once per deal.
  for (let pos = 0; pos < 3; pos++) {
    assert.deepEqual(new Set(plans.slice(0, 3).map((p) => p.seats[pos]!.spec.spec)).size, 3);
  }
  // Rotations share the letter sequence: same deal seed and, with no bids
  // here, the same draws (in server mode a close's tie shuffle comes first,
  // so letters can shift with the number of positive bids).
  const r = await runMatches({ table: "starter,sim:Aggressive,sim:Cheapskate", games: 3, swap: true, seed: 3, keepRecords: true });
  assert.equal(r.games, 3);
  assert.equal(r.deals, 1);
  const letters = (seed: number) => {
    const e = new Engine({ seed, seats: [{ botId: 1, isSim: false }, { botId: 2, isSim: false }, { botId: 3, isSim: false }] });
    e.start();
    const out: string[] = [];
    while (e.status === "Running") {
      out.push(e.auction!.letter);
      e.closeAuction();
    }
    return out.join("");
  };
  assert.equal(letters(plans[0]!.dealSeed), letters(plans[1]!.dealSeed));
  // games rounds up to whole deals
  assert.equal((await runMatches({ table: "starter,sim:Aggressive", games: 3, swap: true })).games, 4);
});

test("pad fills the table from the server's sim pool, like a lobby timeout", async () => {
  const ctx = await prepare({ table: "starter,sim:Aggressive", games: 0, pad: true, seed: 2 });
  const seen = new Map<number, number>();
  for (let g = 0; g < 300; g++) {
    const plan = planGame(ctx, g);
    assert.equal(plan.seats.length, 6);
    const ids = plan.seats.map((s) => s.botId);
    assert.equal(new Set(ids).size, 6, "distinct sims");
    assert.equal(ids[0], SYNTHETIC_ID_BASE);
    assert.equal(ids[1], 3, "an Aggressive seat takes Brutus-sim's id");
    for (const s of plan.seats.slice(2)) {
      const pool = SIM_POOL.find((p) => p.botId === s.botId);
      assert.ok(pool && s.isSim && s.spec.strategy === pool.strategy);
      seen.set(s.botId, (seen.get(s.botId) ?? 0) + 1);
    }
  }
  // 4 of the 5 remaining sims each time, chosen at random.
  assert.deepEqual([...seen.keys()].sort(), [1, 2, 4, 5, 6]);
  for (const n of seen.values()) assert.ok(n > 200 && n < 280, `${[...seen]}`);
});

test("server rng: lobby padding shuffles the sim pool with the start transaction's ctx.random", async () => {
  const ctx = await prepare({ table: "starter,sim:Aggressive", games: 0, pad: true, seed: 2 });
  for (let g = 0; g < 50; g++) {
    const plan = planGame(ctx, g);
    const pool = SIM_POOL.filter((s) => s.botId !== 3);
    new ServerRandom(serverStartUs(plan.dealSeed)).shuffle(pool);
    assert.deepEqual(plan.seats.slice(2).map((s) => s.botId), pool.slice(0, 4).map((s) => s.botId));
    assert.equal(plan.lobbyShuffle, 5, "every available sim is shuffled, even those not taken");
  }
  // A full table never timed out: no padding, no shuffle.
  const full = await prepare({ table: "starter,starter,starter,starter,starter,starter", games: 0, pad: true });
  assert.equal(planGame(full, 0).lobbyShuffle, 0);
  const streams = await prepare({ table: "starter", games: 0, pad: true, rng: "streams" });
  assert.equal(planGame(streams, 0).lobbyShuffle, 0);
});

// First-auction letters of all 5,487 live matches mined by 2026-10-25
// (auction_ctx round_idx 0). A fair draw gives D 4.1%; live it is 7.1%.
const LIVE_FIRST_LETTER: Record<string, number> = {
  A: 455, B: 87, C: 104, D: 388, E: 683, F: 119, G: 161, H: 101, I: 558, J: 94, K: 50, L: 188, M: 109,
  N: 313, O: 388, P: 100, Q: 48, R: 305, S: 240, T: 320, U: 232, V: 106, W: 126, X: 60, Y: 95, Z: 57,
};

test("server rng reproduces the live first-letter skew; fair streams don't", () => {
  // Regression for the uniform-RNG simulator. Most live matches start from
  // a lobby that filled with real bots: no padding shuffle before the deal.
  const live = [...LETTERS].map((l) => LIVE_FIRST_LETTER[l]!);
  const nLive = live.reduce((a, b) => a + b, 0);
  const chi2 = (rng: "server" | "streams") => {
    const counts = new Array<number>(26).fill(0);
    const N = 30_000;
    for (let seed = 0; seed < N; seed++) {
      const e = new Engine({ seed, rng, seats: Array.from({ length: 6 }, (_, i) => ({ botId: 101 + i, isSim: false })) });
      e.start();
      counts[e.auction!.letter.charCodeAt(0) - 65]!++;
    }
    return live.reduce((x, o, i) => {
      const exp = (counts[i]! / N) * nLive;
      return x + (o - exp) ** 2 / exp;
    }, 0);
  };
  const server = chi2("server");
  const streams = chi2("streams");
  // 25 degrees of freedom: 52.6 is the 0.1% critical value.
  assert.ok(server < 52.6, `server-rng chi2 ${server.toFixed(1)}`);
  assert.ok(streams > 120, `fair-stream chi2 ${streams.toFixed(1)} should reject`);
});

test("places share ties; wins split ties", () => {
  assert.deepEqual(placesAndWins([10, 30, 20]), { place: [3, 1, 2], winShare: [0, 1, 0] });
  assert.deepEqual(placesAndWins([30, 30, 5, 5]), { place: [1.5, 1.5, 3.5, 3.5], winShare: [0.5, 0.5, 0, 0] });
  assert.deepEqual(placesAndWins([7, 7, 7]), { place: [2, 2, 2], winShare: [1 / 3, 1 / 3, 1 / 3] });
});

test("clustered estimate: plain mean and standard error when clusters are single", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const e = clusteredEstimate(xs.map((x) => ({ sum: x, n: 1 })));
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - 4.5) ** 2, 0) / 7);
  assert.equal(e.mean, 4.5);
  assert.ok(Math.abs(e.halfWidth - (1.96 * sd) / Math.sqrt(8)) < 1e-12);
  assert.ok(Number.isNaN(clusteredEstimate([{ sum: 3, n: 1 }]).halfWidth));
});

test("aggregate reports every requested metric per spec", async () => {
  const r = await runMatches({ table: TABLE, games: 10, seed: 1, keepRecords: true });
  assert.deepEqual(r.stats.map((s) => s.spec), ["starter", "sim:Cheapskate", "sim:ValueBidder", "sim:Aggressive"]);
  const starter = r.stats[0]!;
  assert.equal(starter.games, 20);
  assert.equal(starter.deals, 10);
  for (const k of ["score", "place", "winRate", "coinsLeft", "tilesLeft"] as const) {
    assert.ok(Number.isFinite(starter[k].mean) && Number.isFinite(starter[k].halfWidth), k);
  }
  assert.equal(starter.bidRejections, 0);
  assert.equal(starter.agentErrors, 0);
  // Places across a table always sum to 1 + 2 + ... + 6, wins to 1.
  const total = r.stats.reduce((s, x) => s + x.place.mean * x.games, 0);
  assert.ok(Math.abs(total - 21 * 10) < 1e-9);
  assert.ok(Math.abs(r.stats.reduce((s, x) => s + x.winRate.mean * x.games, 0) - 10) < 1e-9);
  assert.deepEqual(aggregate(r.records!), r.stats);
});

test("seat specs parse, and bad ones explain themselves", () => {
  assert.deepEqual(parseSeatSpec(" sim:aggressive "), { spec: "sim:Aggressive", kind: "sim", strategy: "Aggressive" });
  assert.deepEqual(parseSeatSpec("clone:42"), { spec: "clone:42", kind: "clone", cloneBotId: 42 });
  assert.deepEqual(parseSeatSpec("rabbot#b"), { spec: "rabbot#b", kind: "rabbot", variant: "b" });
  assert.throws(() => parseSeatSpec("sim:Greedy"), /unknown sim strategy/);
  assert.throws(() => parseSeatSpec("gpt"), /unknown seat spec 'gpt'/);
  const ids = assignBotIds(parseTable("sim:Cheapskate,sim:Cheapskate,sim:Cheapskate,clone:77,clone:77,starter"));
  assert.deepEqual(
    ids.map((p) => p.botId),
    [1, 6, SYNTHETIC_ID_BASE, 77, SYNTHETIC_ID_BASE + 1, SYNTHETIC_ID_BASE + 2],
  );
});

test("optional modules load by .js name, and missing ones come back undefined", async () => {
  const stats = await importIfPresent("./stats.js");
  assert.equal(typeof stats?.["placesAndWins"], "function");
  assert.equal(await importIfPresent("./no-such-module.js"), undefined);
});

test("rabbot and clone seats load through the factory conventions, or say what's missing", async () => {
  const src = path.join(import.meta.dirname, "..");
  for (const [spec, file, name] of [
    ["rabbot", "brain/index.ts", "rabbot"],
    ["clone:42", "memory/clones.ts", "clone:42"],
  ] as const) {
    const specs = parseTable(spec);
    if (!fs.existsSync(path.join(src, file))) {
      await assert.rejects(loadRegistry(specs, { model: false }), new RegExp(`src/${file}, which doesn't exist yet`));
    } else {
      const reg = await loadRegistry(specs, { model: false });
      assert.equal(reg.create(specs[0]!, 1)?.name, name);
    }
  }
});

// Live all-sim matches (6 sims, Vickrey, 68 auctions), read from the public
// match_participant table on 2026-10-24: 59 matches, 118 seats per strategy.
const LIVE_ALL_SIM = {
  "sim:Cheapskate": { score: 4.21, scoreCi: 1.31, coins: 103.1 },
  "sim:ValueBidder": { score: 13.74, scoreCi: 1.37, coins: 103.8 },
  "sim:Aggressive": { score: 74.85, scoreCi: 2.87, coins: 42.9 },
};

test("all-sim tables reproduce live all-sim matches", async () => {
  const r = await runMatches({
    table: "sim:Cheapskate,sim:ValueBidder,sim:Aggressive,sim:ValueBidder,sim:Aggressive,sim:Cheapskate",
    games: 2000,
    seed: 2026,
  });
  for (const s of r.stats) {
    const live = LIVE_ALL_SIM[s.spec as keyof typeof LIVE_ALL_SIM];
    // Both have sampling error; allow the live interval plus ours.
    const tol = live.scoreCi + s.score.halfWidth;
    assert.ok(Math.abs(s.score.mean - live.score) <= tol, `${s.spec}: sim ${s.score.mean.toFixed(2)} vs live ${live.score}`);
    assert.ok(Math.abs(s.coinsLeft.mean - live.coins) <= 3, `${s.spec} coins: sim ${s.coinsLeft.mean.toFixed(1)} vs live ${live.coins}`);
  }
});
