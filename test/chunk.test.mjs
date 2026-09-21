import test from "node:test";
import assert from "node:assert/strict";
import { chunkLawText, normalizeLawText, V2_PARAMS } from "../lib/flk/chunk.js";

function article(n, size) {
  const filler = "本条规定了相关事项的具体要求和管理措施。".repeat(Math.ceil(size / 20)).slice(0, size);
  return `第${n}条　${filler}\n`;
}

const sample = `第一章　总　　则

第一条　为了规范行政管理，保障权益，制定本法。

第二条　本法适用于中华人民共和国领域内的行政管理活动。有关法律规定另有规定的，从其规定。

第三条　行政管理应当遵循公开、公平、公正的原则，提高效率，方便当事人，保障当事人的知情权、参与权和监督权，促进依法行政，建设法治政府，优化营商环境，维护社会公平正义，推动高质量发展，实现治理体系和治理能力现代化的总体目标要求。

第四条　国务院行政部门负责全国的管理工作。`;

test("chunker preserves the lossless invariant on legal text", () => {
  const chunks = chunkLawText(sample);
  assert.ok(chunks.length >= 1);
  assert.equal(chunks.map((c) => c.chunk_text).join(""), sample);
  chunks.forEach((c, i) => {
    assert.equal(c.chunk_no, i);
    assert.equal(c.char_end - c.char_start, c.chunk_text.length);
    assert.equal(c.char_start, i === 0 ? 0 : chunks[i - 1].char_end);
  });
});

test("long articles yield multiple chunks near the target size", () => {
  const law = "第一章　总　　则\n" + ["一", "二", "三", "四", "五", "六"].map((n) => article(n, 300)).join("");
  const chunks = chunkLawText(law);
  assert.equal(chunks.map((c) => c.chunk_text).join(""), law);
  assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
  chunks.forEach((c) => assert.ok(c.chunk_text.length <= 550, `over cap: ${c.chunk_text.length}`));
});

test("chunker respects the cap on oversized single-paragraph content", () => {
  const long = "这是一个很长的句子，".repeat(200); // no newlines, no sentence caps issues
  const chunks = chunkLawText(long);
  assert.equal(chunks.map((c) => c.chunk_text).join(""), long);
  chunks.forEach((c) => assert.ok(c.chunk_text.length <= 550, `chunk over cap: ${c.chunk_text.length}`));
});

test("chunker merges heading into adjacent block", () => {
  const chunks = chunkLawText(sample);
  const headingOnly = chunks.filter(
    (c) => /^第[一二三四]+[章节]/.test(c.chunk_text) && c.chunk_text.trim().split("\n").length === 1,
  );
  assert.equal(headingOnly.length, 0, "heading must not stand alone");
});

test("chunker handles content without any structure", () => {
  const plain = "这是一段没有条款结构的文字。".repeat(30);
  const chunks = chunkLawText(plain);
  assert.equal(chunks.map((c) => c.chunk_text).join(""), plain);
  assert.ok(chunks.length >= 1);
});

test("chunker handles empty and tiny inputs", () => {
  assert.deepEqual(chunkLawText(""), []);
  const tiny = chunkLawText("第一条　仅此一条。");
  assert.equal(tiny.map((c) => c.chunk_text).join(""), "第一条　仅此一条。");
});

// The 2026-09 backfill's docx extraction returned Word's layout whitespace:
// lines of indentation-only spaces between real paragraphs (measured 54.6% of
// the text versus 4.5% on the legacy corpus). Normalizing it must leave the
// legacy corpus' shape untouched, keep headings intact, and let ^第X条 match.
test("normalizeLawText collapses docx layout whitespace", () => {
  const dirty = "中华人民共和国道路运输条例\n      \n    \n\n    \n      \n第一条　为了维护道路运输市场秩序。\n        \n";
  const clean = normalizeLawText(dirty);
  assert.equal(clean, "中华人民共和国道路运输条例\n\n第一条　为了维护道路运输市场秩序。");
  assert.equal(normalizeLawText(clean), clean, "normalization must be idempotent");
});

test("normalizeLawText preserves full-width headings and zero-width cleanup", () => {
  assert.equal(normalizeLawText("目　　录\n"), "目　　录");
  assert.equal(normalizeLawText("第一章　总　　则"), "第一章　总　　则");
  assert.equal(normalizeLawText("\u200b\n安顺市农村公路条例\n\u200b\n"), "安顺市农村公路条例");
  assert.equal(normalizeLawText(""), "");
  assert.equal(normalizeLawText(null), "");
});

test("normalized text chunks to the live corpus' size band", () => {
  const dirty = "第一条　" + "本条规定了相关事项的具体要求和管理措施。".repeat(30) + "\n        \n"
    + "第二条　" + "本条规定了相关事项的具体要求和管理措施。".repeat(30) + "\n   \n";
  const chunks = chunkLawText(normalizeLawText(dirty), V2_PARAMS);
  assert.equal(chunks.map((c) => c.chunk_text).join(""), normalizeLawText(dirty));
  chunks.forEach((c) => assert.ok(c.chunk_text.length <= 550, `over live-corpus cap: ${c.chunk_text.length}`));
  chunks.forEach((c) => assert.ok(!/\n[ \t]+\n/.test(c.chunk_text), "chunk carries layout padding"));
});
