import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PARAMS } from "./params.js";
import { placeView, type Standing } from "./place.js";

const P = { ...DEFAULT_PARAMS };
const s = (botId: number, score: number): Standing => ({ botId, score, balance: 20, rackSize: 3 });

test("rival weights sum to 1 and concentrate on the nearest rivals as the match ends", () => {
  const me = s(1, 60);
  const rivals = [s(2, 62), s(3, 120), s(4, 10)];
  const early = placeView(me, rivals, 0.4, 1, P);
  const late = placeView(me, rivals, 0.4, 0.05, P);
  for (const v of [early, late]) assert.ok(Math.abs(v.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(late.weights[0]! > 0.95, `nearest rival late: ${late.weights[0]}`);
  assert.ok(early.weights[0]! < late.weights[0]!);
  assert.ok(late.sigma < early.sigma);
});

test("tilt is positive when trailing the rivals that matter, negative when leading", () => {
  const behind = placeView(s(1, 50), [s(2, 70), s(3, 75)], 0.4, 0.3, P);
  const ahead = placeView(s(1, 90), [s(2, 70), s(3, 75)], 0.4, 0.3, P);
  assert.ok(behind.tilt > 0);
  assert.ok(ahead.tilt < 0);
});
