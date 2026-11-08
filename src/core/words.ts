// The word engine: every dictionary question our own decisions ask, fast.
//
// Words are grouped by anagram signature (their letters, sorted) and the
// signatures form a trie keyed by those sorted letters. The words a rack can
// spell are exactly the trie nodes reachable while spending the rack's letter
// counts, so a search costs the rack's sub-multisets, not the dictionary.
// Anagrams share their letters, so they share length and reward too: searches
// rank signature groups, and only the winners are expanded into words.
//
// The trie is flat typed arrays. A node's children are contiguous and its
// 26-bit child mask finds a child by popcount, so the inner loop only touches
// letters that are both on the rack and below the node. Each node also keeps
// the best rank in its subtree, which lets "best word" searches skip any
// subtree that can't beat what they already hold.

import * as fs from "node:fs";
import * as path from "node:path";
import { LETTER_VALUES, lengthMultiplier, wordReward, type Counts } from "./rules.js";

export const WORDLIST_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "data",
  "wordlist.txt",
);

/**
 * Letter order inside signatures, rarest in the dictionary first. Rare letters
 * end most branches at the root for racks that lack them, and they are the
 * high-value letters, so best-first searches meet good words early.
 */
export const TRIE_ORDER = "QJXZKVWFYBHGMPCUDOLTNRAISE";

const NONE = 0x7fffffff;
// A word never needs more of one letter than this; clamping keeps typed
// arrays small and makes absurd rack counts harmless.
const MAX_COUNT = 64;
const EPS = 1e-9;
/** bestPartition time cap when the caller gives none. */
export const DEFAULT_PARTITION_BUDGET_MS = 20;

export interface WordHit {
  word: string;
  reward: number;
}

export interface LengthOpts {
  /** Shortest word to consider. Default (and floor) 2: shorter isn't a word. */
  minLen?: number;
  maxLen?: number;
}

export interface PartitionOpts extends LengthOpts {
  maxWords?: number;
  /** Search time cap. The best partition found so far is returned on expiry. */
  timeBudgetMs?: number;
}

export interface Partition {
  /** Best reward first; each word spellable from what the earlier ones left. */
  words: string[];
  total: number;
  /** True when the search finished: no partition beats this one. */
  optimal: boolean;
}

export interface EngineStats {
  /** Non-empty lines in the word list, as the server reads it. */
  lines: number;
  /** Lines the server accepts as words: A-Z only, 2+ letters. */
  words: number;
  /** Lines with characters outside A-Z (the server can never accept them). */
  nonAZ: number;
  /** Whether the list is sorted, which the server's binary search assumes. */
  sorted: boolean;
  groups: number;
  nodes: number;
  loadMs: number;
}

function popcnt(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Rust's `to_ascii_uppercase`, as the server applies it: a-z only. */
function asciiUpper(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) {
      return s.replace(/[a-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 32));
    }
  }
  return s;
}

function isAZ(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 65 || c > 90) return false;
  }
  return true;
}

export class WordEngine {
  readonly stats: EngineStats;
  /** The word list exactly as the server reads it (non-empty lines). */
  readonly lexWords: readonly string[];

  private readonly validSet: Set<string> | null;
  private readonly rankOf = new Int32Array(26); // natural letter -> trie rank

  // Signature groups, numbered in trie (signature) order.
  private readonly gStart: Int32Array; // group g's words: gWords[gStart[g]..gStart[g+1])
  private readonly gWords: string[]; // alphabetical within each group
  private readonly wGroup: Int32Array; // gWords index -> group
  private readonly gLen: Uint8Array;
  private readonly gReward: Int32Array;
  /** Word order for best(): reward desc, length desc, word asc. */
  private readonly wRank: Int32Array; // gWords index -> rank
  private readonly byRank: Int32Array; // rank -> gWords index
  /** A group's best word rank: its alphabetically first word's. */
  private readonly gRank: Int32Array;
  /** Order for the server's findBestPlayable: length desc, word asc. */
  private readonly gSrv: Int32Array;

  // Trie nodes, breadth-first, so children always follow their parent.
  private readonly nMask: Int32Array;
  private readonly nFirst: Int32Array;
  private readonly nGroup: Int32Array;
  private readonly nMaxLen: Uint8Array;
  private readonly nMinRank: Int32Array;
  private readonly nMinSrv: Int32Array;

  // Scratch for the current search; the engine is single-threaded.
  private readonly avail = new Int32Array(26); // by trie rank
  private availMask = 0;

  constructor(text: string, order: string = TRIE_ORDER) {
    const t0 = performance.now();
    if (order.length !== 26 || new Set(order).size !== 26 || !isAZ(order)) {
      throw new Error(`bad trie order ${order}`);
    }
    for (let r = 0; r < 26; r++) this.rankOf[order.charCodeAt(r) - 65] = r;

    // Exactly the server's lexWords(): split on \n, drop empty lines.
    const lex = text.split("\n").filter((l) => l.length > 0);
    this.lexWords = lex;
    let sorted = true;
    for (let i = 1; i < lex.length; i++) {
      if (lex[i - 1]! > lex[i]!) {
        sorted = false;
        break;
      }
    }

    // Signature = the word's letters in trie order, each letter encoded as
    // 'A' + its rank so plain string order is trie order.
    const sigWords = new Map<string, number[]>(); // signature -> lex indices
    const cnt = new Uint8Array(26);
    const rankChar = Array.from({ length: 26 }, (_, r) => String.fromCharCode(65 + r));
    let nonAZ = 0;
    let valid = 0;
    const validSet = sorted ? new Set<string>() : null;
    for (let li = 0; li < lex.length; li++) {
      const w = lex[li]!;
      if (!isAZ(w)) {
        nonAZ++;
        continue;
      }
      if (w.length >= 2) {
        valid++;
        validSet?.add(w);
      }
      cnt.fill(0);
      for (let i = 0; i < w.length; i++) cnt[this.rankOf[w.charCodeAt(i) - 65]!]!++;
      let sig = "";
      for (let r = 0; r < 26; r++) if (cnt[r]) sig += rankChar[r]!.repeat(cnt[r]!);
      const list = sigWords.get(sig);
      if (list) list.push(li);
      else sigWords.set(sig, [li]);
    }
    this.validSet = validSet;

    const sigs = [...sigWords.keys()].sort();
    const G = sigs.length;
    // Alphabetical position of every lex line (identity when sorted).
    const alpha = new Int32Array(lex.length);
    if (sorted) for (let i = 0; i < lex.length; i++) alpha[i] = i;
    else {
      const order = Array.from({ length: lex.length }, (_, i) => i);
      order.sort((a, b) => (lex[a]! < lex[b]! ? -1 : lex[a]! > lex[b]! ? 1 : 0));
      order.forEach((li, pos) => (alpha[li] = pos));
    }

    this.gStart = new Int32Array(G + 1);
    this.gWords = [];
    this.gLen = new Uint8Array(G);
    this.gReward = new Int32Array(G);
    const wAlpha: number[] = [];
    const wGroup: number[] = [];
    let sigChars = 0;
    for (let g = 0; g < G; g++) {
      const ws = sigWords.get(sigs[g]!)!;
      ws.sort((a, b) => alpha[a]! - alpha[b]!);
      this.gStart[g] = this.gWords.length;
      for (const li of ws) {
        this.gWords.push(lex[li]!);
        wAlpha.push(alpha[li]!);
        wGroup.push(g);
      }
      this.gLen[g] = Math.min(255, lex[ws[0]!]!.length);
      this.gReward[g] = wordReward(lex[ws[0]!]!);
      sigChars += sigs[g]!.length;
    }
    this.gStart[G] = this.gWords.length;
    this.wGroup = Int32Array.from(wGroup);

    // Rank orders packed one float per key, (primary key) * span + alphabet
    // position, so a typed-array sort does the work and the alphabet position
    // decodes the winner. Rewards stay far below 1024 and lengths below 64.
    const W = this.gWords.length;
    const span = lex.length;
    const alphaToWord = new Int32Array(span);
    for (let i = 0; i < W; i++) alphaToWord[wAlpha[i]!] = i;
    const keys = new Float64Array(W);
    for (let i = 0; i < W; i++) {
      const g = wGroup[i]!;
      keys[i] = ((1023 - this.gReward[g]!) * 64 + (63 - Math.min(63, this.gLen[g]!))) * span + wAlpha[i]!;
    }
    keys.sort();
    this.wRank = new Int32Array(W);
    this.byRank = new Int32Array(W);
    for (let r = 0; r < W; r++) {
      const i = alphaToWord[keys[r]! % span]!;
      this.byRank[r] = i;
      this.wRank[i] = r;
    }
    this.gRank = new Int32Array(G);
    for (let g = 0; g < G; g++) this.gRank[g] = this.wRank[this.gStart[g]!]!;
    // Server order: length desc, then alphabetical, over each group's first word.
    const srvKeys = new Float64Array(G);
    for (let g = 0; g < G; g++) {
      srvKeys[g] = (255 - this.gLen[g]!) * span + wAlpha[this.gStart[g]!]!;
    }
    srvKeys.sort();
    this.gSrv = new Int32Array(G);
    for (let r = 0; r < G; r++) this.gSrv[wGroup[alphaToWord[srvKeys[r]! % span]!]!] = r;

    // Breadth-first trie over the sorted signatures: node i covers the
    // signature range [lo, hi) sharing its first `depth` letters.
    const cap = sigChars + 1;
    const mask = new Int32Array(cap);
    const first = new Int32Array(cap);
    const group = new Int32Array(cap).fill(-1);
    const lo = new Int32Array(cap);
    const hi = new Int32Array(cap);
    const depth = new Uint8Array(cap);
    hi[0] = G;
    let n = 1;
    for (let node = 0; node < n; node++) {
      let a = lo[node]!;
      const b = hi[node]!;
      const d = depth[node]!;
      // A signature equal to the prefix sorts before its extensions.
      if (a < b && sigs[a]!.length === d) group[node] = a++;
      first[node] = n;
      let m = 0;
      while (a < b) {
        const c = sigs[a]!.charCodeAt(d);
        let j = a + 1;
        while (j < b && sigs[j]!.charCodeAt(d) === c) j++;
        m |= 1 << (c - 65);
        lo[n] = a;
        hi[n] = j;
        depth[n] = d + 1;
        n++;
        a = j;
      }
      mask[node] = m;
    }
    this.nMask = mask.slice(0, n);
    this.nFirst = first.slice(0, n);
    this.nGroup = group.slice(0, n);
    this.nMaxLen = new Uint8Array(n);
    this.nMinRank = new Int32Array(n);
    this.nMinSrv = new Int32Array(n);
    for (let node = n - 1; node >= 0; node--) {
      const g = group[node]!;
      let maxLen = g >= 0 ? depth[node]! : 0;
      let minRank = g >= 0 ? this.gRank[g]! : NONE;
      let minSrv = g >= 0 ? this.gSrv[g]! : NONE;
      const end = first[node]! + popcnt(mask[node]!);
      for (let ch = first[node]!; ch < end; ch++) {
        if (this.nMaxLen[ch]! > maxLen) maxLen = this.nMaxLen[ch]!;
        if (this.nMinRank[ch]! < minRank) minRank = this.nMinRank[ch]!;
        if (this.nMinSrv[ch]! < minSrv) minSrv = this.nMinSrv[ch]!;
      }
      this.nMaxLen[node] = maxLen;
      this.nMinRank[node] = minRank;
      this.nMinSrv[node] = minSrv;
    }

    this.stats = {
      lines: lex.length,
      words: valid,
      nonAZ,
      sorted,
      groups: G,
      nodes: n,
      loadMs: performance.now() - t0,
    };
  }

  /** Exactly the server's isValidWord: a-z uppercased, A-Z only, 2+ letters, listed. */
  isWord(word: string): boolean {
    const target = asciiUpper(word);
    if (this.validSet) return this.validSet.has(target);
    // Unsorted list: replicate the server's binary search, misses and all.
    if (new TextEncoder().encode(target).length < 2 || !isAZ(target)) return false;
    const words = this.lexWords;
    let lo = 0;
    let hi = words.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const w = words[mid]!;
      if (w < target) lo = mid + 1;
      else if (w === target) return true;
      else hi = mid;
    }
    return false;
  }

  /** wordReward from rules.ts; here so callers need one import. */
  reward(word: string): number {
    return wordReward(word);
  }

  /** Highest-reward playable word; ties: longer, then alphabetical. */
  best(rack: Counts, opts?: LengthOpts): WordHit | null {
    const [minLen, maxLen] = lengths(opts);
    this.loadRack(rack);
    const g = this.searchMin(this.gRank, this.nMinRank, minLen, maxLen);
    if (g < 0) return null;
    return { word: this.gWords[this.gStart[g]!]!, reward: this.gReward[g]! };
  }

  /** Reward of best(), 0 when nothing is playable. */
  bestReward(rack: Counts, opts?: LengthOpts): number {
    const [minLen, maxLen] = lengths(opts);
    this.loadRack(rack);
    const g = this.searchMin(this.gRank, this.nMinRank, minLen, maxLen);
    return g < 0 ? 0 : this.gReward[g]!;
  }

  /** The k best playable words, in best() order. */
  topK(rack: Counts, k: number, opts?: LengthOpts): WordHit[] {
    const [minLen, maxLen] = lengths(opts);
    this.loadRack(rack);
    return this.hits(this.searchTop(k, minLen, maxLen));
  }

  /** Every playable word, in best() order. */
  playable(rack: Counts, opts?: LengthOpts): WordHit[] {
    const [minLen, maxLen] = lengths(opts);
    this.loadRack(rack);
    const groups = this.collect(minLen, maxLen);
    let n = 0;
    for (const g of groups) n += this.gStart[g + 1]! - this.gStart[g]!;
    const ranks = new Int32Array(n);
    n = 0;
    for (const g of groups) {
      for (let i = this.gStart[g]!; i < this.gStart[g + 1]!; i++) ranks[n++] = this.wRank[i]!;
    }
    return this.hits(ranks.sort());
  }

  /** Number of playable words, without building them. */
  countPlayable(rack: Counts, opts?: LengthOpts): number {
    const [minLen, maxLen] = lengths(opts);
    this.loadRack(rack);
    let n = 0;
    for (const g of this.collect(minLen, maxLen)) n += this.gStart[g + 1]! - this.gStart[g]!;
    return n;
  }

  /**
   * Exact replica of the server's findBestPlayable(rack, minLen): the
   * longest playable word, alphabetical among those, of length >= minLen.
   * This is what simulated bots play, not the highest-reward word.
   */
  serverBestPlayable(
    rack: Counts | ReadonlyMap<string, number>,
    minLen: number,
  ): string | undefined {
    // Same accumulation as the server, including its u32 clamp.
    const counts = new Array<number>(26).fill(0);
    let total = 0;
    if (rack instanceof Map) {
      for (const [c, n] of rack) {
        if (/^[A-Z]$/.test(c)) {
          const slot = c.charCodeAt(0) - 65;
          counts[slot] = Math.min(counts[slot]! + n, 0xffffffff);
          total = Math.min(total + n, 0xffffffff);
        }
      }
    } else {
      for (let i = 0; i < 26; i++) {
        const n = (rack as Counts)[i] ?? 0;
        counts[i] = Math.min(n, 0xffffffff);
        total = Math.min(total + n, 0xffffffff);
      }
    }
    if (total < minLen) return undefined;
    // The server checks need <= have on all 26 letters, unused ones too, so
    // one negative (or NaN) count fails every word.
    if (!counts.every((n) => n >= 0)) return undefined;
    // It skips words longer than `total` (lengths are whole, so flooring keeps
    // fractional counts exact) and stops below minLen, a test NaN never passes.
    const lo = Number.isNaN(minLen) ? 0 : minLen;
    this.loadRack(counts);
    const g = this.searchMin(this.gSrv, this.nMinSrv, lo, Math.floor(total));
    return g < 0 ? undefined : this.gWords[this.gStart[g]!]!;
  }

  /**
   * Disjoint words from the rack with the highest total reward (ties: fewer
   * tiles used). Branch and bound: the rarest letter left on the rack is
   * either covered by a word containing it or dropped, so each partition is
   * reached once. The bound prices each remaining tile at its letter value
   * times the best reward-per-point of any candidate using that letter,
   * capped by the multiplier the remaining tile count still allows.
   */
  bestPartition(rack: Counts, opts: PartitionOpts = {}): Partition {
    const deadline = performance.now() + (opts.timeBudgetMs ?? DEFAULT_PARTITION_BUDGET_MS);
    const [minLen, maxLen] = lengths(opts);
    const maxWords = opts.maxWords ?? Infinity;
    this.loadRack(rack);
    const cands = this.collect(minLen, maxLen);
    if (cands.length === 0 || !(maxWords >= 1)) return { words: [], total: 0, optimal: true };

    // Letters some candidate uses, the least-used first: covering those is
    // the most constrained choice, so branching on them stays narrow.
    const C = cands.length;
    const used = new Int32Array(26);
    const reps: string[] = new Array(C);
    for (let c = 0; c < C; c++) {
      const w = this.gWords[this.gStart[cands[c]!]!]!;
      reps[c] = w;
      let seen = 0;
      for (let i = 0; i < w.length; i++) {
        const l = w.charCodeAt(i) - 65;
        if (!(seen & (1 << l))) {
          seen |= 1 << l;
          used[l]!++;
        }
      }
    }
    const letters: number[] = [];
    for (let l = 0; l < 26; l++) if (used[l]) letters.push(l);
    letters.sort((a, b) => used[a]! - used[b]! || a - b);
    const K = letters.length;
    const jOf = new Int32Array(26);
    for (let j = 0; j < K; j++) jOf[letters[j]!] = j;
    const R = new Int32Array(K);
    for (let j = 0; j < K; j++) R[j] = clampCount(rack[letters[j]!]);

    // Per candidate: its (letter, count) list, reward, length, first letter.
    const off = new Int32Array(C + 1);
    const cj: number[] = [];
    const cn: number[] = [];
    const reward = new Int32Array(C);
    const len = new Int32Array(C);
    const firstJ = new Int32Array(C);
    const ratio = new Float64Array(C);
    const m = new Float64Array(K); // best reward per letter point, per letter
    const tmp = new Int32Array(K);
    for (let c = 0; c < C; c++) {
      const w = reps[c]!;
      tmp.fill(0);
      let val = 0;
      for (let i = 0; i < w.length; i++) {
        const l = w.charCodeAt(i) - 65;
        tmp[jOf[l]!]!++;
        val += LETTER_VALUES[l]!;
      }
      off[c] = cj.length;
      firstJ[c] = -1;
      for (let j = 0; j < K; j++) {
        if (!tmp[j]) continue;
        if (firstJ[c] < 0) firstJ[c] = j;
        cj.push(j);
        cn.push(tmp[j]!);
      }
      reward[c] = this.gReward[cands[c]!]!;
      len[c] = w.length;
      ratio[c] = reward[c]! / val;
      for (let p = off[c]!; p < cj.length; p++) if (ratio[c]! > m[cj[p]!]!) m[cj[p]!] = ratio[c]!;
    }
    off[C] = cj.length;
    const coef = new Float64Array(K);
    for (let j = 0; j < K; j++) coef[j] = LETTER_VALUES[letters[j]!]! * m[j]!;
    const candCoef = new Float64Array(C);
    for (let c = 0; c < C; c++) {
      let s = 0;
      for (let p = off[c]!; p < off[c + 1]!; p++) s += cn[p]! * coef[cj[p]!]!;
      candCoef[c] = s;
    }
    const byRank = Array.from({ length: C }, (_, c) => c).sort(
      (a, b) => this.gRank[cands[a]!]! - this.gRank[cands[b]!]!,
    );
    const buckets: number[][] = Array.from({ length: K }, () => []);
    for (const c of byRank) buckets[firstJ[c]!]!.push(c);

    // Most candidates fail on a letter that's already gone; a bitmask of the
    // letters still on the rack rejects those in one test.
    const candMask = new Int32Array(C);
    for (let c = 0; c < C; c++) for (let p = off[c]!; p < off[c + 1]!; p++) candMask[c] |= 1 << cj[p]!;
    let rmask = 0;
    for (let j = 0; j < K; j++) if (R[j]) rmask |= 1 << j;
    const fits = (c: number): boolean => {
      if (candMask[c]! & ~rmask) return false;
      for (let p = off[c]!; p < off[c + 1]!; p++) if (R[cj[p]!]! < cn[p]!) return false;
      return true;
    };
    const take = (c: number, sign: number): void => {
      for (let p = off[c]!; p < off[c + 1]!; p++) {
        const j = cj[p]!;
        if ((R[j]! -= sign * cn[p]!) === 0) rmask &= ~(1 << j);
        else rmask |= 1 << j;
      }
    };

    // Greedy seed: best word that fits, repeatedly. A strong first bound.
    let bestPick: number[] = [];
    let bestTotal = 0;
    let bestUsed = 0;
    for (const c of byRank) {
      if (bestPick.length >= maxWords) break;
      if (!fits(c)) continue;
      take(c, 1);
      bestPick.push(c);
      bestTotal += reward[c]!;
      bestUsed += len[c]!;
    }
    for (const c of bestPick) take(c, -1);

    // Tighter bound once few tiles remain: no word is longer than the tiles
    // left, so no tile earns more than that length's multiplier.
    const vj = new Float64Array(K);
    for (let j = 0; j < K; j++) vj[j] = LETTER_VALUES[letters[j]!]!;
    const lenCap = (n: number): number => {
      const [num, den] = lengthMultiplier(Math.min(n, maxLen));
      return num / den;
    };
    const cappedUb = (L: number, cap: number): number => {
      let s = 0;
      for (let j = L; j < K; j++) if (R[j]) s += R[j]! * vj[j]! * Math.min(m[j]!, cap);
      return s;
    };
    // Fewest of the remaining tiles that must be used to gain `need` more.
    const minTilesFor = (L: number, cap: number, ub: number, need: number, nRem: number): number => {
      let cmin = Infinity;
      for (let j = L; j < K; j++) if (R[j]) cmin = Math.min(cmin, vj[j]! * Math.min(m[j]!, cap));
      return nRem - Math.floor((ub - need + EPS) / cmin);
    };

    // Different word sets can leave the same tiles. Once a leftover has been
    // searched in full, `bestTotal - total` then caps what it can add, so a
    // later arrival with a worse total is cut at once. Keys are the leftover
    // counts in mixed radix; a word cap makes the leftover alone not enough.
    const radix = new Float64Array(K);
    let span = 1;
    for (let j = 0; j < K; j++) {
      radix[j] = span;
      span *= R[j]! + 1;
    }
    const memo = maxWords === Infinity && span < 2 ** 52 ? new Map<number, number>() : null;
    const candKey = new Float64Array(C);
    for (let c = 0; c < C; c++) {
      for (let p = off[c]!; p < off[c + 1]!; p++) candKey[c] += cn[p]! * radix[cj[p]!]!;
    }

    const pick: number[] = [];
    let work = 0;
    let aborted = false;
    const dfs = (
      L: number,
      start: number,
      total: number,
      usedTiles: number,
      ub: number,
      nRem: number,
      key: number,
    ): void => {
      if (total > bestTotal || (total === bestTotal && usedTiles < bestUsed)) {
        bestTotal = total;
        bestUsed = usedTiles;
        bestPick = pick.slice();
      }
      while (L < K && R[L] === 0) {
        L++;
        start = 0;
      }
      if (L === K || pick.length >= maxWords) return;
      const known = memo?.get(key);
      if (known !== undefined && total + known < bestTotal) return;
      const cap = lenCap(nRem);
      const ubNode = cap < 3 ? Math.min(ub, cappedUb(L, cap)) : ub;
      const bound = total + Math.floor(ubNode + EPS);
      if (bound < bestTotal) return;
      if (bound === bestTotal) {
        // Only a partition using fewer tiles could still win.
        if (usedTiles >= bestUsed) return;
        if (usedTiles + minTilesFor(L, cap, ubNode, bestTotal - total, nRem) >= bestUsed) return;
      }
      const b = buckets[L]!;
      // Every word here uses at least one L, so it frees at least coef[L].
      const ubL = Math.floor(ub - coef[L]! + EPS);
      for (let i = start; i < b.length; i++) {
        if ((++work & 1023) === 0 && performance.now() > deadline) aborted = true;
        if (aborted) return;
        const c = b[i]!;
        const t = total + reward[c]!;
        if (t + ubL < bestTotal) break; // rewards only fall from here
        if (candMask[c]! & ~rmask) continue;
        const ub2 = ub - candCoef[c]!;
        const b2 = t + Math.floor(ub2 + EPS);
        if (b2 < bestTotal || (b2 === bestTotal && usedTiles + len[c]! >= bestUsed)) continue;
        if (!fits(c)) continue;
        take(c, 1);
        pick.push(c);
        dfs(L, i, t, usedTiles + len[c]!, ub2, nRem - len[c]!, key - candKey[c]!);
        pick.pop();
        take(c, -1);
        if (aborted) return;
      }
      const n = R[L]!;
      R[L] = 0;
      rmask &= ~(1 << L);
      dfs(L + 1, 0, total, usedTiles, ub - n * coef[L]!, nRem - n, key - n * radix[L]!);
      R[L] = n;
      rmask |= 1 << L;
      if (memo && start === 0 && !aborted) memo.set(key, bestTotal - total);
    };
    let ub0 = 0;
    let n0 = 0;
    let key0 = 0;
    for (let j = 0; j < K; j++) {
      ub0 += R[j]! * coef[j]!;
      n0 += R[j]!;
      key0 += R[j]! * radix[j]!;
    }
    dfs(0, 0, 0, 0, ub0, n0, key0);

    bestPick.sort((a, b) => this.gRank[cands[a]!]! - this.gRank[cands[b]!]!);
    return { words: bestPick.map((c) => reps[c]!), total: bestTotal, optimal: !aborted };
  }

  // --- search internals -----------------------------------------------------

  private loadRack(rack: Counts): void {
    let mask = 0;
    for (let l = 0; l < 26; l++) {
      const r = this.rankOf[l]!;
      const n = clampCount(rack[l]);
      this.avail[r] = n;
      if (n > 0) mask |= 1 << r;
    }
    this.availMask = mask;
  }

  /** The playable group with the smallest `key`, or -1. */
  private searchMin(key: Int32Array, nodeKey: Int32Array, minLen: number, maxLen: number): number {
    const { nMask, nFirst, nGroup, nMaxLen, avail } = this;
    let availMask = this.availMask;
    let best = -1;
    let cutoff = NONE; // subtrees whose best key is at or above this can't win
    const visit = (node: number, depth: number): void => {
      const g = nGroup[node]!;
      if (g >= 0 && depth >= minLen && key[g]! < cutoff) {
        best = g;
        cutoff = key[g]!;
      }
      if (depth >= maxLen) return;
      const cm = nMask[node]!;
      let mm = cm & availMask;
      const f = nFirst[node]!;
      while (mm !== 0) {
        const low = mm & -mm;
        mm ^= low;
        const child = f + popcnt(cm & (low - 1));
        if (nodeKey[child]! >= cutoff || nMaxLen[child]! < minLen) continue;
        const r = 31 - Math.clz32(low);
        if (--avail[r]! === 0) availMask ^= low;
        visit(child, depth + 1);
        if (avail[r]!++ === 0) availMask |= low;
      }
    };
    visit(0, 0);
    return best;
  }

  /** Ranks of the k best playable words, ascending. */
  private searchTop(k: number, minLen: number, maxLen: number): Int32Array {
    const top: number[] = [];
    if (!(k >= 1)) return new Int32Array(0);
    const { nMask, nFirst, nGroup, nMaxLen, avail, gStart, gRank, wRank, nMinRank } = this;
    let availMask = this.availMask;
    let cutoff = NONE;
    const visit = (node: number, depth: number): void => {
      const g = nGroup[node]!;
      if (g >= 0 && depth >= minLen && gRank[g]! < cutoff) {
        // A group's words are alphabetical, so their ranks ascend.
        for (let i = gStart[g]!; i < gStart[g + 1]!; i++) {
          const r = wRank[i]!;
          if (r >= cutoff) break;
          let j = top.length;
          top.push(r);
          while (j > 0 && top[j - 1]! > r) {
            top[j] = top[j - 1]!;
            j--;
          }
          top[j] = r;
          if (top.length > k) top.pop();
          if (top.length === k) cutoff = top[k - 1]!;
        }
      }
      if (depth >= maxLen) return;
      const cm = nMask[node]!;
      let mm = cm & availMask;
      const f = nFirst[node]!;
      while (mm !== 0) {
        const low = mm & -mm;
        mm ^= low;
        const child = f + popcnt(cm & (low - 1));
        if (nMinRank[child]! >= cutoff || nMaxLen[child]! < minLen) continue;
        const r = 31 - Math.clz32(low);
        if (--avail[r]! === 0) availMask ^= low;
        visit(child, depth + 1);
        if (avail[r]!++ === 0) availMask |= low;
      }
    };
    visit(0, 0);
    return Int32Array.from(top);
  }

  /** Every group playable from the loaded rack, in trie order. */
  private collect(minLen: number, maxLen: number): number[] {
    const out: number[] = [];
    const { nMask, nFirst, nGroup, nMaxLen, avail } = this;
    let availMask = this.availMask;
    const visit = (node: number, depth: number): void => {
      const g = nGroup[node]!;
      if (g >= 0 && depth >= minLen) out.push(g);
      if (depth >= maxLen) return;
      const cm = nMask[node]!;
      let mm = cm & availMask;
      const f = nFirst[node]!;
      while (mm !== 0) {
        const low = mm & -mm;
        mm ^= low;
        const child = f + popcnt(cm & (low - 1));
        if (nMaxLen[child]! < minLen) continue;
        const r = 31 - Math.clz32(low);
        if (--avail[r]! === 0) availMask ^= low;
        visit(child, depth + 1);
        if (avail[r]!++ === 0) availMask |= low;
      }
    };
    visit(0, 0);
    return out;
  }

  private hits(ranks: Int32Array): WordHit[] {
    const out: WordHit[] = new Array(ranks.length);
    for (let i = 0; i < ranks.length; i++) {
      const w = this.byRank[ranks[i]!]!;
      out[i] = { word: this.gWords[w]!, reward: this.gReward[this.wGroup[w]!]! };
    }
    return out;
  }
}

function clampCount(n: number | undefined): number {
  // `>= 1` is false for NaN, negatives and undefined alike.
  return n !== undefined && n >= 1 ? Math.min(Math.floor(n), MAX_COUNT) : 0;
}

function lengths(opts: LengthOpts | undefined): [number, number] {
  const minLen = Math.max(2, opts?.minLen ?? 2);
  const maxLen = opts?.maxLen ?? Infinity;
  return [minLen, maxLen];
}

let engine: WordEngine | undefined;

/** The shared engine, built from data/wordlist.txt on first use. */
export function getWordEngine(): WordEngine {
  engine ??= new WordEngine(fs.readFileSync(WORDLIST_PATH, "utf8"));
  return engine;
}
