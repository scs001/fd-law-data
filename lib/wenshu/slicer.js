// Search slicing geometry (design.md D7): date window × region × case-type,
// recursing whenever a slice exceeds the paginatable result cap.

const addDays = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (startYmd, endYmd) =>
  Math.round((Date.parse(`${endYmd}T00:00:00Z`) - Date.parse(`${startYmd}T00:00:00Z`)) / 86400000);

export function computeWindow({ today, lookbackDays }) {
  const end = addDays(today, -1);
  const start = addDays(end, -(lookbackDays - 1));
  return { start, end, runDate: today };
}

// planSlices walks the subdivision ladder depth-first, in the fixed order
// region → caseType → date-halving, so leaf order is deterministic:
// region/caseType follow the given arrays' order, date halves are chronological.
export async function planSlices({ window, regions = [], caseTypes = [], courtLevels = [], docTypes = [], reasonAxes = {}, childrenOfReason = null, countOf, resultCap = 200 }) {
  const stats = { probed: 0, subdividedRegion: 0, subdividedCaseType: 0, subdividedCourtLevel: 0, subdividedDocType: 0, subdividedReason: 0, subdividedReason2: 0, subdividedDate: 0, overflowLeaves: 0 };
  const cache = new Map(); // JSON slice key -> countOf result
  const slices = [];

  const probe = async (slice) => {
    const key = JSON.stringify([slice.dateStart, slice.dateEnd, slice.province, slice.caseType, slice.courtLevel ?? null, slice.docType ?? null, slice.reason ?? null]);
    if (!cache.has(key)) {
      stats.probed++;
      cache.set(key, await countOf(slice));
    }
    return cache.get(key);
  };

  const overCap = (count) => count === "OVERFLOW" || count > resultCap;

  const walk = async (slice) => {
    if (!overCap(await probe(slice))) {
      slices.push(slice);
      return;
    }
    if (slice.province === null && regions.length > 0) {
      stats.subdividedRegion++;
      for (const province of regions) await walk({ dateStart: slice.dateStart, dateEnd: slice.dateEnd, province, caseType: slice.caseType, courtLevel: slice.courtLevel ?? null, docType: slice.docType ?? null, reason: slice.reason ?? null });
      return;
    }
    if (slice.caseType === null && caseTypes.length > 0) {
      stats.subdividedCaseType++;
      for (const caseType of caseTypes) await walk({ dateStart: slice.dateStart, dateEnd: slice.dateEnd, province: slice.province, caseType, courtLevel: slice.courtLevel ?? null, docType: slice.docType ?? null, reason: slice.reason ?? null });
      return;
    }
    // 法院层级 before date: a single day cannot be halved further, and the site
    // caps one query at ~600 results, so a day's big case type has to come apart
    // along the court hierarchy to stay reachable.
    if ((slice.courtLevel ?? null) === null && courtLevels.length > 0) {
      stats.subdividedCourtLevel++;
      for (const courtLevel of courtLevels) await walk({ dateStart: slice.dateStart, dateEnd: slice.dateEnd, province: slice.province, caseType: slice.caseType, courtLevel, docType: slice.docType ?? null });
      return;
    }
    if ((slice.docType ?? null) === null && docTypes.length > 0) {
      stats.subdividedDocType++;
      for (const docType of docTypes) await walk({ dateStart: slice.dateStart, dateEnd: slice.dateEnd, province: slice.province, caseType: slice.caseType, courtLevel: slice.courtLevel ?? null, docType, reason: slice.reason ?? null });
      return;
    }
    const reasons = reasonAxes[slice.caseType] ?? [];
    if ((slice.reason ?? null) === null && reasons.length > 0) {
      stats.subdividedReason++;
      for (const reason of reasons) await walk({ dateStart: slice.dateStart, dateEnd: slice.dateEnd, province: slice.province, caseType: slice.caseType, courtLevel: slice.courtLevel ?? null, docType: slice.docType ?? null, reason: reason.code });
      return;
    }
    // 案由 level 3: a busy level-2 branch (民事 合同纠纷 alone hit 629 on one
    // day) can still exceed the cap, and the tree keeps going below it — that
    // split beats date-halving, which is a no-op on the single-day slices the
    // nightly run plans. Falls through on a childless branch exactly as before.
    if ((slice.reason ?? null) !== null && childrenOfReason !== null) {
      const children = await childrenOfReason(slice.reason);
      if (children.length > 0) {
        stats.subdividedReason2++;
        for (const child of children) await walk({ ...slice, reason: child.code });
        return;
      }
    }
    const span = daysBetween(slice.dateStart, slice.dateEnd);
    if (span >= 1) {
      // Halve the date range; the first half takes the extra day on odd spans.
      stats.subdividedDate++;
      const mid = addDays(slice.dateStart, Math.floor(span / 2));
      await walk({ dateStart: slice.dateStart, dateEnd: mid, province: slice.province, caseType: slice.caseType, courtLevel: slice.courtLevel ?? null, docType: slice.docType ?? null, reason: slice.reason ?? null });
      await walk({ dateStart: addDays(mid, 1), dateEnd: slice.dateEnd, province: slice.province, caseType: slice.caseType, courtLevel: slice.courtLevel ?? null, docType: slice.docType ?? null, reason: slice.reason ?? null });
      return;
    }
    // Single day with no axis left to split: surface it, never silently drop.
    slices.push({ ...slice, overflow: true });
    stats.overflowLeaves++;
  };

  await walk({ dateStart: window.start, dateEnd: window.end, province: null, caseType: null });
  return { slices, stats };
}
