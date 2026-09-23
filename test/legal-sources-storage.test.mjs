import test from "node:test";
import assert from "node:assert/strict";
import {
  sourcePrefix,
  stateKey,
  structuredPartKey,
  manifestKey,
  rawKey,
  attachmentKey,
  safeSegment,
  sourceRootSummary,
} from "../lib/legal-sources/storage.js";

test("legal source storage keys stay isolated and deterministic", () => {
  assert.equal(sourcePrefix("mfa-treaty-library"), "legal-sources/mfa-treaty-library");
  assert.equal(stateKey("mfa-treaty-library"), "legal-sources/mfa-treaty-library/state.json");
  assert.equal(
    structuredPartKey("mfa-treaty-library", "2026-09-23", 2),
    "legal-sources/mfa-treaty-library/structured/run-2026-09-23-part002.jsonl",
  );
  assert.equal(
    manifestKey("mfa-treaty-library", "2026-09-23", "20260923000000"),
    "legal-sources/mfa-treaty-library/manifest/run-2026-09-23-20260923000000.manifest.json",
  );
  assert.equal(
    rawKey("mfa-treaty-library", "objid/1", "page.html"),
    "legal-sources/mfa-treaty-library/raw/objid%2F1/page.html",
  );
  assert.equal(
    attachmentKey("mfa-treaty-library", "1", "条约文本.pdf"),
    "legal-sources/mfa-treaty-library/attachments/1/%E6%9D%A1%E7%BA%A6%E6%96%87%E6%9C%AC.pdf",
  );
});

test("safeSegment removes path separators and caps long names", () => {
  assert.equal(safeSegment("a/b\\c"), "a%2Fb%5Cc");
  assert.equal(safeSegment("").length > 0, true);
  assert.ok(safeSegment("x".repeat(500)).length <= 180);
});

test("sourceRootSummary names the five layout roots", () => {
  const summary = sourceRootSummary("rmfyalk-case-library");
  assert.deepEqual(Object.keys(summary).sort(), ["attachments", "manifest", "raw", "root", "state", "structured"]);
  assert.ok(summary.structured.startsWith(`${summary.root}/structured/`));
});

test("invalid source ids fail loudly", () => {
  assert.throws(() => sourcePrefix("../escape"), /invalid legal source id/);
  assert.throws(() => sourcePrefix(""), /invalid legal source id/);
});
