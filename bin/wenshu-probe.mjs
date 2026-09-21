#!/usr/bin/env node
// wenshu-probe — one-shot spike CLI for the wenshu-incremental-crawl change
// (tasks 1.2/1.3): the operator runs it once with a real session to verify or
// fix SELECTORS in lib/wenshu/site.js and to record live findings for
// design.md. Emits ONE JSON report on stdout; writes nothing to S3. The
// account is never read or printed here (env-only, session module's concern).
//
// usage: wenshu-probe.mjs [--session-health] [--search-map [--pages N]]
//                         [--detail [N]] [--volume] [--province P]
//                         [--case-type T] [--headed]
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { URLS, SELECTORS, DATE_FILTER_FIELD, openSite, probeSession, searchTotal, listDocIds, fetchDetail } from "../lib/wenshu/site.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const strArg = (name, def) => {
  const v = arg(name, def);
  return typeof v === "string" && v ? v : def;
};

const CATALOG_KEYS = Object.keys(SELECTORS.detail);

const todayInTz = (tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (ymd, k) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

let browser = null;
let page = null;

async function main() {
  const sessionHealth = !!arg("session-health", false);
  const searchMap = !!arg("search-map", false);
  const volume = !!arg("volume", false);
  const detailRaw = arg("detail", null);
  const detailN = detailRaw === null ? 0 : detailRaw === true ? 3 : Number(detailRaw) || 3;
  if (!sessionHealth && !searchMap && !volume && detailN === 0) {
    console.error("usage: wenshu-probe.mjs [--session-health] [--search-map [--pages N]] [--detail [N]] [--volume] [--province P] [--case-type T] [--headed]");
    console.error("modes: --session-health | --search-map | --detail SAMPLE_N (default 3) | --volume — output is one JSON report on stdout");
    process.exitCode = 1;
    return;
  }
  const pages = Number(arg("pages", 5)) || 5;
  const province = strArg("province", "北京");
  const caseType = strArg("case-type", "民事");
  const cfg = loadConfig();
  const report = {
    tool: "wenshu-probe",
    generatedAt: new Date().toISOString(),
    dateFilterField: DATE_FILTER_FIELD,
    modes: { sessionHealth, searchMap, volume, detail: detailN, pages, province, caseType },
    urls: URLS,
  };

  // Session glue is task 2.2's module; assumed contract:
  // downloadSession({ s3, bucket }) -> storageState (object or path string).
  let downloadSession;
  try {
    ({ downloadSession } = await import("../lib/wenshu/session.js"));
  } catch {
    throw new Error("wenshu-probe: lib/wenshu/session.js is missing — implement the session machinery (task 2.2) first");
  }
  let s3;
  try {
    s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
  } catch (err) {
    throw new Error(`wenshu-probe: cannot init S3 client for the session jar: ${err.message}`);
  }
  let storageState;
  try {
    const jar = await downloadSession({ s3, bucket: cfg.wenshuBucket });
    if (!jar) {
      throw new Error(`no wenshu session jar at ${cfg.wenshuBucket}/sessions/session.json — run \`node bin/wenshu-login.mjs\` (headed; pass the slider once)`);
    }
    // downloadSession returns the wrapper {storageState}; accept a bare
    // storageState or a path string too so a contract tweak stays non-fatal.
    storageState = typeof jar === "string" ? jar : (jar.storageState ?? jar);
  } catch (err) {
    throw new Error(`wenshu-probe: session jar problem: ${err.message}`);
  }

  ({ browser, page } = await openSite({ headless: !arg("headed", false), proxyUrl: cfg.wenshuProxyUrl, storageState }));

  const session = await probeSession({ page });
  report.session = session;
  if (!session.valid && (searchMap || volume || detailN > 0)) {
    throw new Error(`wenshu-probe: session not valid (${session.reason}) — refresh it with the login helper before probing`);
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(todayInTz(cfg.wenshuTz), -(6 - i)));

  let dayRows = null;
  let docIdPool = null;
  if (searchMap || volume) {
    dayRows = [];
    for (const d of days) {
      const base = { dateStart: d, dateEnd: d };
      const row = { date: d, unfiltered: await searchTotal({ page, slice: base }) };
      if (searchMap) {
        row.region = { province, count: await searchTotal({ page, slice: { ...base, province } }) };
        row.caseType = { caseType, count: await searchTotal({ page, slice: { ...base, caseType } }) };
      }
      dayRows.push(row);
    }
  }
  if (volume) {
    const numeric = dayRows.filter((r) => typeof r.unfiltered === "number");
    const total = numeric.reduce((a, r) => a + r.unfiltered, 0);
    report.volume = {
      days: dayRows.map((r) => ({ date: r.date, count: r.unfiltered })),
      overflowDays: dayRows.filter((r) => r.unfiltered === "OVERFLOW").map((r) => r.date),
      numericDays: numeric.length,
      total,
      avgPerDay: numeric.length ? Math.round(total / numeric.length) : null,
      note: "daily incremental volume estimate; OVERFLOW days exceed the display cap and need subdividing (design.md D7)",
    };
  }
  if (searchMap) {
    // Largest slice: prefer an OVERFLOW day (the cap is the interesting case),
    // else the max numeric day.
    const largest = dayRows.find((r) => r.unfiltered === "OVERFLOW") ??
      dayRows.reduce((a, b) => ((b.unfiltered ?? -1) > (a.unfiltered ?? -1) ? b : a));
    let prev = 0;
    const perPage = [];
    const docIds = await listDocIds({
      page,
      slice: { dateStart: largest.date, dateEnd: largest.date },
      maxPages: pages,
      onPage: (_n, ids) => {
        perPage.push(ids.length - prev);
        prev = ids.length;
      },
    });
    report.searchMap = {
      days: dayRows,
      regionFilter: province,
      caseTypeFilter: caseType,
      capBehavior: {
        sawOverflow: dayRows.some((r) =>
          r.unfiltered === "OVERFLOW" || r.region?.count === "OVERFLOW" || r.caseType?.count === "OVERFLOW"),
      },
      pagination: {
        slice: { date: largest.date, unfiltered: largest.unfiltered },
        maxPages: pages,
        pagesWalked: perPage.length,
        stoppedBy: perPage.length < pages ? "nextPage-disabled-or-absent" : "maxPages-cap",
        perPageDocIds: perPage,
        uniqueDocIds: docIds.length,
      },
    };
    docIdPool = docIds;
  }
  if (detailN > 0) {
    if (!docIdPool) {
      docIdPool = [];
      for (let k = 2; k <= days.length && docIdPool.length === 0; k++) {
        const d = days[days.length - k]; // walk back from yesterday
        docIdPool = await listDocIds({ page, slice: { dateStart: d, dateEnd: d }, maxPages: 2 });
      }
    }
    if (docIdPool.length === 0) {
      throw new Error("wenshu-probe: no docIds found in the last 7 days to sample details from");
    }
    const docs = [];
    for (const id of docIdPool.slice(0, detailN)) {
      const d = await fetchDetail({ page, docId: id, rateMs: cfg.wenshuRateMs });
      docs.push({
        docId: d.nativeDocId ?? id,
        present: CATALOG_KEYS.filter((k) => d[k] != null && d[k] !== ""),
        missing: CATALOG_KEYS.filter((k) => d[k] == null || d[k] === ""),
        qwContentLength: d.qwContent ? d.qwContent.length : 0,
        qwContentHead: d.qwContent ? d.qwContent.slice(0, 120).replace(/\s+/g, " ") : null,
        判决结果: d.判决结果 ?? null,
        案例级别: d.案例级别 ?? null,
        判决时间: d.判决时间,
      });
    }
    const fieldPresence = {};
    for (const k of CATALOG_KEYS) fieldPresence[k] = docs.filter((d) => d.present.includes(k)).length;
    report.detailSample = { requested: detailN, sampled: docs.length, fieldPresence, docs };
  }

  console.log(JSON.stringify(report, null, 1));
}

try {
  await main();
} catch (err) {
  const msg = String(err?.message ?? err);
  console.error(msg);
  if (/^selector-drift:/.test(msg)) {
    console.error("fix SELECTORS in lib/wenshu/site.js");
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
} finally {
  if (browser) await browser.close().catch(() => {});
}
