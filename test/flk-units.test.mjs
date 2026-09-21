import test from "node:test";
import assert from "node:assert/strict";
import { stripHighlight, parseOssFile, sxxName, TOP_LEVEL_CODES, fitCategory } from "../lib/flk/api.js";
import { buildDocxKey, computeWindow } from "../lib/flk/crawler.js";

test("stripHighlight removes em tags from flk titles", () => {
  assert.equal(stripHighlight("住房公积金管理<em class='highlight'>条例</em>"), "住房公积金管理条例");
  assert.equal(stripHighlight("中华人民共和国<em>公司法</em>"), "中华人民共和国公司法");
  assert.equal(stripHighlight("no tags"), "no tags");
});

test("parseOssFile parses python-style dict strings", () => {
  const oss = parseOssFile("{'ossWordPath': 'prod/20260810/x.docx', 'ossPdfPath': None}");
  assert.equal(oss.ossWordPath, "prod/20260810/x.docx");
  assert.equal(oss.ossPdfPath, null);
  assert.deepEqual(parseOssFile(undefined), {});
});

test("sxxName maps known codes and falls back", () => {
  assert.equal(sxxName(4), "有效");
  assert.equal(sxxName(3), "已修改");
  assert.equal(sxxName(null), null);
});

test("fitCategory caps over-long flk leaf categories to the top-level group", () => {
  const long = "有关法律问题和重大问题的决定（部分）";
  assert.ok(long.length > 16);
  assert.equal(fitCategory(long, 190), "法律");
  assert.equal(fitCategory(long, null).length <= 16, true);
  assert.equal(fitCategory("行政法规", 210), "行政法规");
  assert.equal(fitCategory(null, 210), null);
});

test("top-level codes cover all six flk categories", () => {
  assert.deepEqual(TOP_LEVEL_CODES.map((c) => c.code), [100, 101, 201, 220, 221, 311]);
});

test("buildDocxKey percent-encodes segments per the laws bucket convention", () => {
  const { key, truncated } = buildDocxKey({ category: "行政法规", title: "住房公积金管理条例", publish: "2026-08-10", effective: "2026-09-20" });
  assert.match(key, /^%E8%A1%8C%E6%94%BF%E6%B3%95%E8%A7%84\//);
  assert.ok(key.endsWith(".docx"));
  const decoded = key.split("/").map((s) => decodeURIComponent(s)).join("/");
  assert.equal(decoded, "行政法规/住房公积金管理条例_2026-08-10_2026-09-20.docx");
  assert.equal(truncated, false);
});

test("buildDocxKey truncates long encoded titles to fit varchar(512)", () => {
  const longTitle = "云南省某自治州某自治县某某河流域某某某某管理条例实施办法".repeat(12);
  const { key, truncated } = buildDocxKey({ category: "地方法规", title: longTitle, publish: "2026-08-10", effective: "2026-09-20" });
  assert.ok(key.length <= 512, `key over 512: ${key.length}`);
  assert.equal(truncated, true);
});

test("computeWindow: first run without watermark defaults to 30d", () => {
  const w = computeWindow({ watermark: null, lookbackDays: 7, since: undefined });
  assert.match(w.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(w.end, /^\d{4}-\d{2}-\d{2}$/);
});

test("computeWindow: watermark minus look-back", () => {
  const w = computeWindow({ watermark: "2026-09-18", lookbackDays: 7, since: undefined });
  assert.equal(w.start, "2026-09-11");
  assert.equal(w.end >= "2026-09-18", true);
});

test("computeWindow: explicit since overrides", () => {
  const w = computeWindow({ watermark: "2026-09-18", lookbackDays: 7, since: "2026-01-01" });
  assert.equal(w.start, "2026-01-01");
});
