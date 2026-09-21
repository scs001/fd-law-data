#!/usr/bin/env node
// Data-machine loader for wenshu crawl JSONL (tasks 4.1-4.3): registers each
// daily file in src_files (schema 'D', provenance by path), upserts
// dict_texts, loads judgments via the per-file DELETE→batched-INSERT rule,
// rebuilds touched months' blocks/, writes processed markers last. Mirrors
// bin/flk-load.mjs conventions: config via loadConfig(), hand-signed S3,
// JSON summary on stdout, non-zero exit on error. Never exposes PG.
import pg from "pg";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { load } from "../lib/wenshu/loader.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const dryRun = !!arg("dry-run");
const cfg = loadConfig();
const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });

try {
  await client.connect();
  const summary = await load({ s3, bucket: cfg.wenshuBucket, pg: client, dryRun });
  console.log(JSON.stringify({ ...summary, dryRun }));
} catch (err) {
  console.error(`[wenshu-load] FATAL: ${err.message}`);
  process.exitCode = 1;
} finally {
  try {
    await client.end();
  } catch {
    /* never connected */
  }
}
