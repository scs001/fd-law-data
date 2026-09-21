import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  BLOCK_MAGIC,
  RAW_TARGET,
  blockKey,
  buildRawBlock,
  packMonth,
  extractDoc,
  compressZstd,
  decompressZstd,
  rebuildMonth,
  readDocFromBucket,
} from "../lib/wenshu/blocks.js";

const MiB = 1024 * 1024;

// Exact-byte-size CJK buffer ("判" is 3 utf8 bytes; pad the remainder with ASCII).
function bufOf(targetBytes) {
  const chars = Math.floor(targetBytes / 3);
  const rem = targetBytes - chars * 3;
  let s = "判".repeat(chars);
  if (rem === 1) s += "A";
  if (rem === 2) s += "AB";
  assert.equal(Buffer.byteLength(s, "utf8"), targetBytes);
  return Buffer.from(s, "utf8");
}

let zstdAvailable = true;
try {
  execFileSync("zstd", ["--version"], { stdio: "ignore" });
} catch {
  zstdAvailable = false;
}

test("buildRawBlock/extractDoc roundtrip is byte-exact incl. CJK", () => {
  const docs = [
    { docId: "a1", bytes: Buffer.from("<html>原告：张三，被告：李四。</html>", "utf8") },
    { docId: "b2", bytes: Buffer.from("<p>判处拘役【三个月】🀄，并处罚金。</p>", "utf8") },
    { docId: "c3", bytes: Buffer.from("", "utf8") }, // empty payload edge
  ];
  const { raw, header, ordinals } = buildRawBlock("2026-09", docs);
  for (const d of docs) {
    const got = extractDoc(raw, d.docId);
    assert.ok(Buffer.isBuffer(got));
    assert.ok(got.equals(d.bytes), `roundtrip mismatch for ${d.docId}`);
  }
  assert.equal(extractDoc(raw, "missing-doc"), null);
  assert.deepEqual(header.docs, ["a1", "b2", "c3"]);
  assert.equal(ordinals.get("a1"), 0);
  assert.equal(ordinals.get("b2"), 1);
  assert.equal(ordinals.get("c3"), 2);
});

test("header shape: magic line, offsets vector, payload boundary", () => {
  const docs = [
    { docId: "x", bytes: Buffer.from("一二三", "utf8") },
    { docId: "y", bytes: Buffer.from("四", "utf8") },
  ];
  const { raw, header } = buildRawBlock("2025-12", docs);
  const firstNl = raw.indexOf(0x0a);
  assert.equal(raw.toString("utf8", 0, firstNl), BLOCK_MAGIC);
  const secondNl = raw.indexOf(0x0a, firstNl + 1);
  const parsed = JSON.parse(raw.toString("utf8", firstNl + 1, secondNl));
  assert.equal(parsed.month, "2025-12");
  assert.deepEqual(parsed.docs, ["x", "y"]);
  assert.equal(parsed.offsets.length, docs.length + 1);
  assert.equal(parsed.offsets[0], 0);
  assert.equal(parsed.offsets[1], Buffer.byteLength("一二三", "utf8"));
  assert.equal(parsed.offsets.at(-1), Buffer.byteLength("一二三四", "utf8"));
  assert.deepEqual(parsed, header);
  // payload starts right after the header line and is the exact doc concat
  const payload = raw.subarray(secondNl + 1);
  assert.equal(payload.length, parsed.offsets.at(-1));
  assert.ok(payload.equals(Buffer.concat(docs.map((d) => d.bytes))));
});

test("packMonth splits 3x3MiB into <=8MiB blocks, keeps docs whole, seq 1..n", () => {
  const docs = [1, 2, 3].map((n) => ({ docId: `d${n}`, bytes: bufOf(3 * MiB) }));
  const blocks = packMonth("2026-09", docs);
  assert.equal(blocks.length, 2);
  blocks.forEach((b, i) => assert.equal(b.seq, i + 1));
  assert.deepEqual(blocks[0].docs.map((d) => d.docId), ["d1", "d2"]);
  assert.deepEqual(blocks[1].docs.map((d) => d.docId), ["d3"]);
  for (const b of blocks) {
    const payloadBytes = b.docs.reduce((s, d) => s + d.bytes.length, 0);
    assert.ok(payloadBytes <= RAW_TARGET, `block payload ${payloadBytes} over budget`);
    for (const d of b.docs) assert.ok(extractDoc(b.raw, d.docId).equals(d.bytes), "doc must not be split");
  }
});

test("packMonth gives an oversized doc its own block and warns once", () => {
  const original = console.error;
  let calls = 0;
  console.error = () => {
    calls++;
  };
  try {
    const docs = [
      { docId: "small-a", bytes: bufOf(MiB) },
      { docId: "huge-1", bytes: bufOf(9 * MiB) },
      { docId: "small-b", bytes: bufOf(MiB) },
      { docId: "huge-2", bytes: bufOf(9 * MiB) },
    ];
    const blocks = packMonth("2026-09", docs);
    assert.deepEqual(
      blocks.map((b) => b.docs.map((d) => d.docId)),
      [["small-a"], ["huge-1"], ["small-b"], ["huge-2"]],
    );
    for (const b of blocks) {
      const oversized = b.docs.some((d) => d.bytes.length > RAW_TARGET);
      assert.ok(!oversized || b.docs.length === 1, "oversized block must hold exactly one doc");
      for (const d of b.docs) assert.ok(extractDoc(b.raw, d.docId).equals(d.bytes));
    }
    assert.equal(calls, 1); // warned once, not once per oversized doc
  } finally {
    console.error = original;
  }
});

test("blockKey format", () => {
  assert.equal(blockKey("2026-09", 1), "blocks/2026/09/000001.zst");
  assert.equal(blockKey("2025-01", 12345), "blocks/2025/01/012345.zst");
  assert.throws(() => blockKey("2026-9", 1), /YYYY-MM/);
});

test("compressZstd/decompressZstd roundtrip via real zstd CLI", async (t) => {
  if (!zstdAvailable) return t.skip("zstd CLI not on PATH");
  const payload = buildRawBlock("2026-09", [{ docId: "z", bytes: bufOf(256 * 1024) }]).raw;
  const zst = await compressZstd(payload);
  assert.ok(Buffer.isBuffer(zst) && zst.length > 0);
  assert.deepEqual([...zst.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd]); // zstd frame magic
  assert.ok(zst.length < payload.length, "CJK filler must actually compress");
  const back = await decompressZstd(zst);
  assert.ok(back.equals(payload));
});

// Minimal Map-backed S3 double: listObjects filters by prefix, getObject
// returns null for missing keys, deleteObject/putObject are plain Map ops.
class FakeS3 {
  constructor(initial = []) {
    this.objects = new Map(initial);
  }
  async listObjects(bucket, { prefix = "" } = {}) {
    assert.equal(bucket, "wenshu");
    const contents = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((key) => ({ key, size: this.objects.get(key).length }));
    return { contents, truncated: false, continuationToken: undefined };
  }
  async deleteObject(bucket, key) {
    this.objects.delete(key);
    return true;
  }
  async putObject(bucket, key, body) {
    this.objects.set(key, Buffer.from(body));
    return { etag: '"fake"' };
  }
  async getObject(bucket, key) {
    return this.objects.has(key) ? this.objects.get(key) : null;
  }
}

test("rebuildMonth rewrites the month prefix, refs are correct, output deterministic", async (t) => {
  if (!zstdAvailable) return t.skip("zstd CLI not on PATH");
  const bucket = "wenshu";
  const month = "2026-09";
  const prefix = "blocks/2026/09/";
  const docs = [1, 2, 3].map((n) => ({ docId: `doc-${n}`, bytes: bufOf(3 * MiB) }));
  // stale blocks under the month prefix, plus a neighbor month that must survive
  const s3 = new FakeS3([
    [`${prefix}000001.zst`, Buffer.from("stale-a")],
    [`${prefix}000099.zst`, Buffer.from("stale-b")],
    ["blocks/2026/08/000001.zst", Buffer.from("keep-me")],
  ]);

  const res = await rebuildMonth({ s3, bucket, month, docs });
  assert.equal(res.month, month);
  const key1 = "blocks/2026/09/000001.zst";
  const key2 = "blocks/2026/09/000002.zst";
  assert.deepEqual(
    res.blocks.map((b) => [b.key, b.docCount, b.rawBytes > 0]),
    [
      [key1, 2, true],
      [key2, 1, true],
    ],
  );
  assert.ok(res.blocks[0].rawBytes + res.blocks[1].rawBytes >= 9 * MiB); // raw bytes incl. header lines
  assert.deepEqual(
    res.refs,
    [
      { docId: "doc-1", block_key: key1, block_ordinal: 0 },
      { docId: "doc-2", block_key: key1, block_ordinal: 1 },
      { docId: "doc-3", block_key: key2, block_ordinal: 0 },
    ],
  );
  // stale prefix objects gone, exactly the new set present, other month untouched
  const listed = (await s3.listObjects(bucket, { prefix })).contents.map((c) => c.key);
  assert.deepEqual(listed, [key1, key2]);
  assert.ok(s3.objects.has("blocks/2026/08/000001.zst"));
  // each doc retrievable byte-exact through the bucket
  for (const r of res.refs) {
    const got = await readDocFromBucket({ s3, bucket, blockKey: r.block_key, docId: r.docId });
    assert.ok(got.equals(docs.find((d) => d.docId === r.docId).bytes), `bucket roundtrip mismatch for ${r.docId}`);
  }

  // second rebuild with identical input: identical keys, byte-identical bodies
  const before = new Map([...s3.objects].filter(([k]) => k.startsWith(prefix)));
  const res2 = await rebuildMonth({ s3, bucket, month, docs });
  assert.deepEqual(res2.blocks, res.blocks);
  assert.deepEqual(res2.refs, res.refs);
  const after = new Map([...s3.objects].filter(([k]) => k.startsWith(prefix)));
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [k, v] of before) assert.ok(after.get(k).equals(v), `non-deterministic body for ${k}`);
  const listed2 = (await s3.listObjects(bucket, { prefix })).contents.map((c) => c.key);
  assert.deepEqual(listed2, [key1, key2]);
});

test("readDocFromBucket: missing key or docId yields null", async (t) => {
  if (!zstdAvailable) return t.skip("zstd CLI not on PATH");
  const s3 = new FakeS3();
  const key = "blocks/2026/09/000001.zst";
  const raw = buildRawBlock("2026-09", [{ docId: "only", bytes: bufOf(1024) }]).raw;
  await s3.putObject("wenshu", key, await compressZstd(raw));
  assert.equal(await readDocFromBucket({ s3, bucket: "wenshu", blockKey: "blocks/2026/09/999999.zst", docId: "only" }), null);
  assert.equal(await readDocFromBucket({ s3, bucket: "wenshu", blockKey: key, docId: "absent" }), null);
  assert.ok((await readDocFromBucket({ s3, bucket: "wenshu", blockKey: key, docId: "only" })).equals(bufOf(1024)));
});
