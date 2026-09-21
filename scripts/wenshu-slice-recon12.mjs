#!/usr/bin/env node
// Recon 12: the 案件类型 option values. Recon 11 proved ?s8= is inert (every value
// rendered 民事案件) and that the type is a query condition chosen in the panel
// (#s8 carries data-val="03" for 民事案件). This opens the dropdown and dumps every
// option with its code, so the adapter can map a slice's caseType to it.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon12.json";
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
await sleep(10000);
await evaluate(`(() => {
  window.__cap = [];
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) { const s = this; this.addEventListener('load', () => { try { window.__cap.push({ u: s.__u, body: typeof b === 'string' ? b : null }); } catch {} }); return XS.apply(this, arguments); };
  const panel = document.querySelector('div.advencedWrapper');
  if (panel && getComputedStyle(panel).display === 'none') document.querySelector('div.advenced-search')?.click();
  return true;
})()`);
await sleep(2500);

const report = {};
// open the 案件类型 dropdown and dump whatever appears with codes
report.beforeClick = JSON.parse(await evaluate(`(() => {
  const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const s8 = document.querySelector('#s8');
  const wraps = [...document.querySelectorAll('div,ul,dl')].filter((el) => /案件类型/.test(t(el)) && t(el).length < 400 && el.querySelectorAll('li,dd,a').length >= 5);
  return JSON.stringify({ s8: s8 ? { val: s8.getAttribute('data-val'), text: t(s8) } : null, wrapCount: wraps.length, wraps: wraps.slice(0, 2).map((el) => ({ cls: (el.className || '').toString().slice(0, 50), html: el.outerHTML.replace(/\\s+/g, ' ').slice(0, 1500) })) });
})()`));
report.clicked = await evaluate(`(() => { const s8 = document.querySelector('#s8'); if (!s8) return false; s8.click(); return true; })()`);
await sleep(1800);
report.afterClick = JSON.parse(await evaluate(`(() => {
  const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const vis = [...document.querySelectorAll('li,dd,a,span')].filter((el) => /案件$|司法协助案件$|管辖案件/.test(t(el)) && el.offsetParent !== null);
  const byClass = {};
  for (const el of vis) {
    const k = el.tagName + '.' + ((el.className || '').toString().slice(0, 30));
    byClass[k] = byClass[k] ?? [];
    if (byClass[k].length < 10) byClass[k].push({ text: t(el), data: el.getAttribute('data-val') ?? el.getAttribute('value') ?? null, html: el.outerHTML.replace(/\\s+/g, ' ').slice(0, 120) });
  }
  const con = document.querySelector('#selectCon_other_ajlx');
  return JSON.stringify({ byClass, conHtml: con ? con.outerHTML.replace(/\\s+/g, ' ').slice(0, 1800) : null });
})()`));

// pick 刑事案件 and capture the query condition it produces
report.pick = JSON.parse(await evaluate(`(() => {
  const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const cands = [...document.querySelectorAll('li,a,dd,span')].filter((el) => t(el) === '刑事案件' && el.offsetParent !== null);
  const btn = cands.find((el) => el.tagName === 'LI') ?? cands[cands.length - 1];
  if (!btn) return JSON.stringify({ found: 0 });
  btn.click();
  return JSON.stringify({ found: cands.length, tag: btn.tagName, cls: (btn.className || '').toString().slice(0, 30) });
})()`));
await sleep(2500);
await evaluate(`window.__cap = []`);
await evaluate(`[...document.querySelectorAll('.searchbtn a')].find((a) => (a.textContent||'').trim() === '检索')?.click()`);
await sleep(12000);
report.pickedType = await evaluate(`document.querySelector('#s8')?.textContent?.trim() ?? null`);
report.rows = JSON.parse(await evaluate(`(() => {
  const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const rs = [...document.querySelectorAll('.LM_list')];
  return JSON.stringify({ n: rs.length, first: t(rs[0]?.querySelector('a.caseName')).slice(0, 30), caseNo: t(rs[0]?.querySelector('.ah')), dates: rs.slice(0, 4).map((r) => t(r.querySelector('.cprq'))) });
})()`));
report.posts = JSON.parse(await evaluate(`JSON.stringify((window.__cap ?? []).filter((c) => (c.body ?? '').includes('queryCondition')).map((c) => { const p = new URLSearchParams(c.body); return { pageSize: p.get('pageSize'), queryCondition: decodeURIComponent(p.get('queryCondition') || '') }; }))`));

writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  s8Before: report.beforeClick.s8,
  wrapClasses: report.beforeClick.wraps.map((w) => w.cls),
  wrapHtml: report.beforeClick.wraps[0]?.html?.slice(0, 900),
  afterClickClasses: Object.keys(report.afterClick.byClass),
  optionSamples: Object.fromEntries(Object.entries(report.afterClick.byClass).map(([k, v]) => [k, v.slice(0, 9)])),
  conHtml: (report.afterClick.conHtml ?? "").slice(0, 900),
  pick: report.pick,
  pickedType: report.pickedType,
  rows: report.rows,
  posts: report.posts.map((p) => p.queryCondition),
  out: OUT,
}, null, 1));
ws.close();
