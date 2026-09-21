// docx -> plain text with zero dependencies: parse the ZIP central directory,
// inflateRaw word/document.xml, then strip OOXML while keeping paragraph breaks.
import { inflateRawSync } from "node:zlib";

function findEocd(buf) {
  // EOCD signature 0x06054b50; scan back over the possible trailing comment.
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function extractDocxEntry(buf, entryName) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("docx: no ZIP end-of-central-directory");
  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // central directory offset
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("docx: bad central directory entry");
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    if (name === entryName) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("docx: bad local header");
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const comp = buf.slice(dataStart, dataStart + compSize);
      if (method === 0) return comp;
      if (method === 8) return inflateRawSync(comp);
      throw new Error(`docx: unsupported compression method ${method}`);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`docx: entry not found: ${entryName}`);
}

function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function docxToText(docxBuffer) {
  const xml = extractDocxEntry(docxBuffer, "word/document.xml").toString("utf8");
  // paragraph boundaries first, then strip every remaining tag
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  const text = withBreaks
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "");
  return decodeXmlEntities(text).replace(/\n{3,}/g, "\n\n").trim();
}
