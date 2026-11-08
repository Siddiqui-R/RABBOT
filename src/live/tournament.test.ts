import assert from "node:assert/strict";
import { test } from "node:test";
import { finalMatchIds, heldBy, isTournamentHold, registerBackoffMs, toRegister } from "./tournament.js";

const tour = (id: bigint, tag: string) => ({ id, status: { tag } });
const entry = (tournamentId: bigint, botId: bigint, eliminated = false) => ({ tournamentId, botId, eliminated });

test("tournament: registers for every open tournament it is not in", () => {
  const ts = [tour(3n, "Registration"), tour(1n, "Ended"), tour(2n, "Registration"), tour(4n, "Swiss")];
  assert.deepEqual(toRegister(ts, [], 7n), [2n, 3n]);
  assert.deepEqual(toRegister(ts, [entry(2n, 7n)], 7n), [3n]);
  assert.deepEqual(toRegister(ts, [entry(2n, 8n), entry(3n, 8n)], 7n), [2n, 3n], "other bots' entries don't count");
  assert.deepEqual(toRegister([tour(4n, "Swiss"), tour(5n, "ForceEnded")], [], 7n), [], "never after the start");
});

test("tournament: backoff doubles from 2 s and caps at 60 s", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(registerBackoffMs), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(registerBackoffMs(0), 2000);
});

test("tournament: held only while still in contention in one under way", () => {
  const ts = [tour(1n, "Registration"), tour(2n, "Bracket"), tour(3n, "Ended")];
  assert.equal(heldBy(ts, [entry(1n, 7n)], 7n), null, "registration: the lobby is open");
  assert.equal(heldBy(ts, [entry(2n, 7n)], 7n), 2n);
  assert.equal(heldBy(ts, [entry(2n, 7n, true)], 7n), null, "knocked out");
  assert.equal(heldBy(ts, [entry(3n, 7n)], 7n), null, "ended");
  assert.equal(heldBy(ts, [entry(2n, 8n)], 7n), null);
  assert.ok(isTournamentHold("You're playing in a tournament; the lobby reopens to you when you're knocked out or it ends"));
  assert.ok(!isTournamentHold("You're already in a running match"));
});

test("tournament: final games of my tournaments only", () => {
  const ms = [
    { tournamentId: 2n, matchId: 30n, phase: { tag: "Final" } },
    { tournamentId: 2n, matchId: 20n, phase: { tag: "Swiss" } },
    { tournamentId: 2n, matchId: 28n, phase: { tag: "Final" } },
    { tournamentId: 1n, matchId: 9n, phase: { tag: "Final" } },
  ];
  assert.deepEqual(finalMatchIds(ms, [entry(2n, 7n)], 7n), [28n, 30n]);
  assert.deepEqual(finalMatchIds(ms, [], 7n), []);
});
