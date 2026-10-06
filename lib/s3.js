// Minimal SigV4 client for RustFS (S3-compatible), per the storage doc §3
// reuse kit: no aws-sdk, hand-signed, exports the documented surface plus
// getObject (needed to read crawler state back).
import { createHash, createHmac } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RFC3986 encoding (AWS signature rules; stricter than encodeURIComponent)
function awsUriEncode(str, encodeSlash = true) {
  let out = "";
  for (const ch of encodeURIComponent(str)) {
    if ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~".includes(ch)) out += ch;
    else if (ch === "%2F") out += encodeSlash ? "%2F" : "/";
    else out += ch; // encodeURIComponent already percent-escaped, uppercase hex
  }
  return out;
}

function canonicalQuery(query = {}) {
  const keys = Object.keys(query);
  if (!keys.length) return "";
  return keys
    .map((k) => ({ k: awsUriEncode(k), v: awsUriEncode(String(query[k])) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.v < b.v ? -1 : 1))
    .map(({ k, v }) => `${k}=${v}`)
    .join("&");
}

function canonicalUri(bucket, key) {
  const enc = (seg) => awsUriEncode(seg);
  let uri = "";
  if (bucket) uri += "/" + enc(bucket);
  if (key) uri += "/" + key.split("/").map(enc).join("/");
  return uri || "/";
}

export function createS3({ endpoint, accessKey, secretKey, region = "us-east-1" }) {
  if (!endpoint || !accessKey || !secretKey) {
    throw new Error("s3: endpoint/accessKey/secretKey are required (see .env.example)");
  }
  const u = new URL(endpoint);
  const host = u.host;
  const basePath = u.pathname.replace(/\/$/, "");

  async function request(method, bucket, key, { body, headers = {}, query, timeoutMs = 60000, retries = 2, consume } = {}) {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body === undefined ? sha256hex("") : sha256hex(body);
    const allHeaders = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const signedHeaders = Object.keys(allHeaders).sort().join(";");
    const canonicalHeaders = Object.keys(allHeaders)
      .sort()
      .map((k) => `${k}:${allHeaders[k]}\n`)
      .join("");
    const canonicalRequest = [
      method,
      basePath + canonicalUri(bucket, key),
      canonicalQuery(query),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256hex(canonicalRequest),
    ].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const qs = canonicalQuery(query);
    const url = `${u.protocol}//${host}${basePath}${canonicalUri(bucket, key)}${qs ? "?" + qs : ""}`;
    // RustFS behind Caddy occasionally stalls; retry network-level failures so
    // a transient hiccup cannot crash a long crawl or the loader (hit live
    // 2026-09-18 twice: checkpoint PUT and shard PUT).
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: { ...allHeaders, Authorization: authorization },
          body,
          signal: ctrl.signal,
        });
        if (consume) {
          // Body read happens before the timeout is cleared, so the abort
          // signal also covers a half-open response body (a plain fetch()
          // resolves on headers and would leave the read hanging forever).
          const value = await consume(res);
          clearTimeout(timer);
          return value;
        }
        clearTimeout(timer);
        return res;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err?.name === "AbortError"
          ? new Error(`${method} ${[bucket, key].filter(Boolean).join("/")} timed out after ${timeoutMs}ms`)
          : err;
        if (lastErr?.noRetry) break;
        if (attempt < retries) {
          const waitMs = 1000 * (attempt + 1);
          console.error(`[s3] ${method} ${[bucket, key].filter(Boolean).join("/")} attempt ${attempt + 1}/${retries + 1} failed (${String(lastErr?.message ?? lastErr).slice(0, 160)}); retrying in ${waitMs}ms`);
          await sleep(waitMs);
        }
      }
    }
    throw lastErr;
  }

  async function xmlText(res) {
    return res.text();
  }

  return {
    async createBucket(bucket) {
      const res = await request("PUT", bucket, undefined, {
        body: `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`,
        headers: { "content-type": "application/xml" },
      });
      if (!res.ok && res.status !== 409) throw new Error(`createBucket ${bucket}: ${res.status} ${await xmlText(res)}`);
      return true;
    },

    async putObject(bucket, key, body, { contentType = "application/octet-stream" } = {}) {
      const res = await request("PUT", bucket, key, {
        body: typeof body === "string" ? Buffer.from(body, "utf8") : body,
        headers: { "content-type": contentType },
      });
      if (!res.ok) throw new Error(`putObject ${bucket}/${key}: ${res.status} ${await xmlText(res)}`);
      return { etag: res.headers.get("etag") };
    },

    async putObjectFromFile(bucket, key, filePath, opts = {}) {
      const buf = readFileSync(filePath);
      return this.putObject(bucket, key, buf, opts);
    },

    async headObject(bucket, key) {
      const res = await request("HEAD", bucket, key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`headObject ${bucket}/${key}: ${res.status}`);
      return {
        contentLength: Number(res.headers.get("content-length") ?? 0),
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
      };
    },

    // Download hardening for the loader: the 60s timeout covers headers and
    // the whole body, and a transient failure retries (default twice). A
    // half-open GET can no longer hang a load job until its deadline.
    async getObject(bucket, key, { timeoutMs = 60000, retries = 2 } = {}) {
      return request("GET", bucket, key, {
        timeoutMs,
        retries,
        consume: async (res) => {
          if (res.status === 404) return null;
          if (!res.ok) {
            const err = new Error(`getObject ${bucket}/${key}: ${res.status}`);
            if (res.status < 500) err.noRetry = true;
            throw err;
          }
          return Buffer.from(await res.arrayBuffer());
        },
      });
    },

    async deleteObject(bucket, key) {
      const res = await request("DELETE", bucket, key);
      if (!res.ok && res.status !== 404) throw new Error(`deleteObject ${bucket}/${key}: ${res.status}`);
      return true;
    },

    // listObjects({prefix, maxKeys, continuationToken}) -> {contents, truncated, continuationToken}
    async listObjects(bucket, { prefix = "", maxKeys = 1000, continuationToken } = {}) {
      const query = { "list-type": "2", prefix, maxKeys: String(maxKeys) };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const xml = await request("GET", bucket, undefined, {
        query,
        consume: async (res) => {
          const body = await res.text();
          if (!res.ok) {
            const err = new Error(`listObjects ${bucket}: ${res.status} ${body}`);
            if (res.status < 500) err.noRetry = true;
            throw err;
          }
          return body;
        },
      });
      const contents = [];
      const entryRe = /<Contents>([\s\S]*?)<\/Contents>/g;
      let m;
      while ((m = entryRe.exec(xml))) {
        const seg = m[1];
        const pick = (tag) => {
          const t = seg.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
          return t ? t[1] : "";
        };
        contents.push({
          key: pick("Key"),
          size: Number(pick("Size") || 0),
          etag: pick("ETag").replace(/&quot;/g, '"'),
        });
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const nextToken = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
      return { contents, truncated, continuationToken: truncated && nextToken ? nextToken[1] : undefined };
    },

    async listBuckets() {
      const res = await request("GET", undefined, undefined);
      if (!res.ok) throw new Error(`listBuckets: ${res.status} ${await xmlText(res)}`);
      const xml = await xmlText(res);
      const names = [];
      const re = /<Name>([\s\S]*?)<\/Name>/g;
      let m;
      while ((m = re.exec(xml))) names.push(m[1]);
      return names;
    },
  };
}

// Idempotent upload per the storage doc: HEAD first, skip when content-length matches.
export async function putIfChanged(s3, bucket, key, body, opts = {}) {
  const size = typeof body === "string" ? Buffer.byteLength(body) : body.length;
  const existing = await s3.headObject(bucket, key);
  if (existing && existing.contentLength === size) return { skipped: true, key };
  await s3.putObject(bucket, key, body, opts);
  return { skipped: false, key, size };
}
