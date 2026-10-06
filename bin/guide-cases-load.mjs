#!/usr/bin/env node
// Data-machine loader for guiding-case snapshots: folds the bucket's part
// files (oldest first, later record for the same source id wins) into
// law_db.guide_cases, then applies the curated 不再参照 list.
//
// Runs where law_db is reachable. It writes exactly one table — guide_cases —
// and reads two counts (laws, law_chunks) purely as a guard that the existing
// corpora did not move; no wenshu database is opened.
import pg from "pg";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { foldSnapshots } from "../lib/guidecases/crawler.js";
import { deprecationsByCaseNo, REFERENCE_EFFECTIVE, REFERENCE_SUPERSEDED } from "../lib/guidecases/deprecations.js";
import { errorHead, finishRun, startRun, telemetrySourceName } from "../lib/telemetry.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS guide_cases (
     source_id        text PRIMARY KEY,
     case_no          integer,
     doc_type         text NOT NULL,
     title            text NOT NULL,
     listed_at        date,
     publish_at       timestamptz,
     source           text,
     source_url       text NOT NULL,
     fetched_at       timestamptz,
     content_hash     text NOT NULL,
     keyword          text,
     gist             text,
     facts            text,
     result           text,
     reasoning        text,
     statutes         text,
     body             text,
     reference_status text NOT NULL DEFAULT '有效',
     reference_note   text,
     loaded_at        timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS guide_cases_case_no_idx ON guide_cases (case_no)`,
  // One row per case number: a re-published case under a new page id would
  // collide here and fail the load loudly rather than fork the corpus.
  `CREATE UNIQUE INDEX IF NOT EXISTS guide_cases_case_no_uniq ON guide_cases (case_no) WHERE case_no IS NOT NULL`,
];

const UPSERT = `INSERT INTO guide_cases
   (source_id, case_no, doc_type, title, listed_at, publish_at, source, source_url,
    fetched_at, content_hash, keyword, gist, facts, result, reasoning, statutes, body)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
 ON CONFLICT (source_id) DO UPDATE SET
   case_no = EXCLUDED.case_no, doc_type = EXCLUDED.doc_type, title = EXCLUDED.title,
   listed_at = EXCLUDED.listed_at, publish_at = EXCLUDED.publish_at, source = EXCLUDED.source,
   source_url = EXCLUDED.source_url, fetched_at = EXCLUDED.fetched_at,
   content_hash = EXCLUDED.content_hash, keyword = EXCLUDED.keyword, gist = EXCLUDED.gist,
   facts = EXCLUDED.facts, result = EXCLUDED.result, reasoning = EXCLUDED.reasoning,
   statutes = EXCLUDED.statutes, body = EXCLUDED.body, loaded_at = now()
 RETURNING (xmax = 0) AS inserted`;

// Federation telemetry under the CronJob name; observer excludes *-load
// CronJobs, so direct reporting is this loader's only visibility. rows_written
// = newly inserted cases/notices. start/finish never throw, so the exit code
// is untouched by reporting trouble.
const runId = await startRun({ source: telemetrySourceName("guide-cases", "load") });
let rowsWritten = 0;
try {
  const cfg = loadConfig();
  const dryRun = !!arg("dry-run");
  const prefix = arg("prefix") === true ? cfg.guideCasesPrefix : (arg("prefix") ?? cfg.guideCasesPrefix);
  const s3 = createS3(
    dryRun && !cfg.s3Endpoint
      ? { endpoint: "https://dry-run.invalid", accessKey: "dry", secretKey: "run" }
      : { endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region },
  );

  const { folded, parts, records } = await foldSnapshots(s3, cfg.lawsBucket, prefix);
  if (!folded.size) throw new Error(`no records under ${cfg.lawsBucket}/${prefix} — run the crawler first`);

  const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
  await client.connect();

  const countOf = async (table) => Number((await client.query(`SELECT count(*)::bigint AS n FROM ${table}`)).rows[0].n);
  const before = { laws: await countOf("laws"), chunks: await countOf("law_chunks") };

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  if (!dryRun) {
    for (const stmt of DDL) await client.query(stmt);
    await client.query("BEGIN");
    try {
      // A record whose stored hash already matches is left alone entirely, so a
      // reload of an unchanged snapshot writes nothing at all.
      const stored = new Map(
        (await client.query("SELECT source_id, content_hash FROM guide_cases")).rows.map((r) => [r.source_id, r.content_hash]),
      );
      for (const rec of folded.values()) {
        const sourceId = String(rec.source_id);
        if (rec.content_hash && stored.get(sourceId) === rec.content_hash) {
          skipped++;
          continue;
        }
        const { rows } = await client.query(UPSERT, [
          sourceId,
          rec.case_no ?? null,
          rec.doc_type === "case" ? "case" : "notice",
          rec.title,
          rec.listed_at ?? null,
          rec.publish_at ?? null,
          rec.source ?? null,
          rec.source_url,
          rec.fetched_at ?? null,
          rec.content_hash,
          rec.sections?.keyword ?? null,
          rec.sections?.gist ?? null,
          rec.sections?.facts ?? null,
          rec.sections?.result ?? null,
          rec.sections?.reasoning ?? null,
          rec.sections?.statutes ?? null,
          rec.body ?? null,
        ]);
        if (rows[0]?.inserted) inserted++;
        else updated++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    rowsWritten = inserted;
  }

  // Reference status is derived from the curated list rather than from the
  // crawl, so a notice published tomorrow only needs this step re-run
  // (design.md D6), and a case removed from the list flips back to 有效. The
  // note names the notice that deprecated *that* case, so a row's status stays
  // traceable when more notices arrive.
  const byCaseNo = deprecationsByCaseNo();
  const deprecated = [...byCaseNo.keys()];
  const byDocNo = new Map();
  for (const [caseNo, notice] of byCaseNo) {
    if (!byDocNo.has(notice.docNo)) byDocNo.set(notice.docNo, []);
    byDocNo.get(notice.docNo).push(caseNo);
  }
  let marked;
  let cleared;
  if (dryRun) {
    const m = await client.query(
      `SELECT count(*)::int AS n FROM guide_cases WHERE case_no = ANY($1) AND reference_status IS DISTINCT FROM $2`,
      [deprecated, REFERENCE_SUPERSEDED],
    );
    const c = await client.query(
      `SELECT count(*)::int AS n FROM guide_cases WHERE reference_status <> $1 AND (case_no IS NULL OR NOT (case_no = ANY($2)))`,
      [REFERENCE_EFFECTIVE, deprecated],
    );
    marked = Number(m.rows[0].n);
    cleared = Number(c.rows[0].n);
  } else {
    marked = 0;
    for (const [docNo, caseNumbers] of byDocNo) {
      const m = await client.query(
        `UPDATE guide_cases SET reference_status = $1, reference_note = $2
         WHERE case_no = ANY($3) AND (reference_status IS DISTINCT FROM $1 OR reference_note IS DISTINCT FROM $2)`,
        [REFERENCE_SUPERSEDED, docNo, caseNumbers],
      );
      marked += m.rowCount ?? 0;
    }
    const c = await client.query(
      `UPDATE guide_cases SET reference_status = $1, reference_note = NULL
       WHERE reference_status <> $1 AND (case_no IS NULL OR NOT (case_no = ANY($2)))`,
      [REFERENCE_EFFECTIVE, deprecated],
    );
    cleared = c.rowCount ?? 0;
  }

  const after = { laws: await countOf("laws"), chunks: await countOf("law_chunks") };
  if (after.laws !== before.laws || after.chunks !== before.chunks) {
    throw new Error(`FATAL: existing corpora moved — laws ${before.laws}->${after.laws}, law_chunks ${before.chunks}->${after.chunks}`);
  }

  const summary = await client.query(
    `SELECT count(*) FILTER (WHERE doc_type = 'case')::int AS cases,
            count(*) FILTER (WHERE doc_type = 'notice')::int AS notices,
            count(*) FILTER (WHERE reference_status = $1)::int AS deprecated,
            min(case_no)::int AS min_case, max(case_no)::int AS max_case,
            count(*) FILTER (WHERE case_no IS NOT NULL AND gist IS NULL)::int AS cases_without_gist
     FROM guide_cases`,
    [REFERENCE_SUPERSEDED],
  );
  const missing = await client.query(
    `SELECT g.n AS case_no FROM generate_series(
       (SELECT min(case_no) FROM guide_cases), (SELECT max(case_no) FROM guide_cases)) AS g(n)
     LEFT JOIN guide_cases c ON c.case_no = g.n WHERE c.case_no IS NULL`,
  );

  await client.end();
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run" : "load",
    bucket: cfg.lawsBucket,
    prefix,
    partFiles: parts.length,
    recordsRead: records,
    distinctSources: folded.size,
    fromParts: {
      cases: [...folded.values()].filter((r) => r.doc_type === "case").length,
      notices: [...folded.values()].filter((r) => r.doc_type !== "case").length,
    },
    inserted,
    updated,
    skippedUnchanged: skipped,
    rows: summary.rows[0],
    missingNumbersInDb: missing.rows.map((r) => r.case_no),
    deprecatedMarked: marked,
    effectiveCleared: cleared,
    guard: { laws: before.laws, law_chunks: before.chunks, unchanged: true },
  }, null, 1));
  await finishRun(runId, { status: "success", rowsWritten });
} catch (err) {
  await finishRun(runId, { status: "failed", rowsWritten, errorHead: errorHead(err) });
  throw err;
}
