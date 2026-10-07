// Object-storage contract for wave-1 legal sources:
//   legal-sources/<source>/{raw,structured,attachments,manifest}/...
// Keys are deterministic so snapshots can be reprocessed and audited in order.
export const LEGAL_SOURCES_ROOT = "legal-sources";

export function sourcePrefix(source) {
  if (!source || !/^[a-z0-9][a-z0-9-]*$/.test(source)) throw new Error(`invalid legal source id: ${source}`);
  return `${LEGAL_SOURCES_ROOT}/${source}`;
}

export function stateKey(source) {
  return `${sourcePrefix(source)}/state.json`;
}

export function structuredPrefix(source) {
  return `${sourcePrefix(source)}/structured/`;
}

export function rawPrefix(source) {
  return `${sourcePrefix(source)}/raw/`;
}

export function attachmentsPrefix(source) {
  return `${sourcePrefix(source)}/attachments/`;
}

export function manifestPrefix(source) {
  return `${sourcePrefix(source)}/manifest/`;
}

// A part is immutable once complete. The run id (UTC timestamp, YYYYMMDDHHMMSS)
// is part of the key: a day-only key let a second run on the same day overwrite
// the first run's parts, and the fold then served only the later run's records
// while state.json still claimed the earlier ones were done — a permanently
// skipped set that even --full could not repair (ccdi full5 clobbered full3).
//
// Sort position is load-bearing, because the loader folds parts in key order
// with latest-wins per source_id: every id-bearing key sorts after every legacy
// day-only key, and id-bearing keys sort by run time, so a newer run always
// folds last. Both byte order and the loader's ICU collation order are covered
// by test/legal-sources-storage.test.mjs.
export function structuredPartKey(source, runId, part) {
  const stamp = String(runId ?? "");
  if (!/^[0-9]{14}$/.test(stamp)) throw new Error(`invalid legal source run id: ${runId}`);
  return `${structuredPrefix(source)}run-${stamp}-part${String(part).padStart(3, "0")}.jsonl`;
}

export function manifestKey(source, runDate, runId) {
  return `${manifestPrefix(source)}run-${runDate}-${runId}.manifest.json`;
}

// Keep object keys stable without letting a source id or URL introduce slashes.
export function safeSegment(value, { maxLength = 180 } = {}) {
  const text = String(value ?? "unnamed");
  let encoded = encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  if (encoded.length > maxLength) encoded = encoded.slice(0, maxLength);
  return encoded || "unnamed";
}

export function rawKey(source, sourceId, filename) {
  return `${rawPrefix(source)}${safeSegment(sourceId)}/${safeSegment(filename)}`;
}

export function attachmentKey(source, sourceId, filename) {
  return `${attachmentsPrefix(source)}${safeSegment(sourceId)}/${safeSegment(filename)}`;
}

export function runDateUtc(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function runIdUtc(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export function sourceRootSummary(source) {
  return {
    root: sourcePrefix(source),
    state: stateKey(source),
    structured: structuredPrefix(source),
    raw: rawPrefix(source),
    attachments: attachmentsPrefix(source),
    manifest: manifestPrefix(source),
  };
}
