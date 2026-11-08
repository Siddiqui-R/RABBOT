import assert from "node:assert/strict";
import { test } from "node:test";
import { BusyTracker, ClockSync, refineBudgetMs, sanitizeBid, sendDeadlineLocal } from "./clock.js";

test("sanitizeBid: only integers in [0, balance] reach the server", () => {
  assert.equal(sanitizeBid(7, 100), 7);
  assert.equal(sanitizeBid(7.9, 100), 7, "floored, never rounded up past what we meant");
  assert.equal(sanitizeBid(150, 100), 100, "capped at balance");
  assert.equal(sanitizeBid(-3, 100), 0);
  assert.equal(sanitizeBid(Number.NaN, 100), 0);
  assert.equal(sanitizeBid(Number.POSITIVE_INFINITY, 100), 0);
  assert.equal(sanitizeBid("12" as unknown, 100), 0);
  assert.equal(sanitizeBid(undefined, 100), 0);
  assert.equal(sanitizeBid(5, 0), 0, "broke: can't bid");
  assert.equal(sanitizeBid(5, -1), 0);
  assert.equal(sanitizeBid(5, 3.5), 3);
});

test("budget: time to the send deadline minus the margin", () => {
  // Auction opened at 0 server time, closes at 1000. Received at local 90
  // with clocks in sync, 45 ms uplink, 250 ms margin: 1000 - 45 - 90 - 250.
  const b = refineBudgetMs({ closesAtServerMs: 1000, nowLocalMs: 90, offsetMs: 0, oneWayMs: 45, safetyMarginMs: 250 });
  assert.equal(b, 615);
  assert.equal(sendDeadlineLocal(1000, 0, 45), 955);
  // Local clock 30 ms behind the server (offset -30): the deadline comes sooner locally.
  assert.equal(refineBudgetMs({ closesAtServerMs: 1000, nowLocalMs: 60, offsetMs: -30, oneWayMs: 45, safetyMarginMs: 250 }), 615);
  // Arrived late: no time to think.
  assert.ok(refineBudgetMs({ closesAtServerMs: 1000, nowLocalMs: 800, offsetMs: 0, oneWayMs: 45, safetyMarginMs: 250 }) < 0);
});

test("clock: defaults before any sample", () => {
  const c = new ClockSync({ defaultOneWayMs: 45 });
  assert.equal(c.offsetMs, 0);
  assert.equal(c.deadlineOffsetMs, 0);
  assert.equal(c.oneWayMs, 45);
  assert.equal(c.serverNow(1000), 1000);
});

test("clock: offset from receipt lag and RTT, conservative for deadlines", () => {
  const c = new ClockSync();
  // True offset +20 (local ahead), one-way 40 ms, plus 0..10 ms jitter.
  for (let i = 0; i < 50; i++) {
    const server = 1_000_000 + i * 1000;
    c.observeLag(server, server + 20 + 40 + (i % 11));
    c.observeRtt(80 + (i % 7));
  }
  assert.ok(Math.abs(c.offsetMs - 20) <= 3, `offset ${c.offsetMs}`);
  assert.equal(c.deadlineOffsetMs, 0, "never assume the local clock is ahead");
  assert.ok(Math.abs(c.oneWayMs - 41.5) <= 2, `oneWay ${c.oneWayMs}`);

  // Local clock 30 ms behind: the deadline offset follows it.
  const d = new ClockSync();
  for (let i = 0; i < 50; i++) {
    const server = 2_000_000 + i * 1000;
    d.observeLag(server, server - 30 + 40 + (i % 5));
    d.observeRtt(80);
  }
  assert.ok(Math.abs(d.deadlineOffsetMs - -30) <= 3, `deadline offset ${d.deadlineOffsetMs}`);
  assert.ok(d.serverNow(10_000) > 10_000);
});

test("clock: junk samples are ignored", () => {
  const c = new ClockSync();
  c.observeLag(Number.NaN, 5);
  c.observeLag(0, 1e9);
  c.observeRtt(-1);
  c.observeRtt(Number.POSITIVE_INFINITY);
  assert.equal(c.lagCount, 0);
  assert.equal(c.rttCount, 0);
});

test("busy tracker: drops samples that spanned blocking work", () => {
  const b = new BusyTracker();
  b.mark(100, 700);
  assert.ok(b.overlaps(90, 200));
  assert.ok(b.overlaps(650, 750));
  assert.ok(!b.overlaps(700, 800));
  assert.ok(!b.overlaps(0, 100));
  b.mark(900, 901); // under 2 ms: not worth remembering
  assert.ok(!b.overlaps(899, 902));
});
