#!/usr/bin/env node
// Recon 10: two levers that decide the adapter's cost.
//  (1) page size — the page's own POST says pageSize=5; can the UI selector raise
//      it (fewer pages to walk per slice)?
//  (2) the page keeps parsed, decrypted data somewhere after a search (the
//      response payloads are encrypted with a per-response secretKey, so reading
//      the page's own state would beat both DOM scraping and implementing their
//      crypto). window.lawyee exposes exactly one property: `data`.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon10.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tabs = await (await fetch(`${CDP}/json/list`)).json();
const tab = tabs.find((t) => t.url.includes("wenshu.court.gov.cn") && t.type === "page");
if (!tab) throw new Error("no wenshu tab");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const call = (method, params = {}, timeoutMs = 40000) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression, timeoutMs = 40000) => {
  const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error(`page js: ${r.exceptionDetails.text}`);
  return r.result.value;
};

await call("Page.navigate", { url: SEARCH });
await sleep(11000);
await evaluate(`(() => {
  window.__cap = []; window.__capInstalled = true;
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) { const s = this; this.addEventListener('load', () => { try { window.__cap.push({ u: s.__u, body: typeof b === 'string' ? b : null }); } catch {} }); return XS.apply(this, arguments); };
  return true;
})()`);

const report = {};
// (1) page-size control
report.pageSizeControl = JSON.parse(await evaluate(`(() => {
  const el = document.querySelector('.pageSizeSelect, select[name*=pageSize], select[id*=pageSize], .pageSize, select');
  const all = [...document.querySelectorAll('select')].map((s) => ({ cls: (s.className || '').toString().slice(0, 40), id: s.id || null, value: s.value, options: [...s.options].map((o) => o.value + ':' + o.text) }));
  return JSON.stringify({ primary: el ? { tag: el.tagName, cls: (el.className || '').toString().slice(0, 40), outer: el.outerHTML.slice(0, 300) } : null, selects: all.slice(0, 5) });
})()`));
// pager area html (where the size selector usually lives)
report.pagerHtml = await evaluate(`(() => { const p = document.querySelector('.pageBox, .page, #page, .LM_page, .pageDiv'); return p ? p.outerHTML.replace(/\\s+/g, ' ').slice(0, 900) : null; })()`);

// (2) page's parsed state before/after a search
report.lawyeeBefore = JSON.parse(await evaluate(`(() => {
  const d = window.lawyee?.data;
  const out = { type: typeof d };
  if (d && typeof d === 'object') { out.keys = Object.keys(d).slice(0, 30); out.sample = JSON.stringify(d).slice(0, 500); }
  return JSON.stringify(out);
})()`));

// drive the flow with the largest page size the selector offers
report.setPageSize = JSON.parse(await evaluate(`(() => {
  const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => /^(5|10|15|20|30)$/.test(o.value)));
  if (!sel) return JSON.stringify({ missing: true });
  const values = [...sel.options].map((o) => o.value);
  const best = values.sort((a, b) => Number(b) - Number(a))[0];
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), 'value')?.set;
  if (setter) setter.call(sel, best); else sel.value = best;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ cls: (sel.className || '').toString().slice(0, 40), options: values, chose: best, nowValue: sel.value });
})()`));
await sleep(1500);
await evaluate(`document.querySelector('div.advenced-search')?.click()`);
await sleep(2000);
await evaluate(`(() => {
  const setVal = (sel, value) => { const el = document.querySelector(sel); if (!el) return null;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    el.focus(); if (setter) setter.call(el, value); else el.value = value;
    for (const type of ['input','change','blur']) el.dispatchEvent(new Event(type, { bubbles: true })); return el.value; };
  return JSON.stringify({ start: setVal('#cprqStart','2026-09-18'), end: setVal('#cprqEnd','2026-09-18') });
})()`);
await sleep(2500);
await evaluate(`window.__cap = []`);
await evaluate(`[...document.querySelectorAll('.searchbtn a')].find((a) => (a.textContent||'').trim() === '检索')?.click()`);
await sleep(13000);
const caps = JSON.parse(await evaluate(`JSON.stringify((window.__cap ?? []).filter((c) => (c.body ?? '').includes('pageNum')).map((c) => { const p = new URLSearchParams(c.body); return { pageNum: p.get('pageNum'), pageSize: p.get('pageSize'), cfg: (p.get('cfg') || '').slice(-24), sort: p.get('sortFields') }; }))`));
report.searchPosts = caps;
report.afterSearch = JSON.parse(await evaluate(`(() => {
  const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const rs = [...document.querySelectorAll('.LM_list')];
  return JSON.stringify({ rows: rs.length, dates: rs.slice(0, 6).map((r) => t(r.querySelector('.cprq'))), pager: [...document.querySelectorAll('.pageButton')].map(t).slice(0, 10) });
})()`));
report.lawyeeAfter = JSON.parse(await evaluate(`(() => {
  const d = window.lawyee?.data;
  const out = { type: typeof d };
  if (d && typeof d === 'object') { out.keys = Object.keys(d).slice(0, 40); out.sample = JSON.stringify(d).slice(0, 700); }
  return JSON.stringify(out);
})()`));
report.globalsHints = JSON.parse(await evaluate(`JSON.stringify(Object.keys(window).filter((k) => /decrypt|encrypt|aes|crypto|sm4|rsa|data|search|lawyee|vue|app/i.test(k)).slice(0, 40))`));

writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  pageSizeControl: report.pageSizeControl.primary,
  selects: report.pageSizeControl.selects,
  pagerHtml: report.pagerHtml,
  setPageSize: report.setPageSize,
  searchPosts: report.searchPosts,
  afterSearch: report.afterSearch,
  lawyeeBefore: report.lawyeeBefore,
  lawyeeAfter: report.lawyeeAfter,
  globalsHints: report.globalsHints,
  out: OUT,
}, null, 1));
ws.close();
