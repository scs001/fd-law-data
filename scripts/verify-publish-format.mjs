#!/usr/bin/env node
// Run ON THE DATA MACHINE (PG is 127.0.0.1-only there).
// Verifies laws.publish format uniformity for the watermark seed and prints
// the recommended --since for the first crawler run.
//   node scripts/verify-publish-format.mjs
import pg from "pg";
import { loadConfig } from "../lib/config.js";

const cfg = loadConfig();
const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
await client.connect();

const { rows } = await client.query(`
  SELECT src_db,
         count(*) AS total,
         count(*) FILTER (WHERE substring(publish from 1 for 10) ~ '^\\d{4}-\\d{2}-\\d{2}$') AS ymd,
         count(*) FILTER (WHERE publish IS NULL) AS nulls,
         count(*) FILTER (WHERE publish IS NOT NULL AND substring(publish from 1 for 10) !~ '^\\d{4}-\\d{2}-\\d{2}$') AS other,
         max(substring(publish from 1 for 10)) AS max_ymd,
         max(src_id) AS max_src_id
  FROM laws WHERE src_db IN ('law','lawv2') GROUP BY src_db`);

console.table(rows.map((r) => ({
  src_db: r.src_db, total: r.total, date_part_ok: r.ymd, null_: r.nulls, other: r.other, max_publish_date: r.max_ymd,
})));

const bad = rows.reduce((a, r) => a + Number(r.other), 0);
const maxs = rows.map((r) => r.max_ymd).filter(Boolean).sort();
console.log(bad === 0
  ? `publish date-part uniform. Recommended first-run seed: --since ${maxs.at(-1)}`
  : `WARNING: ${bad} rows whose publish date-part is not YYYY-MM-DD — inspect before seeding the watermark`);
await client.end();
