// --entries CLI contract: file vs inline spec, id resolution through the
// adapter, and loud failures. No network, no object storage, no telemetry.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEntriesSpec } from "../bin/legal-source-crawl.mjs";
import { parseEntriesOverride } from "../lib/legal-sources/runtime.js";
import { ccdiSupervisoryAdapter } from "../lib/legal-sources/sources/ccdi-supervisory.js";
import { mfaTreatyAdapter } from "../lib/legal-sources/sources/mfa-treaty.js";

function tempFile(name, body) {
  const dir = mkdtempSync(join(tmpdir(), "legal-entries-"));
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

test("--entries reads source ids from a file and resolves them through the adapter", () => {
  const file = tempFile("ids.txt", "253\n1434,\n999\n");
  const entries = parseEntriesOverride(readEntriesSpec(file), ccdiSupervisoryAdapter);
  assert.deepEqual(entries.map((entry) => entry.source_id), ["253", "1434", "999"]);
  assert.ok(entries.every((entry) => /\/fgk\/law_display\/\d+$/.test(entry.url)));
});

test("--entries accepts an inline comma list and JSON / JSONL entry files", () => {
  const inline = parseEntriesOverride(readEntriesSpec("253,1434"), ccdiSupervisoryAdapter);
  assert.deepEqual(inline.map((entry) => entry.source_id), ["253", "1434"]);

  const jsonl = tempFile("entries.jsonl", '{"source_id":"253","title":"监察法实施条例","url":"https://www.ccdi.gov.cn/fgk/law_display/253"}\n');
  const fromJsonl = parseEntriesOverride(readEntriesSpec(jsonl), ccdiSupervisoryAdapter);
  assert.deepEqual(fromJsonl.map((entry) => entry.source_id), ["253"]);
  assert.equal(fromJsonl[0].title, "监察法实施条例");

  const jsonArray = tempFile("entries.json", JSON.stringify([{ source_id: "1", url: "u1" }, { source_id: "2", url: "u2" }]));
  assert.equal(parseEntriesOverride(readEntriesSpec(jsonArray), ccdiSupervisoryAdapter).length, 2);
});

test("--entries fails loudly on a missing flag value, a missing file and a non-resolving adapter", () => {
  assert.throws(() => readEntriesSpec(true), /requires a file path or comma-separated source ids/);
  assert.throws(() => readEntriesSpec("/no/such/legal-source-entries.txt"), /--entries file not found/);
  // mfa-treaty has no entryFromId: a bare id would need a hand-built entry, so
  // it must ask for an entries file instead of fetching a synthesized URL.
  assert.throws(
    () => parseEntriesOverride(readEntriesSpec("1758592256114"), mfaTreatyAdapter),
    /cannot resolve entries from a bare source id/,
  );
});