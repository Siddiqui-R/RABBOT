// Worker-thread entry for runMatches: builds the agents once, then plays
// whatever game ranges the parent hands it.

import { parentPort, workerData } from "node:worker_threads";
import { playGame, prepare, type RunContext, type WorkerOptions } from "./runner.js";

type ToWorker = { type: "run"; from: number; to: number } | { type: "exit" };

const port = parentPort;
if (!port) throw new Error("worker.ts must run in a worker thread");

const fail = (e: unknown) =>
  port.postMessage({ type: "error", message: e instanceof Error ? (e.stack ?? e.message) : String(e) });

let ctx: RunContext | undefined;
try {
  ctx = await prepare(workerData as WorkerOptions);
} catch (e) {
  fail(e);
}

if (ctx) {
  const ready = ctx;
  port.on("message", (m: ToWorker) => {
    if (m.type === "exit") {
      port.close();
      return;
    }
    try {
      const records = [];
      for (let g = m.from; g < m.to; g++) records.push(playGame(ready, g));
      port.postMessage({ type: "done", records });
    } catch (e) {
      fail(e);
    }
  });
  port.postMessage({ type: "ready", warnings: ready.registry.warnings });
}
