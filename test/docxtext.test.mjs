import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { docxToText } from "../lib/docxtext.js";

const FIXTURE = new URL("./fixtures/sample.docx", import.meta.url);

test("docxToText extracts readable text from a real flk docx", () => {
  const buf = readFileSync(FIXTURE);
  const text = docxToText(buf);
  assert.ok(text.length > 500, `text too short: ${text.length}`);
  assert.ok(!text.includes("<w:"), "raw OOXML leaked into text");
  assert.match(text, /住房公积金管理条例/);
  assert.match(text, /第一条/);
});

test("docxToText is deterministic", () => {
  const buf = readFileSync(FIXTURE);
  assert.equal(docxToText(buf), docxToText(buf));
});
