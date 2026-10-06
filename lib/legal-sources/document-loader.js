// Idempotent PostgreSQL loader for legal_documents. The SQL here is the only
// writer for this table; source-specific CLI loaders only fetch and fold
// structured JSONL snapshots before handing records to loadLegalDocuments().
export const LEGAL_DOCUMENTS_DDL_FILE = "db/001_legal_documents.sql";

export const DDL = [
  `CREATE TABLE IF NOT EXISTS legal_documents (
     id            bigserial PRIMARY KEY,
     source        text        NOT NULL,
     source_id     text        NOT NULL,
     doc_type      text        NOT NULL,
     title         text        NOT NULL,
     published_at  timestamptz,
     effective_at  timestamptz,
     status        text,
     authority     text,
     language      text,
     content       text,
     content_hash  text        NOT NULL,
     source_url    text        NOT NULL,
     metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
     fetched_at    timestamptz,
     loaded_at     timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS legal_documents_source_source_id_uniq
     ON legal_documents (source, source_id)`,
  `CREATE INDEX IF NOT EXISTS legal_documents_source_doc_type_idx
     ON legal_documents (source, doc_type)`,
  `CREATE INDEX IF NOT EXISTS legal_documents_published_at_idx
     ON legal_documents (published_at)`,
  `CREATE INDEX IF NOT EXISTS legal_documents_metadata_idx
     ON legal_documents USING gin (metadata jsonb_path_ops)`,
];

// Rows per multi-row upsert. 14 columns per row means 200 rows = 2,800 bind
// parameters, far below PostgreSQL's 65,535 limit, while keeping each statement
// small enough that content-heavy sources (gov rules run ~14 KB/row average)
// do not put multi-megabyte statements on a high-latency link. On the xinru ->
// Windows-PG path (~200 ms RTT) 10.5k rows drop from 10.5k round trips to ~53.
export const UPSERT_CHUNK_SIZE = 200;

export const UPSERT_COLUMNS = [
  "source", "source_id", "doc_type", "title", "published_at", "effective_at", "status",
  "authority", "language", "content", "content_hash", "source_url", "metadata", "fetched_at",
];

const UPSERT_TAIL = `ON CONFLICT (source, source_id) DO UPDATE SET
  doc_type = EXCLUDED.doc_type,
  title = EXCLUDED.title,
  published_at = EXCLUDED.published_at,
  effective_at = EXCLUDED.effective_at,
  status = EXCLUDED.status,
  authority = EXCLUDED.authority,
  language = EXCLUDED.language,
  content = EXCLUDED.content,
  content_hash = EXCLUDED.content_hash,
  source_url = EXCLUDED.source_url,
  metadata = EXCLUDED.metadata,
  fetched_at = EXCLUDED.fetched_at,
  loaded_at = now()
RETURNING (xmax = 0) AS inserted`;

// Versioned sources carry a canonical_url; before a new current row lands,
// retire prior versions in place; their content stays intact.
const RETIRE_PRIOR_VERSIONS = `UPDATE legal_documents
    SET status = '历史版本',
        metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{is_current}', 'false'::jsonb, true)
  WHERE source = $1
    AND source_id <> $2
    AND metadata->>'canonical_url' = $3
    AND COALESCE(metadata->>'is_current','true') <> 'false'`;

export function validateDocument(doc, index = 0) {
  const where = `legal_documents[${index}]`;
  for (const field of ["source", "source_id", "doc_type", "title", "content_hash", "source_url"]) {
    if (!doc?.[field] || String(doc[field]).trim() === "") throw new Error(`${where} missing ${field}`);
  }
  if (doc.content != null && typeof doc.content !== "string") throw new Error(`${where} content must be text or null`);
  return doc;
}

export function normalizeDocumentRow(doc, index = 0) {
  validateDocument(doc, index);
  return {
    source: String(doc.source),
    source_id: String(doc.source_id),
    doc_type: String(doc.doc_type),
    title: String(doc.title),
    published_at: doc.published_at ?? null,
    effective_at: doc.effective_at ?? null,
    status: doc.status ?? null,
    authority: doc.authority ?? null,
    language: doc.language ?? null,
    content: doc.content ?? null,
    content_hash: String(doc.content_hash),
    source_url: String(doc.source_url),
    metadata: doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {},
    fetched_at: doc.fetched_at ?? null,
  };
}

export async function ensureLegalDocumentsTable(client) {
  for (const stmt of DDL) await client.query(stmt);
}

export function chunkRecords(records, size = UPSERT_CHUNK_SIZE) {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunk size must be a positive integer: ${size}`);
  const chunks = [];
  for (let i = 0; i < records.length; i += size) chunks.push(records.slice(i, i + size));
  return chunks;
}

// One INSERT with $n placeholders per batch row; exported so the SQL shape
// (placeholder numbering, conflict target, RETURNING) is unit-testable.
export function buildUpsertSql(rowCount) {
  if (!Number.isInteger(rowCount) || rowCount < 1) throw new Error(`rowCount must be a positive integer: ${rowCount}`);
  const width = UPSERT_COLUMNS.length;
  const tuples = [];
  for (let r = 0; r < rowCount; r++) {
    const placeholders = [];
    for (let c = 0; c < width; c++) placeholders.push(`$${r * width + c + 1}`);
    tuples.push(`(${placeholders.join(",")})`);
  }
  return `INSERT INTO legal_documents\n  (${UPSERT_COLUMNS.join(", ")})\nVALUES ${tuples.join(",")}\n${UPSERT_TAIL}`;
}

function rowParams(row) {
  return [
    row.source,
    row.source_id,
    row.doc_type,
    row.title,
    row.published_at,
    row.effective_at,
    row.status,
    row.authority,
    row.language,
    row.content,
    row.content_hash,
    row.source_url,
    JSON.stringify(row.metadata ?? {}),
    row.fetched_at,
  ];
}

// Fold multiple snapshots before calling this: latest record for a source_id
// wins. Unchanged rows are skipped by hash, so a full reload writes nothing.
// Changed rows are written in chunkSize-row batches, each committed on its own:
// a crash leaves a complete prefix of chunks (all rows individually complete)
// and a rerun skips whatever already landed, instead of holding one 2h
// transaction open across a high-latency link.
export async function loadLegalDocuments(
  client,
  records,
  { dryRun = false, guardTables = ["laws", "law_chunks"], chunkSize = UPSERT_CHUNK_SIZE, onProgress } = {},
) {
  const normalized = records.map(normalizeDocumentRow);
  const countsBefore = {};
  for (const table of guardTables) {
    const res = await client.query(`SELECT count(*)::bigint AS n FROM ${table}`);
    countsBefore[table] = Number(res.rows[0].n);
  }

  let inserted = 0;
  let updated = 0;
  let skippedUnchanged = 0;
  if (!dryRun) {
    await ensureLegalDocumentsTable(client);
    if (normalized.length) {
      const stored = new Map();
      const sources = [...new Set(normalized.map((r) => r.source))];
      const { rows } = await client.query(
        "SELECT source, source_id, content_hash FROM legal_documents WHERE source = ANY($1)",
        [sources],
      );
      for (const row of rows) stored.set(`${row.source}\u0000${row.source_id}`, row.content_hash);

      const chunks = chunkRecords(normalized, chunkSize);
      for (let index = 0; index < chunks.length; index++) {
        const changed = [];
        // Versioned sources: the last changed row per (source, canonical_url)
        // is the new current one; one retire statement per group replaces the
        // per-row retires (same final state, one round trip per group).
        const retires = new Map();
        for (const row of chunks[index]) {
          const key = `${row.source}\u0000${row.source_id}`;
          if (stored.get(key) === row.content_hash) {
            skippedUnchanged++;
            continue;
          }
          changed.push(row);
          const canonicalUrl = row.metadata?.canonical_url;
          if (canonicalUrl) {
            retires.set(`${row.source}\u0000${canonicalUrl}`, { source: row.source, canonicalUrl, sourceId: row.source_id });
          }
        }
        if (!changed.length) continue;

        await client.query("BEGIN");
        try {
          const { rows: affected } = await client.query(buildUpsertSql(changed.length), changed.flatMap(rowParams));
          for (const row of affected) {
            if (row.inserted) inserted++;
            else updated++;
          }
          for (const row of changed) stored.set(`${row.source}\u0000${row.source_id}`, row.content_hash);
          for (const retire of retires.values()) {
            await client.query(RETIRE_PRIOR_VERSIONS, [retire.source, retire.sourceId, retire.canonicalUrl]);
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
        onProgress?.({ chunk: index + 1, chunks: chunks.length, rows: changed.length, inserted, updated, skippedUnchanged });
      }
    }
  }

  const countsAfter = {};
  for (const table of guardTables) {
    const res = await client.query(`SELECT count(*)::bigint AS n FROM ${table}`);
    countsAfter[table] = Number(res.rows[0].n);
  }
  const guardUnchanged = Object.keys(countsBefore).every((table) => countsBefore[table] === countsAfter[table]);
  return {
    recordsRead: normalized.length,
    inserted,
    updated,
    skippedUnchanged,
    guard: { before: countsBefore, after: countsAfter, unchanged: guardUnchanged },
  };
}

// Effective-body caliber over in-memory records (report.js parity: content
// with all whitespace stripped must reach 50 chars, else the row counts as no
// effective body). Feeds the loader's telemetry metrics so the platform sees
// the same quality numbers the daily report computes from SQL.
export function effectiveBodyStats(records) {
  const total = records.length;
  let effective = 0;
  for (const record of records) {
    const body = typeof record?.content === "string" ? record.content.replace(/\s+/g, "") : "";
    if (body.length >= 50) effective++;
  }
  return {
    coverage_count: total,
    effective_body_rows: effective,
    effective_body_ratio: total ? Math.round((effective / total) * 10000) / 10000 : 0,
  };
}