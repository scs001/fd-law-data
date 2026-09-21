// Unit tests for the curated deprecation list (lib/guidecases/deprecations.js).
// The list is the single source of reference status, so its contents are
// pinned here: exactly two notices are known, and both are applied.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEPRECATION_NOTICES, deprecationsByCaseNo, referenceStatus, deprecationDocNo,
  REFERENCE_EFFECTIVE, REFERENCE_SUPERSEDED,
} from "../lib/guidecases/deprecations.js";

test("the curated list carries both known notices with their provenance", () => {
  assert.deepEqual(DEPRECATION_NOTICES.map((n) => n.docNo), ["法〔2020〕343号", "法〔2026〕119号"]);
  for (const notice of DEPRECATION_NOTICES) {
    assert.match(notice.url, /^https:\/\/www\.court\.gov\.cn\/fabu\/xiangqing\/\d+\.html$/);
    assert.ok(notice.caseNumbers.length > 0);
    assert.match(notice.effectiveAt, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("deprecated case numbers map back to the notice that deprecated them", () => {
  const byCaseNo = deprecationsByCaseNo();
  assert.deepEqual([...byCaseNo.keys()].sort((a, b) => a - b), [9, 20, 123, 136, 139, 204]);
  assert.equal(byCaseNo.get(9).docNo, "法〔2020〕343号");
  assert.equal(byCaseNo.get(204).docNo, "法〔2026〕119号");
  assert.equal(byCaseNo.get(204).effectiveAt, "2026-08-15");
});

test("referenceStatus marks exactly the listed cases", () => {
  assert.equal(referenceStatus(9), REFERENCE_SUPERSEDED);
  assert.equal(referenceStatus(123), REFERENCE_SUPERSEDED);
  assert.equal(referenceStatus(1), REFERENCE_EFFECTIVE);
  assert.equal(referenceStatus(279), REFERENCE_EFFECTIVE);
  assert.equal(deprecationDocNo(136), "法〔2026〕119号");
  assert.equal(deprecationDocNo(137), null);
});
