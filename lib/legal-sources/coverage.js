// Cross-source coverage reporting over the immutable legal-sources manifests.
// It reads object storage only: crawls may succeed even before PG loading, and
// this report must expose crawl gaps separately from load status.
import { manifestPrefix } from "./storage.js";

export function summarizeManifests(manifests) {
  const ordered = [...manifests].sort((a, b) => String(a.finishedAt ?? "").localeCompare(String(b.finishedAt ?? "")));
  const latest = ordered.at(-1) ?? null;
  const totals = ordered.reduce(
    (acc, manifest) => {
      acc.runs += 1;
      acc.emitted += Number(manifest.coverage?.emitted ?? manifest.emitted ?? 0);
      acc.failures += Number(manifest.coverage?.failures ?? manifest.failures?.length ?? 0);
      acc.missingText += Number(manifest.coverage?.missingText ?? 0);
      acc.unreachablePages += Number(manifest.coverage?.unreachablePages?.length ?? 0);
      return acc;
    },
    { runs: 0, emitted: 0, failures: 0, missingText: 0, unreachablePages: 0 },
  );
  return {
    runs: totals.runs,
    latest: latest ? {
      runDate: latest.runDate,
      runId: latest.runId,
      mode: latest.mode,
      finishedAt: latest.finishedAt,
      sourceTotal: latest.coverage?.sourceTotal ?? null,
      listed: latest.coverage?.listed ?? null,
      planned: latest.coverage?.planned ?? null,
      skippedUnchanged: latest.coverage?.skippedUnchanged ?? null,
      emitted: latest.coverage?.emitted ?? null,
      failures: latest.coverage?.failures ?? null,
      missingText: latest.coverage?.missingText ?? null,
      attachments: latest.coverage?.attachments ?? null,
      complete: latest.coverage?.complete ?? false,
      aborted: latest.aborted ?? null,
      unreachablePages: latest.coverage?.unreachablePages ?? [],
    } : null,
    cumulative: totals,
  };
}

export async function readSourceManifests(s3, bucket, source) {
  const prefix = manifestPrefix(source);
  const out = [];
  let token;
  for (;;) {
    const page = await s3.listObjects(bucket, { prefix, continuationToken: token });
    for (const object of page.contents) {
      if (!object.key.endsWith(".manifest.json")) continue;
      const buf = await s3.getObject(bucket, object.key);
      if (!buf) continue;
      try {
        out.push(JSON.parse(buf.toString("utf8")));
      } catch (err) {
        console.error(`[${source}] corrupt manifest ${object.key}: ${err.message}`);
      }
    }
    if (!page.truncated) break;
    token = page.continuationToken;
  }
  return out;
}

export async function coverageReport(s3, bucket, sources) {
  const report = {};
  for (const source of sources) {
    report[source] = summarizeManifests(await readSourceManifests(s3, bucket, source));
  }
  return {
    generatedAt: new Date().toISOString(),
    bucket,
    sources: report,
    incomplete: Object.entries(report)
      .filter(([, summary]) => !summary.latest || summary.latest.complete !== true)
      .map(([source]) => source),
  };
}
