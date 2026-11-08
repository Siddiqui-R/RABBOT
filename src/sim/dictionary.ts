// The server's dictionary.ts and text.ts, ported literally (same names, same
// control flow) so word validity and sim word choice are exactly the
// server's. data/wordlist.txt is byte-identical to the server's bundled
// spacetimedb/wordlist.txt (172,820 words, LC_ALL=C sorted, which is what
// isValidWord's binary search needs).
//
// findBestPlayable is the ground truth but scans up to 172k words per call,
// and sims call it after every auction they win. bestPlayable() gives the
// same answer from an anagram index in microseconds; dictionary.test.ts
// checks the two agree.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Counts } from "../core/rules.js";

export const WORDLIST_PATH = path.join(import.meta.dirname, "..", "..", "data", "wordlist.txt");

// ---------- text.ts ----------

const encoder = new TextEncoder();

// Length in UTF-8 bytes, like Rust's `str::len`.
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

// Uppercases a-z only, like Rust's `str::to_ascii_uppercase`.
export function asciiUppercase(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

export function isAsciiUppercase(s: string): boolean {
  return /^[A-Z]*$/.test(s);
}

// ---------- dictionary.ts ----------

let LEX_WORDS: string[] | undefined;
let WORDS_BY_LENGTH: string[] | undefined;

export function lexWords(): string[] {
  LEX_WORDS ??= fs
    .readFileSync(WORDLIST_PATH, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  return LEX_WORDS;
}

export function wordsByLength(): string[] {
  WORDS_BY_LENGTH ??= [...lexWords()].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  return WORDS_BY_LENGTH;
}

export function isValidWord(word: string): boolean {
  const target = asciiUppercase(word);
  if (byteLength(target) < 2) {
    return false;
  }
  if (!isAsciiUppercase(target)) {
    return false;
  }
  const words = lexWords();
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const w = words[mid]!;
    if (w < target) {
      lo = mid + 1;
    } else if (w === target) {
      return true;
    } else {
      hi = mid;
    }
  }
  return false;
}

const A = "A".charCodeAt(0);
const U32_MAX = 0xffffffff;

// Longest word spellable from `rack`, first alphabetically among equals;
// undefined if none has `minLen` or more letters. Literal server port.
export function findBestPlayable(
  rack: Map<string, number>,
  minLen: number,
): string | undefined {
  const rackCounts = new Array<number>(26).fill(0);
  let total = 0;
  for (const [c, n] of rack) {
    if (/^[A-Z]$/.test(c)) {
      const slot = c.charCodeAt(0) - A;
      rackCounts[slot] = Math.min(rackCounts[slot]! + n, U32_MAX);
      total = Math.min(total + n, U32_MAX);
    }
  }
  if (total < minLen) {
    return undefined;
  }

  const need = new Array<number>(26);
  for (const word of wordsByLength()) {
    if (word.length < minLen) {
      break;
    }
    if (word.length > total) {
      continue;
    }
    need.fill(0);
    let ok = true;
    for (let i = 0; i < word.length; i++) {
      const slot = word.charCodeAt(i) - A;
      if (slot < 0 || slot >= 26) {
        ok = false;
        break;
      }
      need[slot]!++;
    }
    if (!ok) {
      continue;
    }
    if (need.every((n, i) => n <= rackCounts[i]!)) {
      return word;
    }
  }
  return undefined;
}

// ---------- fast equivalent ----------

// A letter multiset as two exact integers: 4 bits per letter count, A..M in
// `lo` and N..Z in `hi`, 52 bits each. No word is longer than 15 letters,
// so no digit can overflow, whatever the rack holds.
const PLACE: number[] = Array.from({ length: 26 }, (_, i) => 16 ** (i % 13));

// hi -> lo -> alphabetically first word with exactly those letters.
let ANAGRAMS: Map<number, Map<number, string>> | undefined;
let MAX_LEN = 0;

function anagrams(): Map<number, Map<number, string>> {
  if (!ANAGRAMS) {
    const m = new Map<number, Map<number, string>>();
    for (const w of lexWords()) {
      let lo = 0;
      let hi = 0;
      for (let i = 0; i < w.length; i++) {
        const slot = w.charCodeAt(i) - A;
        if (slot < 13) lo += PLACE[slot]!;
        else hi += PLACE[slot]!;
      }
      let inner = m.get(hi);
      if (!inner) m.set(hi, (inner = new Map()));
      if (!inner.has(lo)) inner.set(lo, w); // lex order: first seen is smallest
      if (w.length > MAX_LEN) MAX_LEN = w.length;
    }
    ANAGRAMS = m;
  }
  return ANAGRAMS;
}

// Above this many sub-racks, scanning the word list is cheaper.
const MAX_SUBRACKS = 40_000;

/** Same result as findBestPlayable(rack as Map, minLen), from 26 counts. */
export function bestPlayable(rack: Counts, minLen: number): string | undefined {
  let total = 0;
  let subracks = 1;
  const letters: number[] = [];
  for (let i = 0; i < 26; i++) {
    const n = rack[i] ?? 0;
    if (n > 0) {
      letters.push(i);
      total += n;
      subracks *= n + 1;
    }
  }
  if (total < minLen) return undefined;
  if (subracks > MAX_SUBRACKS) return findBestPlayable(countsToMap(rack), minLen);

  const index = anagrams();
  let best: string | undefined;
  // Picks exactly `left` more tiles from letters[li..], so each
  // sub-multiset is visited once.
  const visit = (li: number, left: number, lo: number, hi: number): void => {
    if (left === 0) {
      const w = index.get(hi)?.get(lo);
      if (w !== undefined && (best === undefined || w < best)) best = w;
      return;
    }
    if (li >= letters.length) return;
    const slot = letters[li]!;
    const place = PLACE[slot]!;
    const low = slot < 13;
    for (let k = Math.min(rack[slot]!, left); k >= 0; k--) {
      visit(li + 1, left - k, low ? lo + k * place : lo, low ? hi : hi + k * place);
    }
  };
  for (let len = Math.min(total, MAX_LEN || 64); len >= minLen; len--) {
    visit(0, len, 0, 0);
    if (best !== undefined) return best;
  }
  return undefined;
}

export function countsToMap(rack: Counts): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < 26; i++) if (rack[i]! > 0) m.set(String.fromCharCode(A + i), rack[i]!);
  return m;
}
