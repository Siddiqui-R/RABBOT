// Worker-thread entry for eval.ts: loads the model and the clone factory
// once, then plays whatever jobs the parent sends.

import { parentPort, workerData } from "node:worker_threads";
import { loadEnv, runJob, type Job } from "./evaljobs.js";

const port = parentPort;
if (!port) throw new Error("evalworker.ts must run in a worker thread");
const data = workerData as { variants: Record<string, Record<string, unknown>>; model: boolean; budgetMs?: number };
const env = await loadEnv(data.variants, data.model);
env.budgetMs = data.budgetMs;

port.on("message", (m: { type: "run"; jobs: Job[] } | { type: "exit" }) => {
  if (m.type === "exit") {
    port.close();
    return;
  }
  try {
    port.postMessage({ type: "done", results: m.jobs.map((j) => runJob(env, j)) });
  } catch (e) {
    port.postMessage({ type: "error", message: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
});
port.postMessage({ type: "ready" });
