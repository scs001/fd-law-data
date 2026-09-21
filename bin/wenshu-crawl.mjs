#!/usr/bin/env node
// wenshu nightly incremental crawl (spec wenshu-incremental-crawl).
// Credentials via env/.env only (RustFS keys + wenshu account; no PG here).
// Session jar comes from wenshu/sessions/ (local login helper); automatic
// re-login is attempted with the Secret account; a slider challenge or
// unvalidatable session fails loud with exit code 42 (runbook: human
// refreshes the session) instead of crawling logged-out.
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { crawl, DEFAULT_REGIONS, DEFAULT_CASE_TYPES } from "../lib/wenshu/crawler.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const cfg = loadConfig();
const dryRun = !!arg("dry-run");
let courtLevelCodes = []; // filled from the CDP adapter when the raw-CDP path is used
let docTypeCodes = [];
let reasonAxes = {}; // caseType -> [{code,label}]
const s3 = createS3(
  dryRun
    ? { endpoint: "https://dry-run.invalid", accessKey: "dry", secretKey: "run" }
    : { endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region },
);

// Browser + session glue, loaded late so lib/wenshu/crawler.js stays
// playwright-free and unit-testable. SessionError duck-types by name — the
// same check the crawler uses for its drift-class abort.
const site = await import("../lib/wenshu/site.js");
const sessionMod = await import("../lib/wenshu/session.js");
const SessionError =
  site.SessionError ??
  sessionMod.SessionError ??
  class SessionError extends Error {
    constructor(kind, message) {
      super(message);
      this.name = "SessionError";
      this.kind = kind;
    }
  };

let browser = null;
let context = null;
let page = null;
let cdpDetached = false;
try {
  // --cdp <url>: ATTACH to the standing warm browser (scripts/wenshu-
  // warm-browser.mjs, CDP 9223) and ride its keepalive-sustained session —
  // the durable session shape (activity-bound sessions die ~20 min idle;
  // the warm browser never idles). Detach (not close) when done.
  // --profile <dir>: ride a login-helper persistent profile directly (the
  // session must have been created moments ago — see runbook).
  let cdpRawUrl = arg("cdp-raw");
  const cdpUrl = arg("cdp");
  const profileDir = arg("profile");
  if (cdpRawUrl) {
    // attach to the STANDING standalone real Chrome via raw CDP (login-state
    // reuse; playwright cannot drive real Chrome 153 — see lib/wenshu/cdp-adapter.js)
    if (cdpRawUrl === true) cdpRawUrl = "http://localhost:9223";
    const { createCdpAdapter, COURT_LEVELS, DOC_TYPES } = await import("../lib/wenshu/cdp-adapter.js");
    courtLevelCodes = COURT_LEVELS.map((l) => l.code); // declared at module scope below
    docTypeCodes = DOC_TYPES.map((l) => l.code);
    const tabId = arg("cdp-tab");
    // A worker without a tab of its own must open one: adopting an existing tab
    // would land it on the tab another worker is driving and the two would fight
    // over its navigation.
    const workerId = arg("worker-id");
    const cdp = await createCdpAdapter({
      cdpUrl: String(cdpRawUrl),
      targetId: tabId && tabId !== true ? String(tabId) : null,
      ownTabOnly: !!(workerId && workerId !== true),
    });
    globalThis.__wenshuCdpAdapter = cdp; // exposed before the probe so the finally block can close its socket
    // 案由 branches per case type, read from the site's own tree once the tab is on
    // the search page: the axis that finally brings a busy slice (基层民事裁定书 etc.)
    // under the per-query cap. Reading it before the probe sees a stale page and
    // yields zero options.
    const readReasonAxes = async () => {
      const caseTypesForAxes = (arg("case-types") && arg("case-types") !== true ? String(arg("case-types")) : "民事,刑事,行政,执行,赔偿").split(",").map((x) => x.trim()).filter(Boolean);
      for (const ct of caseTypesForAxes) reasonAxes[ct] = await cdp.reasonOptions(ct).catch(() => []);
      console.error(`[wenshu-crawl] 案由 axis: ${Object.entries(reasonAxes).map(([k, v]) => `${k}=${v.length}`).join(" ")}`);
    };
    const probe = await cdp.probeSession();
    if (!probe.valid) {
      if (probe.reason === "account-banned") {
        const { AccountBannedError } = await import("../lib/wenshu/cdp-adapter.js");
        throw new AccountBannedError("session probe landed on the ban notice");
      }
      const err = new Error(`standing-browser session invalid (${probe.reason}) — complete the login in the standing Chrome window (scripts/wenshu-standalone.sh), then retry`);
      err.name = "SessionError";
      err.code = "STANDING";
      throw err;
    }
    if (arg("no-details")) await readReasonAxes();
  } else if (cdpUrl) {
    if (cdpUrl === true) throw new Error("--cdp requires a URL argument (e.g. --cdp http://localhost:9223)");
    const { chromium } = await import("playwright");
    browser = await chromium.connectOverCDP(String(cdpUrl));
    cdpDetached = true; // closing the browser would kill the warm browser; detach only
    context = browser.contexts()[0];
    page = await context.newPage();
    const probe = await site.probeSession({ page });
    if (!probe.valid) {
      const err = new Error(`warm-browser session invalid (${probe.reason}) — the standing browser needs a re-login: run node scripts/wenshu-warm-browser.mjs and pass the captcha once`);
      err.name = "SessionError";
      err.code = "WARM_BROWSER";
      throw err;
    }
  } else if (profileDir) {
    if (profileDir === true) throw new Error("--profile requires a directory argument");
    const { chromium } = await import("playwright");
    context = await chromium.launchPersistentContext(String(profileDir), { headless: true });
    page = context.pages()[0] ?? (await context.newPage());
    const probe = await site.probeSession({ page });
    if (!probe.valid) {
      const err = new Error(`profile session invalid (${probe.reason}) — re-run node bin/wenshu-login.mjs, pass the captcha, then retry with --profile immediately`);
      err.name = "SessionError";
      err.code = "PROFILE";
      throw err;
    }
  } else {
    ({ browser, context, page } = await site.openSite({ headless: true, proxyUrl: cfg.wenshuProxyUrl }));

  // Minimal inline automatic re-login (design.md: the cluster retries with
  // the Secret account; a slider is not machine-solvable → fail loud via
  // onSlider/SessionError, which session.js turns into the SLIDER exit).
  // Preferred when site.js ships its own attemptRelogin.
  const inlineRelogin = async ({ account, onSlider }) => {
    const sel = site.SELECTORS ?? {};
    const userSel = sel.login?.user ?? sel.usernameInput;
    const passSel = sel.login?.password ?? sel.passwordInput;
    const submitSel = sel.login?.submit ?? sel.loginEntry;
    if (!userSel || !passSel || !submitSel || !account?.user || !account?.pass) {
      throw new SessionError(
        "SLIDER",
        "automatic relogin unavailable (no login selectors or no WENSHU_ACCOUNT_USER/PASSWORD in the Secret); run node bin/wenshu-login.mjs locally and re-pass the slider",
      );
    }
    await page.goto(site.LOGIN_URL ?? "https://wenshu.court.gov.cn/");
    await page.locator(userSel).first().fill(account.user);
    await page.locator(passSel).first().fill(account.pass);
    await page.locator(submitSel).first().click();
    if (sel.slider && (await page.locator(sel.slider).count()) > 0) {
      onSlider();
      throw new SessionError("SLIDER", "slider captcha during automatic relogin");
    }
    await page.waitForLoadState("networkidle");
    return page.storageState();
  };
  const attemptRelogin = site.attemptRelogin ?? site.relogin ?? inlineRelogin;

  // In dry-run no S3 object may be touched: give the session layer an offline
  // view (no stored jar → fresh probe/relogin; a refreshed jar is not persisted).
  const sessionS3 = dryRun
    ? { getObject: async () => null, headObject: async () => null, putObject: async () => ({ etag: null }) }
    : s3;
  await sessionMod.ensureSession({
    s3: sessionS3,
    bucket: cfg.wenshuBucket,
    account: { user: cfg.wenshuAccountUser, pass: cfg.wenshuAccountPassword },
    applyJar: async (state) => {
      // cookies AND localStorage — the wenshu SPA keys its logged-in state
      // off localStorage tokens (nickName/wenshuListInfo/$listparams); a
      // cookies-only restore renders an anonymous shell (found live
      // 2026-09-19: the jar's origins are as essential as its cookies).
      await context.addCookies(state?.cookies ?? []);
      for (const o of state?.origins ?? []) {
        if (!o?.localStorage?.length) continue;
        await context.addInitScript(
          ({ origin, items }) => {
            if (location.origin === origin) for (const { name, value } of items) localStorage.setItem(name, value);
          },
          { origin: o.origin, items: o.localStorage },
        );
      }
    },
    probe: () => site.probeSession({ page }),
    attemptRelogin,
  });
  } // end non-profile (jar) path

  const adapter = globalThis.__wenshuCdpAdapter
    ? {
        // raw-CDP adapter riding the standing real Chrome (login-state reuse)
        probeSession: () => globalThis.__wenshuCdpAdapter.probeSession(),
        searchTotal: (slice) => globalThis.__wenshuCdpAdapter.searchTotal(slice),
        listDocIds: (slice, opts = {}) => globalThis.__wenshuCdpAdapter.listDocIds(slice, opts),
        listRows: (slice, opts = {}) => globalThis.__wenshuCdpAdapter.listRows(slice, opts),
        fetchDetail: (docId) => globalThis.__wenshuCdpAdapter.fetchDetail(docId),
      }
    : site.createAdapter
    ? await site.createAdapter({ page })
    : {
        probeSession: () => site.probeSession({ page }),
        searchTotal: (slice) => site.searchTotal({ page, slice }),
        listDocIds: (slice, opts = {}) => site.listDocIds({ page, slice, ...opts }),
        // site.fetchDetail paces internally too — rate 0 there; crawl()'s
        // rateMs (from --rate-ms / cfg) is the single source of pacing truth.
        fetchDetail: (docId) => site.fetchDetail({ page, docId, rateMs: 0 }),
      };

  // Slice shape. The raw-CDP adapter can only express date (裁判日期) and
  // 案件类型 on the live form — there is no province control on the search page —
  // so --no-regions drops that axis and lets the slicer subdivide by case type
  // and date instead of probing province slices the site cannot honour.
  const caseTypesArg = arg("case-types");
  const caseTypes = caseTypesArg && caseTypesArg !== true
    ? String(caseTypesArg).split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CASE_TYPES;

  const res = await crawl({
    s3,
    bucket: cfg.wenshuBucket,
    adapter,
    lookbackDays: Number(arg("lookback", cfg.wenshuLookbackDays)),
    rateMs: Number(arg("rate-ms", cfg.wenshuRateMs)),
    budgetMs: Number(arg("budget-ms", cfg.wenshuBudgetMs)),
    resultCap: Number(arg("result-cap", cfg.wenshuResultCap)),
    maxPages: Number(arg("max-pages", 20)),
    regions: arg("no-regions") ? [] : DEFAULT_REGIONS,
    caseTypes,
    since: arg("since") === true ? undefined : arg("since"),
    until: arg("until") === true ? undefined : arg("until"),
    worker: arg("worker-id") && arg("worker-id") !== true ? String(arg("worker-id")) : "",
    // --no-details: catalog metadata + detail URL only, no full text. ~25x lighter
    // on the site (list pages carry 5 documents each; details are 1 request each).
    metaOnly: !!arg("no-details"),
    courtLevels: arg("no-details") ? courtLevelCodes : [],
    docTypes: arg("no-details") ? docTypeCodes : [],
    reasonAxes,
    dryRun,
  });
  console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "crawl", manifest: res.manifest }, null, 1));
} catch (err) {
  if (err?.name === "AccountBannedError") {
    // Not a session problem: the site blocked the account. Exit with its own code
    // so the supervisor stops crawling instead of retrying into the ban.
    console.error(`[wenshu-crawl] ACCOUNT BANNED: ${err.message}`);
    process.exitCode = 44;
  } else if (err?.name === "SessionError") {
    console.error(`[wenshu-crawl] session invalid (${err.code ?? err.kind ?? "unknown"}): ${err.message}`);
    console.error("[wenshu-crawl] operator action: run node bin/wenshu-login.mjs locally, pass the slider, then retry.");
    process.exitCode = 42; // runbook: human session refresh required
  } else {
    // The finally block exits explicitly, so the exception never reaches node's
    // uncaught handler: report it here and carry the failure in the exit code.
    console.error(`[wenshu-crawl] FATAL: ${err?.stack ?? err}`);
    process.exitCode = 1;
    throw err;
  }
} finally {
  // Detaching from the warm browser can hang indefinitely (the CDP close ack
  // never arrives), which used to leave this process alive forever with the
  // crawl already uploaded and the supervisor waiting on its exit. Cap the wait,
  // then exit explicitly — the manifest must reach the supervisor, so let stdout
  // drain first.
  const closes = [];
  if (browser) closes.push(browser.close().catch(() => {})); // CDP close = detach; the warm browser keeps running
  else if (context) closes.push(context.close().catch(() => {}));
  await Promise.race([Promise.all(closes), new Promise((r) => setTimeout(r, 3000))]);
  // The raw-CDP adapter holds an open WebSocket; without this an exit-42 run
  // reports "session invalid" and then hangs instead of exiting.
  globalThis.__wenshuCdpAdapter?.ws?.close();
  await new Promise((r) => process.stdout.write("", r));
  process.exit(process.exitCode ?? 0);
}
