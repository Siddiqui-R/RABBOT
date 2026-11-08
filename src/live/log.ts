// Decision log: one JSON object per line in logs/<prefix>-YYYY-MM-DD.jsonl
// (UTC date), plus a short human line on stdout. Writes go through a
// buffered stream so a log line never blocks a bid.

import * as fs from "node:fs";
import * as path from "node:path";

export type LogRecord = Record<string, unknown>;

function jsonSafe(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? Number(v) : v;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Receives every record after it is written (e.g. backend telemetry). */
export type LogTap = (type: string, rec: LogRecord) => void;

export class DecisionLog {
  private stream: fs.WriteStream | null = null;
  private day = "";
  readonly dir: string;
  private tap: LogTap | null = null;

  constructor(
    dir: string,
    readonly prefix = "decisions",
    readonly tag = "rackforge",
    private readonly echo = true,
  ) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Mirrors each record to `tap` (synchronous; its errors are swallowed). */
  setTap(tap: LogTap | null) {
    this.tap = tap;
  }

  fileFor(day: string): string {
    return path.join(this.dir, `${this.prefix}-${day}.jsonl`);
  }

  write(type: string, rec: LogRecord) {
    try {
      const now = Date.now();
      const day = utcDay(now);
      if (day !== this.day || !this.stream) {
        this.stream?.end();
        this.day = day;
        this.stream = fs.createWriteStream(this.fileFor(day), { flags: "a" });
        this.stream.on("error", (e) => console.error(`[${this.tag}] log write failed: ${e.message}`));
      }
      this.stream.write(JSON.stringify({ t: new Date(now).toISOString(), type, ...rec }, jsonSafe) + "\n");
    } catch (e) {
      console.error(`[${this.tag}] log failed: ${e instanceof Error ? e.message : e}`);
    }
    if (this.tap) {
      try {
        this.tap(type, rec);
      } catch {
        /* telemetry must never break the local log */
      }
    }
  }

  human(msg: string) {
    if (!this.echo) return;
    const t = new Date().toISOString().slice(11, 23);
    console.log(`${t} [${this.tag}] ${msg}`);
  }

  warn(msg: string) {
    const t = new Date().toISOString().slice(11, 23);
    console.warn(`${t} [${this.tag}] WARN ${msg}`);
  }

  close(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    if (!s) return Promise.resolve();
    return new Promise((res) => s.end(res));
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
