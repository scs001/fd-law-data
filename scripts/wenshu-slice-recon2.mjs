#!/usr/bin/env node
// Recon 2: the corrected slice-filter flow. Recon 1 (wenshu-slice-recon.mjs) found
// the search button really is `div.search-rightBtn.search-click` (recon 1 clicked
// the wrapper) and the 裁判日期 inputs live in a collapsed panel. This one
// expands the panel, sets the dates, clicks the real button, and captures the
// FULL rest.q4w payload so the CDP adapter can apply a slice the way the page
// does (the page owns the ciphertext encryption — we never reproduce it).
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon2.json";
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

const ROWS = `(() => {
  const txt = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const rows = [...document.querySelectorAll('.LM_list')];
  const vis = (el) => !!el && el.offsetParent !== null;
  return JSON.stringify({
    url: location.href,
    visibleStart: vis(document.querySelector('#cprqStart')),
    startVal: document.querySelector('#cprqStart')?.value ?? null,
    endVal: document.querySelector('#cprqEnd')?.value ?? null,
    rowCount: rows.length,
    dates: rows.slice(0, 10).map((r) => txt(r.querySelector('.cprq'))),
    pager: [...document.querySelectorAll('.pageButton')].map(txt).slice(0, 10),
  });
})()`;

const CLICK = (sel, text) => `(() => {
  const txt = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const el = ${text ? `[...document.querySelectorAll(${JSON.stringify(sel)})].find(e => txt(e) === ${JSON.stringify(text)})` : `document.querySelector(${JSON.stringify(sel)})`};
  if (!el) return false;
  el.click();
  return true;
})()`;

const SET_DATES = `(() => {
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
})()`;

const report = { searchUrl: SEARCH, steps: [] };
await call("Page.navigate", { url: SEARCH });
await sleep(10000);
report.before = JSON.parse(await evaluate(ROWS));

let postsAt = posts.length;
report.steps.push({ openPanel: await evaluate(CLICK("span.titles.fl", "裁判日期")) });
await sleep(2000);
report.afterPanel = JSON.parse(await evaluate(ROWS));
report.steps.push({ altPanelClick: await evaluate(CLICK("div.fl.tool_PX", null)) });
await sleep(1500);
report.afterAltPanel = JSON.parse(await evaluate(ROWS));
report.setDates = JSON.parse(await evaluate(SET_DATES));
await sleep(3000);
report.afterSetDates = JSON.parse(await evaluate(ROWS));
posts.length = postsAt; // keep only the search request that follows
report.steps.push({ search: await evaluate(CLICK("div.search-rightBtn.search-click", null)) });
await sleep(12000);
report.afterSearch = JSON.parse(await evaluate(ROWS));
report.posts = posts;
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  before: report.before,
  afterPanel: { visibleStart: report.afterPanel.visibleStart, rows: report.afterPanel.rowCount },
  afterSetDates: { startVal: report.afterSetDates.startVal, endVal: report.afterSetDates.endVal },
  afterSearch: report.afterSearch,
  posts: report.posts.map((p) => `${p.method} ${p.url} | ${p.postData.slice(0, 400)}`),
  out: OUT,
}, null, 1));
ws.close();
