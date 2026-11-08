// Test harness: publishes the module to a throwaway database on the local
// rabbot server, allow-lists the writer identity there, and deletes the
// database afterwards. Tests never touch the real `rabbot` database.
//
// These are integration tests: they run only with RABBOT_IT=1 and a reachable
// local rabbot server plus a writer token; otherwise they skip. SPACETIME_BIN and
// RABBOT_STDB_CONFIG override the CLI binary and its config file.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectBackend, readWriterToken, type Backend } from "./client.js";

const SPACETIME = process.env.SPACETIME_BIN ?? join(homedir(), ".local", "bin", "spacetime");
const CONFIG = process.env.RABBOT_STDB_CONFIG ?? join(homedir(), ".config", "rabbot", "local.toml");
const MODULE = join(import.meta.dirname, "..", "..", "backend");

// Per-process name: the repo's `npm test` may run while someone else runs
// this file, and two runs must not wipe each other's database.
export const TEST_DB = process.env.RABBOT_TEST_DB ?? `rabbot-test-${process.pid}`;
if (TEST_DB === "rabbot") throw new Error("tests must not run against the real rabbot database");

/** Integration tests are opt-in: RABBOT_IT=1. */
export const INTEGRATION = process.env.RABBOT_IT === "1";

/** True when RABBOT_IT=1 and the local rabbot server answers; tests skip otherwise. */
export async function serverUp(): Promise<boolean> {
  if (!INTEGRATION) return false;
  try {
    const res = await fetch("http://127.0.0.1:3013/v1/ping", { signal: AbortSignal.timeout(2_000) });
    return res.ok && readWriterToken() !== undefined;
  } catch {
    return false;
  }
}

function cli(args: string[]): string {
  return execFileSync(SPACETIME, ["--config-path", CONFIG, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });
}

/** Fresh empty database with the current module; the CLI's owner identity owns it. */
export function publishTestDb(): void {
  cli(["publish", "-s", "rabbot", "-p", MODULE, "-y", "--delete-data=always", TEST_DB]);
}

export function deleteTestDb(): void {
  try {
    cli(["delete", "-s", "rabbot", "-y", TEST_DB]);
  } catch {
    // Already gone.
  }
}

/** Calls a reducer as the owner (the CLI login). Args are SATS-JSON strings. */
export function ownerCall(reducer: string, ...args: string[]): void {
  cli(["call", "-s", "rabbot", TEST_DB, reducer, ...args]);
}

export function identityJson(hex: string): string {
  return JSON.stringify({ __identity__: hex.startsWith("0x") ? hex : `0x${hex}` });
}

/** Connects with the writer token and allow-lists it on the test database. */
export async function connectTestWriter(): Promise<Backend> {
  const token = readWriterToken();
  if (!token) throw new Error("no writer token; run src/backend/mint-writer.ts");
  const b = await connectBackend({ token, db: TEST_DB });
  ownerCall("add_writer", identityJson(b.identity.toHexString()), '"test-writer"');
  return b;
}

export function connectTestAnon(): Promise<Backend> {
  return connectBackend({ anonymous: true, db: TEST_DB });
}

/**
 * Waits until every server message sent before now has been applied to the
 * cache: messages on one socket are ordered, so a new subscription's
 * Applied arrives after earlier transaction updates.
 */
export async function settle(b: Backend): Promise<void> {
  const h = await b.subscribe(["SELECT * FROM rabbot_status"]);
  await b.unsubscribe(h);
}
