#!/usr/bin/env node
// Recon: how the search page's slice filters (裁判日期 range, 省份, 案件类型)
// are wired, and which XHR the search issues. Read-only against the standing
// Chrome's session — it applies a date filter once and reports what changed, so
// the CDP adapter can be taught to honour a slice instead of reading the
// unfiltered default list. Writes nothing.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tabs = await (await fetch(`${CDP}/json/list`)).json();
const tab = tabs.find((t) => t.url.includes("wenshu.court.gov.cn") && t.type === "page");
if (!tab) throw new Error("no wenshu tab in the standing Chrome");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const xhr = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent") {
    const r = m.params.request;
    if (r.method !== "GET" || /search|list|doc|query/i.test(r.url)) {
      xhr.push({ url: r.url.slice(0, 300), method: r.method, postData: (r.postData ?? "").slice(0, 600), type: m.params.type });
    }
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

await call("Network.enable", {});

// ------------------------------------------------------------------ structure
const STRUCTURE = `(() => {
  const shown = (el) => !!el && el.offsetParent !== null;
  const txt = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const desc = (el) => el ? { tag: el.tagName, id: el.id || null, cls: (el.className || '').toString().slice(0, 80), text: txt(el).slice(0, 40) } : null;
  const dates = ['#cprqStart', '#cprqEnd'].map((s) => {
    const el = document.querySelector(s);
    return el ? { sel: s, value: el.value, type: el.type, readonly: el.readOnly, visible: shown(el), outer: el.outerHTML.slice(0, 220) } : { sel: s, missing: true };
  });
  const searchBtns = [...document.querySelectorAll('button,a,div,span,input')]
    .filter((el) => /^搜\\s*索$/.test(txt(el)) || el.value === '搜索')
    .slice(0, 8).map(desc);
  const dateTabs = [...document.querySelectorAll('li,span,a,div')]
    .filter((el) => /裁判日期|上传日期|公开日期/.test(txt(el)) && txt(el).length < 20)
    .slice(0, 10).map(desc);
  // filter groups: the containers whose own text mentions 省份/法院/案件类型
  const groups = [...document.querySelectorAll('div,ul,dl')]
    .filter((el) => /省份|地域|法院|案件类型/.test(txt(el)) && txt(el).length < 600 && el.querySelectorAll('*').length < 80)
    .slice(0, 12)
    .map((el) => ({ ...desc(el), children: [...el.children].slice(0, 8).map(desc) }));
  const rows = [...document.querySelectorAll('.LM_list')];
  return JSON.stringify({
    url: location.href,
    dates, searchBtns, dateTabs, groups,
    rowCount: rows.length,
    rowDates: rows.slice(0, 5).map((r) => txt(r.querySelector('.cprq'))),
    pager: [...document.querySelectorAll('.pageButton')].map(txt).slice(0, 12),
  });
})()`;

// ------------------------------------------------------------- apply a filter
const SET_DATES = `(() => {
  const setVal = (sel, value) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus();
    if (setter) setter.call(el, value); else el.value = value;
    for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
    return el.value;
  };
  const a = setVal('#cprqStart', '2026-09-19');
  const b = setVal('#cprqEnd', '2026-09-19');
  return JSON.stringify({ start: a, end: b });
})()`;

const CLICK_SEARCH = `(() => {
  const txt = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const btn = [...document.querySelectorAll('button,a,div,span,input')]
    .find((el) => /^搜\\s*索$/.test(txt(el)) || el.value === '搜索');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

const report = { searchUrl: SEARCH };
await call("Page.navigate", { url: SEARCH });
await sleep(9000);
report.before = JSON.parse(await evaluate(STRUCTURE));
report.setDates = JSON.parse(await evaluate(SET_DATES));
report.clicked = await evaluate(CLICK_SEARCH);
await sleep(9000);
report.after = JSON.parse(await evaluate(STRUCTURE));
report.xhr = xhr.slice(-14);
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  before: { url: report.before.url, rows: report.before.rowCount, dates: report.before.rowDates, pager: report.before.pager.slice(0, 6) },
  setDates: report.setDates,
  clicked: report.clicked,
  after: { url: report.after.url, rows: report.after.rowCount, dates: report.after.rowDates, pager: report.after.pager.slice(0, 6) },
  xhr: report.xhr.map((x) => `${x.method} ${x.url.slice(0, 120)}`),
  out: OUT,
}, null, 1));
ws.close();
