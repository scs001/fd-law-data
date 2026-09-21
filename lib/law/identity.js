// Loader-side identity rules for law-db-hygiene (design D6): the flk loader
// must not re-insert a law that already exists under another corpus
// generation, and must not store crawler-batch labels as categories when a
// canonical twin exists. Pure of I/O except the passed-in pg client.
import { BATCH_CATEGORIES, normalizeCategory } from "./reconcile.js";

const BATCH_LIST = [...BATCH_CATEGORIES];

/**
 * True when the lower-cased title already exists in any generation with a
 * real-law category and `有效` status — the caller skips the INSERT.
 * NULL categories count as non-batch (never as a batch label).
 */
export async function findCrossGenerationDuplicate(client, { title }) {
  if (!title) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM laws
      WHERE lower(title) = lower($1)
        AND status = '有效'
        AND (category IS NULL OR NOT (category = ANY($2)))
      LIMIT 1`,
    [title, BATCH_LIST],
  );
  return rows.length > 0;
}

/**
 * Map a crawler-batch label to the same title's canonical category when one
 * exists (legacy manual re-download imports); otherwise return the label
 * unchanged. Non-batch categories pass through untouched.
 */
export async function resolveBatchCategory(client, { title, category }) {
  const normalized = normalizeCategory(category);
  if (!BATCH_CATEGORIES.has(normalized) || !title) return normalized;
  const { rows } = await client.query(
    `SELECT category FROM laws
      WHERE lower(title) = lower($1)
        AND (category IS NULL OR NOT (category = ANY($2)))
      ORDER BY CASE WHEN status = '有效' THEN 0 ELSE 1 END
      LIMIT 1`,
    [title, BATCH_LIST],
  );
  return rows.length ? normalizeCategory(rows[0].category) : normalized;
}
