// Worker-thread entry for SimPool: loads the word engine and the model once,
// then plays whatever batches of match jobs the parent sends.

import { parentPort } from "node:worker_threads";
import type { Agent } from "../core/types.js";
import { getWordEngine } from "../core/words.js";
import { playJob, type Env, type MatchJob } from "./calibrate-sim.js";
import { cloneModel } from "./clones.js";

const port = parentPort;
if (!port) throw new Error("calibrate-worker.ts must run in a worker thread");

const fail = (e: unknown) =>
  port.postMessage({ type: "error", message: e instanceof Error ? (e.stack ?? e.message) : String(e) });

const env: Env = {};
try {
  getWordEngine();
  cloneModel();
  const brain = (await import("../brain/index.js")) as { createAgent?: (o: object) => Agent };
  env.createRackForge = brain.createAgent;
  port.on("message", (m: { type: "run"; id: number; jobs: MatchJob[] }) => {
    try {
      port.postMessage({ type: "done", id: m.id, stats: m.jobs.map((j) => playJob(env, j)) });
    } catch (e) {
      fail(e);
    }
  });
  port.postMessage({ type: "ready" });
} catch (e) {
  fail(e);
}
