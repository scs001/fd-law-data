#!/usr/bin/env node
// Recon 11: the case-type axis. The list pages are case-type scoped by ?s8=<code>
// (we have been crawling s8=03 only), so a full crawl has to walk the other codes
// — and the advanced panel's 案件类型 dropdown is how a type is applied to a query.
// This maps s8 values to their type names and learns (a) the dropdown's option
// values and (b) which query key a chosen type lands in.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const BASE = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=";
const OUT = "/tmp/wenshu-slice-recon11.json";
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
const pageInfo = `(() => {
  const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const openPanel = document.querySelector('div.advencedWrapper');
  return JSON.stringify({
    h1: t(document.querySelector('.list-tit, .listTitle, h1, .searchTitle')) || null,
    s8text: t(document.querySelector('#s8')) || null,
    rows: document.querySelectorAll('.LM_list').length,
    firstTitle: t(document.querySelector('.LM_list a.caseName')) || null,
    panelDisplay: openPanel ? getComputedStyle(openPanel).display : null,
  });
})()`;

const report = { mapping: [] };
for (const code of ["02", "03", "04", "05", "10", "01", "06"]) {
  await call("Page.navigate", { url: BASE + code });
  await sleep(8500);
  const info = JSON.parse(await evaluate(pageInfo));
  report.mapping.push({ code, ...info });
}

// dropdown options + which query key a chosen type uses
await call("Page.navigate", { url: BASE + "03" });
await sleep(9000);
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
report.ajlxOptions = JSON.parse(
  await evaluate(`(() => {
    const mk = (el) => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 40), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20), data: el.getAttribute('data-value'), val: el.getAttribute('value') });
    const con = document.querySelector('#selectCon_other_ajlx');
    const span = document.querySelector('#s8');
    const lists = [...document.querySelectorAll('div,ul')].filter((el) => /ajlx|selectCon_other/.test((el.className || '').toString()) || /案件类型/.test((el.textContent || '').slice(0, 30)));
    return JSON.stringify({
      span: span ? mk(span) : null,
      spanNext: span?.nextElementSibling ? mk(span.nextElementSibling) : null,
      con: con ? con.outerHTML.replace(/\\s+/g, ' ').slice(0, 1200) : null,
      listContainers: lists.slice(0, 4).map((el) => ({ cls: (el.className || '').toString().slice(0, 40), html: el.outerHTML.replace(/\\s+/g, ' ').slice(0, 700) })),
    });
  })()`),
);
// choose 刑事案件 through the dropdown and search
report.choose = JSON.parse(
  await evaluate(`(() => {
    const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const span = document.querySelector('#s8');
    if (!span) return JSON.stringify({ missing: true });
    span.click();
    return JSON.stringify({ clicked: true, afterOpen: getComputedStyle(document.querySelector('#selectCon_other_ajlx') ?? document.body).display });
  })()`),
);
await sleep(1500);
report.pickOption = JSON.parse(
  await evaluate(`(() => {
    const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const cands = [...document.querySelectorAll('li,a,dd')].filter((el) => t(el) === '刑事案件' && el.offsetParent !== null);
    if (!cands.length) return JSON.stringify({ found: 0 });
    cands[cands.length - 1].click();
    return JSON.stringify({ found: cands.length, clickedClass: (cands[cands.length - 1].className || '').toString().slice(0, 40) });
  })()`),
);
await sleep(2000);
await evaluate(`window.__cap = []`);
await evaluate(`[...document.querySelectorAll('.searchbtn a')].find((a) => (a.textContent||'').trim() === '检索')?.click()`);
await sleep(12000);
report.afterPick = JSON.parse(await evaluate(pageInfo));
report.posts = JSON.parse(
  await evaluate(`JSON.stringify((window.__cap ?? []).filter((c) => (c.body ?? '').includes('queryCondition')).map((c) => { const p = new URLSearchParams(c.body); return { cfg: (p.get('cfg') || '').slice(-20), queryCondition: decodeURIComponent(p.get('queryCondition') || ''), pageSize: p.get('pageSize') }; }))`),
);
report.s8After = await evaluate(`document.querySelector('#s8')?.textContent?.trim() ?? null`);

writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  mapping: report.mapping.map((m) => ({ code: m.code, s8text: m.s8text, h1: m.h1, rows: m.rows, first: (m.firstTitle ?? "").slice(0, 24) })),
  spanS8: report.ajlxOptions.span,
  spanNext: report.ajlxOptions.spanNext,
  con: (report.ajlxOptions.con ?? "").slice(0, 500),
  choose: report.choose,
  pickOption: report.pickOption,
  s8After: report.s8After,
  afterPickRows: report.afterPick.rows,
  posts: report.posts.map((p) => p.queryCondition),
  out: OUT,
}, null, 1));
ws.close();
