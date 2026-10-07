import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalContentHash,
  crawlLegalSource,
  entriesFromIds,
  parseEntriesOverride,
  parseEntryIds,
} from "../lib/legal-sources/runtime.js";
import { StructureDriftError, SessionProxyError } from "../lib/legal-sources/errors.js";

function memoryS3() {
  const objects = new Map();
  return {
    objects,
    async getObject(bucket, key) {
      return objects.get(`${bucket}/${key}`) ?? null;
    },
    async putObject(bucket, key, body) {
      objects.set(`${bucket}/${key}`, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
      return {};
    },
    async headObject(bucket, key) {
      const value = objects.get(`${bucket}/${key}`);
      return value ? { contentLength: value.length } : null;
    },
  };
}

const BUCKET = "laws";
const entries = [
  { source_id: "1", title: "One", url: "https://example.test/1", hash: "h1" },
  { source_id: "2", title: "Two", url: "https://example.test/2", hash: "h2" },
  { source_id: "3", title: "Three", url: "https://example.test/3", hash: "h3" },
];

function adapter(overrides = {}) {
  return {
    mode: "http",
    rateMs: 0,
    async list(filters, helpers) {
      return { entries: overrides.entries ?? entries, total: 3, pages: 1, unreachablePages: [] };
    },
    async detail(entry) {
      if (overrides.detail) return overrides.detail(entry);
      return {
        document: {
          source_id: entry.source_id,
          doc_type: "case",
          title: entry.title,
          source_url: entry.url,
          content: `body ${entry.source_id}`,
          published_at: "2026-01-0" + entry.source_id,
        },
        hash: entry.hash,
      };
    },
  };
}

test("canonical hash is stable under metadata key order", () => {
  const left = { title: "T", content: "C", metadata: { a: 1, b: 2 } };
  const right = { content: "C", title: "T", metadata: { b: 2, a: 1 } };
  assert.equal(canonicalContentHash(left), canonicalContentHash(right));
});

test("first crawl emits and persists state; second incremental crawl is a no-op", async () => {
  const s3 = memoryS3();
  const first = await crawlLegalSource({ s3, bucket: BUCKET, source: "test-source", adapter: adapter(), mode: "incremental", rateMs: 0 });
  assert.equal(first.manifest.coverage.emitted, 3);
  assert.equal(first.manifest.parts.length, 1);
  assert.ok(first.state.hashes["1"]);

  const second = await crawlLegalSource({ s3, bucket: BUCKET, source: "test-source", adapter: adapter(), mode: "incremental", rateMs: 0 });
  assert.equal(second.manifest.coverage.planned, 0);
  assert.equal(second.records.length, 0);
  const part = [...s3.objects.keys()].find((key) => key.endsWith(".jsonl"));
  const rows = s3.objects.get(part).toString().trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.source === "test-source" && row.content_hash));
});

test("full mode refreshes unchanged rows and preserves failures in state", async () => {
  const s3 = memoryS3();
  await crawlLegalSource({ s3, bucket: BUCKET, source: "test-source", adapter: adapter(), mode: "incremental", rateMs: 0 });
  const failing = adapter({
    detail(entry) {
      if (entry.source_id === "1") throw new Error("detail unavailable");
      return { document: { source_id: entry.source_id, title: entry.title, source_url: entry.url, content: "changed" } };
    },
  });
  const result = await crawlLegalSource({ s3, bucket: BUCKET, source: "test-source", adapter: failing, mode: "full", rateMs: 0 });
  assert.equal(result.records.length, 2);
  assert.equal(result.manifest.failures.length, 1);
  assert.equal(result.state.failures["1"].attempts, 1);
  assert.equal(result.state.hashes["1"], firstStoredHash(s3));
});

test("full mode writes records even when the hash is unchanged", async () => {
  const s3 = memoryS3();
  const first = await crawlLegalSource({
    s3, bucket: BUCKET, source: "test-source", adapter: adapter(), mode: "incremental", rateMs: 0,
    now: () => new Date("2026-10-07T01:00:00Z"),
  });
  assert.equal(first.manifest.coverage.emitted, 3);

  // Re-download with identical content in full mode: the hash matches state,
  // but dropping the record here would discard the only fresh copy of the
  // evidence (the ccdi full5 failure mode).
  const runDate = new Date("2026-10-07T02:00:00Z");
  const second = await crawlLegalSource({
    s3, bucket: BUCKET, source: "test-source", adapter: adapter(), mode: "full", rateMs: 0,
    now: () => runDate,
  });
  assert.equal(second.manifest.coverage.skippedUnchanged, 0);
  assert.equal(second.manifest.coverage.emitted, 3);
  assert.equal(second.records.length, 3);
  assert.equal(second.manifest.parts.length, 1);

  // The second run writes its own part; the first run's part is untouched.
  const firstKey = first.manifest.parts[0].key;
  const secondKey = second.manifest.parts[0].key;
  assert.notEqual(firstKey, secondKey);
  assert.ok(secondKey.includes("run-20261007020000"), secondKey);
  assert.ok(s3.objects.has(`${BUCKET}/${firstKey}`));
  assert.ok(s3.objects.has(`${BUCKET}/${secondKey}`));
  const rows = s3.objects.get(`${BUCKET}/${secondKey}`).toString().trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 3);
});

test("incremental mode still suppresses an unchanged detail hash", async () => {
  const s3 = memoryS3();
  await crawlLegalSource({ s3, bucket: BUCKET, source: "test-source", adapter: adapter(), mode: "incremental", rateMs: 0 });
  // A changed list-level hash puts every entry back in the target list; the
  // detail hash still matches state, so incremental mode skips the write.
  const relisted = adapter({
    entries: entries.map((entry) => ({ ...entry, hash: `${entry.hash}-list` })),
    detail(entry) {
      return {
        document: {
          source_id: entry.source_id,
          doc_type: "case",
          title: entry.title,
          source_url: entry.url,
          content: `body ${entry.source_id}`,
          published_at: "2026-01-0" + entry.source_id,
        },
        hash: entry.hash.replace(/-list$/, ""),
      };
    },
  });
  const second = await crawlLegalSource({ s3, bucket: BUCKET, source: "test-source", adapter: relisted, mode: "incremental", rateMs: 0 });
  assert.equal(second.manifest.coverage.planned, 3);
  assert.equal(second.manifest.coverage.skippedUnchanged, 3);
  assert.equal(second.records.length, 0);
  assert.equal(second.manifest.parts.length, 0);
});

test("entries override runs the given entries with full semantics and marks the manifest", async () => {
  const s3 = memoryS3();
  await crawlLegalSource({
    s3, bucket: BUCKET, source: "test-source", adapter: adapter(), mode: "incremental", rateMs: 0,
    now: () => new Date("2026-10-07T01:00:00Z"),
  });
  const requested = entries.filter((entry) => entry.source_id === "2");
  const result = await crawlLegalSource({
    s3, bucket: BUCKET, source: "test-source", adapter: adapter(), mode: "full", entries: requested, rateMs: 0,
    now: () => new Date("2026-10-07T03:00:00Z"),
  });
  assert.equal(result.manifest.entriesOverride, true);
  assert.equal(result.manifest.coverage.listed, 1);
  assert.equal(result.manifest.coverage.skippedUnchanged, 0);
  assert.deepEqual(result.records.map((row) => row.source_id), ["2"]);
});

test("entries override spec accepts ids, JSON arrays and JSONL", () => {
  assert.deepEqual(parseEntryIds("1, 2\n3;1"), ["1", "2", "3"]);
  assert.deepEqual(parseEntryIds(["4", "4", "5"]), ["4", "5"]);

  const resolving = { id: "fake", entryFromId: (id) => ({ source_id: id, url: `https://example.test/${id}` }) };
  const entries = entriesFromIds("7,8", resolving);
  assert.deepEqual(entries.map((entry) => entry.url), ["https://example.test/7", "https://example.test/8"]);
  assert.throws(() => entriesFromIds("9", { id: "no-resolver" }), /cannot resolve entries from a bare source id/);
  assert.throws(() => entriesFromIds(" , ", resolving), /at least one source id/);

  const fromArray = parseEntriesOverride('[{"source_id": 1, "url": "u1"}]', resolving);
  assert.deepEqual(fromArray, [{ source_id: "1", url: "u1" }]);
  const fromJsonl = parseEntriesOverride('{"source_id":"1","url":"u1"}\n{"source_id":"2","url":"u2"}', resolving);
  assert.deepEqual(fromJsonl.map((entry) => entry.source_id), ["1", "2"]);
  const fromIds = parseEntriesOverride("11,12", resolving);
  assert.deepEqual(fromIds.map((entry) => entry.source_id), ["11", "12"]);
  assert.throws(() => parseEntriesOverride('[{"url":"u"}]', resolving), /missing source_id/);
  assert.throws(() => parseEntriesOverride("   ", resolving), /entries override is empty/);
});

test("unreachable list pages make the manifest incomplete", async () => {
  const s3 = memoryS3();
  const result = await crawlLegalSource({
    s3,
    bucket: BUCKET,
    source: "test-source",
    adapter: {
      mode: "http",
      rateMs: 0,
      async list() {
        return {
          entries: [entries[0]],
          total: 1,
          pages: 2,
          unreachablePages: [{ page: 2, reason: "list page returned no entries (soft block or partial render)" }],
        };
      },
      async detail(entry) {
        return { document: { source_id: entry.source_id, title: entry.title, source_url: entry.url, content: "body" } };
      },
    },
    rateMs: 0,
  });
  assert.equal(result.manifest.coverage.complete, false);
  assert.deepEqual(result.manifest.coverage.unreachablePages, [
    { page: 2, reason: "list page returned no entries (soft block or partial render)" },
  ]);
  assert.equal(result.records.length, 1);
});

test("a list-phase SessionProxyError aborts the run instead of producing an empty manifest", async () => {
  const s3 = memoryS3();
  await assert.rejects(
    () => crawlLegalSource({
      s3,
      bucket: BUCKET,
      source: "test-source",
      adapter: {
        mode: "http",
        rateMs: 0,
        async list() { throw new SessionProxyError("rate-limit block page reached the list parser", { code: "RATE_LIMITED" }); },
        async detail() { throw new Error("unreachable"); },
      },
      rateMs: 0,
    }),
    (err) => err.name === "SessionProxyError" && /rate-limit/.test(err.message),
  );
  assert.equal([...s3.objects.keys()].filter((key) => key.endsWith(".jsonl")).length, 0);
});

function firstStoredHash(s3) {
  const stateKey = [...s3.objects.keys()].find((key) => key.endsWith("/state.json"));
  return JSON.parse(s3.objects.get(stateKey).toString()).hashes["1"];
}

test("structure drift is a recoverable item failure, not a run abort", async () => {
  const s3 = memoryS3();
  const result = await crawlLegalSource({
    s3,
    bucket: BUCKET,
    source: "test-source",
    adapter: adapter({
      detail(entry) {
        if (entry.source_id === "1") throw new StructureDriftError("missing title");
        return { document: { source_id: entry.source_id, title: entry.title, source_url: entry.url, content: "body" } };
      },
    }),
    rateMs: 0,
  });
  assert.equal(result.records.length, 2);
  assert.equal(result.manifest.failures[0].kind, "structure");
  assert.equal(result.manifest.coverage.complete, true);
});

test("failure threshold aborts with an incomplete manifest", async () => {
  const s3 = memoryS3();
  const many = Array.from({ length: 20 }, (_, i) => ({ source_id: String(i + 1), title: `T${i}`, url: `u${i}` }));
  const result = await crawlLegalSource({
    s3,
    bucket: BUCKET,
    source: "test-source",
    adapter: adapter({
      entries: many,
      detail() { throw new StructureDriftError("drift"); },
    }),
    maxFailureRatio: 0.1,
    rateMs: 0,
  });
  assert.ok(result.manifest.aborted);
  assert.equal(result.manifest.coverage.complete, false);
  assert.ok(result.manifest.failures.length < many.length);
});

test("session/proxy failure aborts immediately and never invents success", async () => {
  const s3 = memoryS3();
  const result = await crawlLegalSource({
    s3,
    bucket: BUCKET,
    source: "test-source",
    adapter: adapter({
      detail() { throw new SessionProxyError("stale session", { code: "EXPIRED" }); },
    }),
    rateMs: 0,
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.manifest.aborted.reason, "session/proxy failure");
  assert.equal(result.manifest.coverage.complete, false);
  assert.equal(result.state.failures["1"].kind, "session");
});

test("attachments are uploaded separately and referenced in metadata", async () => {
  const s3 = memoryS3();
  const result = await crawlLegalSource({
    s3,
    bucket: BUCKET,
    source: "test-source",
    adapter: adapter({
      detail(entry) {
        return {
          document: { source_id: entry.source_id, title: entry.title, source_url: entry.url, content: "body" },
          artifacts: [{ kind: "attachment", filename: `${entry.source_id}.pdf`, contentType: "application/pdf", body: Buffer.from("pdf") }],
        };
      },
    }),
    rateMs: 0,
  });
  assert.equal(result.manifest.coverage.attachments, 3);
  assert.ok(result.records[0].metadata.object_keys[0].includes("/attachments/"));
});
