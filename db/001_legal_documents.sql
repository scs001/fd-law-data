-- Unified canonical document store for the wave-1 authoritative legal sources.
-- Applied idempotently by lib/legal-sources/document-loader.js; source-specific
-- fields live in metadata to avoid one table per source.
CREATE TABLE IF NOT EXISTS legal_documents (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_documents_source_source_id_uniq
  ON legal_documents (source, source_id);

CREATE INDEX IF NOT EXISTS legal_documents_source_doc_type_idx
  ON legal_documents (source, doc_type);

CREATE INDEX IF NOT EXISTS legal_documents_published_at_idx
  ON legal_documents (published_at);

CREATE INDEX IF NOT EXISTS legal_documents_metadata_idx
  ON legal_documents USING gin (metadata jsonb_path_ops);
