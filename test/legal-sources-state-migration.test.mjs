// State size guard + state rebuild (change rmfyalk-incremental-identity,
// tasks 2.5 and 2.6).
//
// The identity key of three legal sources changed, so their state.json keys are
// dead weight (rmfyalk held 17,461 one-shot token keys, 2.1 MB). Task 2.5 keeps
// that from ever growing silently again; task 2.6 rebuilds the state under the
// new keys from the newest run's part files so the first post-fix run does not
// pay a full crawl.
import test from "node:test";
import assert from "node:assert/strict";
import { LocalS3 } from "./fixtures/local-s3.mjs";
import {
  DEFAULT_MAX_HASH_ENTRIES,
  MAX_HASH_ENTRIES,
  emptyState,
  rememberSuccess,
  saveState,
  selectTargets,
  stateKeyOf,
  stateSizeReport,
  warnStateSize,
} from "../lib/legal-sources/state.js";
import { crawlLegalSource } from "../lib/legal-sources/runtime.js";
import { stateKey, structuredPartKey } from "../lib/legal-sources/storage.js";
import {
  classifyPartKeys,
  commitRebuild,
  parseArgs,
  parsePartLines,
  rebuildSource,
  run,
  serializeState,
} from "../scripts/rebuild-legal-source-state.mjs";

const BUCKET = "laws";
const RMFYALK = "rmfyalk-case-library";
const PARTY = "party-regulation-library";

// ── task 2.5: bounded state size ───────────────────────────────────────────

test("the default hash bound leaves headroom over the largest corpus", () => {
  // Largest steady-state legal corpus is gov-rules at ~10.6k entries; a bound
  // under that would alarm on a healthy source, and one with no headroom would
  // alarm as soon as the source grows.
  assert.equal(DEFAULT_MAX_HASH_ENTRIES, 20000);
  assert.ok(DEFAULT_MAX_HASH_ENTRIES > 10600 * 1.5);
  // A key that rotates per request adds ~5.8k dead keys per run (rmfyalk), so
  // the bound must be reachable within a handful of runs, not years.
  assert.ok(DEFAULT_MAX_HASH_ENTRIES < 5800 * 10);
  assert.equal(MAX_HASH_ENTRIES, DEFAULT_MAX_HASH_ENTRIES);
});

test("the size report flags an over-bound state and stays silent under it", () => {
  const small = emptyState("small-source");
  for (let i = 0; i < 3; i++) rememberSuccess(small, { sourceId: `k${i}`, hash: `h${i}` });
  assert.deepEqual(stateSizeReport(small, { max: 10 }), { source: "small-source", hashes: 3, max: 10, exceeded: false });
  assert.deepEqual(stateSizeReport(small, { max: 2 }), { source: "small-source", hashes: 3, max: 2, exceeded: true });
  assert.equal(warnStateSize(small, { log: () => { throw new Error("must not log"); }, max: 10 }), null);
});

test("an over-bound state warns without truncating and without failing the save", async () => {
  const s3 = new LocalS3();
  const state = emptyState("leaky-source");
  for (let i = 0; i < 12; i++) rememberSuccess(state, { sourceId: `tok-${i}`, hash: `h${i}` });

  const logged = [];
  const saved = await saveState(s3, BUCKET, state, { log: (message) => logged.push(message), max: 10 });

  // Loud: names the source, the count and the bound.
  assert.equal(logged.length, 1);
  assert.match(logged[0], /\[leaky-source\]/);
  assert.match(logged[0], /12 hash keys/);
  assert.match(logged[0], /over the 10 bound/);
  // Non-fatal and non-destructive: every key is still there.
  assert.equal(Object.keys(saved.hashes).length, 12);
  const stored = JSON.parse((await s3.getObject(BUCKET, stateKey("leaky-source"))).toString("utf8"));
  assert.equal(Object.keys(stored.hashes).length, 12);
  assert.equal(stored.hashes["tok-11"], "h11");
});

test("the legality of an over-bound save is what the next run sees, not a prune", () => {
  // A silent prune would make the next run re-plan the whole corpus with
  // nothing in the logs to explain it — the exact failure the bound exists to
  // make visible.
  const state = emptyState("leaky-source");
  for (let i = 0; i < 12; i++) rememberSuccess(state, { sourceId: `tok-${i}`, hash: `h${i}` });
  const { targets } = selectTargets([{ source_id: "tok-3", hash: "h3" }], state, { mode: "incremental" });
  assert.deepEqual(targets, [], "known keys still hit after an over-bound save");
});

test("LEGAL_STATE_MAX_HASHES overrides the bound", async () => {
  const previous = process.env.LEGAL_STATE_MAX_HASHES;
  process.env.LEGAL_STATE_MAX_HASHES = "5";
  try {
    const { MAX_HASH_ENTRIES: override } = await import("../lib/legal-sources/state.js?override=5");
    assert.equal(override, 5);
  } finally {
    if (previous === undefined) delete process.env.LEGAL_STATE_MAX_HASHES;
    else process.env.LEGAL_STATE_MAX_HASHES = previous;
  }
});

test("an over-bound crawl still succeeds and reports the state size in its manifest", async () => {
  const s3 = new LocalS3();
  // Seed an over-bound state so the run's save path has to warn.
  const seeded = emptyState("over-bound-source");
  for (let i = 0; i < 25; i++) rememberSuccess(seeded, { sourceId: `tok-${i}`, hash: `h${i}` });
  await s3.putObject(BUCKET, stateKey("over-bound-source"), JSON.stringify(seeded, null, 1));

  const logged = [];
  const entries = [{ source_id: "new-1", title: "New", url: "https://example.test/new-1" }];
  const result = await crawlLegalSource({
    s3,
    bucket: BUCKET,
    source: "over-bound-source",
    adapter: {
      mode: "http",
      rateMs: 0,
      async list() { return { entries, total: 1, pages: 1, unreachablePages: [] }; },
      async detail(entry) {
        return {
          document: { source_id: entry.source_id, title: entry.title, source_url: entry.url, content: "body" },
          hash: "h-new",
        };
      },
    },
    rateMs: 0,
    log: (message) => logged.push(message),
    // The real bound is 20k; 25 seeded keys trip a scaled-down one so the
    // warning path is exercised without seeding 20k entries.
    maxHashEntries: 20,
  });

  assert.equal(result.manifest.coverage.emitted, 1, "the run completes despite the oversized state");
  assert.equal(result.manifest.state.hashes, 26);
  assert.equal(result.manifest.state.maxHashes, 20);
  assert.equal(result.manifest.state.overMaxHashes, true);
  assert.ok(logged.some((line) => /over the 20 bound/.test(line)), `expected a size warning, got ${JSON.stringify(logged)}`);
});

test("a healthy crawl records its state size as within bounds", async () => {
  const s3 = new LocalS3();
  const logged = [];
  const result = await crawlLegalSource({
    s3,
    bucket: BUCKET,
    source: "healthy-source",
    adapter: {
      mode: "http",
      rateMs: 0,
      async list() {
        return { entries: [{ source_id: "a", title: "A", url: "https://example.test/a" }], total: 1, pages: 1, unreachablePages: [] };
      },
      async detail(entry) {
        return { document: { source_id: entry.source_id, title: entry.title, source_url: entry.url, content: "body" }, hash: "h" };
      },
    },
    rateMs: 0,
    log: (message) => logged.push(message),
  });
  assert.equal(result.manifest.state.hashes, 1);
  assert.equal(result.manifest.state.overMaxHashes, false);
  assert.deepEqual(logged.filter((line) => /bound/.test(line)), []);
});

// ── task 2.6: rebuild helpers ──────────────────────────────────────────────

test("the rebuild CLI parses one source and rejects a valueless flag", () => {
  // parseArgs is permissive about WHICH sources exist; run() validates against
  // the registry and refuses to rewrite the fleet unless --all is explicit.
  const opts = parseArgs(["--source", RMFYALK, "--dry-run", "--limit", "2"]);
  assert.deepEqual(opts, { source: RMFYALK, all: false, dryRun: true, limit: 2, help: false });
  assert.equal(parseArgs(["--all"]).all, true);
  assert.throws(() => parseArgs(["--source"]), /--source/);
  assert.throws(() => parseArgs(["--wat"]), /unknown or incomplete argument/);
});

test("part keys group into runs in chronological order", () => {
  const runs = classifyPartKeys([
    "legal-sources/s/structured/run-20261008120000-part002.jsonl",
    "legal-sources/s/structured/run-20261005090000-part001.jsonl",
    "legal-sources/s/structured/run-20261008120000-part001.jsonl",
    "legal-sources/s/structured/run-2026-10-06-part001.jsonl", // legacy day-only key
    "legal-sources/s/structured/run-20261008120000-part010.jsonl",
  ]);
  // Only id-bearing run parts qualify; the newest run folds last.
  assert.deepEqual(runs.map((run) => run.runId), ["20261005090000", "20261008120000"]);
  assert.deepEqual(runs.at(-1).keys, [
    "legal-sources/s/structured/run-20261008120000-part001.jsonl",
    "legal-sources/s/structured/run-20261008120000-part002.jsonl",
    "legal-sources/s/structured/run-20261008120000-part010.jsonl",
  ]);
});

test("a torn tail line is skipped, not fatal", () => {
  const { records, malformed } = parsePartLines('{"source_id":"a"}\n\n{truncated\n{"source_id":"b"}');
  assert.deepEqual(records.map((r) => r.source_id), ["a", "b"]);
  assert.equal(malformed, 1);
});

// Seed one source's newest run with NDJSON parts plus a state keyed the OLD
// way. Case numbers (rmfyalk) and canonical URLs (party) are the new keys.
async function seedSource(s3, { source, runId = "20261008120000", parts }) {
  for (const [index, records] of parts.entries()) {
    const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await s3.putObject(BUCKET, structuredPartKey(source, runId, index + 1), body);
  }
}

function rmfyalkParts() {
  return [[
    { source: RMFYALK, source_id: "2026-13-2-167-004", content_hash: "h-case-1", published_at: "2026-03-01" },
    { source: RMFYALK, source_id: "2026-13-2-167-005", content_hash: "h-case-2", published_at: "2026-04-01" },
  ], [
    { source: RMFYALK, source_id: "2026-13-2-167-006", content_hash: "h-case-3" },
  ]];
}

test("rebuild keys the state by the new identity and drops the old keys", async () => {
  const s3 = new LocalS3();
  await seedSource(s3, { source: RMFYALK, parts: rmfyalkParts() });
  // Old state: rotating token keys, plus a failure on one of them.
  const old = emptyState(RMFYALK);
  rememberSuccess(old, { sourceId: "tok-AAA%3D", hash: "h-case-1" });
  rememberSuccess(old, { sourceId: "tok-BBB%3D", hash: "h-case-2" });
  old.failures["tok-CCC%3D"] = { sourceId: "tok-CCC%3D", kind: "http", reason: "boom", attempts: 2 };
  old.watermark = "2026-01-01";
  await s3.putObject(BUCKET, stateKey(RMFYALK), JSON.stringify(old, null, 1));

  const lines = [];
  const plan = await rebuildSource({ s3, bucket: BUCKET, source: RMFYALK, stamp: "20261010090000", log: (l) => lines.push(l) });

  assert.equal(plan.oldKeys, 2);
  assert.equal(plan.newKeys, 3);
  assert.equal(plan.droppedKeys, 2);
  assert.equal(plan.partsRead, 2);
  assert.equal(plan.droppedFailures, 1);

  const stored = JSON.parse((await s3.getObject(BUCKET, stateKey(RMFYALK))).toString("utf8"));
  assert.deepEqual(Object.keys(stored.hashes).sort(), ["2026-13-2-167-004", "2026-13-2-167-005", "2026-13-2-167-006"]);
  assert.equal(stored.hashes["2026-13-2-167-004"], "h-case-1");
  assert.ok(!("tok-AAA%3D" in stored.hashes), "old token keys are gone");
  assert.deepEqual(Object.keys(stored.failures), [], "an unmappable failure is dropped, not carried");
  // The watermark is corpus-wide, so it survives the key change — and the
  // rebuilt parts push it forward to the newest published_at they carry.
  assert.equal(stored.watermark, "2026-04-01");
  assert.equal(stored.rebuild.fromRunId, "20261008120000");
  assert.equal(stored.rebuild.previousHashKeys, 2);
  // Result is readable from the summary alone.
  assert.ok(lines.join("\n").includes("new hash keys     : 3"));
  assert.ok(lines.join("\n").includes("backup            : legal-sources/rmfyalk-case-library/state.json.bak-20261010090000"));
});

test("rebuild is idempotent: a second run yields the same state", async () => {
  const s3 = new LocalS3();
  await seedSource(s3, { source: RMFYALK, parts: rmfyalkParts() });

  await rebuildSource({
    s3, bucket: BUCKET, source: RMFYALK, stamp: "20261010090000",
    now: new Date("2026-10-10T09:00:00Z"), log: () => {},
  });
  const firstState = JSON.parse((await s3.getObject(BUCKET, stateKey(RMFYALK))).toString("utf8"));

  const second = await rebuildSource({
    s3, bucket: BUCKET, source: RMFYALK, stamp: "20261010100000",
    now: new Date("2026-10-10T09:00:00Z"), log: () => {},
  });
  const secondState = JSON.parse((await s3.getObject(BUCKET, stateKey(RMFYALK))).toString("utf8"));

  // The incremental state is identical: same keys, same hashes, same
  // watermark, same source run. Only the `rebuild` provenance marker differs
  // (previousHashKeys 0 -> 3) because it records what the rebuild REPLACED,
  // not what the state holds now. Nothing that affects the next run moves.
  const stripMarker = (state) => JSON.stringify({ ...state, rebuild: null }, null, 1);
  assert.equal(stripMarker(secondState), stripMarker(firstState));

  // A second run drops nothing: every key it reads is already a new key.
  assert.equal(second.droppedKeys, 0);
  assert.equal(second.newKeys, 3);
  assert.deepEqual(Object.keys(secondState.hashes), Object.keys(firstState.hashes));
});

test("rebuild survives a mid-way failure with the original state intact", async () => {
  const s3 = new LocalS3();
  await seedSource(s3, { source: RMFYALK, parts: rmfyalkParts() });
  const original = JSON.stringify({ ...emptyState(RMFYALK), hashes: { "tok-OLD": "h" }, failures: {} }, null, 1);
  await s3.putObject(BUCKET, stateKey(RMFYALK), original);
  const before = (await s3.getObject(BUCKET, stateKey(RMFYALK))).toString("utf8");

  // Fail on the second put of the commit: the backup exists, the stage exists,
  // but state.json must never have been touched. A wrapper object (not
  // Object.create) keeps LocalS3's private-key methods callable.
  let puts = 0;
  const failing = {
    getObject: (bucket, key) => s3.getObject(bucket, key),
    listObjects: (bucket, opts) => s3.listObjects(bucket, opts),
    deleteObject: (bucket, key) => s3.deleteObject(bucket, key),
    putObject: async (bucket, key, body, opts) => {
      puts++;
      if (puts === 2) throw new Error("network died mid-rebuild");
      return s3.putObject(bucket, key, body, opts);
    },
  };

  await assert.rejects(
    () => rebuildSource({ s3: failing, bucket: BUCKET, source: RMFYALK, stamp: "20261010090000", log: () => {} }),
    /network died mid-rebuild/,
  );
  const after = await s3.getObject(BUCKET, stateKey(RMFYALK));
  assert.equal(after.toString("utf8"), before, "the original state object is untouched");
  // The backup was written before the failure, so nothing is lost either.
  const backup = await s3.getObject(BUCKET, `legal-sources/${RMFYALK}/state.json.bak-20261010090000`);
  assert.ok(backup, "the previous state was preserved as a backup sibling key");
  assert.equal(backup.toString("utf8"), before);
});

test("a source with no run parts is skipped loudly, not silently rebuilt empty", async () => {
  const s3 = new LocalS3();
  const old = emptyState("never-ran-source");
  rememberSuccess(old, { sourceId: "tok-1", hash: "h" });
  await s3.putObject(BUCKET, stateKey("never-ran-source"), JSON.stringify(old, null, 1));
  const before = (await s3.getObject(BUCKET, stateKey("never-ran-source"))).toString("utf8");

  await assert.rejects(
    () => rebuildSource({ s3, bucket: BUCKET, source: "never-ran-source", stamp: "20261010090000", log: () => {} }),
    /no structured run parts/,
  );
  assert.equal((await s3.getObject(BUCKET, stateKey("never-ran-source"))).toString("utf8"), before);
});

test("dry-run writes nothing and still reports what would change", async () => {
  const s3 = new LocalS3();
  await seedSource(s3, { source: RMFYALK, parts: rmfyalkParts() });
  const old = emptyState(RMFYALK);
  rememberSuccess(old, { sourceId: "tok-AAA%3D", hash: "h-case-1" });
  await s3.putObject(BUCKET, stateKey(RMFYALK), JSON.stringify(old, null, 1));
  const before = s3.snapshot(`legal-sources/${RMFYALK}/`);

  const lines = [];
  await rebuildSource({ s3, bucket: BUCKET, source: RMFYALK, dryRun: true, stamp: "20261010090000", log: (l) => lines.push(l) });
  const after = s3.snapshot(`legal-sources/${RMFYALK}/`);

  assert.deepEqual([...after.keys()], [...before.keys()], "no object added, removed or replaced");
  const summary = lines.join("\n");
  assert.match(summary, /dry-run \(nothing written\)/);
  assert.match(summary, /old hash keys     : 1/);
  assert.match(summary, /new hash keys     : 3/);
  assert.match(summary, /backup would be   : legal-sources\/rmfyalk-case-library\/state.json.bak-20261010090000 \(cleanup is manual\)/);
});

test("party regulations rebuild onto the canonical URL, not the versioned row id", async () => {
  const s3 = new LocalS3();
  const article = "http://news.12371.cn/2015/03/12/ARTI1426127349457326.shtml";
  await seedSource(s3, {
    source: PARTY,
    runId: "20261008120000",
    parts: [[
      // Versioned source_id (one row per revision) + state_key (canonical URL):
      // the rebuild must use the same key the runtime's stateKeyOf() picks.
      { source: PARTY, source_id: `${article}@v-aaaaaaaaaaaaaaaaaaaa`, state_key: article, content_hash: "h-v1" },
      { source: PARTY, source_id: `${article}@v-bbbbbbbbbbbbbbbbbbbb`, state_key: article, content_hash: "h-v2" },
    ]],
  });
  const old = emptyState(PARTY);
  rememberSuccess(old, { sourceId: `${article}@v-00000000000000000000`, hash: "h-old" });
  await s3.putObject(BUCKET, stateKey(PARTY), JSON.stringify(old, null, 1));

  await rebuildSource({ s3, bucket: BUCKET, source: PARTY, stamp: "20261010090000", log: () => {} });
  const stored = JSON.parse((await s3.getObject(BUCKET, stateKey(PARTY))).toString("utf8"));

  assert.deepEqual(Object.keys(stored.hashes), [article], "keyed by the canonical URL the list side looks up");
  assert.equal(stored.hashes[article], "h-v2", "the newest part wins per key, as the loader fold does");
  assert.equal(stateKeyOf({ source_id: `${article}@v-x`, state_key: article }), article);
});

test("the rebuilt state is what the next incremental run skips on", async () => {
  // The point of the whole exercise: a run over an unchanged corpus after the
  // rebuild must plan nothing.
  const s3 = new LocalS3();
  const parts = rmfyalkParts();
  await seedSource(s3, { source: RMFYALK, parts });
  await rebuildSource({ s3, bucket: BUCKET, source: RMFYALK, stamp: "20261010090000", log: () => {} });

  const rebuilt = JSON.parse((await s3.getObject(BUCKET, stateKey(RMFYALK))).toString("utf8"));
  const entries = parts.flat().map((record) => ({ source_id: record.source_id, hash: record.content_hash }));
  const { targets, skipped } = selectTargets(entries, rebuilt, { mode: "incremental" });
  assert.deepEqual(targets, [], "every corpus entry is already known under the new key");
  assert.equal(skipped.length, 3);
});

test("commit verifies what it wrote and cleans up its staging key", async () => {
  const s3 = new LocalS3();
  const source = "verify-source";
  const original = JSON.stringify({ ...emptyState(source), hashes: { old: "h" } }, null, 1);
  await s3.putObject(BUCKET, stateKey(source), original);
  const bytes = serializeState({ ...emptyState(source), hashes: { fresh: "h2" } }, {
    rebuiltAt: "2026-10-10T00:00:00.000Z",
    runId: "20261008120000",
    previousKeys: 1,
  });
  const result = await commitRebuild({ s3, bucket: BUCKET, source, bytes, stamp: "20261010090000" });
  assert.equal(result.backupKey, `legal-sources/${source}/state.json.bak-20261010090000`);
  assert.equal(await s3.getObject(BUCKET, result.tempKey), null, "the staging key is deleted after commit");
  assert.equal((await s3.getObject(BUCKET, stateKey(source))).toString("utf8"), bytes);
  assert.equal((await s3.getObject(BUCKET, result.backupKey)).toString("utf8"), original);
  assert.deepEqual(JSON.parse(bytes).rebuild, { at: "2026-10-10T00:00:00.000Z", fromRunId: "20261008120000", previousHashKeys: 1 });
});

test("run() rejects an unknown source and enforces an explicit --all", async () => {
  const s3 = new LocalS3();
  // A fleet-wide rewrite must never be the default: --source is required.
  await assert.rejects(() => run({ argv: [], s3, bucket: BUCKET }), /--source <id> is required/);
  await assert.rejects(() => run({ argv: ["--source", "not-a-source"], s3, bucket: BUCKET }), /unknown legal source/);
  // --all is explicit and tolerant: over an empty registry every source has no
  // parts, so each is reported as skipped rather than rebuilt empty — and the
  // run still exits non-zero so a cron cannot read it as success.
  const all = await run({ argv: ["--all"], s3, bucket: BUCKET, log: () => {} });
  assert.equal(all.ok, false);
  assert.equal(all.skipped.length, 5);
  assert.ok(all.skipped.every((entry) => /no structured run parts/.test(entry.reason)));
  assert.deepEqual(all.results, []);

  const dry = await run({ argv: ["--all", "--dry-run"], s3, bucket: BUCKET, log: () => {} });
  assert.equal(dry.ok, false, "dry-run reports skips too");
  assert.deepEqual([...s3.snapshot("legal-sources/").keys()], [], "dry-run over --all wrote nothing");
});
