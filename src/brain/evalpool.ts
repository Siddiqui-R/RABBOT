// A pool of worker threads that play evaluation jobs (evaljobs.ts). Workers
// load the word engine, the opponent model and the clone factory once and
// stay up across batches, so the tuner pays start-up once per run.

import { Worker } from "node:worker_threads";
import { loadEnv, runJob, type Env, type Job, type JobResult } from "./evaljobs.js";

export interface PoolOptions {
  workers: number;
  variants?: Record<string, Record<string, unknown>>;
  model?: boolean;
  budgetMs?: number;
  /** Jobs per message to a worker. */
  chunk?: number;
}

function workerArgv(): string[] {
  let loader = "tsx";
  try {
    loader = import.meta.resolve("tsx");
  } catch {
    // resolve from cwd
  }
  return ["--import", loader];
}

type FromWorker = { type: "ready" } | { type: "done"; results: JobResult[] } | { type: "error"; message: string };

export class EvalPool {
  private workers: Worker[] = [];
  private ready: Promise<void>[] = [];
  private env: Promise<Env> | undefined;

  constructor(private o: PoolOptions) {
    const variants = o.variants ?? {};
    if (o.workers <= 1) {
      this.env = loadEnv(variants, o.model ?? true).then((e) => {
        e.budgetMs = o.budgetMs;
        return e;
      });
      return;
    }
    const url = new URL("./evalworker.ts", import.meta.url);
    for (let i = 0; i < o.workers; i++) {
      const w = new Worker(url, {
        execArgv: workerArgv(),
        workerData: { variants, model: o.model ?? true, budgetMs: o.budgetMs },
      });
      this.workers.push(w);
      this.ready.push(
        new Promise((res, rej) => {
          const onMsg = (m: FromWorker) => {
            if (m.type === "ready") {
              w.off("message", onMsg);
              res();
            } else if (m.type === "error") rej(new Error(m.message));
          };
          w.on("message", onMsg);
          w.once("error", rej);
        }),
      );
    }
  }

  async run(jobs: Job[], onProgress?: (done: number) => void): Promise<JobResult[]> {
    if (this.env) {
      const env = await this.env;
      const out: JobResult[] = [];
      for (const j of jobs) {
        out.push(runJob(env, j));
        onProgress?.(out.length);
      }
      return out;
    }
    await Promise.all(this.ready);
    const chunk = Math.max(1, this.o.chunk ?? 2);
    const results: JobResult[] = [];
    let next = 0;
    await Promise.all(
      this.workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const feed = () => {
              if (next >= jobs.length) {
                w.off("message", onMsg);
                resolve();
                return;
              }
              const batch = jobs.slice(next, next + chunk);
              next += batch.length;
              w.postMessage({ type: "run", jobs: batch });
            };
            const onMsg = (m: FromWorker) => {
              if (m.type === "done") {
                results.push(...m.results);
                onProgress?.(results.length);
                feed();
              } else if (m.type === "error") {
                w.off("message", onMsg);
                reject(new Error(m.message));
              }
            };
            w.on("message", onMsg);
            feed();
          }),
      ),
    );
    return results.sort((a, b) => a.id - b.id);
  }

  async close(): Promise<void> {
    await Promise.all(
      this.workers.map(
        (w) =>
          new Promise<void>((res) => {
            w.once("exit", () => res());
            w.postMessage({ type: "exit" });
          }),
      ),
    );
    this.workers = [];
  }
}
