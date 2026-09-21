// Chunker implementing the documented law_chunks v1 rules (storage doc §1.2):
// lines are the unit; ^第X条 starts a main block; ^第X编/章/节 headings merge
// into the adjacent block; overlong lines split at sentence marks; small blocks
// merge; target 200-450 chars, cap 550. Acceptance invariant: concatenating
// chunk_text over (char_start, char_end] reproduces laws.content exactly.
const ARTICLE_RE = /^第[一二三四五六七八九十百千零〇两0-9０-９]+条/;
const HEADING_RE = /^第[一二三四五六七八九十百千零〇两0-9０-９]+[编章节]/;
const SENTENCE_MARK_RE = /[。；！？!?]/g;

// Split [start, end) into pieces, greedy at sentence marks, hard slices at cap.
function splitRange(content, start, end, cap) {
  const text = content.slice(start, end);
  const cuts = [];
  let m;
  SENTENCE_MARK_RE.lastIndex = 0;
  while ((m = SENTENCE_MARK_RE.exec(text))) cuts.push(start + m.index + m[0].length);
  cuts.push(end);
  const pieces = [];
  let pieceStart = start;
  let prev = start;
  for (const c of cuts) {
    if (c - pieceStart > cap) {
      if (prev > pieceStart) pieces.push([pieceStart, prev]);
      pieceStart = prev;
      while (c - pieceStart > cap) {
        pieces.push([pieceStart, pieceStart + cap]);
        pieceStart += cap;
      }
    }
    prev = c;
  }
  if (pieceStart < end) pieces.push([pieceStart, end]);
  return pieces;
}

// Docx extraction keeps Word's layout whitespace: the 2026-09-19 backfill
// carried runs of spaces and nearly-empty lines (measured at 54.6% of all
// characters, versus 4.5% in the legacy corpus), which the line-based chunker
// reads as paragraph breaks. Collapsing them makes new text structurally
// identical to the legacy corpus. Zero-width spaces are the legacy corpus'
// blank-line placeholder, so they are dropped too.
export function normalizeLawText(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b\ufeff]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

// law_chunks_v2 is the live semantic layer (Qdrant collection law_chunks_v2,
// 448,187 points at 1024 dims). Fit 2026-09-19 against that corpus: chunking
// normalized text at 300-450 with cap 550 reproduces its shape (median 362,
// p90 494, avg 364 chars, +3% chunk count); the 300-1200/4000 parameters first
// guessed from a handful of rows produced 1,204-char chunks, 3.3x the live
// median, which a 1024-dim encoder would truncate.
export const V2_PARAMS = { targetMin: 300, targetMax: 450, cap: 550 };

export function chunkLawText(content, { targetMin = 200, targetMax = 450, cap = 550 } = {}) {
  if (typeof content !== "string" || content.length === 0) return [];
  // 1) atomic segments [start, end) covering the string contiguously
  const segments = [];
  const lineRe = /[^\n]*\n|[^\n]+\n?/g;
  let m;
  while ((m = lineRe.exec(content))) {
    const [start, end] = [m.index, m.index + m[0].length];
    if (end - start > cap) segments.push(...splitRange(content, start, end, cap));
    else segments.push([start, end]);
  }
  let expect = 0;
  for (const [s, e] of segments) {
    if (s !== expect || e < s) throw new Error("chunker: non-contiguous segments");
    expect = e;
  }
  if (expect !== content.length) throw new Error("chunker: segments do not cover content");

  // 2) group segments into blocks; headings merge into the next block
  const blocks = [];
  let pendingHeading = null;
  for (const [s, e] of segments) {
    const text = content.slice(s, e);
    const isHeading = HEADING_RE.test(text);
    const isArticle = !isHeading && ARTICLE_RE.test(text);
    if (isHeading) {
      if (pendingHeading) blocks.push(pendingHeading);
      pendingHeading = { start: s, end: e };
      continue;
    }
    if (pendingHeading) {
      blocks.push({ start: pendingHeading.start, end: e });
      pendingHeading = null;
      continue;
    }
    if (isArticle || blocks.length === 0) {
      blocks.push({ start: s, end: e });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last.end - last.start >= targetMax) blocks.push({ start: s, end: e });
    else last.end = e;
  }
  if (pendingHeading) blocks.push(pendingHeading);

  // 3) merge undersized neighbours (order kept; union of adjacent ranges)
  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      (prev.end - prev.start < targetMin || b.end - b.start < targetMin) &&
      prev.end - prev.start + (b.end - b.start) <= targetMax
    ) {
      prev.end = b.end;
    } else {
      merged.push({ ...b });
    }
  }

  // 4) heading+article merges can exceed the cap — re-split any offender
  const sized = [];
  for (const b of merged) {
    if (b.end - b.start > cap) sized.push(...splitRange(content, b.start, b.end, cap).map(([s, e]) => ({ start: s, end: e })));
    else sized.push(b);
  }

  // 5) emit with the lossless invariant asserted
  const out = sized.map((b, i) => ({
    chunk_no: i,
    char_start: b.start,
    char_end: b.end,
    chunk_text: content.slice(b.start, b.end),
  }));
  if (out.map((c) => c.chunk_text).join("") !== content) {
    throw new Error("chunker: lossless invariant violated");
  }
  return out;
}
