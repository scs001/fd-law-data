import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isNativeDocId, normalizeCaseNumber, deriveDocId, pickDocId } from "../lib/wenshu/ids.js";

test("isNativeDocId accepts 32-char lowercase hex only", () => {
  assert.equal(isNativeDocId("0123456789abcdef0123456789abcdef"), true);
  assert.equal(isNativeDocId("f".repeat(32)), true);
  assert.equal(isNativeDocId("0123456789ABCDEF0123456789ABCDEF"), false); // uppercase is not native
  assert.equal(isNativeDocId("0123456789abcdef0123456789abcde"), false); // 31 chars
  assert.equal(isNativeDocId("0123456789abcdef0123456789abcdeff"), false); // 33 chars
  assert.equal(isNativeDocId("z".repeat(32)), false); // non-hex
  assert.equal(isNativeDocId(""), false);
  assert.equal(isNativeDocId(null), false);
  assert.equal(isNativeDocId(undefined), false);
  assert.equal(isNativeDocId(123), false);
  assert.equal(isNativeDocId({}), false);
});

test("normalizeCaseNumber strips all whitespace and fullwidth forms", () => {
  assert.equal(normalizeCaseNumber("(2025)苏0981民初4173号"), "(2025)苏0981民初4173号");
  assert.equal(normalizeCaseNumber("（２０２５）苏0981民初4173号"), "(2025)苏0981民初4173号");
  assert.equal(normalizeCaseNumber(" (2025) 苏 0981\t民初\n4173号 "), "(2025)苏0981民初4173号");
  assert.equal(normalizeCaseNumber("(2025)\u3000苏0981民初4173号"), "(2025)苏0981民初4173号"); // U+3000 ideographic space
  assert.equal(normalizeCaseNumber("（2023）Ａｂｃ９号"), "(2023)Abc9号"); // mixed fullwidth parens/digits/letters
  assert.equal(normalizeCaseNumber(null), null);
  assert.equal(normalizeCaseNumber(undefined), null);
});

test("deriveDocId is deterministic and matches the pinned known vector", () => {
  const fields = { 案号: "(2025)苏0981民初4173号", 法院: "江苏省东台市人民法院", 判决时间: "2025-09-01" };
  const expected = createHash("sha1").update("(2025)苏0981民初4173号|江苏省东台市人民法院|2025-09-01", "utf8").digest("hex").slice(0, 32);
  assert.equal(deriveDocId(fields), expected);
  assert.match(deriveDocId(fields), /^[0-9a-f]{32}$/); // 32-hex shape per spec/storage doc
  assert.equal(deriveDocId(fields), deriveDocId({ ...fields })); // stable across calls
  // Fullwidth/whitespace case numbers collapse to the same derived id.
  assert.equal(deriveDocId({ ...fields, 案号: "（２０２５）苏 0981 民初4173号" }), expected);
});

test("deriveDocId throws on missing fields", () => {
  const base = { 案号: "(2025)苏0981民初4173号", 法院: "江苏省东台市人民法院", 判决时间: "2025-09-01" };
  for (const bad of [
    { ...base, 案号: null },
    { ...base, 案号: "" },
    { ...base, 案号: "  " }, // whitespace-only normalizes to empty
    { ...base, 法院: null },
    { ...base, 法院: "" },
    { ...base, 判决时间: null },
    { ...base, 判决时间: "" },
  ]) {
    assert.throws(() => deriveDocId(bad), { message: "deriveDocId: missing fields" });
  }
});

test("pickDocId prefers native 32-hex ids and falls back to derivation", () => {
  const native = "0123456789abcdef0123456789abcdef";
  const fields = { 案号: "(2025)苏0981民初4173号", 法院: "江苏省东台市人民法院", 判决时间: "2025-09-01" };
  assert.deepEqual(pickDocId({ native, ...fields }), { doc_id: native, id_origin: "native" });
  // Native wins even when the fallback fields are unusable.
  assert.deepEqual(pickDocId({ native, 案号: null, 法院: null, 判决时间: null }), { doc_id: native, id_origin: "native" });
  // Anything else (short, uppercase, junk) falls back to the derivation.
  for (const bad of [null, undefined, "", "abc", native.slice(0, 31), native.toUpperCase()]) {
    const picked = pickDocId({ native: bad, ...fields });
    assert.equal(picked.id_origin, "derived");
    assert.equal(picked.doc_id, deriveDocId(fields));
  }
});
