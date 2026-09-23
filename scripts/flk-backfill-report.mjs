#!/usr/bin/env node
// FLK historical-backfill coverage report. Default mode reads backfill state
// and law_db only. --live adds six cheap source-side total probes (one per
// top-level FLK category); it never downloads docx bodies.
import pg from "pg";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { BACKFILL_STATE_KEY } from "../lib/flk/crawler.js";
import { TOP_LEVEL_CODES, enumData, searchList } from "../lib/flk/api.js";

const arg = (name, def = false) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const value = process.argv[i + 1];
  return value && !value.startsWith("--") ? value : true;
};
const cfg = loadConfig();
const s3 = createS3({
  endpoint: cfg.s3Endpoint,
  accessKey: cfg.s3AccessKey,
  secretKey: cfg.s3SecretKey,
  region: cfg.s3Region,
});
const buf = await s3.getObject(cfg.lawsBucket, BACKFILL_STATE_KEY);
const state = buf ? JSON.parse(buf.toString("utf8")) : { known: [], backfill: { complete: false, nextStart: "1949-01-01" } };

const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
await client.connect();
try {
  const bySourceNote = (await client.query(
    `SELECT COALESCE(source_note,'unknown') AS source_note, count(*)::bigint AS n
       FROM laws WHERE src_db='flk' GROUP BY 1 ORDER BY 1`,
  )).rows;
  const byCategory = (await client.query(
    `SELECT COALESCE(category,'unknown') AS category, count(*)::bigint AS n
       FROM laws WHERE src_db='flk' GROUP BY 1 ORDER BY count(*) DESC`,
  )).rows;
  const byYear = (await client.query(
    `SELECT EXTRACT(YEAR FROM publish)::int AS year, count(*)::bigint AS n
       FROM laws WHERE src_db='flk' AND publish IS NOT NULL GROUP BY 1 ORDER BY 1`,
  )).rows;
  const minMax = (await client.query(
    `SELECT min(publish) AS min_publish, max(publish) AS max_publish, count(*)::bigint AS n
       FROM laws WHERE src_db='flk'`,
  )).rows[0];

  const live = {};
  if (arg("live")) {
    const { topLevel } = await enumData();
    for (const root of topLevel) {
      const { total } = await searchList({
        flfgCodeId: root.codes,
        gbrqStart: "1949-01-01",
        gbrqEnd: new Date().toISOString().slice(0, 10),
        pageNum: 1,
        pageSize: 1,
      });
      live[`${root.code} ${root.name}`] = total;
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    backfill: {
      complete: state.backfill?.complete ?? false,
      nextStart: state.backfill?.nextStart ?? "1949-01-01",
      completedWindows: state.backfill?.completedWindows ?? [],
      knownSourceIds: state.known?.length ?? 0,
      lastRun: state.lastRun ?? null,
    },
    local: {
      total: Number(minMax.n ?? 0),
      minPublish: minMax.min_publish,
      maxPublish: minMax.max_publish,
      bySourceNote: bySourceNote.map((r) => ({ source_note: r.source_note, rows: Number(r.n) })),
      byCategory: byCategory.map((r) => ({ category: r.category, rows: Number(r.n) })),
      byYear: byYear.map((r) => ({ year: r.year, rows: Number(r.n) })),
    },
    sourceTotalsLive: arg("live") ? live : null,
    notes: [
      "local.total is the live flk generation after loader dedupe; law/lawv2 rows are intentionally excluded.",
      "completedWindows totals are source-side candidate totals observed by each completed batch, not inserted rows.",
      "Use --live to compare current per-category source totals with local coverage.",
    ],
  };
  console.log(JSON.stringify(report, null, 1));
  if (arg("strict") && (!state.backfill?.complete || Object.keys(live).length === 0)) process.exitCode = 2;
} finally {
  await client.end();
}
