// Minimal Map-backed S3 for tests/proofs: implements getObject, putObject,
// headObject, deleteObject, listObjects({prefix, continuationToken}) with
// correct prefix filtering + maxKeys paging. Objects stored as Buffers;
// putObject records etag; getObject returns Buffer|null.
//
// Extra conveniences for proofs (beyond the real client's surface):
//   - every call is appended to `calls` as {op, bucket, key, prefix?}
//   - snapshot(prefix) -> Map<key, Buffer copy> for byte-compare idempotency proofs
// continuationToken is the last key of the prior page (S3 tokens are opaque;
// this keeps paging deterministic: the next page starts strictly after it).
import { createHash } from "node:crypto";

export class LocalS3 {
  constructor() {
    this.objects = new Map(); // `${bucket} ${key}` -> { buf, etag, contentType, lastModified }
    this.calls = [];
  }

  #k(bucket, key) {
    return `${bucket} ${key}`;
  }

  async putObject(bucket, key, body, { contentType = "application/octet-stream" } = {}) {
    this.calls.push({ op: "putObject", bucket, key });
    const buf = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
    const etag = `"${createHash("md5").update(buf).digest("hex")}"`;
    this.objects.set(this.#k(bucket, key), { buf, etag, contentType, lastModified: new Date().toISOString() });
    return { etag };
  }

  async getObject(bucket, key) {
    this.calls.push({ op: "getObject", bucket, key });
    const o = this.objects.get(this.#k(bucket, key));
    return o ? o.buf : null;
  }

  async headObject(bucket, key) {
    this.calls.push({ op: "headObject", bucket, key });
    const o = this.objects.get(this.#k(bucket, key));
    return o ? { contentLength: o.buf.length, etag: o.etag, lastModified: o.lastModified } : null;
  }

  async deleteObject(bucket, key) {
    this.calls.push({ op: "deleteObject", bucket, key });
    this.objects.delete(this.#k(bucket, key));
    return true;
  }

  async listObjects(bucket, { prefix = "", maxKeys = 1000, continuationToken } = {}) {
    this.calls.push({ op: "listObjects", bucket, prefix });
    const all = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(`${bucket} `))
      .map(([k, v]) => ({ key: k.slice(bucket.length + 1), size: v.buf.length, etag: v.etag }))
      .filter((o) => o.key.startsWith(prefix))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let start = 0;
    if (continuationToken) {
      start = all.findIndex((o) => o.key > continuationToken);
      if (start < 0) start = all.length;
    }
    const contents = all.slice(start, start + maxKeys);
    const truncated = start + maxKeys < all.length;
    return {
      contents,
      truncated,
      continuationToken: truncated && contents.length ? contents[contents.length - 1].key : undefined,
    };
  }

  snapshot(prefix = "") {
    const out = new Map();
    for (const [k, v] of this.objects) {
      const key = k.slice(k.indexOf(" ") + 1);
      if (key.startsWith(prefix)) out.set(key, Buffer.from(v.buf));
    }
    return out;
  }
}
