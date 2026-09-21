#!/usr/bin/env node
// Recon 7: the complete slice flow with the RIGHT button. Recon 6 found that
// opening the advanced panel hides div.search-rightBtn and puts a 检索 / 重置 pair
// inside .searchbtn (that is the search trigger for the advanced form). This opens
// the panel, sets the 裁判日期 range, clicks 检索, and captures the resulting list
// payload — plus the left facet groups (省份 / 案件类型 / 法院层级) and their options.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon7.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tabs = await (await fetch(`${CDP}/json/list`)).json();
const tab = tabs.find((t) => t.url.includes("wenshu.court.gov.cn") && t.type === "page");
if (!tab) throw new Error("no wenshu tab");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
let lastListPost = null;
let lastFacetPost = null;
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent") {
    const r = m.params.request;
    if (r.url.includes("rest.q4w") && (r.postData ?? "").includes("pageNum")) lastListPost = r.postData;
    if (r.url.includes("rest.q4w") && (r.postData ?? "").includes("groupFields")) lastFacetPost = r.postData;
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
const snapshot = `(() => {
  const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const rs = [...document.querySelectorAll('.LM_list')];
  return JSON.stringify({
    start: document.querySelector('#cprqStart')?.value ?? null,
    end: document.querySelector('#cprqEnd')?.value ?? null,
    n: rs.length,
    dates: rs.slice(0, 8).map((r) => t(r.querySelector('.cprq'))),
    pager: [...document.querySelectorAll('.pageButton')].map(t).slice(0, 8),
  });
})()`;

await call("Network.enable", {});
await call("Page.navigate", { url: SEARCH });
await sleep(11000);
const report = { before: JSON.parse(await evaluate(snapshot)) };

report.openPanel = await evaluate(`(() => { document.querySelector('div.advenced-search')?.click(); return getComputedStyle(document.querySelector('div.advencedWrapper')).display; })()`);
await sleep(2500);
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
report.beforeClick = JSON.parse(await evaluate(snapshot));
lastListPost = null;
report.clicked = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.searchbtn a')].find((a) => (a.textContent || '').trim() === '检索');
  if (!btn) return false;
  btn.click();
  return true;
})()`);
await sleep(14000);
report.after = JSON.parse(await evaluate(snapshot));
report.listPost = lastListPost;
report.facetPost = lastFacetPost;

// facet groups: containers holding 省份 / 案件类型 / 法院层级 with their options
report.facets = JSON.parse(
  await evaluate(`(() => {
    const t = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const out = [];
    for (const key of ['省份', '地域', '法院层级', '案件类型', '裁判年份']) {
      const label = [...document.querySelectorAll('span,div,h3,h4,dt,strong,li')].find((el) => t(el) === key || t(el) === key + '：');
      if (!label) continue;
      let box = label.parentElement;
      for (let i = 0; i < 3 && box && box.querySelectorAll('a,li').length < 3; i++) box = box.parentElement;
      if (!box) continue;
      out.push({
        key,
        cls: (box.className || '').toString().slice(0, 60),
        options: [...box.querySelectorAll('a,li')].slice(0, 12).map((el) => ({ text: t(el).slice(0, 24), cls: (el.className || '').toString().slice(0, 30), data: el.getAttribute('data-value') })),
      });
    }
    return JSON.stringify(out);
  })()`),
);

writeFileSync(OUT, JSON.stringify(report, null, 1));
const clean = (p) => (p ?? "").replace(/ciphertext=[^&]+/, "ciphertext=<…>").replace(/__RequestVerificationToken=[^&]+/, "token=<…>");
console.log(JSON.stringify({
  before: report.before,
  openPanel: report.openPanel,
  setDates: report.setDates,
  beforeClick: report.beforeClick,
  clicked: report.clicked,
  after: report.after,
  listPost: decodeURIComponent(clean(report.listPost)).slice(0, 700),
  facetPost: decodeURIComponent(clean(report.facetPost)).slice(0, 400),
  facets: report.facets.map((f) => ({ key: f.key, cls: f.cls, opts: f.options.map((o) => o.text).slice(0, 8) })),
  out: OUT,
}, null, 1));
ws.close();
