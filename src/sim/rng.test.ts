// ServerRandom must be the live server's ctx.random, bug for bug.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { ServerRandom } from "./rng.js";

const SDK_RNG = new URL("../../node_modules/spacetimedb/src/server/rng.ts", import.meta.url);

test("ServerRandom gives the SDK's known answers", () => {
  // Values printed by spacetimedb/src/server/rng.ts makeRandomFromSeed(t):
  // uint32 (signed, as unsafeNext returns it), integerInRange(0,97), (-2,2), (0,0), (0,5), uint32.
  const known: [bigint, number[]][] = [
    [1_790_000_000_000_000n, [-1451476108, 10, -1, 0, 1, -2139920149]],
    [1_761_350_400_123_456n, [1016829597, 89, 1, 0, 2, -515886402]],
  ];
  for (const [t, want] of known) {
    const r = new ServerRandom(t);
    assert.deepEqual([r.unsafeNext(), r.int(0, 97), r.int(-2, 2), r.int(0, 0), r.int(0, 5), r.unsafeNext()], want, String(t));
  }
  // A degenerate timestamp: PCG's signed rotate yields seed -1, so the
  // first output is ~(-1) = 0.
  assert.equal(new ServerRandom(1_790_000_000_000_022n).unsafeNext(), 0);
});

test("ServerRandom matches the SDK's makeRandomFromSeed draw for draw", { skip: !fs.existsSync(SDK_RNG) && "SDK source not installed" }, async () => {
  const sdk = (await import(SDK_RNG.href)) as {
    makeRandomFromSeed(seed: bigint): { uint32(): number; integerInRange(a: number, b: number): number };
  };
  const ranges: [number, number][] = [[0, 97], [-2, 2], [0, 0], [0, 1], [0, 5], [0, 67], [3, 40]];
  for (let k = 0; k < 2000; k++) {
    const t = 1_790_000_000_000_000n + BigInt(k) * 999_983n + BigInt(k % 7);
    const a = sdk.makeRandomFromSeed(t);
    const b = new ServerRandom(t);
    for (let d = 0; d < 40; d++) {
      const [lo, hi] = ranges[d % ranges.length]!;
      if (d % 9 === 0) assert.equal(b.unsafeNext(), a.uint32(), `t=${t} draw ${d}`);
      else assert.equal(b.int(lo, hi), a.integerInRange(lo, hi), `t=${t} draw ${d} [${lo},${hi}]`);
    }
  }
});

test("the server's draws are skewed: some indices come up ~3x too often", () => {
  const n = 68;
  const counts = new Array<number>(n).fill(0);
  const N = 40_000;
  for (let k = 0; k < N; k++) counts[new ServerRandom(1_790_000_000_000_000 + k * 1_000_003).int(0, n - 1)]!++;
  const max = Math.max(...counts);
  assert.ok(max / (N / n) > 2.3, `max/expected ${(max / (N / n)).toFixed(2)}`);
  // 2^31 mod 68 = 60: where seed -1 (first output 0) lands.
  assert.equal(counts.indexOf(max), 2 ** 31 % n);
});
