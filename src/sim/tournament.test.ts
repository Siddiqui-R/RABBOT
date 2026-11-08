import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent, MatchView } from "../core/types.js";
import { runMatch } from "./engine.js";
import { levelStandings } from "./tournament.js";

// An agent that bids 1 on everything, plays nothing, and remembers what it saw.
function probe(seen: MatchView[]): Agent {
  return {
    name: "probe",
    quickBid(view) {
      seen.push(view);
      return 1;
    },
    chooseWords() {
      return [];
    },
  };
}

test("engine views carry the tournament context only when given one", () => {
  for (const withCtx of [false, true]) {
    const seen: MatchView[] = [];
    const t = levelStandings([1_000_000, 1_000_001], "Final", 2, 2);
    runMatch({
      seats: [
        { botId: 1_000_000, isSim: false, agent: probe(seen) },
        { botId: 1_000_001, isSim: false, agent: probe([]) },
      ],
      seed: 5,
      tournament: withCtx ? t : undefined,
    });
    assert.ok(seen.length > 0);
    if (withCtx) {
      assert.deepEqual(seen[0]!.tournament, t);
      seen[0]!.tournament!.round = 99; // a view is a copy
      assert.equal(seen[1]!.tournament!.round, 2);
    } else assert.equal(seen[0]!.tournament, undefined);
  }
});

test("heads-up and oversized tables deal 98 - seats x rack and run to the end", () => {
  for (const [seats, rack] of [[2, 5], [11, 5], [11, 7], [3, 7]] as const) {
    const out = runMatch({
      seats: Array.from({ length: seats }, (_, i) => ({ botId: 1_000_000 + i, isSim: false, agent: probe([]) })),
      seed: 9,
      startingRackSize: rack,
    });
    assert.equal(out.rounds, 98 - seats * rack, `${seats} seats, rack ${rack}`);
    assert.equal(out.seats.reduce((a, s) => a + s.agentErrors, 0), 0);
  }
});
