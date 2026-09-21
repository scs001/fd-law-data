#!/usr/bin/env node
// flk daily crawl. Credentials via env/.env only (RustFS keys; no PG here).
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { crawl, retryPending } from "../lib/flk/crawler.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const cfg = loadConfig();
const dryRun = !!arg("dry-run");
const retryMode = !!arg("retry-pending");
const s3 = createS3(
  dryRun
    ? { endpoint: "https://dry-run.invalid", accessKey: "dry", secretKey: "run" }
    : { endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region },
);

if (retryMode) {
  const res = await retryPending({ s3, bucket: cfg.lawsBucket, days: Number(arg("days", 14)), dryRun, rateMs: cfg.flkRateMs });
  console.log(JSON.stringify({ mode: "retry-pending", fixed: res.fixed.length, detail: res.fixed.slice(0, 20) }, null, 1));
} else {
  const res = await crawl({
    s3,
    bucket: cfg.lawsBucket,
    lookbackDays: cfg.flkLookbackDays,
    pageSize: cfg.flkPageSize,
    rateMs: cfg.flkRateMs,
    since: arg("since") === true ? undefined : arg("since"),
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
