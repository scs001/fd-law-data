#!/usr/bin/env node
// Unified data-machine loader for legal_documents snapshots. It reads only the
// structured/ prefix and writes only legal_documents; existing corpora are
// guarded, never modified.
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { loadLegalDocuments } from "../lib/legal-sources/document-loader.js";
import { SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";
import { structuredPrefix } from "../lib/legal-sources/storage.js";

function arg(argv, name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : true;
}

export async function main({ source: defaultSource, argv = [] } = {}) {
  const source = arg(argv, "source", defaultSource);
  if (!source || source === true) {
    throw new Error(`--source is required; known: ${[...SOURCE_ADAPTERS.keys()].join(", ")}`);
  }
  const cfg = loadConfig();
  const dryRun = !!arg(argv, "dry-run");
  const s3 = createS3({
    endpoint: cfg.s3Endpoint,
    accessKey: cfg.s3AccessKey,
    secretKey: cfg.s3SecretKey,
    region: cfg.s3Region,
  });
  const prefix = structuredPrefix(String(source));
  const objects = [];
  let token;
  for (;;) {
    const page = await s3.listObjects(cfg.lawsBucket, { prefix, continuationToken: token });
    objects.push(...page.contents.filter((o) => o.key.endsWith(".jsonl")));
    if (!page.truncated) break;
    token = page.continuationToken;
  }
  objects.sort((a, b) => a.key.localeCompare(b.key));

  const folded = new Map();
  let recordsRead = 0;
  for (const object of objects) {
    const buf = await s3.getObject(cfg.lawsBucket, object.key);
    if (!buf) continue;
    for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        folded.set(`${record.source}\u0000${record.source_id}`, record);
        recordsRead++;
      } catch {
        // A torn final line is tolerable; row-level hashes keep a malformed
        // line from being silently promoted to a database row.
        console.error(`[${source}] skipped malformed line in ${object.key}`);
      }
    }
  }
  const records = [...folded.values()];
  if (!records.length) throw new Error(`no structured records under ${cfg.lawsBucket}/${prefix}`);

  const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
  await client.connect();
  try {
    const guardTables = arg(argv, "no-guard") ? [] : ["laws", "law_chunks"];
    const result = await loadLegalDocuments(client, records, { dryRun, guardTables });
    const summary = {
      mode: dryRun ? "dry-run" : "load",
      source,
      prefix,
      partFiles: objects.length,
      recordsRead,
      ...result,
    };
    console.log(JSON.stringify(summary, null, 1));
    if (!result.guard.unchanged) throw new Error("existing corpora moved during legal_documents load");
    return summary;
  } finally {
    await client.end();
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  return entry && import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  try {
    await main({ argv: process.argv.slice(2) });
  } catch (err) {
    console.error(`[legal-source-load] FATAL: ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
}
