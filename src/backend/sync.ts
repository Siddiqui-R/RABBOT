// Synchronous SQL against the backend, for callers whose API is synchronous
// (the opponent model: loadOpponentModel() and refresh() return values, and
// the brain and the sim harness call them that way). A worker thread does
// the HTTP request; the caller sleeps on Atomics.wait and takes the answer
// with receiveMessageOnPort. It blocks the event loop for the round trip
// (milliseconds on localhost), as the SQLite reads it replaces did.

import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { DEFAULT_DB, DEFAULT_URI, decodeSqlResponse, type SqlRow } from "./client.js";

// Plain CommonJS so the worker needs no TypeScript loader.
const WORKER_SRC = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", async ({ url, body, token, timeoutMs, port, flag }) => {
  let msg;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: token ? { Authorization: "Bearer " + token } : {},
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    msg = { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    msg = { ok: false, status: 0, text: String((e && e.message) || e) };
  }
  port.postMessage(msg);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
`;

let worker: Worker | undefined;
const flag = new Int32Array(new SharedArrayBuffer(4));

function ensureWorker(): void {
  if (worker) return;
  // execArgv: [] keeps tsx's loader hooks out of the worker; it needs none.
  worker = new Worker(WORKER_SRC, { eval: true, execArgv: [] });
  worker.unref();
  worker.on("error", () => {
    worker = undefined;
  });
}

export interface SyncSqlOptions {
  uri?: string;
  db?: string;
  /** Only needed for private tables; public reads are anonymous. */
  token?: string;
  timeoutMs?: number;
}

/**
 * `sql()` but synchronous: same rows, same refusal of the forbidden view.
 * Throws on an HTTP error or a timeout.
 */
export function sqlSync(query: string, o: SyncSqlOptions = {}): SqlRow[] {
  if (/visible_auction_top_bids/i.test(query)) throw new Error("refusing to read visible_auction_top_bids");
  ensureWorker();
  const timeoutMs = o.timeoutMs ?? 120_000;
  const uri = (o.uri ?? DEFAULT_URI).replace(/\/$/, "");
  const url = `${uri}/v1/database/${encodeURIComponent(o.db ?? DEFAULT_DB)}/sql`;
  // A fresh channel per call: a reply that arrives after a timeout must
  // never be read as the answer to the next query.
  const ch = new MessageChannel();
  ch.port1.unref();
  Atomics.store(flag, 0, 0);
  worker!.postMessage({ url, body: query, token: o.token, timeoutMs, port: ch.port2, flag }, [ch.port2]);
  const r = Atomics.wait(flag, 0, 0, timeoutMs + 2_000);
  const got = receiveMessageOnPort(ch.port1)?.message as { ok: boolean; status: number; text: string } | undefined;
  ch.port1.close();
  if (!got) throw new Error(r === "timed-out" ? `sql timed out after ${timeoutMs} ms` : "sql worker gave no answer");
  if (!got.ok) throw new Error(`sql ${got.status || "failed"}: ${got.text.slice(0, 300)}`);
  return decodeSqlResponse(got.text);
}

/** Stops the worker (tests; a process exits fine without this). */
export function closeSqlSync(): void {
  void worker?.terminate();
  worker = undefined;
}

/** RFC 3339 for a µs timestamp, as SpacetimeDB SQL compares timestamps. */
export function isoUs(us: number): string {
  const ms = Math.floor(us / 1000);
  const frac = String(Math.floor(us) % 1_000_000).padStart(6, "0");
  return new Date(ms).toISOString().slice(0, 19) + "." + frac + "Z";
}
