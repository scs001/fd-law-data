#!/usr/bin/env node
// Recon 4: the page controller. Recon 3 found window.$app / window.lawyee and that
// the date inputs sit in a display:none div.advencedWrapper (so the panel must be
// opened first), and that the toolbar tool_PX items are SORT axes (s50=法院层级,
// s51=裁判日期) rather than filters. This dumps $app's callable surface, opens the
// advanced panel, and dumps the filters it actually contains.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon4.json";
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

await call("Page.navigate", { url: SEARCH });
await sleep(10000);

const APP_PROBE = `(() => {
  const describe = (obj, name) => {
    if (!obj) return { name, missing: true };
    const own = Object.getOwnPropertyNames(obj).slice(0, 60);
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(obj) ?? {}).slice(0, 60);
    const fns = [...new Set([...own, ...proto])].filter((k) => { try { return typeof obj[k] === 'function'; } catch { return false; } });
    const interesting = fns.filter((k) => /search|query|condition|submit|cprq|page|list|load|init|filter/i.test(k)).slice(0, 40);
    return { name, own: own.slice(0, 40), fns: interesting };
  };
  const out = { app: describe(window.$app, '$app'), lawyee: describe(window.lawyee, 'lawyee') };
  try {
    if (window.$app?.$data) out.appData = Object.keys(window.$app.$data).slice(0, 50);
    if (window.$app?.$options?.methods) out.appMethods = Object.keys(window.$app.$options.methods).slice(0, 60);
  } catch (e) { out.err = e.message; }
  // what do the interesting search functions look like?
  try {
    const f = window.$app?.search || window.$app?.doSearch || window.$app?.$options?.methods?.search;
    if (typeof f === 'function') out.searchSrc = String(f).slice(0, 700);
  } catch {}
  try { if (window.lawyee) out.lawyeeKeys = Object.getOwnPropertyNames(window.lawyee).slice(0, 50); } catch {}
  return JSON.stringify(out);
})()`;

const OPEN_PANEL = `(() => {
  const el = document.querySelector('div.advenced-search');
  const before = getComputedStyle(document.querySelector('div.advencedWrapper')).display;
  if (el) el.click();
  const after = getComputedStyle(document.querySelector('div.advencedWrapper')).display;
  return JSON.stringify({ clicked: !!el, before, after, advHtml: el ? el.outerHTML.slice(0, 300) : null });
})()`;

const PANEL_HTML = `(() => {
  const w = document.querySelector('div.advencedWrapper');
  const mk = (el) => ({ tag: el.tagName, id: el.id || null, cls: (el.className || '').toString().slice(0, 50), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30) });
  return JSON.stringify({
    display: w ? getComputedStyle(w).display : null,
    html: w ? w.innerHTML.slice(0, 3000) : null,
    fields: w ? [...w.querySelectorAll('input,select,li,span,a')].slice(0, 40).map(mk) : null,
  });
})()`;

const report = { app: JSON.parse(await evaluate(APP_PROBE)) };
report.open = JSON.parse(await evaluate(OPEN_PANEL));
await sleep(1500);
report.panel = JSON.parse(await evaluate(PANEL_HTML));
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  app: report.app,
  open: report.open,
  panel: { display: report.panel.display, fields: (report.panel.fields ?? []).slice(0, 24) },
  out: OUT,
}, null, 1));
ws.close();
