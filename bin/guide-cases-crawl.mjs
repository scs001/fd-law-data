#!/usr/bin/env node
// Guiding-cases crawl (fd-law-data). Credentials via env/.env only (RustFS
// keys; no PG here — the loader runs on the data machine).
//
//   node bin/guide-cases-crawl.mjs --dry-run          # sweep + parse, write nothing
//   node bin/guide-cases-crawl.mjs --list             # sweep only, no detail pages
//   node bin/guide-cases-crawl.mjs --limit 5          # smoke run on the newest cases
//   node bin/guide-cases-crawl.mjs                    # full run -> bucket
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { crawl, sweepColumn, noticeTitles, defaultFetchPage } from "../lib/guidecases/crawler.js";
import { errorHead, finishRun, startRun, telemetrySourceName } from "../lib/telemetry.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const cfg = loadConfig();
const dryRun = !!arg("dry-run");
const listOnly = !!arg("list");
const limit = arg("limit") ? Number(arg("limit")) : undefined;
const rateMs = Number(arg("rate-ms", cfg.guideCasesRateMs));
const bucket = cfg.lawsBucket;
const prefix = cfg.guideCasesPrefix;

const fetchPage = defaultFetchPage;

if (listOnly) {
  const sweep = await sweepColumn({ fetchPage });
  console.log(JSON.stringify({
    mode: "list",
    pages: sweep.pages,
    columnTotal: sweep.total,
    entries: sweep.entries.length,
    cases: sweep.cases.length,
    notices: sweep.notices.length,
    coverage: sweep.coverage,
    noticeTitles: noticeTitles(sweep),
  }, null, 1));
} else {
  const s3 = createS3(
    dryRun
      ? { endpoint: "https://dry-run.invalid", accessKey: "dry", secretKey: "run" }
      : { endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region },
  );
  // Federation telemetry under the CronJob name; never throws, so reporting
  // trouble cannot change this script's exit code.
  const runId = await startRun({ source: telemetrySourceName("guide-cases") });
  try {
    const { manifest } = await crawl({ s3, bucket, prefix, rateMs, dryRun, limit, fetchPage });
    await finishRun(runId, { status: "success", rowsWritten: manifest.emitted ?? 0 });
    console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "crawl", bucket, prefix, manifest }, null, 1));
  } catch (err) {
    await finishRun(runId, { status: "failed", rowsWritten: 0, errorHead: errorHead(err) });
    throw err;
  }
}
