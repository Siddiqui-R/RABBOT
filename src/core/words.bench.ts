// Word engine timings on realistic racks: tiles drawn without replacement
// from the real 98-tile bag. Run with `npm run bench:words [racksPerSize]`.

import { DEFAULT_BAG, emptyCounts, type Counts } from "./rules.js";
import { DEFAULT_PARTITION_BUDGET_MS, getWordEngine } from "./words.js";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `size` tiles drawn without replacement from the standard bag. */
export function randomRack(rand: () => number, size: number): Counts {
  const bag: number[] = [];
  DEFAULT_BAG.forEach((n, l) => {
    for (let i = 0; i < n; i++) bag.push(l);
  });
  const rack = emptyCounts();
  for (let i = 0; i < size && bag.length > 0; i++) {
    const j = Math.floor(rand() * bag.length);
    rack[bag[j]!]!++;
    bag[j] = bag[bag.length - 1]!;
    bag.pop();
  }
  return rack;
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function time(racks: Counts[], fn: (rack: Counts) => unknown): string {
  for (let i = 0; i < Math.min(50, racks.length); i++) fn(racks[i]!); // warm up
  const ms: number[] = [];
  for (const rack of racks) {
    const t = performance.now();
    fn(rack);
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const mean = ms.reduce((s, x) => s + x, 0) / ms.length;
  const f = (x: number) => x.toFixed(3).padStart(8);
  return `p50 ${f(pct(ms, 0.5))}  p99 ${f(pct(ms, 0.99))}  max ${f(ms[ms.length - 1]!)}  mean ${f(mean)} ms`;
}

function main(): void {
  const perSize = Number(process.argv[2] ?? 2000);
  const t0 = performance.now();
  const engine = getWordEngine();
  const loadMs = performance.now() - t0;
  const s = engine.stats;
  console.log(
    `load ${loadMs.toFixed(0)} ms (build ${s.loadMs.toFixed(0)} ms): ${s.lines} lines, ` +
      `${s.words} words, ${s.nonAZ} non A-Z, ${s.groups} anagram groups, ${s.nodes} trie nodes`,
  );
  const rand = mulberry32(12345);
  for (const size of [5, 7, 10, 12, 15, 16, 20]) {
    const racks = Array.from({ length: perSize }, () => randomRack(rand, size));
    let words = 0;
    for (const r of racks) words += engine.countPlayable(r);
    console.log(`\n${size}-tile racks (${perSize}), mean ${(words / perSize).toFixed(0)} playable words`);
    console.log(`  best             ${time(racks, (r) => engine.best(r))}`);
    console.log(`  topK(10)         ${time(racks, (r) => engine.topK(r, 10))}`);
    console.log(`  serverBest(3)    ${time(racks, (r) => engine.serverBestPlayable(r, 3))}`);
    console.log(`  playable         ${time(racks, (r) => engine.playable(r))}`);
    console.log(`  bestPartition    ${time(racks, (r) => engine.bestPartition(r))}`);
    const unfinished = racks.filter((r) => !engine.bestPartition(r).optimal).length;
    console.log(`    hit the default ${DEFAULT_PARTITION_BUDGET_MS} ms budget: ${unfinished}/${racks.length}`);
  }
  const mb = (process.memoryUsage().heapUsed / 2 ** 20).toFixed(0);
  console.log(`\nheap in use: ${mb} MB`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
