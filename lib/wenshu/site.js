// Playwright adapter for wenshu.court.gov.cn (post-2024 UI). Every selector
// and URL lives in this file: a site redesign is fixed by editing SELECTORS /
// URLS here only. Anchors verified against the live logged-in site
// 2026-09-19 (design.md "Task 1.2 final"); every consumer fails loud with a
// `selector-drift:<key>:` error naming the key to fix. Pages handed to these
// functions are assumed authenticated — session glue lives in
// lib/wenshu/session.js.
//
// Live-verified facts baked in here:
//   - result rows are `div.LM_list`; the site's document reference is an
//     ENCRYPTED docId token (≈150 chars, may contain `/` and `+`) — NOT a
//     32-hex id (the new UI exposes no native id; archive ids are derived).
//   - date filtering is on 裁判日期 (`#cprqStart` / `#cprqEnd` laydate inputs).
//   - the full text lives in `.PDF_pox` as raw HTML (the legacy `#qwContent`
//     container is gone); `.PDF_title` carries the title, `#ahdiv` the 案号.
//   - the keyword-search page shows NO “共 N 条” total; pagination
//     (`.pageButton`, `.pageSizeSelect`) is the count proxy.

export const URLS = {
  home: "https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html",
  // keyword search + case-type lists share the page id; ?s8=02..05,10 per type
  search: "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html",
  list: (s8) => `https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=${s8}`,
  // docId is the site's raw encrypted token — do NOT encode it (the site's
  // own links carry `/` and `+` literally in the query value)
  detail: (docId) => `https://wenshu.court.gov.cn/website/wenshu/181107ANFZ0BXSK4/index.html?docId=${docId}`,
};

export const SELECTORS = {
  // The post-login header renders “欢迎您，<phone> … 退出”; 退出 is the anchor.
  loggedIn: ["a:has-text('退出')", "a:has-text('退出登录')"],
  // Logged-out signals: entries prefixed "url:" are substrings matched against
  // page.url(); the rest are CSS selectors (the SSO wall + tianai captcha).
  loginRedirect: [
    "url:181010CARHS5BS3C",           // the login wall that wraps deep links
    "url:account.court.gov.cn",       // SSO host
    ".tianai-captcha-popup", ".tianai-captcha-mask",
  ],
  // No 共N条 element exists on the live UI (verified) — searchTotal falls back
  // to the pagination proxy; keep these candidates for older/other views.
  resultCount: ".searchCount, .resultCount, .total-count",
  resultOverflow: ".search-tip, .over-count-tip, .el-message",
  resultItem: ".LM_list",             // verified: one div.LM_list per row
  resultDocId: "a.caseName",          // row link carrying ?docId=<token>
  nextPage: ".pageButton:has-text('下一页')", // verified pager
  pageSizeSelect: ".pageSizeSelect",  // 5/10/15 per page
  dateStartInput: "#cprqStart",       // verified: 裁判日期 range (laydate)
  dateEndInput: "#cprqEnd",
  dateApply: ".laydate-btns-confirm, .date-apply", // absent when UI applies on input
  provinceFilter: ".filter-province, .filter-group:has-text('省份'), .region-filter",
  caseTypeFilter: ".filter-casetype, .filter-group:has-text('案件类型'), .case-type-filter",
  filterApply: ".filter-apply, .filter-confirm, button:has-text('确定')",
  canonicalLink: "link[rel='canonical']",
  // Detail catalog anchors (verified 2026-09-19). Fields rendered behind the
  // “点击了解更多” popup (案由 etc.) resolve to null here — the crawler's row
  // meta (list page .slfyName/.ah/.cprq) is the primary source for those.
  detail: {
    案号: "#ahdiv, #iframedfah",
    标题: ".PDF_title",
    法院: ".PDF_cut:has-text('法院')",
    案由: ".PDF_cut:has-text('案由')",
    省: ".PDF_cut:has-text('省')",
    市: ".PDF_cut:has-text('市')",
    案件类型: ".List_label .labelTwo",
    文书类型: ".PDF_cut:has-text('文书类型')",
    审理程序: ".PDF_cut:has-text('审理程序')",
    案例级别: ".PDF_cut:has-text('案例级别')",
    法院级别: ".PDF_cut:has-text('法院级别')",
    法条: ".PDF_cut:has-text('法律依据')",
    判决时间: ".PDF_cut",
    发布时间: ".PDF_cut",
    受理时间: ".PDF_cut",
    判决结果: ".PDF_cut",
    qwContent: ".PDF_pox",            // verified: raw HTML full text
  },
};

// Phrases in the resultOverflow element (or count text) meaning "result set is
// capped — subdivide the slice" (design.md D7).
export const OVERFLOW_TEXTS = ["仅提供前", "仅显示前", "最多显示", "结果过多", "请缩小范围", "缩小检索范围"];

// Which date axis the range filter binds to. Verified live 2026-09-19: the
// search page exposes 裁判日期 (`#cprqStart`/`#cprqEnd`) — not 上传/公开日期.
// The incremental window therefore filters on 裁判日期 (design D7 amended).
export const DATE_FILTER_FIELD = process.env.WENSHU_DATE_FIELD || "裁判日期";

const DEFAULT_TIMEOUT_MS = 15000; // every wait is explicit; this is the default
const DETAIL_FIELD_TIMEOUT_MS = 2500; // absent catalog fields are normal, not drift — keeps 17 probes cheap
const PAGE_PACE_MS = 800; // min pause between pagination actions (listDocIds)
const SETTLE_MS = 3000; // SPA render settle after load events

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sel(key) {
  const s = SELECTORS?.[key];
  if (typeof s !== "string" || !s) {
    throw new Error(`selector-drift:${key}: SELECTORS.${key} is missing — fix SELECTORS in lib/wenshu/site.js`);
  }
  return s;
}

const drift = (key, detail, page) =>
  new Error(`selector-drift:${key}: ${detail} (url: ${page.url()}) — fix SELECTORS in lib/wenshu/site.js`);

const loginUrlPatterns = () => SELECTORS.loginRedirect.filter((p) => p.startsWith("url:"));
const loginOverlaySelectors = () => SELECTORS.loginRedirect.filter((p) => !p.startsWith("url:"));

function matchedLoginUrl(url) {
  return loginUrlPatterns().find((p) => url.includes(p.slice(4))) ?? null;
}

async function visibleLoginOverlay(page) {
  for (const s of loginOverlaySelectors()) {
    if (await page.locator(s).first().isVisible().catch(() => false)) return s;
  }
  return null;
}

// Navigate and ride the login wall's auto-pass chain. Live-verified
// 2026-09-19: deep links transiently land on 181010CARHS5BS3C and leave it
// within ~25 s when the session is valid; STAYING walled means a dead
// session. Returns true when the wall was left (or never hit).
async function gotoWithWallPass(page, url, { timeout = 45000, tries = 14 } = {}) {
  await page.goto(url, { timeout, waitUntil: "domcontentloaded" });
  for (let i = 0; i < tries; i++) {
    if (!matchedLoginUrl(page.url())) return true;
    await sleep(2500);
  }
  return !matchedLoginUrl(page.url());
}

// Loud guard against the "silently crawled logged-out" failure mode. Patient:
// the wall chain may still be in flight when this is called.
async function assertSession(page) {
  for (let i = 0; i < 4 && matchedLoginUrl(page.url()); i++) await sleep(2500);
  const url = page.url();
  const hit = matchedLoginUrl(url);
  if (hit) throw new Error(`wenshu: session invalid — login redirect "${hit}" at ${url}`);
  const overlay = await visibleLoginOverlay(page);
  if (overlay) throw new Error(`wenshu: session invalid — login overlay "${overlay}" at ${url}`);
}

export async function openSite({ headless = true, proxyUrl, storageState } = {}) {
  const { chromium } = await import("playwright"); // heavy — only pulled in when actually browsing
  const browser = await chromium.launch({
    headless,
    proxy: proxyUrl ? { server: proxyUrl } : undefined,
  });
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  return { browser, context, page };
}

// Probing/opening the BARE search URL is wall-intercepted (login-redirect
// even with a live session); the case-type list URL (?s8=03) renders the
// logged-in header — live-verified 2026-09-19.
const PROBE_URL = () => URLS.list("03");

export async function probeSession({ page }) {
  try {
    await page.goto(PROBE_URL(), { timeout: 45000, waitUntil: "domcontentloaded" });
  } catch (err) {
    return { valid: false, reason: `goto-failed:${err.message}`, url: page.url() };
  }
  // Live-verified timing 2026-09-19: deep links pass through the login wall's
  // auto-pass chain (up to ~25 s) and the SPA renders the logged-in header
  // only ~10-30 s after load. A short check false-negatives a valid session.
  for (let i = 0; i < 12; i++) {
    await sleep(2500);
    if (!matchedLoginUrl(page.url())) break;
  }
  for (let i = 0; i < 6; i++) {
    const url = page.url();
    const hit = matchedLoginUrl(url);
    if (hit) return { valid: false, reason: `login-redirect:${hit}`, url };
    for (const s of SELECTORS.loggedIn) {
      if (await page.locator(s).first().isVisible().catch(() => false)) {
        return { valid: true, reason: `loggedIn:${s}`, url };
      }
    }
    await sleep(3000);
  }
  const overlay = await visibleLoginOverlay(page);
  if (overlay) return { valid: false, reason: `login-overlay:${overlay}`, url: page.url() };
  return { valid: false, reason: "indeterminate:no-logged-in-signal", url: page.url() };
}

async function openSearch(page) {
  try {
    await gotoWithWallPass(page, URLS.search + "?s8=03");
  } catch (err) {
    throw new Error(`wenshu: cannot reach search page ${URLS.search}: ${err.message}`);
  }
  await page.waitForLoadState("load", { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
  await sleep(SETTLE_MS);
  await assertSession(page);
}

// Click an affordance that only exists in some UI states (apply buttons);
// absence is normal, so a miss here is NOT selector drift.
async function softClick(page, key, timeout = 3000) {
  const el = page.locator(sel(key)).first();
  try {
    await el.waitFor({ state: "visible", timeout });
  } catch {
    return false;
  }
  await el.click().catch(() => {});
  await sleep(500);
  return true;
}

// Click the option with exact text `value` inside the filter group `key`.
async function pickFilterOption(page, key, value) {
  const groupSel = sel(key);
  const group = page.locator(groupSel).first();
  try {
    await group.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  } catch {
    throw drift(key, `filter group "${groupSel}" not visible within ${DEFAULT_TIMEOUT_MS}ms`, page);
  }
  const opt = group.getByText(value, { exact: true }).first();
  try {
    await opt.click({ timeout: 5000 });
  } catch {
    throw new Error(`wenshu: filter option "${value}" not found in ${key} at ${page.url()}`);
  }
  await sleep(PAGE_PACE_MS);
}

// Apply one slice ({dateStart, dateEnd, province, caseType}) on the open
// search page. The date range binds to DATE_FILTER_FIELD.
async function applySlice(page, slice = {}) {
  if (slice.dateStart || slice.dateEnd) {
    // some builds expose 上传日期/公开日期 tabs — activate ours when present
    const tab = page.locator(`.date-field:has-text('${DATE_FILTER_FIELD}'), li:has-text('${DATE_FILTER_FIELD}')`).first();
    if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => {});
    for (const [key, value] of [["dateStartInput", slice.dateStart], ["dateEndInput", slice.dateEnd]]) {
      if (!value) continue;
      const s = sel(key);
      const input = page.locator(s).first();
      try {
        await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
        await input.fill(value);
      } catch (err) {
        throw drift(key, `cannot fill "${s}" with "${value}" (${err.message})`, page);
      }
      await sleep(300);
    }
    await softClick(page, "dateApply");
  }
  if (slice.province) await pickFilterOption(page, "provinceFilter", slice.province);
  if (slice.caseType) await pickFilterOption(page, "caseTypeFilter", slice.caseType);
  await softClick(page, "filterApply");
  await sleep(1500); // results reload
}

const matchesOverflow = (text) => OVERFLOW_TEXTS.some((t) => text.includes(t));

function parseCount(text) {
  const m = text.match(/共\s*([\d,，]+)\s*条/)?.[1] ?? text.match(/(\d[\d,，]*)/)?.[1];
  if (!m) return null;
  const n = Number(m.replace(/[,，]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export async function searchTotal({ page, slice = {} }) {
  await openSearch(page);
  await applySlice(page, slice);
  // The live UI renders NO “共 N 条” total (verified 2026-09-19); try the
  // element briefly for other views, then fall back to the pagination proxy:
  // highest numeric .pageButton × .pageSizeSelect ≈ result count (a lower
  // bound — the pager windows large sets — which is exactly what the slicer
  // needs: anything above the cap triggers subdivision anyway).
  const combined = `${sel("resultCount")}, ${sel("resultOverflow")}`;
  const el = await page.waitForSelector(combined, { timeout: 5000, state: "visible" }).catch(() => null);
  if (el) {
    const text = (await el.innerText().catch(() => "")) || "";
    if (matchesOverflow(text)) return "OVERFLOW";
    const overflowEl = page.locator(sel("resultOverflow")).first();
    if (await overflowEl.isVisible().catch(() => false)) {
      const ovText = (await overflowEl.innerText().catch(() => "")) || "";
      if (matchesOverflow(ovText)) return "OVERFLOW";
    }
    const n = parseCount(text);
    if (n !== null) return n;
  }
  // pagination proxy
  const nums = await page
    .locator(".pageButton")
    .allInnerTexts()
    .catch(() => []);
  const maxPage = nums.reduce((m, t) => {
    const n = Number(String(t).trim());
    return Number.isInteger(n) && n > m ? n : m;
  }, 0);
  if (maxPage > 0) {
    const sizeText = (await page.locator(sel("pageSizeSelect")).first().inputValue().catch(() => "")) || "";
    const size = Number(String(sizeText).trim()) || 15; // default page size is 15
    return maxPage * size;
  }
  throw drift("resultCount", `no count element and no .pageButton pager rendered (url: ${page.url()})`, page);
}

export async function listDocIds({ page, slice = {}, maxPages = 20, onPage }) {
  await openSearch(page);
  await applySlice(page, slice);
  const ids = [];
  const seen = new Set();
  for (let i = 0; i < maxPages; i++) {
    try {
      await page.waitForSelector(sel("resultItem"), { timeout: DEFAULT_TIMEOUT_MS, state: "visible" });
    } catch {
      throw drift("resultItem", `selector "${sel("resultItem")}" not visible within ${DEFAULT_TIMEOUT_MS}ms`, page);
    }
    const rows = page.locator(sel("resultItem"));
    const n = await rows.count();
    for (let r = 0; r < n; r++) {
      const id = await extractDocId(rows.nth(r)).catch(() => null);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    onPage?.(i + 1, ids.slice());
    if (i === maxPages - 1) break;
    const next = page.locator(sel("nextPage")).first();
    let clickable = false;
    try {
      await next.waitFor({ state: "visible", timeout: 5000 });
      clickable = await next.isEnabled();
    } catch {
      clickable = false;
    }
    if (!clickable) break; // disabled or absent -> last page reached
    await sleep(PAGE_PACE_MS);
    await next.click();
    await sleep(PAGE_PACE_MS); // pacing between page actions
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  }
  return ids;
}

// One result row (Playwright Locator) -> the site's document reference. Since
// 2024 the reference is an ENCRYPTED docId token (≈150 chars, may contain `/`
// and `+`) from the row link `a.caseName`; the legacy 32-hex form still
// passes through for older/feed-era links. Row meta (标题/法院/案号/裁判日期)
// is stashed per token in rowMetaByToken for fetchDetail's derived-id needs.
export async function extractDocId(row) {
  const href = await row.locator(sel("resultDocId")).first().getAttribute("href").catch(() => null);
  const fromHref = href ? extractDocIdFromUrl(href) : null;
  if (fromHref) {
    await stashRowMeta(row, fromHref);
    return fromHref;
  }
  for (const attr of ["data-docId", "data-docid", "data-id"]) {
    const v = await row.getAttribute(attr).catch(() => null);
    if (typeof v === "string" && v && v !== "undefined") {
      await stashRowMeta(row, v);
      return v;
    }
  }
  return null;
}

// token -> {标题, 法院, 案号, 判决时间, 案件类型} harvested from the list row.
// The live detail page renders 案号/发布日期/正文 but NOT 法院/裁判日期 (those
// live behind the “点击了解更多” popup), so the row is the primary source for
// the fields the derived doc_id needs (sha1(案号|法院|判决时间)).
export const rowMetaByToken = new Map();

async function stashRowMeta(row, token) {
  if (rowMetaByToken.has(token)) return;
  const textOf = (s) =>
    row.locator(s).first().innerText().catch(() => null).then((v) => (v == null ? null : v.trim() || null));
  rowMetaByToken.set(token, {
    标题: await textOf(".caseName"),
    法院: await textOf(".slfyName"),
    案号: await textOf(".ah"),
    判决时间: normalizeSiteDate((await textOf(".cprq")) ?? ""),
    案件类型: await textOf(".List_label .labelTwo"),
  });
}

function stripLabel(key, text) {
  for (const sep of ["：", ":"]) {
    const prefix = `${key}${sep}`;
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  // generic '字段名：' prefix when the element's label differs from our key
  return text.replace(/^[\u4e00-\u9fa5]{1,6}[：:]\s*/, "").trim();
}

async function readDetailField(page, key) {
  const s = SELECTORS.detail[key];
  if (typeof s !== "string" || !s) {
    throw new Error(`selector-drift:detail.${key}: missing selector — fix SELECTORS in lib/wenshu/site.js`);
  }
  try {
    await page.waitForSelector(s, { timeout: DETAIL_FIELD_TIMEOUT_MS, state: "visible" });
  } catch {
    return null; // missing field is data, not drift
  }
  const text = (await page.locator(s).first().innerText().catch(() => "")) || "";
  return stripLabel(key, text.trim()) || null;
}

export async function fetchDetail({ page, docId, rateMs = 1000 }) {
  await sleep(rateMs); // pacing: at most one detail per rateMs
  try {
    await gotoWithWallPass(page, URLS.detail(docId));
  } catch (err) {
    throw new Error(`wenshu: cannot reach detail for ${docId}: ${err.message}`);
  }
  await page.waitForLoadState("load", { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
  await sleep(SETTLE_MS);
  await assertSession(page);

  const out = {};
  // No native 32-hex id exists in the live UI (verified 2026-09-19): the token
  // in the URL is the site's only reference; archive ids are derived from
  // 案号|法院|判决时间 (row meta below fills the fields the detail page omits).
  out.nativeDocId = /^[0-9a-f]{32}$/i.test(docId) ? docId.toLowerCase() : null;
  for (const key of Object.keys(SELECTORS.detail)) {
    if (key === "qwContent") continue;
    out[key] = await readDetailField(page, key);
  }
  // Detail meta block: the only dated field it renders is 发布日期.
  const cut = await page.locator(".PDF_cut").first().innerText().catch(() => "");
  const pub = (cut || "").match(/发布日期\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/);
  if (pub) out.发布时间 = normalizeSiteDate(pub[1]);
  // Row-meta fallbacks: 法院/案号/裁判日期 render on the LIST row, not here.
  const rowMeta = rowMetaByToken.get(docId) ?? {};
  for (const key of ["标题", "法院", "案号", "判决时间", "案件类型"]) {
    if (!out[key] && rowMeta[key]) out[key] = rowMeta[key];
  }
  out.判决时间 = normalizeSiteDate(out.判决时间);
  out.发布时间 = normalizeSiteDate(out.发布时间);
  out.受理时间 = normalizeSiteDate(out.受理时间);
  out.判决年份 = out.判决时间 ? Number(out.判决时间.slice(0, 4)) : null;
  // qwContent: raw innerHTML, byte-for-byte — no tag stripping, no trimming.
  try {
    await page.waitForSelector(SELECTORS.detail.qwContent, { timeout: DETAIL_FIELD_TIMEOUT_MS, state: "visible" });
    out.qwContent = await page.locator(SELECTORS.detail.qwContent).first().innerHTML();
  } catch {
    out.qwContent = null;
  }
  return out;
}

// 'YYYY年M月D日' | 'YYYY-MM-DD...' | 'YYYY/M/D' | other Date-ish string ->
// 'YYYY-MM-DD' | null. Time-of-day parts are dropped; calendar-invalid or
// unparseable input yields null (never throws).
export function normalizeSiteDate(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  let m = str.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (!m) m = str.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return ymd(m[1], m[2], m[3]);
  const t = Date.parse(str);
  if (Number.isFinite(t)) {
    const d = new Date(t);
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

function ymd(y, mo, d) {
  const [yy, mm, dd] = [Number(y), Number(mo), Number(d)];
  if (!Number.isInteger(yy) || yy < 1900 || yy > 2100 || mm < 1 || mm > 12) return null;
  const check = new Date(yy, mm - 1, dd); // calendar-validity round trip (local, TZ-safe)
  if (check.getFullYear() !== yy || check.getMonth() !== mm - 1 || check.getDate() !== dd) return null;
  return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// '?docId=<value>' (in query or hash) -> the document reference | null.
// The live post-2024 UI carries an ENCRYPTED token (base64-ish, may contain
// `/` and `+`, ≈150 chars) — returned verbatim. A 32-hex value (legacy /
// feed-era) is normalized to lowercase hex. Empty/absent -> null.
export function extractDocIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  let u;
  try {
    u = new URL(url, URLS.home);
  } catch {
    return null;
  }
  const raw = u.searchParams.get("docId") || u.searchParams.get("docid") || u.hash.match(/doc[Ii]d=([^&]+)/)?.[1] || null;
  if (!raw) return null;
  const val = decodeURIComponent(raw).trim();
  if (!val) return null;
  if (/^[0-9a-f]{32}$/i.test(val)) return val.toLowerCase();
  return val; // encrypted token — opaque to us, used as-is for navigation
}
