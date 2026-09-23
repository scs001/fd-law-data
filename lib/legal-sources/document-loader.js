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

const UPSERT = `INSERT INTO legal_documents
  (source, source_id, doc_type, title, published_at, effective_at, status,
   authority, language, content, content_hash, source_url, metadata, fetched_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
ON CONFLICT (source, source_id) DO UPDATE SET
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

// Fold multiple snapshots before calling this: latest record for a source_id
// wins. Unchanged rows are skipped by hash, so a full reload writes nothing.
export async function loadLegalDocuments(client, records, { dryRun = false, guardTables = ["laws", "law_chunks"] } = {}) {
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
    await client.query("BEGIN");
    try {
      const stored = new Map();
      if (normalized.length) {
        const sources = [...new Set(normalized.map((r) => r.source))];
        const { rows } = await client.query(
          "SELECT source, source_id, content_hash FROM legal_documents WHERE source = ANY($1)",
          [sources],
        );
        for (const row of rows) stored.set(`${row.source}\u0000${row.source_id}`, row.content_hash);
      }
      for (const row of normalized) {
        const key = `${row.source}\u0000${row.source_id}`;
        if (stored.get(key) === row.content_hash) {
          skippedUnchanged++;
          continue;
        }
        // Versioned sources carry a canonical_url. Before a new current row
        // lands, retire prior versions in place; their content stays intact.
        const canonicalUrl = row.metadata?.canonical_url;
        if (canonicalUrl) {
          await client.query(
            `UPDATE legal_documents
                SET status = '历史版本',
                    metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{is_current}', 'false'::jsonb, true)
              WHERE source = $1
                AND source_id <> $2
                AND metadata->>'canonical_url' = $3
                AND COALESCE(metadata->>'is_current','true') <> 'false'`,
            [row.source, row.source_id, canonicalUrl],
          );
        }
        const result = await client.query(UPSERT, [
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
        ]);
        if (result.rows[0]?.inserted) inserted++;
        else updated++;
        stored.set(key, row.content_hash);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
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
