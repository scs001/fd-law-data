// Pure planning for FLK historical backfill. A run owns one bounded publish
// date window; its part files and state key are separate from the daily
// incremental cursor, while source-id dedupe and src_id allocation are seeded
// from the live generation.
export const DEFAULT_BACKFILL_SINCE = "1949-01-01";
export const DEFAULT_BACKFILL_BATCH_DAYS = 365;

const addDays = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const dayAfter = (ymd) => addDays(ymd, 1);

export function backfillPlan(state, {
  since = DEFAULT_BACKFILL_SINCE,
  until,
  batchDays = DEFAULT_BACKFILL_BATCH_DAYS,
} = {}) {
  if (!until) throw new Error("backfill plan requires until");
  if (since > until) throw new Error("backfill since must not exceed until");
  const width = Math.max(1, Number(batchDays));
  // Resume only when the planning constants match; states recorded before
  // batchDays existed (batchDays == null) resume on `since` alone. `until` is
  // deliberately excluded: the scheduled backfill targets "today", which
  // changes daily and must not reset historical progress.
  const progress = state?.backfill && state.backfill.since === since
    && (state.backfill.batchDays == null || Number(state.backfill.batchDays) === width)
    ? state.backfill
    : { nextStart: since, complete: false, completedWindows: [] };
  return {
    since,
    until,
    batchDays: width,
    nextStart: progress.complete ? null : progress.nextStart,
    complete: Boolean(progress.complete),
    completedWindows: progress.completedWindows ?? [],
  };
}

export function backfillWindow(plan) {
  if (plan.complete || !plan.nextStart) return null;
  const proposedEnd = addDays(plan.nextStart, plan.batchDays - 1);
  const end = proposedEnd > plan.until ? plan.until : proposedEnd;
  return { start: plan.nextStart, end };
}

export function advanceBackfill(state, window, until, totalByCode = {}, { since, batchDays } = {}) {
  const nextStart = dayAfter(window.end);
  const complete = nextStart > until;
  state.backfill = {
    ...(state.backfill ?? {}),
    // Persist the planning constants so the next run's resume guard holds.
    since: since ?? state.backfill?.since ?? window.start,
    batchDays: batchDays ?? state.backfill?.batchDays ?? null,
    nextStart: complete ? null : nextStart,
    complete,
    completedWindows: [
      ...(state.backfill?.completedWindows ?? []),
      { ...window, finishedAt: new Date().toISOString(), totalByCode },
    ],
  };
  return state;
}
