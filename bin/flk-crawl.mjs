#!/usr/bin/env node
// flk daily crawl. Credentials via env/.env only (RustFS keys; no PG here).
// --backfill advances one bounded historical window in backfill-state.json;
// normal incremental runs continue to own incremental/state.json.
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { crawl, retryPending, BACKFILL_STATE_KEY, loadBackfillState, saveBackfillState } from "../lib/flk/crawler.js";
import { backfillPlan, backfillWindow, advanceBackfill, DEFAULT_BACKFILL_SINCE, DEFAULT_BACKFILL_BATCH_DAYS } from "../lib/flk/backfill.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const cfg = loadConfig();
const dryRun = !!arg("dry-run");
const retryMode = !!arg("retry-pending");
const backfillMode = !!arg("backfill");
const s3 = createS3(
  dryRun
    ? { endpoint: "https://dry-run.invalid", accessKey: "dry", secretKey: "run" }
    : { endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region },
);

if (retryMode) {
  const res = await retryPending({ s3, bucket: cfg.lawsBucket, days: Number(arg("days", 14)), dryRun, rateMs: cfg.flkRateMs });
  console.log(JSON.stringify({ mode: "retry-pending", fixed: res.fixed.length, detail: res.fixed.slice(0, 20) }, null, 1));
} else if (backfillMode) {
  let until = arg("until") === true ? undefined : arg("until");
  if (!until) {
    // Scheduled backfill always targets the latest Beijing calendar day.
    until = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }
  const planInput = {
    since: (arg("since") === true ? undefined : arg("since")) ?? DEFAULT_BACKFILL_SINCE,
    until,
    batchDays: Number(arg("batch-days", DEFAULT_BACKFILL_BATCH_DAYS)),
  };
  const priorState = dryRun ? {} : await loadBackfillState(s3, cfg.lawsBucket);
  const plan = backfillPlan(priorState, planInput);
  const window = backfillWindow(plan);
  if (!window) {
    console.log(JSON.stringify({ mode: "backfill", plan, window: null, complete: true }, null, 1));
  } else {
    const res = await crawl({
      s3,
      bucket: cfg.lawsBucket,
      lookbackDays: cfg.flkLookbackDays,
      pageSize: cfg.flkPageSize,
      since: window.start,
      until: window.end,
      codes: arg("codes") ? String(arg("codes")).split(",").map(Number) : undefined,
      dryRun,
      tz: cfg.flkTz,
      rateMs: cfg.flkRateMs,
      stateKey: BACKFILL_STATE_KEY,
      keyPrefix: "incremental/backfill",
      sourceNote: "flk-backfill",
    });
    if (!dryRun) advanceBackfill(res.state, window, until, res.manifest.byCode);
    if (!dryRun) await saveBackfillState(s3, cfg.lawsBucket, res.state);
    console.log(JSON.stringify({
      mode: dryRun ? "dry-run" : "backfill",
      plan: { ...plan, window },
      manifest: res.manifest,
      complete: dryRun ? false : res.state.backfill.complete,
    }, null, 1));
  }
} else {
  const res = await crawl({
    s3,
    bucket: cfg.lawsBucket,
    lookbackDays: cfg.flkLookbackDays,
    pageSize: cfg.flkPageSize,
    rateMs: cfg.flkRateMs,
    since: arg("since") === true ? undefined : arg("since"),
    until: arg("until") === true ? undefined : arg("until"),
    codes: arg("codes") ? String(arg("codes")).split(",").map(Number) : undefined,
    dryRun,
    tz: cfg.flkTz,
  });
  // Records whose docx failed land as pending; the repair pass re-fetches them
  // for the last N days as part of the same daily run (--no-retry opts out).
  let retried = 0;
  if (!dryRun && !arg("no-retry")) {
    try {
      const fix = await retryPending({ s3, bucket: cfg.lawsBucket, days: Number(arg("days", 14)), rateMs: cfg.flkRateMs });
      retried = fix.fixed.length;
    } catch (err) {
      console.error(`[flk-crawl] retry-pending failed (will retry next run): ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
  console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "crawl", manifest: res.manifest, retried }, null, 1));
}
