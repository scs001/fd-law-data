#!/usr/bin/env node
// law-db-hygiene: move vector points after scripts/reconcile-law-db.mjs has
// converged the law tables. Re-pointed chunks keep their existing embedding —
// the point is scrolled out (id `law_id * 1048576 + chunk_no`, vector
// included), written back under the survivor's id with `law_id` updated in
// the payload, then the old point is deleted. Deleted duplicates' chunks have
// their points deleted. The embedding API is NEVER called (design D4).
//
// Input: a JSON file emitted by the reconcile run, or two id files:
//   { "repoints": [{ "fromId": <dup law id>, "toId": <survivor id> }],
//     "deleteLawIds": [<deleted law id>, ...] }
import { readFileSync } from "node:fs";
import { loadConfig } from "../lib/config.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const cfg = loadConfig();
const qdrantUrl = cfg.qdrantUrl.replace(/\/$/, "");
const collection = cfg.qdrantCollection;
const inputPath = arg("input");
if (!inputPath) {
  console.error("usage: node scripts/qdrant-move-chunks.mjs --input <plan.json> [--execute]");
  process.exit(2);
}
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const repoints = input.repoints ?? [];
const deleteLawIds = (input.deleteLawIds ?? []).map(String);
const execute = !!arg("execute");
const BATCH = Number(arg("batch", 200));

const POINT_ID_STRIDE = 1048576; // export rule: law_id * 1048576 + chunk_no

async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const res = await fetch(`${qdrantUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`qdrant ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function scrollByLawIds(lawIds, onPoints) {
  let offset = null;
  for (;;) {
    const body = {
      limit: BATCH,
      with_payload: true,
      with_vector: true,
      filter: { should: lawIds.map((id) => ({ key: "law_id", match: { value: String(id) } })) },
      ...(offset ? { offset } : {}),
    };
    const { result } = await api(`/collections/${collection}/points/scroll`, body);
    for (const p of result.points) await onPoints(p);
    offset = result.next_page_offset;
    if (offset === null || offset === undefined || result.points.length === 0) break;
  }
}

// ---- re-point: read with vectors, upsert under survivor ids, delete olds --
let movedPoints = 0;
for (const { fromId, toId } of repoints) {
  let count = 0;
  await scrollByLawIds([fromId], async (point) => {
    const chunkNo = point.payload.chunk_no;
    const newId = Number(toId) * POINT_ID_STRIDE + chunkNo;
    if (!execute) {
      count += 1;
      return;
    }
    await api(`/collections/${collection}/points?wait=true`, {
      points: [
        {
          id: newId,
          vector: point.vector,
          payload: { ...point.payload, law_id: String(toId) },
        },
      ],
    }, "PUT");
    await api(`/collections/${collection}/points/delete?wait=true`, { points: [point.id] });
    count += 1;
  });
  movedPoints += count;
  console.error(`[qdrant-move] ${fromId} -> ${toId}: ${count} point(s)${execute ? " moved" : " (dry-run)"}`);
}

// ---- deleted duplicates: remove their points ------------------------------
let deletedPoints = 0;
if (deleteLawIds.length) {
  for (let i = 0; i < deleteLawIds.length; i += 1000) {
    const batch = deleteLawIds.slice(i, i + 1000).map((id) => ({ key: "law_id", match: { value: String(id) } }));
    const { result } = await api(`/collections/${collection}/points/count`, {
      filter: { should: batch }, exact: true,
    });
    deletedPoints += result.count;
    if (execute) {
      await api(`/collections/${collection}/points/delete?wait=true`, { filter: { should: batch } });
    }
  }
  console.error(`[qdrant-move] ${deletedPoints} point(s) for ${deleteLawIds.length} deleted law(s)${execute ? " deleted" : " (dry-run)"}`);
}

console.log(JSON.stringify({
  mode: execute ? "execute" : "dry-run",
  repointSources: repoints.length,
  movedPoints,
  deleteLawIds: deleteLawIds.length,
  deletedPoints,
}));
