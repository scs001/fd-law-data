// Wenshu full-text archive: per-month compressed blocks in the `wenshu` bucket.
// The on-disk format is pinned here (the historical Windows writer is
// unreachable and the bucket is empty — see design.md):
//   decompressed block = utf8 "WENSHUBLOCK1\n"
//                      + utf8 JSON.stringify({month, docs, offsets}) + "\n"
//                      + payload = concat of each doc's Buffer.from(qwContent, "utf8")
//   offsets has docs.length+1 entries: offsets[0]=0, offsets[i]=payload bytes
//   before doc i, last entry = total payload length. zstd level 19.
import { execFileSync } from "node:child_process";

export const BLOCK_MAGIC = "WENSHUBLOCK1";
export const RAW_TARGET = 8 * 1024 * 1024; // payload budget per block before zstd

const MONTH_RE = /^\d{4}-\d{2}$/;

function assertMonth(month) {
  if (typeof month !== "string" || !MONTH_RE.test(month)) {
    throw new Error(`wenshu blocks: month must be 'YYYY-MM', got ${JSON.stringify(month)}`);
  }
}

export function blockKey(month, seq) {
  assertMonth(month);
  const [yyyy, mm] = month.split("-");
  return `blocks/${yyyy}/${mm}/${String(seq).padStart(6, "0")}.zst`;
}

// Byte-wise line reader: the payload after the header may contain 0x0a, so the
// magic/header lines must be located before any whole-buffer string decoding.
function readLine(buf, start) {
  const nl = buf.indexOf(0x0a, start);
  if (nl === -1) throw new Error(`wenshu blocks: truncated block (no newline after byte ${start})`);
  return { line: buf.toString("utf8", start, nl), next: nl + 1 };
}

export function buildRawBlock(month, docs) {
  assertMonth(month);
  const offsets = [0];
  let total = 0;
  for (const d of docs) {
    total += d.bytes.length;
    offsets.push(total);
  }
  const header = { month, docs: docs.map((d) => d.docId), offsets };
  const raw = Buffer.concat([
    Buffer.from(`${BLOCK_MAGIC}\n${JSON.stringify(header)}\n`, "utf8"),
    ...docs.map((d) => d.bytes),
  ]);
  const ordinals = new Map(docs.map((d, i) => [d.docId, i]));
  return { raw, header, ordinals };
}

// Greedy split: fill a block up to RAW_TARGET, never split a doc; a doc larger
// than the budget gets its own oversized block (allowed, warned once).
export function packMonth(month, docs) {
  assertMonth(month);
  const groups = [];
  let cur = [];
  let curBytes = 0;
  let oversizedWarned = false;
  for (const d of docs) {
    if (cur.length && curBytes + d.bytes.length > RAW_TARGET) {
      groups.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(d);
    curBytes += d.bytes.length;
    if (d.bytes.length > RAW_TARGET && !oversizedWarned) {
      console.error(
        `wenshu blocks: doc ${d.docId} payload ${d.bytes.length}B exceeds RAW_TARGET ${RAW_TARGET}B; storing as an oversized block`,
      );
      oversizedWarned = true;
    }
  }
  if (cur.length) groups.push(cur);
  return groups.map((group, i) => ({ seq: i + 1, docs: group, raw: buildRawBlock(month, group).raw }));
}

export function extractDoc(rawBuf, docId) {
  const magic = readLine(rawBuf, 0);
  if (magic.line !== BLOCK_MAGIC) {
    throw new Error(`wenshu blocks: bad magic ${JSON.stringify(magic.line.slice(0, 32))}, expected ${BLOCK_MAGIC}`);
  }
  const headerLine = readLine(rawBuf, magic.next);
  const header = JSON.parse(headerLine.line);
  const idx = header.docs.indexOf(docId);
  if (idx === -1) return null;
  const from = headerLine.next + header.offsets[idx];
  const to = headerLine.next + header.offsets[idx + 1];
  // Copy out so callers never pin the whole decompressed block in memory.
  return Buffer.from(rawBuf.subarray(from, to));
}

// zstd: prefer a future node:zstd builtin, else the zstd CLI (>= 1.5) on PATH.
// The strategy is resolved lazily so the sync pack functions above stay pure;
// only the final compress/decompress step pays the (one-time) async probe.
let strategyPromise = null;

function runZstdCli(args, input) {
  try {
    return execFileSync("zstd", args, { input, maxBuffer: Infinity });
  } catch (err) {
    const stderr = err && err.stderr ? Buffer.from(err.stderr).toString("utf8").trim() : "";
    throw new Error(`wenshu blocks: zstd CLI failed (zstd ${args.join(" ")}): ${err.message}${stderr ? "\n" + stderr : ""}`);
  }
}

async function resolveZstdStrategy() {
  if (!strategyPromise) {
    strategyPromise = (async () => {
      try {
        const mod = await import("node:zstd");
        if (typeof mod?.compress === "function" && typeof mod?.decompress === "function") {
          return {
            async compress(buf) {
              return mod.compress(buf, { level: 19 });
            },
            async decompress(buf) {
              return mod.decompress(buf);
            },
          };
        }
      } catch {
        // no node:zstd builtin in this Node build — fall through to the CLI
      }
      try {
        execFileSync("zstd", ["--version"], { stdio: "ignore" });
      } catch {
        throw new Error(
          "wenshu blocks: no zstd available — need the node:zstd builtin or a zstd >= 1.5 CLI on PATH (e.g. brew install zstd)",
        );
      }
      return {
        async compress(buf) {
          return runZstdCli(["-19", "-T0", "--stdout"], buf);
        },
        async decompress(buf) {
          return runZstdCli(["-d", "--stdout"], buf);
        },
      };
    })();
  }
  return strategyPromise;
}

export async function compressZstd(buf) {
  const s = await resolveZstdStrategy();
  return s.compress(buf);
}

export async function decompressZstd(buf) {
  const s = await resolveZstdStrategy();
  return s.decompress(buf);
}

function monthPrefix(month) {
  const [yyyy, mm] = month.split("-");
  return `blocks/${yyyy}/${mm}/`;
}

// docs: ALL docs of the month (caller aggregates across every crawl file).
// Month-prefix rewrite: delete every existing block under blocks/{yyyy}/{mm}/
// (deleteObject is idempotent), then upload the freshly packed set. Returns
// refs for the loader's judgments UPDATE.
export async function rebuildMonth({ s3, bucket, month, docs }) {
  assertMonth(month);
  const prefix = monthPrefix(month);
  let token;
  do {
    const page = await s3.listObjects(bucket, { prefix, ...(token ? { continuationToken: token } : {}) });
    for (const obj of page.contents ?? []) await s3.deleteObject(bucket, obj.key);
    token = page.truncated ? page.continuationToken : undefined;
  } while (token);

  const blocks = [];
  const refs = [];
  for (const packed of packMonth(month, docs)) {
    const key = blockKey(month, packed.seq);
    await s3.putObject(bucket, key, await compressZstd(packed.raw));
    blocks.push({ key, docCount: packed.docs.length, rawBytes: packed.raw.length });
    packed.docs.forEach((d, ordinal) => refs.push({ docId: d.docId, block_key: key, block_ordinal: ordinal }));
  }
  return { month, blocks, refs };
}

// Single-doc retrieval: block_key -> decompress -> header offsets -> byte slice.
export async function readDocFromBucket({ s3, bucket, blockKey, docId }) {
  const zst = await s3.getObject(bucket, blockKey);
  if (!zst) return null;
  return extractDoc(await decompressZstd(zst), docId);
}
