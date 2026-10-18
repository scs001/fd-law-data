// Core of the incremental embed worker. All collaborators are injected so the
// whole flow is unit-testable without live services. The bin/ entry wires this
// to config; see design.md for the conventions this implements:
//   D1 same model/call as the historical corpus (self-check pins it)
//   D2 claims/<shard>.claim-<worker> carrying the shard's sha256 is the ledger
//   D3 regenerated shards get their laws' stale points deleted before re-upsert
import { createHash } from "node:crypto";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Startup assertion that the embedding configuration still reproduces the
// historical corpus: embed one known historical chunk and require the vector
// to land within minCosine of the stored point. Aborts the run otherwise —
// quietly embedding into a different space would poison retrieval.
//
// The probe must be a point that is STILL in the collection. A hardcoded
// historical shard name rots: `sh2-00000.jsonl`'s first row (point 1048576) was
// re-chunked away, so the fixed probe aborted every run with a 404 that read
// like a credentials/collection failure. Walk the probe shard's rows until one
// resolves, and default to the CURRENT manifest's first shard so the probe
// tracks what is actually deployed.
export async function selfCheck({ s3, bucket, embedder, qdrant, probeShard = null, minCosine = 0.999, maxProbes = 20 }) {
  const shardName = probeShard ?? (await _firstManifestShard(s3, bucket));
  const buf = await s3.getObject(bucket, shardName);
  if (!buf) throw new Error(`self-check: probe shard ${shardName} not found`);

  const rows = buf
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .slice(0, maxProbes)
    .map((line) => JSON.parse(line));

  let row = null;
  let point = null;
  for (const candidate of rows) {
    const p = await qdrant.getPoint(candidate.point_id, { withVector: true });
    if (p?.vector) {
      row = candidate;
      point = p;
      break;
    }
  }
  if (!row) {
    throw new Error(
      `self-check: none of the first ${rows.length} points in ${shardName} exist in the collection — ` +
        "cannot verify the embedding space (is QDRANT_COLLECTION the one this corpus was built into?)",
    );
  }

  const { vectors } = await embedder.embed([row.chunk_text]);
  const v = vectors[0];
  const w = point.vector;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < Math.max(v.length, w.length); i++) {
    dot += (v[i] ?? 0) * (w[i] ?? 0);
    a += (v[i] ?? 0) ** 2;
    b += (w[i] ?? 0) ** 2;
  }
  const cosine = dot / Math.sqrt(a * b);
  if (cosine < minCosine) {
    throw new Error(`self-check: cosine ${cosine.toFixed(6)} < ${minCosine} — embedding config does not match the historical corpus`);
  }
  return { cosine, probe: row.point_id, dim: v.length, shard: shardName };
}

async function _firstManifestShard(s3, bucket) {
  const buf = await s3.getObject(bucket, "incr-manifest.json");
  if (!buf) throw new Error("self-check: incr-manifest.json not found");
  const manifest = JSON.parse(buf.toString("utf8"));
  const first = manifest?.shards?.[0]?.shard;
  if (!first) throw new Error("self-check: incr-manifest.json lists no shards");
  return first;
}

export async function runEmbedJob({ s3, embedder, qdrant, bucket, worker, batchSize = 32, minLawId = 71295, log = () => {} }) {
  const manifest = JSON.parse((await s3.getObject(bucket, "incr-manifest.json")).toString("utf8"));
  const stats = { shards: 0, skipped: 0, rows: 0, points: 0, tokens: 0 };

  for (const { shard } of manifest.shards) {
    const buf = await s3.getObject(bucket, shard);
    if (!buf) {
      log(`[flk-embed] ${shard}: object missing, skipping`);
      continue;
    }
    const digest = sha256(buf);
    const rows = buf.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

    // A claim from ANY worker with a matching digest means done. A claim with
    // a different digest means the shard was regenerated: re-embed, and clear
    // the old points first (upsert cannot shrink a law's point set).
    const claimKey = (w) => `claims/${shard}.claim-${w}`;
    const claimed = (await s3.listObjects(bucket, { prefix: `claims/${shard}.claim-` })).contents ?? [];
    let done = false;
    let staleLawIds = [];
    for (const c of claimed) {
      let m;
      try {
        m = JSON.parse((await s3.getObject(bucket, c.key)).toString("utf8"));
      } catch {
        continue;
      }
      if (m?.sha256 === digest) {
        done = true;
        break;
      }
      if (Array.isArray(m?.lawIds)) staleLawIds = m.lawIds;
    }
    if (done) {
      stats.skipped++;
      continue;
    }

    const lawIds = [...new Set(rows.map((r) => r.payload?.law_id ?? String(r.law_id)))];
    for (const r of rows) {
      if (!Number.isFinite(Number(r.law_id)) || Number(r.law_id) < minLawId) {
        throw new Error(`${shard}: refusing to embed historical law_id ${r.law_id}`);
      }
    }
    if (claimed.length) {
      const targets = [...new Set([...staleLawIds, ...lawIds])];
      await qdrant.deleteByLawIds(targets);
      log(`[flk-embed] ${shard}: shard regenerated; cleared points of ${targets.length} law(s)`);
    }

    let upserted = 0;
    const t0 = Date.now();
    for (let i = 0; i < rows.length; i += batchSize) {
      const part = rows.slice(i, i + batchSize);
      const { vectors, usage } = await embedder.embed(part.map((r) => r.chunk_text));
      stats.tokens += usage?.total_tokens ?? 0;
      await qdrant.upsert(part.map((r, j) => ({ id: r.point_id, vector: vectors[j], payload: r.payload })));
      upserted += part.length;
      if (upserted % (batchSize * 10) === 0 || upserted === rows.length) {
        log(`[flk-embed] ${shard}: ${upserted}/${rows.length} rows`);
      }
    }

    // Claim only after every row is verifiably present; a crash mid-shard
    // leaves already-upserted points in place and the next run redoes the shard.
    const ids = rows.map((r) => r.point_id);
    let found = 0;
    for (let i = 0; i < ids.length; i += 128) {
      found += (await qdrant.pointsByIds(ids.slice(i, i + 128))).length;
    }
    if (found !== rows.length) throw new Error(`${shard}: verification found ${found}/${rows.length} points`);

    await s3.putObject(
      bucket,
      claimKey(worker),
      JSON.stringify({ shard, sha256: digest, rows: rows.length, points: found, lawIds, worker, at: new Date().toISOString() }),
      { contentType: "application/json" },
    );
    stats.shards++;
    stats.rows += rows.length;
    stats.points += found;
    log(`[flk-embed] ${shard}: ${rows.length} points upserted+verified in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return stats;
}
