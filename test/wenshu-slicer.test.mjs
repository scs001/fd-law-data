import test from "node:test";
import assert from "node:assert/strict";
import { computeWindow, planSlices } from "../lib/wenshu/slicer.js";

test("computeWindow: 7-day lookback ends yesterday and spans exactly 7 days", () => {
  const w = computeWindow({ today: "2026-09-18", lookbackDays: 7 });
  assert.deepEqual(w, { start: "2026-09-11", end: "2026-09-17", runDate: "2026-09-18" });
});

test("computeWindow: month boundary", () => {
  const w = computeWindow({ today: "2026-09-01", lookbackDays: 7 });
  assert.deepEqual(w, { start: "2026-08-25", end: "2026-08-31", runDate: "2026-09-01" });
  // February, non-leap year: yesterday is 02-28.
  const feb = computeWindow({ today: "2026-03-01", lookbackDays: 7 });
  assert.deepEqual(feb, { start: "2026-02-22", end: "2026-02-28", runDate: "2026-03-01" });
});

const WIN = { start: "2026-09-11", end: "2026-09-17" }; // 7 days
const keyOf = (s) => JSON.stringify([s.dateStart, s.dateEnd, s.province, s.caseType]);

test("planSlices: small count yields a single unsplit leaf", async () => {
  const { slices, stats } = await planSlices({ window: WIN, regions: [], caseTypes: [], countOf: async () => 50 });
  assert.deepEqual(slices, [{ dateStart: "2026-09-11", dateEnd: "2026-09-17", province: null, caseType: null }]);
  assert.deepEqual(stats, { probed: 1, subdividedRegion: 0, subdividedCaseType: 0, subdividedCourtLevel: 0, subdividedDocType: 0, subdividedReason: 0, subdividedReason2: 0, subdividedDate: 0, overflowLeaves: 0 });
});

test("planSlices: over cap splits by region", async () => {
  const countOf = async (s) => (s.province === null ? "OVERFLOW" : 100);
  const { slices, stats } = await planSlices({ window: WIN, regions: ["江苏省", "广东省"], caseTypes: [], countOf, resultCap: 200 });
  assert.deepEqual(
    slices.map((s) => [s.province, s.caseType, s.overflow]),
    [
      ["江苏省", null, undefined],
      ["广东省", null, undefined],
    ],
  );
  for (const s of slices) {
    assert.equal(s.dateStart, "2026-09-11");
    assert.equal(s.dateEnd, "2026-09-17");
  }
  assert.deepEqual(stats, { probed: 3, subdividedRegion: 1, subdividedCaseType: 0, subdividedCourtLevel: 0, subdividedDocType: 0, subdividedReason: 0, subdividedReason2: 0, subdividedDate: 0, overflowLeaves: 0 });
});

test("planSlices: region still over cap splits by caseType within the region", async () => {
  const countOf = async (s) => (s.caseType === null ? "OVERFLOW" : 150); // over at level 0 and per region
  const { slices, stats } = await planSlices({ window: WIN, regions: ["江苏省", "广东省"], caseTypes: ["民事", "刑事"], countOf, resultCap: 200 });
  assert.equal(slices.length, 4); // 2 regions × 2 case types
  assert.deepEqual(
    slices.map((s) => [s.province, s.caseType]),
    [
      ["江苏省", "民事"],
      ["江苏省", "刑事"],
      ["广东省", "民事"],
      ["广东省", "刑事"],
    ],
  );
  assert.ok(slices.every((s) => !s.overflow));
  assert.deepEqual(stats, { probed: 7, subdividedRegion: 1, subdividedCaseType: 2, subdividedCourtLevel: 0, subdividedDocType: 0, subdividedReason: 0, subdividedReason2: 0, subdividedDate: 0, overflowLeaves: 0 });
});

test("planSlices: caseType over cap falls through to date halving down to single days", async () => {
  const window = { start: "2026-09-11", end: "2026-09-12" }; // 2 days
  const countOf = async (s) => (s.dateStart === s.dateEnd ? 100 : "OVERFLOW");
  const { slices, stats } = await planSlices({ window, regions: ["江苏省"], caseTypes: ["民事"], countOf, resultCap: 200 });
  // Ladder: whole window → 江苏省 → 民事 → halve into two single-day leaves.
  assert.deepEqual(
    slices.map((s) => [s.dateStart, s.dateEnd, s.province, s.caseType, s.overflow]),
    [
      ["2026-09-11", "2026-09-11", "江苏省", "民事", undefined],
      ["2026-09-12", "2026-09-12", "江苏省", "民事", undefined],
    ],
  );
  assert.deepEqual(stats, { probed: 5, subdividedRegion: 1, subdividedCaseType: 1, subdividedCourtLevel: 0, subdividedDocType: 0, subdividedReason: 0, subdividedReason2: 0, subdividedDate: 1, overflowLeaves: 0 });
});

test("planSlices: date halving alone when no region/caseType axes exist", async () => {
  const window = { start: "2026-09-11", end: "2026-09-14" }; // 4 days
  const countOf = async (s) => (s.dateStart === s.dateEnd ? 100 : "OVERFLOW");
  const { slices, stats } = await planSlices({ window, regions: [], caseTypes: [], countOf, resultCap: 200 });
  assert.deepEqual(
    slices.map((s) => [s.dateStart, s.dateEnd]),
    [
      ["2026-09-11", "2026-09-11"],
      ["2026-09-12", "2026-09-12"],
      ["2026-09-13", "2026-09-13"],
      ["2026-09-14", "2026-09-14"],
    ],
  );
  // 1 root split + 2 splits of the 2-day halves.
  assert.deepEqual(stats, { probed: 7, subdividedRegion: 0, subdividedCaseType: 0, subdividedCourtLevel: 0, subdividedDocType: 0, subdividedReason: 0, subdividedReason2: 0, subdividedDate: 3, overflowLeaves: 0 });
});

test("planSlices: single-day region+caseType still over cap becomes an overflow leaf", async () => {
  const window = { start: "2026-09-11", end: "2026-09-11" }; // single day
  const countOf = async () => "OVERFLOW";
  const { slices, stats } = await planSlices({ window, regions: ["江苏省"], caseTypes: ["民事"], countOf, resultCap: 200 });
  assert.deepEqual(slices, [{
    dateStart: "2026-09-11", dateEnd: "2026-09-11", province: "江苏省", caseType: "民事",
    courtLevel: null, docType: null, reason: null, overflow: true,
  }]);
  assert.deepEqual(stats, { probed: 3, subdividedRegion: 1, subdividedCaseType: 1, subdividedCourtLevel: 0, subdividedDocType: 0, subdividedReason: 0, subdividedReason2: 0, subdividedDate: 0, overflowLeaves: 1 });
});

test("planSlices: countOf is never called twice for the same slice (cache)", async () => {
  const calls = [];
  const countOf = async (s) => {
    calls.push(keyOf(s));
    return s.caseType === null ? "OVERFLOW" : 150;
  };
  await planSlices({ window: WIN, regions: ["江苏省", "广东省"], caseTypes: ["民事", "刑事"], countOf, resultCap: 200 });
  assert.equal(calls.length, new Set(calls).size); // no duplicate slice keys
  assert.equal(calls.length, 7); // 1 root + 2 regions + 4 region×caseType probes
});

// --- 案由 level 3 (childrenOfReason) --------------------------------------
// Production shape: a single-day window (the nightly --since/--until runs) and
// a busy level-2 branch — 民事 合同纠纷 alone hit 629 documents on 2026-09-17.
const DAY = { start: "2026-09-17", end: "2026-09-17" };
const AXES = { 民事: [{ code: "hetong", label: "合同纠纷" }] };
// Over cap on every rung down to the reason split; the branch itself is over.
const branchCountOf = async (s) => (s.caseType == null || s.reason == null ? "OVERFLOW" : s.reason === "hetong" ? 700 : 10);

test("planSlices: level-2 案由 branch still over cap subdivides into its level-3 children", async () => {
  const children = [
    { code: "hetong-maimai", label: "买卖合同纠纷" },
    { code: "hetong-jiekuan", label: "借款合同纠纷" },
    { code: "hetong-zulin", label: "租赁合同纠纷" },
  ];
  const { slices, stats } = await planSlices({
    window: DAY, regions: [], caseTypes: ["民事"],
    courtLevels: ["基层"], docTypes: ["裁判文书"],
    reasonAxes: AXES,
    childrenOfReason: async (code) => (code === "hetong" ? children : []),
    countOf: branchCountOf, resultCap: 200,
  });
  assert.deepEqual(slices.map((s) => s.reason), ["hetong-maimai", "hetong-jiekuan", "hetong-zulin"]); // children order
  for (const s of slices) {
    assert.equal(s.caseType, "民事");
    assert.equal(s.courtLevel, "基层"); // the parent's other axes ride along
    assert.equal(s.docType, "裁判文书");
    assert.equal(s.overflow, undefined);
  }
  assert.deepEqual(stats, { probed: 8, subdividedRegion: 0, subdividedCaseType: 1, subdividedCourtLevel: 1, subdividedDocType: 1, subdividedReason: 1, subdividedReason2: 1, subdividedDate: 0, overflowLeaves: 0 });
});

test("planSlices: over-cap 案由 branch with no children still becomes an overflow leaf", async () => {
  const { slices, stats } = await planSlices({
    window: DAY, regions: [], caseTypes: ["民事"],
    reasonAxes: AXES,
    childrenOfReason: async () => [], // a leaf node in the tree
    countOf: branchCountOf, resultCap: 200,
  });
  assert.deepEqual(slices, [{
    dateStart: "2026-09-17", dateEnd: "2026-09-17", province: null, caseType: "民事",
    courtLevel: null, docType: null, reason: "hetong", overflow: true,
  }]);
  assert.deepEqual(stats, { probed: 3, subdividedRegion: 0, subdividedCaseType: 1, subdividedCourtLevel: 0, subdividedDocType: 0, subdividedReason: 1, subdividedReason2: 0, subdividedDate: 0, overflowLeaves: 1 });
});

test("planSlices: childrenOfReason omitted keeps the old behavior (overflow leaf)", async () => {
  const { slices, stats } = await planSlices({
    window: DAY, regions: [], caseTypes: ["民事"],
    reasonAxes: AXES,
    countOf: branchCountOf, resultCap: 200,
  });
  assert.equal(stats.subdividedReason2, 0);
  assert.equal(stats.overflowLeaves, 1);
  assert.ok(slices.length === 1 && slices[0].overflow === true && slices[0].reason === "hetong");
});

test("planSlices: a level-3 branch still over cap recurses one 案由 level deeper", async () => {
  const tree = new Map([
    ["hetong", [{ code: "hetong-maimai", label: "买卖合同纠纷" }, { code: "hetong-jiekuan", label: "借款合同纠纷" }]],
    ["hetong-maimai", [{ code: "hetong-maimai-fang", label: "房屋买卖合同纠纷" }, { code: "hetong-maimai-qt", label: "其他买卖合同纠纷" }]],
    ["hetong-jiekuan", []],
  ]);
  const countOf = async (s) => (s.caseType == null || s.reason == null
    ? "OVERFLOW"
    : s.reason === "hetong" || s.reason === "hetong-maimai" ? 700 : 10);
  const { slices, stats } = await planSlices({
    window: DAY, regions: [], caseTypes: ["民事"],
    reasonAxes: AXES,
    childrenOfReason: async (code) => tree.get(code) ?? [],
    countOf, resultCap: 200,
  });
  assert.deepEqual(slices.map((s) => s.reason), ["hetong-maimai-fang", "hetong-maimai-qt", "hetong-jiekuan"]);
  assert.deepEqual(stats, { probed: 7, subdividedRegion: 0, subdividedCaseType: 1, subdividedCourtLevel: 0, subdividedDocType: 0, subdividedReason: 1, subdividedReason2: 2, subdividedDate: 0, overflowLeaves: 0 });
});

test("planSlices: sanity — single-day caseType over cap splits by courtLevel when provided", async () => {
  const countOf = async (s) => (s.caseType == null || (s.courtLevel ?? null) === null ? "OVERFLOW" : 100);
  const { slices, stats } = await planSlices({
    window: DAY, regions: [], caseTypes: ["民事"],
    courtLevels: ["最高", "高级", "中级", "基层"],
    countOf, resultCap: 200,
  });
  assert.deepEqual(slices.map((s) => s.courtLevel), ["最高", "高级", "中级", "基层"]);
  assert.ok(slices.every((s) => s.overflow === undefined));
  assert.deepEqual(stats, { probed: 6, subdividedRegion: 0, subdividedCaseType: 1, subdividedCourtLevel: 1, subdividedDocType: 0, subdividedReason: 0, subdividedReason2: 0, subdividedDate: 0, overflowLeaves: 0 });
});
