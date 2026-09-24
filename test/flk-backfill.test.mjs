import test from "node:test";
import assert from "node:assert/strict";
import {
  backfillPlan,
  backfillWindow,
  advanceBackfill,
  DEFAULT_BACKFILL_SINCE,
} from "../lib/flk/backfill.js";

test("backfill plan defaults to 1949 and resumes its own cursor", () => {
  const first = backfillPlan({}, { until: "2026-12-31", batchDays: 365 });
  assert.equal(first.nextStart, DEFAULT_BACKFILL_SINCE);
  assert.equal(first.complete, false);

  const state = advanceBackfill({ backfill: { since: DEFAULT_BACKFILL_SINCE, until: "2026-12-31" } }, { start: "1949-01-01", end: "1949-12-31" }, "2026-12-31");
  const resumed = backfillPlan(state, { until: "2026-12-31", batchDays: 365 });
  assert.equal(resumed.nextStart, "1950-01-01");
  assert.equal(resumed.completedWindows.length, 1);
});

test("backfill windows are inclusive and clamp at until", () => {
  const plan = backfillPlan({}, { since: "2025-01-01", until: "2025-12-31", batchDays: 365 });
  assert.deepEqual(backfillWindow(plan), { start: "2025-01-01", end: "2025-12-31" });

  const mid = backfillPlan({ backfill: { since: "2025-01-01", until: "2025-12-31", nextStart: "2025-12-01", complete: false, completedWindows: [] } }, { since: "2025-01-01", until: "2025-12-31", batchDays: 365 });
  assert.deepEqual(backfillWindow(mid), { start: "2025-12-01", end: "2025-12-31" });
});

test("advancing past until marks the plan complete", () => {
  const state = {};
  advanceBackfill(state, { start: "2026-12-01", end: "2026-12-31" }, "2026-12-31", { "100": 7 });
  assert.equal(state.backfill.complete, true);
  assert.equal(state.backfill.nextStart, null);
  assert.deepEqual(state.backfill.completedWindows[0].totalByCode, { "100": 7 });
});

test("changing bounds restarts instead of mixing progress", () => {
  const state = { backfill: { since: "1949-01-01", until: "2020-01-01", nextStart: "1990-01-01", complete: false, completedWindows: [{}] } };
  const plan = backfillPlan(state, { since: "1949-01-01", until: "2026-12-31" });
  assert.equal(plan.nextStart, "1990-01-01");

  const changedBatch = backfillPlan(state, { since: "1949-01-01", until: "2026-12-31", batchDays: 30 });
  // Legacy state recorded no batchDays, so it resumes on `since` alone.
  assert.equal(changedBatch.nextStart, "1990-01-01");

  const changedSince = backfillPlan(state, { since: "2000-01-01", until: "2026-12-31" });
  assert.equal(changedSince.nextStart, "2000-01-01");

  // A state that DID record batchDays restarts when the batch width changes.
  const modern = { backfill: { since: "1949-01-01", batchDays: 365, nextStart: "1990-01-01", complete: false, completedWindows: [{}] } };
  assert.equal(backfillPlan(modern, { until: "2026-12-31", batchDays: 30 }).nextStart, "1949-01-01");
});

test("production sequence: fresh state, dynamic until, back-to-back runs advance the cursor", () => {
  // Run 1: cold state, until = "today" (changes every day in production).
  const state1 = {};
  advanceBackfill(state1, { start: "1949-01-01", end: "1949-12-31" }, "2026-09-24", {}, {
    since: "1949-01-01", batchDays: 365,
  });
  assert.equal(state1.backfill.nextStart, "1950-01-01");

  // Run 2 (next day): until changed; the plan must resume, not reset.
  const plan2 = backfillPlan(state1, { until: "2026-09-25", batchDays: 365 });
  assert.equal(plan2.nextStart, "1950-01-01");
  assert.deepEqual(backfillWindow(plan2), { start: "1950-01-01", end: "1950-12-31" });

  // Round-trip through JSON like the S3 state file does.
  const state2 = JSON.parse(JSON.stringify(state1));
  advanceBackfill(state2, { start: "1950-01-01", end: "1950-12-31" }, "2026-09-25", {}, {
    since: plan2.since, batchDays: plan2.batchDays,
  });
  const plan3 = backfillPlan(state2, { until: "2026-09-26", batchDays: 365 });
  assert.equal(plan3.nextStart, "1951-01-01");
  assert.equal(plan3.completedWindows.length, 2);
});
