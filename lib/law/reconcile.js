// Pure planning for law-db-hygiene: collapse law_db.laws to one authoritative
// row per exact title (case-insensitive) and decide what happens to the
// removed rows' chunks. No I/O — the caller supplies rows and a per-table
// chunk index, then executes the returned plan.
//
// Authority order (design D1): generation rank (flk > lawv2 > law → the live
// pipeline's row survives), then real-law category over crawler-batch label,
// then 有效 status, then newest publish (NULLs last). Id ascending breaks
// ties so re-runs pick the same survivor.

export const BATCH_CATEGORIES = new Set(["重下载", "新法速递"]);
export const CATEGORY_SYNONYMS = new Map([["地方法规", "地方性法规"]]);
export const CHUNK_TABLES = ["law_chunks", "law_chunks_v2"];

const GENERATION_RANK = new Map([["flk", 0], ["lawv2", 1], ["law", 2]]);
const UNKNOWN_GENERATION_RANK = 3;

function toTime(value) {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function generationRank(srcDb) {
  return GENERATION_RANK.get(srcDb) ?? UNKNOWN_GENERATION_RANK;
}

export function categoryClass(category) {
  return BATCH_CATEGORIES.has(category ?? "") ? 1 : 0;
}

export function statusClass(status) {
  return status === "有效" ? 0 : 1;
}

/** Negative when a is the better (more authoritative) row. */
export function compareAuthority(a, b) {
  const ka = [generationRank(a.src_db), categoryClass(a.category), statusClass(a.status)];
  const kb = [generationRank(b.src_db), categoryClass(b.category), statusClass(b.status)];
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  const ta = toTime(a.publish);
  const tb = toTime(b.publish);
  if (ta !== tb) return (tb ?? -Infinity) - (ta ?? -Infinity); // newest first, NULL last
  return Number(a.id) - Number(b.id);
}

export function normalizeCategory(category) {
  return CATEGORY_SYNONYMS.get(category) ?? category;
}

/**
 * @param {object} input
 * @param {Array<{id,src_db,title,category,status,publish}>} input.laws
 * @param {{law_chunks: Set, law_chunks_v2: Set}} input.hasChunks law ids that
 *   own at least one chunk row, per table (ids compared as strings)
 * @returns {{deleteIds: Array, categoryUpdates: Array<{id,from,to}>,
 *   repoints: Array<{table,fromId,toId}>, chunkDeletes: {law_chunks: Array,
 *   law_chunks_v2: Array}, report: object}}
 */
export function planReconciliation({ laws, hasChunks }) {
  const groups = new Map();
  for (const row of laws) {
    const key = String(row.title ?? "").trim().toLowerCase();
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(row);
  }

  const deleteIds = [];
  const categoryUpdates = [];
  const repoints = [];
  const chunkDeletes = { law_chunks: [], law_chunks_v2: [] };
  const report = {
    titles: groups.size,
    duplicatedTitles: 0,
    repointedTitles: 0,
    survivorsByGeneration: {},
    deletedByGeneration: {},
  };
  const bump = (obj, key) => {
    obj[key] = (obj[key] ?? 0) + 1;
  };

  for (const rows of groups.values()) {
    const ordered = [...rows].sort(compareAuthority);
    const survivor = ordered[0];
    const removed = ordered.slice(1);

    let category = normalizeCategory(survivor.category);
    if (category !== survivor.category) {
      categoryUpdates.push({ id: survivor.id, from: survivor.category, to: category });
    }
    bump(report.survivorsByGeneration, survivor.src_db);

    if (!removed.length) continue;
    report.duplicatedTitles += 1;
    for (const row of removed) {
      deleteIds.push(row.id);
      bump(report.deletedByGeneration, row.src_db);
    }

    for (const table of CHUNK_TABLES) {
      const survivorHasChunks = hasChunks[table].has(String(survivor.id));
      const withChunks = removed.filter((row) => hasChunks[table].has(String(row.id)));
      if (!withChunks.length) continue;
      if (!survivorHasChunks) {
        // Exactly one source re-points: several would collide on the
        // (law_id, chunk_no) unique index. The best removed row wins.
        const source = [...withChunks].sort(compareAuthority)[0];
        repoints.push({ table, fromId: source.id, toId: survivor.id });
        report.repointedTitles += 1;
        for (const row of withChunks) {
          if (row.id !== source.id) chunkDeletes[table].push(row.id);
        }
      } else {
        for (const row of withChunks) chunkDeletes[table].push(row.id);
      }
    }
  }

  return { deleteIds, categoryUpdates, repoints, chunkDeletes, report };
}
