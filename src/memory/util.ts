// Small shared helpers for the memory tools.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** True when the module at `metaUrl` is the script node was asked to run. */
export function isMain(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(metaUrl);
  const target = path.resolve(argv1);
  return self === target || self.replace(/\.ts$/, "") === target.replace(/\.ts$/, "");
}

/** mulberry32: tiny, fast, seedable; good enough for simulation noise. */
export function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fmtUs(us: number | null | undefined): string {
  if (!us) return "-";
  return new Date(us / 1000).toISOString().replace("T", " ").slice(0, 16);
}
