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

// A part is immutable once complete; a later run never rewrites an earlier part.
export function structuredPartKey(source, runDate, part) {
  return `${structuredPrefix(source)}run-${runDate}-part${String(part).padStart(3, "0")}.jsonl`;
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
