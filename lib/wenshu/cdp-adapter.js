// Raw-CDP adapter for the STANDING standalone real Chrome (login-state reuse,
// 2026-09-19). Playwright's connectOverCDP cannot drive real Chrome 153
// ("Browser context management is not supported"), so this adapter speaks raw
// CDP (Page.navigate + Runtime.evaluate) and implements the crawler adapter
// surface {searchTotal, listDocIds, fetchDetail} with the live-verified
// selectors (design.md "Task 1.2 final"; slicing reconned live 2026-09-20).
//
// SLICING (2026-09-20). The search page has no per-slice URL: the query lives in
// the page's own model and goes out as an encrypted `ciphertext` (POST
// /website/parse/rest.q4w), so the only way to run a slice is to drive the form
// the way a reader would:
//   案件类型  click #s8, then the nav option for the type (clicking an option
//             reloads the page with that type applied)
//   页大小    select.pageSizeSelect -> 15  (the options are 5/10/15)
//   裁判日期  open div.advencedWrapper through its toggle div.advenced-search,
//             then set #cprqStart / #cprqEnd (the page validates each against
//             /api/fp/cprq)
//   执行      click the `a` 检索 inside .searchbtn.  NOTE: div.search-rightBtn
//             is display:none once the panel is open, and clicking it does
//             nothing; a search issued with the panel CLOSED silently drops the
//             advanced conditions.
// Every slice application is verified before use — the facet request must carry
// the cprq range AND the rendered rows must fall inside the window — and a slice
// that will not apply throws instead of quietly crawling the unfiltered list.
const WALL = /181010CARHS5BS3C|waf_text_verify/;
// The site's own notice when it has blocked the account:
//   "由于检测到您的账号存在违规行为，已对您的账号进行封禁。…请发邮件至 cpwsw@court.gov.cn 进行申诉"
// It replaces the list page with a ~300-byte HTML body. Not a session problem
// and not a WAF wall: no re-login, refresh or retry changes it, and every
// further request is more evidence against a flagged account. Stop instead.
const BANNED_NOTICE = /已对您的账号进行封禁|账号存在违规行为/;
export class AccountBannedError extends Error {
  constructor(detail = "") {
    super(`wenshu account banned by the site${detail ? ` (${detail})` : ""} — appeal to cpwsw@court.gov.cn; no further crawling until the account works again`);
    this.name = "AccountBannedError";
  }
}
// A listing that stops far short of the site's own count for the same slice. Not
// an empty slice and not a licence to advance the day: the caller keeps the
// documents that were listed and records the shortfall as an error, so the day is
// retried instead of being recorded complete.
export class ShortListingError extends Error {
  constructor(slice, got, total, tokens) {
    super(`listed ${got} of ${total} documents for ${JSON.stringify(slice)}`);
    this.name = "ShortListingError";
    this.got = got;
    this.total = total;
    this.tokens = tokens;
  }
}
const bannedCheck = `new RegExp(${JSON.stringify(BANNED_NOTICE.source)}).test(document.body?.innerText || '')`;
// The site caps one query at roughly 600 results (下一页 is disabled past that;
// verified 2026-09-21 at page 119 of a 1,121-document slice), so a slice over the
// cap must be subdivided. 法院层级 is the axis that needs no extra navigation.
export const COURT_LEVELS = [
  { label: "最高法院", code: "1" },
  { label: "高级法院", code: "2" },
  { label: "中级法院", code: "3" },
  { label: "基层法院", code: "4" },
];
// 文书类型: the second subdivision axis, because one case type at one court level
// still overflows the per-query cap on a busy day (基层民事 was 1,009 documents on
// 2026-09-17, and 下一页 disabled at 600).
export const DOC_TYPES = [
  { label: "判决书", code: "01" },
  { label: "裁定书", code: "02" },
  { label: "调解书", code: "03" },
  { label: "决定书", code: "04" },
];
// 案由 (#ayTreeDiv, a jstree whose whole node table sits in data-val) is the last
// axis: a single (day, case type, court level, document type) can still exceed the
// per-query cap — 基层民事裁定书 was 838 documents on 2026-09-17 — so the slice comes
// apart along the case type's own 案由 branches (民事案由 has ten).
export const REASON_TREE = "#ayTreeDiv";
export const REASON_SPAN = "#s16";
// One query answers at most this many documents, whatever the site's own total says.
export const PAGE_CAP = 600;
// Detail page for a document: the docId is the token the list links carry.
export const docUrl = (docId) => `https://wenshu.court.gov.cn/website/wenshu/181107ANFZ0BXSK4/index.html?docId=${docId}`;
const LIST = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html";
// The DEFAULT list page must be a pageId link, exactly as the site's own nav uses
// them. A bare `?s8=03` is NOT equivalent: the site bounces it to the login page
// (verified live 2026-09-20 — a fresh tab on that URL lands on
// 181010CARHS5BS3C/index.html?<url> and stays logged out), which is why the
// adapter kept reporting "session invalid" while the profile was in fact logged in.
const SEARCH_URL = `${LIST}?pageId=fde099276267316234622fb6d3f9557d&s8=03`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The list is case-type scoped, and the site's own navigation links are the
// authoritative per-type URLs (they carry BOTH pageId and s8 — read off the home
// page nav, 2026-09-20). Driving the panel's dropdown instead is unreliable: its
// displayed value follows the URL while the QUERY state persists in localStorage,
// so the two can disagree (found live: #s8 said 民事/03 while the query sent
// 刑事/02). Navigating to the type's URL sets both consistently.
const CASE_TYPES = [
  { code: "01", label: "管辖案件", url: `${LIST}?pageId=01fbc3906e097f341b8a9fb3a9b601dc&s8=01` },
  { code: "02", label: "刑事案件", url: `${LIST}?pageId=05da5e602f0d93231488884b6c5104e0&s8=02` },
  { code: "03", label: "民事案件", url: `${LIST}?pageId=fde099276267316234622fb6d3f9557d&s8=03` },
  { code: "04", label: "行政案件", url: `${LIST}?pageId=46e5ad07fe0f9c5c2f2df7c96023d9bc&s8=04` },
  { code: "05", label: "赔偿案件", url: `${LIST}?pageId=8010a692c1d831aa6255b77ad2cf72c4&s8=05` },
  { code: "10", label: "执行案件", url: `${LIST}?pageId=ef45bc8189f19f25f5493dab3d3f8288&s8=10` },
];
const resolveCaseType = (input) => {
  if (!input) return null;
  const s = String(input).trim();
  return (
    CASE_TYPES.find((c) => c.label === s) ??
    CASE_TYPES.find((c) => c.label.startsWith(s)) ??
    CASE_TYPES.find((c) => c.label.includes(s)) ??
    null
  );
};

// The site's own LOGIN page (found live 2026-09-20: its title is 登录/注册 and
// the body is a ~17-char shell). A navigation that lands here means the session
// was killed server-side — often after a burst of searches — not a WAF block.
const LOGIN = /181010CARHS5BS3C/;

// ------------------------------------------------------------------ CDP glue
// The local CDP HTTP endpoints drop connections under load (observed live: an
// unretried /json/list fetch killed a whole crawl cycle with "terminated" /
// UND_ERR_SOCKET). Nothing here is worth failing a multi-hour run over.
async function cdpHttp(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`http ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

// Browser-level call (Target.*) — used to open a crawl tab in the BACKGROUND,
// because activating a window steals the operator's focus, and this tool must
// run silently.
async function browserCall(cdpUrl, method, params = {}) {
  const ver = await cdpHttp(`${cdpUrl}/json/version`);
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { bws.onopen = resolve; bws.onerror = reject; });
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`browser cdp timeout ${method}`)), 20000);
      bws.addEventListener("message", (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) { clearTimeout(t); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      });
      bws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    try { bws.close(); } catch {}
  }
}

const wenshuTabPages = async (cdpUrl) =>
  (await cdpHttp(`${cdpUrl}/json/list`)).filter((t) => t.type === "page" && t.url.includes("wenshu.court.gov.cn"));

// Evaluate once on a tab without keeping a connection (tab health checks).
function quickEval(tab, expression, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const w = new WebSocket(tab.webSocketDebuggerUrl);
    const done = (v) => { try { w.close(); } catch {} resolve(v); };
    w.onopen = () => w.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    w.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) done(m.result?.result?.value); };
    w.onerror = () => done(undefined);
    setTimeout(() => done(undefined), timeoutMs);
  });
}

export async function createCdpAdapter({ cdpUrl = "http://localhost:9223", targetId = null, ownTabOnly = false } = {}) {
  // Pick a tab that is actually rendering the list. A long-lived wenshu tab can
  // end up wedged — after the site force-logs-out and the SSO returns, its SPA
  // stops painting the result list entirely (observed 2026-09-20: the query went
  // out with the right conditions and the DOM kept the previous rows), while a
  // fresh tab renders normally. Never activate a window here: the operator's
  // focus must not move.
  const createTab = async (url) => {
    const { targetId } = await browserCall(cdpUrl, "Target.createTarget", { url, background: true });
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const tab = (await wenshuTabPages(cdpUrl)).find((t) => t.id === targetId);
      if (tab?.webSocketDebuggerUrl) return tab;
    }
    throw new Error("cdp-adapter: could not create a crawl tab in the standing Chrome");
  };

  let ownedTab = false;
  let target = null;
  if (targetId) {
    // A dedicated tab per worker: several crawl processes must never share one
    // tab, or they would fight over its navigation.
    target = (await wenshuTabPages(cdpUrl)).find((t) => t.id === targetId) ?? null;
    if (!target) {
      target = await createTab(SEARCH_URL);
      ownedTab = true;
    }
  }
  for (const tab of target || ownTabOnly ? [] : await wenshuTabPages(cdpUrl)) {
    if (LOGIN.test(tab.url)) continue;
    if (!/181217BMTKHNT2W0/.test(tab.url)) continue;
    const rows = await quickEval(tab, `document.querySelectorAll('.LM_list').length`);
    if (Number(rows) > 0) { target = tab; break; }
  }
  if (!target) {
    target = await createTab(SEARCH_URL);
    ownedTab = true;
  }

  let ws = null;
  let seq = 0;
  const pending = new Map();
  const attach = async (tab) => {
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
  };
  await attach(target);

  // Replace a wedged tab with a fresh background one (only ever closes the tab
  // this adapter opened itself).
  const resetTab = async () => {
    try { if (ownedTab) await browserCall(cdpUrl, "Target.closeTarget", { targetId: target.id }); } catch {}
    target = await createTab(SEARCH_URL);
    ownedTab = true;
    await attach(target);
  };
  const call = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); if (m.error) reject(new Error(`cdp error ${method}: ${m.error.message}`)); else resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, timeoutMs = 30000) => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(`page js error: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description?.slice(0, 200) ?? ""}`);
    return r.result.value;
  };

  const rowMeta = new Map(); // token -> {标题, 法院, 案号, 判决时间, 案件类型}

  const isBanned = () => evaluate(bannedCheck, 8000);

  async function navigate(url) {
    await call("Page.navigate", { url });
    // wall chain + SPA settle: poll until URL leaves the wall and body stabilizes.
    // A detour through the site's own login page is reported as such — polling it
    // for a body that will never come wastes the caller's patience.
    for (let i = 0; i < 16; i++) {
      await sleep(2500);
      const info = await evaluate(`JSON.stringify({u: location.href, len: (document.body?.textContent||'').length})`, 10000).catch(() => null);
      if (!info) continue;
      const { u, len } = JSON.parse(info);
      if (LOGIN.test(u)) return "login";
      if (WALL.test(u)) continue;
      if (len > 800) { await sleep(4000); return true; }
    }
    return false;
  }

  // ------------------------------------------------------------------ page hooks
  // The page's own XHRs are the only trustworthy source for a slice's TOTAL:
  // the pager is a windowed control (it never shows the last page), while the
  // facet request (groupFields …@leftDataItem) returns per-group counts for the
  // CURRENT query — s4 (法院层级) partitions every document, so its counts sum to
  // the slice total. The hook must never throw into the page.
  const HOOK = `(() => {
    if (window.__wd) return true;
    window.__wd = { facets: null, facetBody: null, facetSeq: 0, lists: 0, cprq: 0 };
    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__b = null; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      const self = this;
      if (typeof b === 'string') self.__b = b;
      self.addEventListener('load', () => {
        try {
          const u = self.__u || '';
          const body = self.__b || '';
          if (/api\\/fp\\/cprq/.test(u)) {
            // the page validates each 裁判日期 as it is entered; the value is only
            // part of the query once this round-trip has come back
            window.__wd.cprq += 1;
          } else if (/rest\\.q4w/.test(u) && body.indexOf('groupFields') >= 0) {
            const j = JSON.parse(self.responseText || '{}');
            const g = j.result || {};
            const sum = (arr) => Array.isArray(arr) ? arr.reduce((s, x) => s + (Number(x && x.count) || 0), 0) : null;
            window.__wd.facets = { s4: sum(g.s4), s42: sum(g.s42), s33: sum(g.s33), groups: Object.keys(g) };
            window.__wd.facetBody = body;
            window.__wd.facetSeq += 1;
          } else if (/rest\\.q4w/.test(u) && body.indexOf('pageNum') >= 0) {
            window.__wd.lists += 1;
          }
        } catch (e) { /* a hook must never break the page */ }
      });
      return XS.apply(this, arguments);
    };
    return true;
  })()`;

  const hookCounters = () =>
    evaluate(`(() => { const w = window.__wd || {}; return JSON.stringify({ cprq: w.cprq || 0, lists: w.lists || 0, seq: w.facetSeq || 0 }); })()`, 10000)
      .then((s) => JSON.parse(s))
      .catch(() => ({ cprq: 0, lists: 0, seq: 0 }));

  async function waitForCounter(kind, before, timeoutMs = 9000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(400);
      const c = await hookCounters();
      if ((c[kind] ?? 0) > before) return true;
    }
    return false;
  }

  const HARVEST_ROWS = `(() => {
    const rows = [...document.querySelectorAll('.LM_list')];
    const out = [];
    for (const r of rows) {
      const a = r.querySelector('a.caseName');
      if (!a) continue;
      const href = a.getAttribute('href') || '';
      const token = (href.match(/docId=([^&]+)/) || [])[1] || (r.querySelector('.ListSelect')?.getAttribute('data-value')) || null;
      if (!token) continue;
      out.push({
        token,
        标题: (a.textContent || '').trim() || null,
        法院: (r.querySelector('.slfyName')?.textContent || '').trim() || null,
        案号: (r.querySelector('.ah')?.textContent || '').trim() || null,
        cprq: (r.querySelector('.cprq')?.textContent || '').trim() || null,
        category: (r.querySelector('.List_label .labelTwo')?.textContent || '').trim() || null,
      });
    }
    return JSON.stringify(out);
  })()`;

  const CLICK_NEXT = `(() => {
    const next = [...document.querySelectorAll('.pageButton')].find(e => (e.textContent||'').includes('下一页'));
    if (!next || next.className.includes('disabled')) return false;
    next.click(); return true;
  })()`;

  const DETAIL_EXTRACT = `(() => {
    const grab = (re) => {
      for (const el of document.querySelectorAll('li,dd,dt,span,div')) {
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        if (re.test(own)) return (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      }
      return null;
    };
    const cut = document.querySelector('.PDF_cut');
    const cutText = cut ? cut.textContent.replace(/\\s+/g, ' ') : '';
    const pub = cutText.match(/发布日期\\s*(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2})/);
    const norm = (s) => { const m = (s||'').match(/(\\d{4})[-/.年](\\d{1,2})[-/.月](\\d{1,2})/); return m ? m[1]+'-'+String(m[2]).padStart(2,'0')+'-'+String(m[3]).padStart(2,'0') : null; };
    const body = document.querySelector('.PDF_pox');
    return JSON.stringify({
      案号: (document.querySelector('#ahdiv')?.textContent || '').trim() || null,
      标题: (document.querySelector('.PDF_title')?.textContent || '').replace(/\\s+/g, ' ').trim() || null,
      发布时间: pub ? norm(pub[1]) : null,
      案由: grab(/^案\\s*由/) ? grab(/^案\\s*由/).replace(/^案\\s*由\\s*/, '') : null,
      qwContent: body ? body.innerHTML : null,
      url: location.href.slice(0, 150),
    });
  })()`;

  // -------------------------------------------------------------------- slicing
  const onSearchPage = async () => {
    const href = await evaluate(`location.href`, 10000).catch(() => "");
    return /181217BMTKHNT2W0/.test(href);
  };

  // Put the page on the case type's own list URL. Cheap when already there; the
  // caller verifies the query it produces (waitForSlice checks the s8 code in the
  // page's next facet request), so no DOM indicator is trusted here.
  async function setCaseType(label) {
    const want = resolveCaseType(label);
    if (!want) throw new Error(`cdp-adapter: unknown case type "${label}"`);
    const href = (await evaluate(`location.href`, 10000).catch(() => "")) ?? "";
    if (href.includes(`s8=${want.code}`)) return { code: want.code, navigated: false };
    const ok = await navigate(want.url);
    if (ok !== true) throw new Error(`cdp-adapter: case type page for ${want.label} did not settle (${ok})`);
    return { code: want.code, navigated: true };
  }


  // 法院层级 is a plain dropdown (#gjjs_fycj, li[data-val]) whose selection folds
  // into the next 检索. Applied per slice; the panel must already be open.
  async function setCourtLevel(labelOrCode) {
    const want = COURT_LEVELS.find((l) => l.code === String(labelOrCode) || l.label === labelOrCode);
    if (!want) throw new Error(`cdp-adapter: unknown court level "${labelOrCode}"`);
    const applied = await evaluate(
      `(() => {
        const span = document.querySelector('#s4');
        if (!span) return 'missing';
        if (String(span.getAttribute('data-val') || '') === ${JSON.stringify(want.code)}) return 'already';
        const li = [...document.querySelectorAll('#gjjs_fycj li')].find((e) => e.getAttribute('data-val') === ${JSON.stringify(want.code)});
        if (!li) return 'no-option';
        span.click();          // open the dropdown (jQuery-bound)
        li.click();
        return String(span.getAttribute('data-val') || '') === ${JSON.stringify(want.code)} ? 'set' : 'clicked';
      })()`,
      10000,
    ).catch(() => "error");
    if (applied === "missing" || applied === "no-option" || applied === "error") throw new Error(`cdp-adapter: court level ${want.label} not applicable (${applied})`);
    return { code: want.code, label: want.label, applied };
  }

  // The 案由 tree's node table is embedded in the DOM, so the options are readable
  // without the UI: the axis for a case type is the second level under its branch.
  const reasonNodes = async () => {
    const raw = await evaluate(`document.querySelector(${JSON.stringify(REASON_TREE)})?.getAttribute('data-val') || ''`, 10000).catch(() => "");
    try {
      const data = JSON.parse(raw);
      return Object.values(data).flat();
    } catch { return []; }
  };

  async function setReason(codeOrLabel) {
    const nodes = await reasonNodes();
    const want = nodes.find((n) => String(n.id) === String(codeOrLabel) || n.text === codeOrLabel);
    if (!want) throw new Error(`cdp-adapter: unknown 案由 "${codeOrLabel}"`);
    const parent = nodes.find((n) => String(n.id) === String(want.parent));
    // jstree: the toggle (<i class="jstree-ocl">) expands a branch, its anchor
    // SELECTS the node. Clicking the anchor to "open" the node (the first attempt)
    // selected the parent instead, so every 案由 branch searched the same unfiltered
    // set — each branch reported the parent's own total.
    const opened = await evaluate(
      `(() => {
        const span = document.querySelector(${JSON.stringify(REASON_SPAN)});
        if (!span) return 'missing';
        span.click();
        return 'opened';
      })()`,
      10000,
    ).catch(() => "error");
    if (opened === "missing" || opened === "error") throw new Error(`cdp-adapter: 案由 tree not reachable (${opened})`);
    await sleep(1000);
    if (parent) {
      await evaluate(
        `(() => {
          const anchors = [...document.querySelectorAll(${JSON.stringify(REASON_TREE)} + ' a.jstree-anchor')];
          const top = anchors.find((a) => (a.textContent || '').trim() === ${JSON.stringify(parent.text)});
          if (!top) return 'no-parent';
          const li = top.closest('li');
          const ocl = li ? li.querySelector('i.jstree-ocl') : null;
          if (ocl && top.getAttribute('aria-expanded') !== 'true') ocl.click();
          return 'expanded';
        })()`,
        10000,
      ).catch(() => "error");
      await sleep(1000);
    }
    // Preferred path: jstree's own API. The tree renders only part of its nodes, so
    // an anchor for the branch we want may not exist in the DOM at all (observed:
    // 合同纠纷 missing while 人格权纠纷 present).
    const viaApi = await evaluate(
      `(() => {
        try {
          const jq = window.jQuery || window.$;
          if (!jq || !jq.fn || !jq.fn.jstree) return 'no-jquery';
          const inst = jq(${JSON.stringify(REASON_TREE)}).jstree(true);
          if (!inst) return 'no-instance';
          ${parent ? `try { inst.open_node(${JSON.stringify(parent.id)}); } catch (e) {}` : ""}
          inst.select_node(${JSON.stringify(String(want.id))});
          const span = document.querySelector(${JSON.stringify(REASON_SPAN)});
          return String(span?.getAttribute('data-val') || '');
        } catch (e) { return 'api-error:' + String(e).slice(0, 60); }
      })()`,
      10000,
    ).catch(() => "error");
    if (String(viaApi) === String(want.id)) return { code: String(want.id), label: want.text, applied: "api" };
    const applied = await evaluate(
      `(() => {
        const norm = (s) => (s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
        const want = norm(${JSON.stringify(want.text)});
        const span = document.querySelector(${JSON.stringify(REASON_SPAN)});
        const anchors = [...document.querySelectorAll(${JSON.stringify(REASON_TREE)} + ' a.jstree-anchor')];
        // the tree's labels carry punctuation the DOM may render differently
        const anchor = anchors.find((a) => norm(a.textContent) === want)
          ?? anchors.find((a) => norm(a.textContent).startsWith(want.slice(0, 6)));
        if (!anchor) return 'no-anchor:' + anchors.length;
        anchor.click();
        return String(span?.getAttribute('data-val') || '');
      })()`,
      10000,
    ).catch(() => "error");
    if (applied === "error" || String(applied).startsWith("no-anchor")) throw new Error(`cdp-adapter: 案由 ${want.text} not selectable (api=${viaApi}, click=${applied})`);
    // The filter is only real when the tree recorded the selection; an unselected
    // branch silently searches the parent set and every branch looks identical.
    if (String(applied) !== String(want.id)) throw new Error(`cdp-adapter: 案由 ${want.text} (${want.id}) did not take effect (span shows "${applied}")`);
    return { code: String(want.id), label: want.text, applied };
  }

  // 文书类型 (#s6) is a static dropdown like 法院层级; applied per slice.
  async function setDocType(labelOrCode) {
    const want = DOC_TYPES.find((l) => l.code === String(labelOrCode) || l.label === labelOrCode);
    if (!want) throw new Error(`cdp-adapter: unknown document type "${labelOrCode}"`);
    const applied = await evaluate(
      `(() => {
        const span = document.querySelector('#s6');
        if (!span) return 'missing';
        if (String(span.getAttribute('data-val') || '') === ${JSON.stringify(want.code)}) return 'already';
        const li = [...document.querySelectorAll('ul.list-box li')].find((e) => e.getAttribute('data-val') === ${JSON.stringify(want.code)} && /判决书|裁定书|调解书|决定书/.test(e.textContent || ''));
        if (!li) return 'no-option';
        span.click();
        li.click();
        return String(span.getAttribute('data-val') || '') === ${JSON.stringify(want.code)} ? 'set' : 'clicked';
      })()`,
      10000,
    ).catch(() => "error");
    if (applied === "missing" || applied === "no-option" || applied === "error") throw new Error(`cdp-adapter: 文书类型 ${want.label} not applicable (${applied})`);
    return { code: want.code, label: want.label, applied };
  }

  // div.advenced-search is a TOGGLE: click it only while the panel is closed.
  const openPanel = () =>
    evaluate(
      `(() => {
        const w = document.querySelector('div.advencedWrapper');
        if (!w) return 'missing';
        if (getComputedStyle(w).display !== 'none') return 'open';
        document.querySelector('div.advenced-search')?.click();
        return getComputedStyle(w).display !== 'none' ? 'opened' : 'failed';
      })()`,
      10000,
    ).catch(() => "error");

  const setDateRange = (start, end) =>
    evaluate(
      `(() => {
        const setVal = (sel, value) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
          el.focus();
          if (setter) setter.call(el, value); else el.value = value;
          for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
          return el.value;
        };
        return JSON.stringify({ start: setVal('#cprqStart', ${JSON.stringify(start ?? "")}), end: setVal('#cprqEnd', ${JSON.stringify(end ?? "")}) });
      })()`,
      15000,
    );

  const clickSearch = () =>
    evaluate(
      `(() => {
        const btn = [...document.querySelectorAll('.searchbtn a')].find((a) => (a.textContent || '').trim() === '检索');
        if (!btn) return false;
        btn.click();
        return true;
      })()`,
      10000,
    ).catch(() => false);

  const queryMarker = (start, end) => (start && end ? `${start} TO ${end}` : start ?? "");

  // A slice is applied when the rendered rows all fall inside the window — the DOM
  // is what the harvest reads, so it is the ground truth. The page's own facet
  // request is corroborating evidence only: the site navigates itself after the
  // first load of a list page, which discards the hook and its counter, and then
  // demanding "a facet capture newer than the hook" rejects a slice that plainly
  // worked (observed live). So the facet body vetoes for 12 s and then yields.
  async function waitForSlice(start, end, typeCode, facetSeqBefore, timeoutMs = 30000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1200);
      const state = JSON.parse(
        await evaluate(
          `(() => {
            const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
            const rs = [...document.querySelectorAll('.LM_list')];
            return JSON.stringify({
              seq: window.__wd ? window.__wd.facetSeq : 0,
              body: window.__wd ? window.__wd.facetBody : null,
              n: rs.length,
              dates: rs.map((r) => t(r.querySelector('.cprq'))),
            });
          })()`,
          15000,
        ).catch(() => "{}"),
      );
      last = state;
      // the facet body is form-encoded (`%22value%22%3A%2204%22`), so decode it
      // before looking for the condition literals
      const bodyRaw = String(state.body ?? "");
      let body = "";
      try { body = bodyRaw ? decodeURIComponent(bodyRaw) : ""; } catch { body = bodyRaw; }
      const marker = queryMarker(start, end).split(" ")[0]; // the start day identifies the query
      const bodyOk = !body || ((!start || body.includes(marker)) && (!typeCode || body.includes(`"value":"${typeCode}"`)));
      const dated = (state.dates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      const datesInRange = start && end ? dated.length > 0 && dated.every((d) => d >= start && d <= end) : dated.length > 0;
      const seqAdvanced = (state.seq ?? 0) > facetSeqBefore;
      const settled = seqAdvanced || Date.now() - t0 > 12000;
      if ((datesInRange || state.n === 0) && bodyOk && settled) {
        // Zero rows is a legitimate answer (an empty day) — unless the page is
        // the site's ban notice or its "noauth" refusal, which also render no
        // rows. Accepting those as an empty day would silently skip the day and
        // advance the cursor past data that exists; both must fail loud instead.
        if (state.n === 0) {
          if (await isBanned().catch(() => false)) throw new AccountBannedError(`empty list page for ${start ?? "?"}..${end ?? "?"}`);
          const title = String(await evaluate("document.title", 5000).catch(() => "")).trim();
          if (/^noauth$/i.test(title)) {
            const err = new Error(`list refused (${title}) for ${start ?? "?"}..${end ?? "?"} — session not accepted by the search API`);
            err.name = "SessionError";
            err.code = "NOAUTH";
            throw err;
          }
        }
        return { ok: true, rows: state.n, dates: dated.slice(0, 3) };
      }
    }
    return { ok: false, last };
  }

  /**
   * Drive the search form onto one slice. Throws when the slice will not apply:
   * crawling the unfiltered list would look like success while quietly widening
   * the window, which is exactly the failure the caller cannot detect later.
   */
  async function applySlice(slice = {}) {
    let attempt = 0;
    let lastWhy = null;
    while (attempt < 2) {
      attempt += 1;
      if (!(await onSearchPage())) {
        const ok = await navigate(SEARCH_URL);
        if (!ok) throw new Error("cdp-adapter: search page did not settle");
      }
      // Case type FIRST: choosing one navigates (its own list URL), which would
      // discard the hook and any dates set before it. The hook goes in after.
      const type = slice.caseType ? await setCaseType(slice.caseType) : null;
      await evaluate(HOOK, 10000);
      // The page size is deliberately left at the site's default (5). Raising it
      // through select.pageSizeSelect fires a re-query under the pre-date
      // conditions, and from that moment the tab's list stops repainting for good
      // (bisected live 2026-09-20: identical flows with and without the size
      // change render vs. wedge). More pages per slice is the price; correctness
      // is not negotiable.
      const before = await hookCounters();
      const panel = await openPanel();
      const level = slice.courtLevel ? await setCourtLevel(slice.courtLevel) : null;
      const docType = slice.docType ? await setDocType(slice.docType) : null;
      const reason = slice.reason ? await setReason(slice.reason) : null;
      const dates = JSON.parse(await setDateRange(slice.dateStart, slice.dateEnd));
      // The page validates each 裁判日期 against /api/fp/cprq as it is entered and
      // only then folds it into the query; firing 检索 before that round-trip comes
      // back searches WITHOUT the date condition (found live 2026-09-20: the run
      // reported panel=opened, the inputs held the dates, and the rows came back
      // unfiltered). Wait for the validation, then re-assert the inputs in case a
      // late re-render cleared them.
      const validated = slice.dateStart ? await waitForCounter("cprq", before.cprq, 9000) : true;
      const held = await evaluate(`(() => { const a = document.querySelector('#cprqStart'); const b = document.querySelector('#cprqEnd'); return JSON.stringify({ start: a ? a.value : null, end: b ? b.value : null }); })()`, 10000)
        .then((s) => JSON.parse(s))
        .catch(() => ({ start: null, end: null }));
      const reassert = slice.dateStart && held.start !== slice.dateStart;
      if (reassert) {
        await setDateRange(slice.dateStart, slice.dateEnd);
        await waitForCounter("cprq", (await hookCounters()).cprq, 9000);
      }
      await sleep(600);
      const clicked = await clickSearch();
      if (!clicked) throw new Error("cdp-adapter: 检索 button not found (search page drift)");
      const res = await waitForSlice(slice.dateStart, slice.dateEnd, type?.code, before.seq);
      if (res.ok) return { panel, dates, level: level?.code ?? null, docType: docType?.code ?? null, reason: reason?.code ?? null, rows: res.rows, validated, reassert, type: type?.code };
      lastWhy = `panel=${panel} type=${type?.code ?? "-"} validated=${validated} reassert=${reassert} set=${JSON.stringify(dates)} held=${JSON.stringify(held)} last=${JSON.stringify(res.last?.dates?.slice(0, 3))} body=${String(res.last?.body ?? "").slice(0, 220)}`;
      // A wedged tab never paints a new result set — retry on a fresh background
      // tab instead of merely reloading the stuck one.
      await resetTab();
    }
    throw new Error(`cdp-adapter: slice ${JSON.stringify(slice)} did not take effect after ${attempt} attempts (${lastWhy})`);
  }

  const facetsTotal = () =>
    evaluate(`(() => { const f = window.__wd && window.__wd.facets; if (!f) return null; return JSON.stringify(f); })()`, 10000)
      .then((s) => (s ? JSON.parse(s) : null))
      .catch(() => null);

  const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));

  return {
    // getter: a wedged tab is replaced mid-run, so the exposed socket must track
    // the current one (the CLI closes it on exit)
    get ws() { return ws; },
    async probeSession() {
      const ok = await navigate(SEARCH_URL);
      if (ok === "login") return { valid: false, reason: "logged-out" };
      if (!ok) return { valid: false, reason: "navigate-failed" };
      if (await evaluate(bannedCheck, 8000).catch(() => false)) return { valid: false, reason: "account-banned" };
      const loggedIn = await evaluate(`[...document.querySelectorAll('a,span')].some(e => /退出/.test(e.textContent || ''))`, 10000);
      return loggedIn ? { valid: true } : { valid: false, reason: "not-logged-in" };
    },
    async searchTotal(slice = {}) {
      // The page can only ever express ONE case type (its list is type-scoped and
      // there is no "all types" option), so the widest probe is reported as
      // OVERFLOW: that is exactly what it is, and it makes the slicer subdivide
      // into the per-type leaves this adapter can apply.
      if (!slice.caseType) return "OVERFLOW";
      const applied = await applySlice(slice);
      if (process.env.WENSHU_DEBUG_PAGES) console.error(`[total] applied=${JSON.stringify(applied)}`);
      const f = await facetsTotal();
      if (f && Number.isFinite(f.s4)) return f.s4; // 法院层级 partitions every doc
      if (f && Number.isFinite(f.s42)) return f.s42; // 裁判年份 (single-day slices: one year)
      // Facets missing: the pager is a WINDOWED control (it never renders the
      // last page), so this is a lower bound — log it, the slicer only needs
      // "over the cap or not".
      const proxy = JSON.parse(
        await evaluate(
          `(() => {
            const nums = [...document.querySelectorAll('.pageButton')].map(e => Number((e.textContent||'').trim())).filter(Number.isInteger);
            const max = nums.reduce((m, n) => n > m ? n : m, 0);
            const size = Number((document.querySelector('.pageSizeSelect')?.value || '').trim()) || 15;
            return JSON.stringify({ max, size, items: document.querySelectorAll('.LM_list').length });
          })()`,
          15000,
        ),
      );
      if (proxy.items === 0 && proxy.max === 0) return 0;
      console.error(`[cdp-adapter] facets unavailable for ${JSON.stringify(slice)} — pager proxy ${proxy.max}×${proxy.size}`);
      return proxy.max * proxy.size;
    },
    // Metadata-only harvesting: the list rows already carry 标题/法院/案号/裁判日期/
    // 案件类型 and the document's token, so a crawl that does not need the full
    // text skips the detail page entirely — one request per five documents instead
    // of one per document, which is both ~25x lighter on the site and the only
    // shape of traffic this account can sustain (see design.md, ban risk).
    async listRows(slice = {}, { maxPages = 20 } = {}) {
      const { rows } = await harvestListing(slice, { maxPages });
      return rows;
    },
    async listDocIds(slice = {}, { maxPages = 20 } = {}) {
      const { tokens } = await harvestListing(slice, { maxPages });
      return tokens;
    },
    // 案由 branches for one case type (e.g. 民事 → 合同纠纷, 侵权责任纠纷, …).
    async reasonOptions(caseTypeLabel = "") {
      const nodes = await reasonNodes();
      const top = nodes.find((n) => n.parent === "#" && String(n.text).includes(caseTypeLabel));
      if (!top) return [];
      return nodes.filter((n) => String(n.parent) === String(top.id)).map((n) => ({ code: String(n.id), label: n.text }));
    },
    async _harvestListing(slice = {}, opts = {}) {
      return await harvestListing(slice, opts);
    },
  

    async fetchDetail(docId) {
      const detailUrl = `https://wenshu.court.gov.cn/website/wenshu/181107ANFZ0BXSK4/index.html?docId=${docId}`;
      await call("Page.navigate", { url: detailUrl });
      // Poll for the rendered body instead of the old fixed 2.5s + 4s waits: the
      // content arrives with the page's own XHR, and a stable length means it is
      // fully in. The wall interstitial is not an error — keep polling through it.
      let ready = false;
      let lastLen = -1;
      let stable = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        await sleep(400);
        const st = await evaluate(
          `(() => {
            const b = document.querySelector('.PDF_pox');
            return JSON.stringify({ u: location.href, len: b ? (b.innerHTML || '').length : 0, title: !!document.querySelector('.PDF_title') });
          })()`,
          10000,
        ).catch(() => null);
        if (!st) continue;
        const s = JSON.parse(st);
        if (WALL.test(s.u)) continue;
        if (s.len > 200) {
          if (s.len === lastLen) {
            stable += 1;
            if (stable >= 2) { ready = true; break; } // two consecutive polls, same length
          } else {
            stable = 0;
          }
          lastLen = s.len;
        }
      }
      if (!ready) throw new Error(`cdp-adapter: detail did not settle for ${docId.slice(0, 24)}…`);
      const d = JSON.parse(await evaluate(DETAIL_EXTRACT, 20000));
      const meta = rowMeta.get(docId) ?? {};
      const out = { ...d };
      for (const k of ["标题", "法院", "案号", "判决时间", "案件类型"]) if (!out[k] && meta[k]) out[k] = meta[k];
      const ymd = (v) => { const m = String(v || "").match(/(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})/); return m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : null; };
      out.判决时间 = ymd(out.判决时间);
      out.发布时间 = ymd(out.发布时间);
      out.判决年份 = out.判决时间 && isYmd(out.判决时间) ? Number(out.判决时间.slice(0, 4)) : null;
      out.nativeDocId = null; // no 32-hex native id in the live UI (verified)
      out.受理时间 = out.受理时间 ?? null;
      out.判决结果 = out.判决结果 ?? null;
      return out;
    },
  };

  async function harvestListing(slice = {}, { maxPages = 20 } = {}) {
    const applied = await applySlice(slice);
    const tokens = [];
    const seen = new Set();
    const harvest = async () => {
      const rows = JSON.parse(await evaluate(HARVEST_ROWS, 20000).catch(() => "[]"));
      for (const r of rows) {
        if (!seen.has(r.token)) {
          seen.add(r.token);
          tokens.push(r.token);
          rowMeta.set(r.token, { 标题: r.标题, 法院: r.法院, 案号: r.案号, 判决时间: r.cprq, 案件类型: r.category });
        }
      }
      return rows.length;
    };
    // Catalogue rows for everything the listing harvested: what a metadata-only
    // crawl needs, with the detail URL in place of the body.
    const finish = (total) => ({
      tokens,
      rows: tokens.map((t) => {
        const meta = rowMeta.get(t) ?? {};
        return {
          docId: t,
          标题: meta.标题 ?? null,
          法院: meta.法院 ?? null,
          案号: meta.案号 ?? null,
          判决时间: meta.判决时间 ?? null,
          案件类型: meta.案件类型 ?? null,
          url: docUrl(t),
        };
      }),
      total,
    });
    const firstRowHref = () =>
      evaluate(`(() => { const a = document.querySelector('.LM_list a.caseName'); return a ? a.getAttribute('href') : null; })()`, 10000).catch(() => null);
    const pageOne = await harvest();
    if (process.env.WENSHU_DEBUG_PAGES) console.error(`[pages] page 1 rows=${pageOne} tokens=${tokens.length}`);
    let page = 1;
    let exhausted = false;
    while (page < maxPages) {
      const before = await firstRowHref();
      // The pager element is replaced on every re-render, so a click can land on a
      // detached node and silently do nothing. Re-query and re-click instead of
      // deciding the list is over.
      let advanced = false;
      for (let attempt = 0; attempt < 3 && !advanced; attempt++) {
        const more = await evaluate(CLICK_NEXT, 10000).catch(() => false);
        if (process.env.WENSHU_DEBUG_PAGES) console.error(`[pages] page=${page} attempt=${attempt} more=${more}`);
        if (!more) {
          // "No next page" is also what a control mid-re-render looks like, and the
          // site disables it outright at its per-query cap (observed 2026-09-21:
          // 下一页 disabled at page 119 of a 1,121-document slice). Confirm twice,
          // then fall through to the facet-count check so the caller can tell a
          // finished list from a capped one.
          await sleep(2500);
          const stillDone = !(await evaluate(CLICK_NEXT, 10000).catch(() => false));
          if (process.env.WENSHU_DEBUG_PAGES) console.error(`[pages] page=${page} end-confirm=${stillDone}`);
          if (stillDone) { exhausted = true; break; }
          continue;
        }
        const pagePace = Number(process.env.WENSHU_PAGE_MS || 0);
        if (pagePace) await sleep(pagePace);
        for (let i = 0; i < 20; i++) {
          await sleep(700);
          const now = await firstRowHref();
          if (now && now !== before) { advanced = true; break; }
        }
        if (!advanced) await sleep(1200);
      }
      if (!advanced || exhausted) break;
      page += 1;
      const got = await harvest();
      if (process.env.WENSHU_DEBUG_PAGES) console.error(`[pages] page ${page} rows=${got} tokens=${tokens.length}`);
    }
    const f = await facetsTotal();
    const total = f && Number.isFinite(f.s4) ? f.s4 : null;
    if (total !== null && tokens.length < total) {
      console.error(`[cdp-adapter] slice ${JSON.stringify(slice)}: harvested ${tokens.length} of ${total} (window ${slice.dateStart ?? "?"}..${slice.dateEnd ?? "?"}, ${applied.rows} rows on page 1)`);
      // 2% (at least two documents) of slack absorbs a rounding difference between
      // the facet count and the listed rows; beyond that the listing was truncated
      // and must not be mistaken for a complete day.
      const slack = Math.max(2, Math.ceil(total * 0.02));
      if (tokens.length < total - slack) {
        // Carry the rows as well: a capped listing still has usable catalogue data.
        const err = new ShortListingError(slice, tokens.length, total, tokens);
        err.rows = finish(total).rows;
        // The site's per-query cap (下一页 disabled past ~600) is a property of the
        // query, not a transient failure: retrying the same slice re-lists the same
        // 600 documents. Mark it so the caller records the shortfall and moves on.
        err.capped = tokens.length >= PAGE_CAP - 5;
        throw err;
      }
    }
    return finish(total);
  }


}
