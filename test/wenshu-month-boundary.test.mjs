import test from "node:test";
import assert from "node:assert/strict";
import { dayFile, dailyKey, manifestKey } from "../lib/wenshu/crawler.js";
import { monthOfKey } from "../lib/wenshu/loader.js";
import { blockKey } from "../lib/wenshu/blocks.js";

// Partition invariant: a day whose judgment date is the LAST day of a month must
// land its rows in that month's blocks/ and not the next month's. The chain is
// crawler day-file naming (dayFile → dailyKey) → loader monthOfKey → blocks
// blockKey; if any link names the file after the run date instead of the data
// day, month-boundary judgments drift into the following month's blocks.

test("last day of a month, run in the NEXT month: file named after the data day", () => {
  const f = dayFile("2026-08-31", "2026-08-31", "2026-09-02", "w2");
  assert.equal(f.fileDay, "2026-08-31");
  assert.equal(f.fileMonth, "2026-08");
  assert.ok(f.dayKey.startsWith("raw/2026/08/"), f.dayKey);
  assert.ok(f.dayKey.includes("crawl-2026-08-31-w2"), f.dayKey);
  assert.equal(f.dayKey, dailyKey("2026-08-31", "w2"));
});

test("naming → monthOfKey → blockKey: August 31 never feeds September's blocks", () => {
  const { dayKey } = dayFile("2026-08-31", "2026-08-31", "2026-09-02");
  const month = monthOfKey(dayKey);
  assert.equal(month, "2026-08");
  assert.equal(blockKey(month, 1), "blocks/2026/08/000001.zst");
});

test("first day of the next month stays in its own month", () => {
  const f = dayFile("2026-09-01", "2026-09-01", "2026-09-02");
  assert.ok(f.dayKey.startsWith("raw/2026/09/"), f.dayKey);
  assert.equal(f.fileMonth, "2026-09");
  assert.equal(monthOfKey(f.dayKey), "2026-09");
  assert.equal(blockKey(monthOfKey(f.dayKey), 1), "blocks/2026/09/000001.zst");
});

test("multi-day window keeps the RUN date as its name", () => {
  const f = dayFile("2026-08-30", "2026-09-02", "2026-09-03");
  assert.equal(f.fileDay, "2026-09-03");
  assert.equal(f.fileMonth, "2026-09");
  assert.ok(f.dayKey.includes("crawl-2026-09-03"), f.dayKey);
});

test("year boundary: Dec 31 crawled in January still lands in raw/{prev-year}/12", () => {
  const f = dayFile("2026-12-31", "2026-12-31", "2027-01-02");
  assert.ok(f.dayKey.startsWith("raw/2026/12/"), f.dayKey);
  assert.equal(f.fileMonth, "2026-12");
  assert.equal(monthOfKey(f.dayKey), "2026-12");
  assert.equal(blockKey(monthOfKey(f.dayKey), 1), "blocks/2026/12/000001.zst");
});

test("manifest lands in the same month directory as the jsonl", () => {
  for (const [since, until, runDate, worker] of [
    ["2026-08-31", "2026-08-31", "2026-09-02", "w1"],
    ["2026-12-31", "2026-12-31", "2027-01-02", "w1"],
    ["2026-08-30", "2026-09-02", "2026-09-03", "w1"], // multi-day: named after run date
  ]) {
    const f = dayFile(since, until, runDate);
    const mKey = manifestKey(f.fileDay, worker);
    const dirOf = (k) => k.slice(0, k.lastIndexOf("/"));
    assert.equal(dirOf(mKey), dirOf(f.dayKey), `${mKey} vs ${f.dayKey}`);
    assert.equal(monthOfKey(mKey), f.fileMonth);
    assert.ok(mKey.endsWith(".manifest.json"));
  }
});
