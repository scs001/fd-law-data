import test from "node:test";
import assert from "node:assert/strict";
import { summarizeManifests } from "../lib/legal-sources/coverage.js";

test("coverage sums immutable manifests and exposes the latest gap state", () => {
  const summary = summarizeManifests([
    {
      runDate: "2026-09-22", runId: "1", mode: "full", finishedAt: "2026-09-22T00:00:00Z",
      coverage: { sourceTotal: 5000, listed: 5000, planned: 5000, emitted: 4980, failures: 20, missingText: 3, attachments: 12, complete: false, unreachablePages: [{ page: 9 }] },
    },
    {
      runDate: "2026-09-23", runId: "2", mode: "incremental", finishedAt: "2026-09-23T00:00:00Z",
      coverage: { sourceTotal: 5010, listed: 5010, planned: 10, emitted: 10, failures: 0, missingText: 0, attachments: 0, complete: true, unreachablePages: [] },
    },
  ]);
  assert.equal(summary.runs, 2);
  assert.equal(summary.cumulative.emitted, 4990);
  assert.equal(summary.cumulative.failures, 20);
  assert.equal(summary.latest.complete, true);
  assert.equal(summary.latest.planned, 10);
  assert.equal(summary.latest.sourceTotal, 5010);
});

test("empty manifest history is explicitly missing rather than complete", () => {
  const summary = summarizeManifests([]);
  assert.equal(summary.latest, null);
  assert.equal(summary.cumulative.runs, 0);
});
