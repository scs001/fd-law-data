#!/usr/bin/env node
// Recon 6: the two things recon 5 left open — (a) with the advanced panel open the
// search button is gone from div.search-rightBtn, so find what replaced it, and
// (b) the 裁判日期 inputs are laydate widgets whose model only updates through the
// widget's own day-cell click. Also captures the leftDataItem RESPONSE bodies,
// which carry the facet groups (省份/案件类型/法院层级 …) with their option values.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon6.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tabs = await (await fetch(`${CDP}/json/list`)).json();
const tab = tabs.find((t) => t.url.includes("wenshu.court.gov.cn") && t.type === "page");
if (!tab) throw new Error("no wenshu tab");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const reqs = [];
let lastListPost = null;
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent") {
    const r = m.params.request;
    if (r.url.includes("rest.q4w") && (r.postData ?? "").includes("pageNum")) lastListPost = { at: Date.now(), postData: r.postData };
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

const report = {};
await call("Network.enable", {});
await call("Page.navigate", { url: SEARCH });
await sleep(11000);

// (a) controls that exist once the panel is open
report.openPanel = await evaluate(`(() => { document.querySelector('div.advenced-search')?.click(); return getComputedStyle(document.querySelector('div.advencedWrapper')).display; })()`);
await sleep(2500);
report.searchConHtml = await evaluate(`(() => {
  const con = document.querySelector('div.search-con') || document.body;
  return con.outerHTML.replace(/\\s+/g, ' ').slice(0, 4000);
})()`);
report.buttons = JSON.parse(await evaluate(`(() => {
  const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  return JSON.stringify([...document.querySelectorAll('div,a,button,span')]
    .filter((el) => /^(搜\\s*索|重\\s*置|检索|确定)$/.test(t(el)) && el.offsetParent !== null)
    .slice(0, 12)
    .map((el) => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 60), text: t(el), parent: (el.parentElement?.className || '').toString().slice(0, 40) })));
})()`));

// (b) the laydate widget: what does clicking the input open?
report.cprqClick = await evaluate(`(() => { const el = document.querySelector('#cprqStart'); if (!el) return 'missing'; el.click(); return 'clicked'; })()`);
await sleep(1800);
report.calendar = JSON.parse(await evaluate(`(() => {
  const c = document.querySelector('.layui-laydate');
  if (!c) return JSON.stringify({ missing: true, bodyHasLayui: !!document.querySelector('[class*=layui]') });
  return JSON.stringify({ cls: c.className.slice(0, 80), html: c.innerHTML.replace(/\\s+/g, ' ').slice(0, 1600) });
})()`));

// try to commit 2026-09-19 through the widget
report.pickDay = await evaluate(`(() => {
  const c = document.querySelector('.layui-laydate');
  if (!c) return 'no-calendar';
  const ym = c.querySelector('.layui-laydate-header .layui-laydate-ym') || c.querySelector('.layui-laydate-header');
  const byAttr = c.querySelector('td[lay-ymd="2026-9-19"]') || c.querySelector('td[lay-ymd="2026-09-19"]');
  let cell = byAttr;
  if (!cell) {
    cell = [...c.querySelectorAll('td')].find((td) => (td.textContent || '').trim() === '19');
  }
  if (!cell) return 'no-cell:' + (ym?.textContent ?? '');
  cell.click();
  return 'clicked:' + (ym?.textContent ?? '').replace(/\\s+/g, ' ');
})()`);
await sleep(1500);
report.afterPick = JSON.parse(await evaluate(`(() => {
  const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const rs = [...document.querySelectorAll('.LM_list')];
  return JSON.stringify({
    start: document.querySelector('#cprqStart')?.value ?? null,
    end: document.querySelector('#cprqEnd')?.value ?? null,
    calendarOpen: !!document.querySelector('.layui-laydate'),
    dates: rs.slice(0, 4).map((r) => t(r.querySelector('.cprq'))),
    lastPost: ${JSON.stringify(lastListPost?.postData ?? "")}.slice(0, 1) && null,
  });
})()`));
report.lastListPost = lastListPost?.postData ?? null;

writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  openPanel: report.openPanel,
  buttons: report.buttons,
  cprqClick: report.cprqClick,
  calendar: report.calendar.missing ? report.calendar : { cls: report.calendar.cls, head: report.calendar.html.slice(0, 400) },
  pickDay: report.pickDay,
  afterPick: { start: report.afterPick.start, end: report.afterPick.end, calendarOpen: report.afterPick.calendarOpen },
  lastListPost: (report.lastListPost ?? "").replace(/ciphertext=[^&]+/, "ciphertext=<…>").slice(0, 400),
  out: OUT,
}, null, 1));
ws.close();
