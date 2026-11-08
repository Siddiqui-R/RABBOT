import assert from "node:assert/strict";
import { test } from "node:test";
import { feedStalled, stallLimitMs } from "./watchdog.js";

test("watchdog: 5 auctions of silence, at least 6 s", () => {
  assert.equal(stallLimitMs(1000), 6000);
  assert.equal(stallLimitMs(500), 6000);
  assert.equal(stallLimitMs(3000), 15000);
  assert.equal(stallLimitMs(NaN), 6000);
  assert.equal(stallLimitMs(1000, 20000), 20000, "override");
  assert.equal(stallLimitMs(1000, 0), 6000, "0 = default");
  assert.ok(!feedStalled(10_000, 5_000, 1000));
  assert.ok(feedStalled(12_000, 5_000, 1000));
  assert.ok(!feedStalled(12_000, 5_000, 3000));
});
