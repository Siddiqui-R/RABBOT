import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRows } from "./http.js";
import { anchorFor, anchoredQueries, assertAllowed, baseQueries, identityLiteral, rackQuery, rosterQuery, tournamentQueries } from "./queries.js";

test("queries: anchored set follows our seat, never self-joins match_participant", () => {
  const q = anchoredQueries(42n, 13000n);
  assert.ok(q.every((s) => s.includes("p.bot_id = 42 AND p.match_id > 13000") || s.includes("bot_id = 42 AND match_id > 13000")));
  // A self-join only streams updates for our own row (measured live).
  assert.ok(!q.some((s) => /FROM match_participant \w+ JOIN match_participant/.test(s)));
  assert.equal(rosterQuery(13001n), "SELECT * FROM match_participant WHERE match_id = 13001");
  assert.equal(rackQuery(13000n), "SELECT * FROM my_rack WHERE match_id > 13000");
  assert.equal(anchorFor([12n, 99n, 50n]), 98n, "covers the latest seat");
  assert.equal(anchorFor([]), 0n);
});

test("queries: identity literal and the forbidden table", () => {
  const hex = "c2".padEnd(64, "0");
  assert.equal(identityLiteral(`0x${hex}`), `0x${hex}`);
  assert.throws(() => identityLiteral("0x1234; DROP"));
  assert.match(baseQueries(hex)[0]!, /bot_credential WHERE identity = 0xc2/);
  assert.equal(baseQueries(null).length, 2);
  assert.throws(() => assertAllowed(["SELECT * FROM visible_auction_top_bids"]));
  assert.doesNotThrow(() => assertAllowed(anchoredQueries(1n, 0n)));
  assert.doesNotThrow(() => assertAllowed(tournamentQueries()));
  assert.deepEqual(tournamentQueries(), ["SELECT * FROM tournament_entry", "SELECT * FROM tournament_match"]);
});

test("http: SATS-JSON rows decode enums, options and timestamps", () => {
  // Shape captured from the live /sql endpoint (match_state, trimmed).
  const res = {
    schema: {
      elements: [
        { name: { some: "id" }, algebraic_type: { U64: [] } },
        {
          name: { some: "status" },
          algebraic_type: {
            Sum: {
              variants: [
                { name: { some: "lobby" }, algebraic_type: { Product: { elements: [] } } },
                { name: { some: "running" }, algebraic_type: { Product: { elements: [] } } },
                { name: { some: "ended" }, algebraic_type: { Product: { elements: [] } } },
              ],
            },
          },
        },
        {
          name: { some: "current_auction_id" },
          algebraic_type: {
            Sum: {
              variants: [
                { name: { some: "some" }, algebraic_type: { U64: [] } },
                { name: { some: "none" }, algebraic_type: { Product: { elements: [] } } },
              ],
            },
          },
        },
        {
          name: { some: "created_at" },
          algebraic_type: { Product: { elements: [{ name: { some: "__timestamp_micros_since_unix_epoch__" }, algebraic_type: { I64: [] } }] } },
        },
      ],
    },
    rows: [
      [13060, [2, []], [1, []], [1792885362162930]],
      [13061, [1, []], [0, 627001], [1792885362162930]],
    ],
  };
  assert.deepEqual(decodeRows(res), [
    { id: 13060, status: "ended", current_auction_id: null, created_at: 1792885362162.93 },
    { id: 13061, status: "running", current_auction_id: 627001, created_at: 1792885362162.93 },
  ]);
});
