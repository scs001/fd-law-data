// Document-ID discipline for wenshu crawl rows. Native 32-hex docId wins
// (id_origin='native'); the fallback derivation must be deterministic and
// documented: sha1(`${normalizeCaseNumber(案号)}|${法院}|${判决时间}`) truncated
// to 32 hex chars. The storage doc calls the derivation "sha1 … 32-hex";
// plain sha1 is 40 hex, while live derived doc_ids ARE 32-hex — truncation
// honors both the algorithm name and the 32-hex id shape (128-bit collision
// bound is ample at archive scale).
import { createHash } from "node:crypto";

// Fullwidth forms U+FF01..U+FF5E are the ASCII range shifted by 0xFEE0, which
// covers （）, ０-９ and Ａ-Ｚａ-ｚ in one pass.
const FULLWIDTH = /[\uff01-\uff5e]/g;

export function isNativeDocId(s) {
  return typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
}

// Pinned normalization rule (design.md): trim, remove ALL whitespace
// (JS \s also covers the ideographic space U+3000), （）→ (),
// fullwidth digits/letters → ASCII. null/undefined → null.
export function normalizeCaseNumber(s) {
  if (s == null) return null;
  return String(s)
    .replace(FULLWIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "");
}

export function deriveDocId({ 案号, 法院, 判决时间 }) {
  const cn = normalizeCaseNumber(案号);
  const court = 法院 == null ? "" : String(法院);
  const date = 判决时间 == null ? "" : String(判决时间);
  // 判决时间 arrives pre-normalized as 'YYYY-MM-DD' from the caller; 法院 is
  // hashed as given so the derivation stays byte-stable.
  if (!cn || !court.trim() || !date.trim()) throw new Error("deriveDocId: missing fields");
  return createHash("sha1").update(`${cn}|${court}|${date}`, "utf8").digest("hex").slice(0, 32);
}

export function pickDocId({ native, 案号, 法院, 判决时间 }) {
  if (isNativeDocId(native)) return { doc_id: native, id_origin: "native" };
  return { doc_id: deriveDocId({ 案号, 法院, 判决时间 }), id_origin: "derived" };
}
