#!/usr/bin/env node
// Recon 5: the decisive one. Recon 4 showed div.advenced-search opens the advanced
// panel (display none -> block). This drives the panel like a user — set the
// 裁判日期 range, click div.search-rightBtn.search-click — and captures the FULL
// rest.q4w list payload, then clicks a left-facet option to learn how 省份/案件类型
// enter the query. That payload is the contract the CDP adapter has to produce.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon5.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tabs = await (await fetch(`${CDP}/json/list`)).json();
const tab = tabs.find((t) => t.url.includes("wenshu.court.gov.cn") && t.type === "page");
if (!tab) throw new Error("no wenshu tab");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const posts = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent" && /rest\.q4w|api\/fp/.test(m.params.request.url)) {
    posts.push({ url: m.params.request.url.replace("https://wenshu.court.gov.cn", ""), method: m.params.request.method, postData: m.params.request.postData ?? "" });
  }
});
const call = (method, params = {}, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression, timeoutMs = 30000) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error(`page js: ${r.exceptionDetails.text}`);
  return r.result.value;
};
const rows = () => evaluate(`(() => {
  const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const rs = [...document.querySelectorAll('.LM_list')];
  return JSON.stringify({ n: rs.length, dates: rs.slice(0, 6).map((r) => t(r.querySelector('.cprq'))), pager: [...document.querySelectorAll('.pageButton')].map(t).slice(0, 6) });
})()`);

await call("Network.enable", {});
await call("Page.navigate", { url: SEARCH });
await sleep(10000);

const report = {};

// ---- all advanced-panel fields (the panel is closed at load) ----
report.openPanel = await evaluate(`(() => { const el = document.querySelector('div.advenced-search'); if (el) el.click(); return getComputedStyle(document.querySelector('div.advencedWrapper')).display; })()`);
await sleep(2000);
report.panelFields = JSON.parse(
  await evaluate(`(() => {
    const w = document.querySelector('div.advencedWrapper');
    const mk = (el) => ({ tag: el.tagName, id: el.id || null, cls: (el.className || '').toString().slice(0, 40), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24), visible: el.offsetParent !== null });
    return JSON.stringify({ display: getComputedStyle(w).display, all: [...w.querySelectorAll('input,span[id],div[id]')].slice(0, 60).map(mk) });
  })()`),
);

// ---- left facet panel ----
report.leftPanel = JSON.parse(
  await evaluate(`(() => {
    const mk = (el) => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 50), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30), href: el.getAttribute('href'), data: el.getAttribute('data-value'), onclick: el.getAttribute('onclick') });
    const cands = [...document.querySelectorAll('div,ul')].filter((el) => /leftDataItem|left-con|leftMenu|condition|facet|search-left|fl.*left/i.test((el.className || '').toString()) && el.querySelectorAll('a').length > 2);
    const pick = cands.slice(0, 3);
    return JSON.stringify(pick.map((el) => ({
      cls: (el.className || '').toString().slice(0, 60),
      groups: [...el.querySelectorAll('h3,h4,.titles,.itemTitle,.groupTitle,dt,strong')].slice(0, 14).map((g) => (g.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20)),
      options: [...el.querySelectorAll('a')].slice(0, 24).map(mk),
    })));
  })()`),
);

// ---- date range -> search, capture payload ----
const before = posts.length;
report.setDates = JSON.parse(
  await evaluate(`(() => {
    const setVal = (sel, value) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      el.focus();
      if (setter) setter.call(el, value); else el.value = value;
      for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
      return el.value;
    };
    return JSON.stringify({ start: setVal('#cprqStart', '2026-09-19'), end: setVal('#cprqEnd', '2026-09-19') });
  })()`),
);
await sleep(3000);
report.clickedSearch = await evaluate(`(() => { const b = document.querySelector('div.search-rightBtn.search-click'); if (!b) return false; b.click(); return true; })()`);
await sleep(14000);
report.afterSearch = JSON.parse(await rows());
posts.length = before;
report.searchPosts = posts.slice(-3);
report.searchPosts.forEach((p) => { p.len = p.postData.length; p.postData = p.postData.slice(0, 3000); });
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  openPanel: report.openPanel,
  panelFields: report.panelFields.all.filter((f) => f.id).slice(0, 30),
  leftGroups: (report.leftPanel[0]?.groups ?? []).slice(0, 12),
  leftOptions: (report.leftPanel[0]?.options ?? []).slice(0, 8),
  setDates: report.setDates,
  clickedSearch: report.clickedSearch,
  afterSearch: report.afterSearch,
  searchPosts: report.searchPosts.map((p) => `${p.method} ${p.url} (${p.len} chars)`),
  out: OUT,
}, null, 1));
ws.close();
