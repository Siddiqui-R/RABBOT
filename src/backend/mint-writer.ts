// Mints a writer identity for RABBOT's Node processes: connects once with no
// token, saves the server-issued token (mode 600) and prints the identity
// for the owner to allow-list. Never prints the token.
//
//   tsx src/backend/mint-writer.ts [--out <path>] [--force]
//   spacetime --config-path ~/.config/rabbot/local.toml call -s rabbot rabbot \
//     add_writer '{"__identity__":"0x<identity>"}' '"rabbot-node"'

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WRITER_TOKEN_PATH, connectBackend } from "./client.js";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] ?? WRITER_TOKEN_PATH : WRITER_TOKEN_PATH;

if (existsSync(out) && !args.includes("--force")) {
  console.error(`${out} exists; pass --force to replace it (the old identity stays allow-listed until removed)`);
  process.exit(1);
}

const b = await connectBackend({ anonymous: true });
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(out, b.token + "\n", { mode: 0o600 });
console.log(`saved token to ${out}`);
console.log(`identity 0x${b.identity.toHexString()}`);
await b.close();
process.exit(0);
