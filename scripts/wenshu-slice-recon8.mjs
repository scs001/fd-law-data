#!/usr/bin/env node
// Recon 8: the response side. Recon 7 proved the slice flow (open panel → set
// #cprqStart/#cprqEnd → click .searchbtn 检索) produces
// queryCondition [{key:'s8'},{key:'cprq',value:'D TO D'}]. If the list RESPONSE
// carries the total and the rows, searchTotal/listDocIds stop guessing from the
// pager DOM, and if the detail page's content XHR carries the full text, that is
// the difference between ~8s and ~1s per document. This dumps both bodies.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon8.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tabs = await (await fetch(`${CDP}/json/list`)).json();
const tab = tabs.find((t) => t.url.includes("wenshu.court.gov.cn") && t.type === "page");
if (!tab) throw new Error("no wenshu tab");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const seen = []; // {requestId, url, method, post} in arrival order
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.responseReceived") {
    const { requestId, response, type } = m.params;
    if (/rest\.q4w|parse\/|api\/|docId=|content|detail/i.test(response.url) && ["XHR", "Fetch", "Document"].includes(type)) {
      seen.push({ requestId, url: response.url.replace("https://wenshu.court.gov.cn", ""), status: response.status, mime: response.mimeType, type });
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
const body = async (requestId, max = 4000) => {
  try {
    const r = await call("Network.getResponseBody", { requestId }, 20000);
    const text = r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
    return { len: text.length, head: text.slice(0, max) };
  } catch (e) {
    return { error: e.message };
  }
};

const report = {};
await call("Network.enable", {});
await call("Page.navigate", { url: SEARCH });
await sleep(11000);
// apply a one-day slice with results (2026-09-18) through the proven flow
await evaluate(`document.querySelector('div.advenced-search')?.click()`);
await sleep(2000);
await evaluate(`(() => {
  const setVal = (sel, value) => { const el = document.querySelector(sel); if (!el) return null;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    el.focus(); if (setter) setter.call(el, value); else el.value = value;
    for (const type of ['input','change','blur']) el.dispatchEvent(new Event(type, { bubbles: true })); return el.value; };
  return JSON.stringify({ start: setVal('#cprqStart','2026-09-18'), end: setVal('#cprqEnd','2026-09-18') });
})()`);
await sleep(3000);
const listStart = seen.length;
await evaluate(`[...document.querySelectorAll('.searchbtn a')].find((a) => (a.textContent||'').trim() === '检索')?.click()`);
await sleep(14000);
report.listResponses = [];
for (const s of seen.slice(listStart)) {
  const b = await body(s.requestId, 2500);
  report.listResponses.push({ ...s, len: b.len, head: b.head, error: b.error });
}
report.rowLinks = JSON.parse(
  await evaluate(`JSON.stringify([...document.querySelectorAll('.LM_list a.caseName')].slice(0, 3).map((a) => ({ href: a.getAttribute('href'), text: (a.textContent||'').trim().slice(0, 40) })))`),
);

// detail page XHRs
const token = (report.rowLinks[0]?.href ?? "").match(/docId=([^&]+)/)?.[1];
report.detailToken = token ? `${token.slice(0, 24)}…(${token.length})` : null;
if (token) {
  const detailStart = seen.length;
  await call("Page.navigate", { url: `https://wenshu.court.gov.cn/website/wenshu/181107ANFZ0BXSK4/index.html?docId=${token}` });
  await sleep(12000);
  report.detailResponses = [];
  for (const s of seen.slice(detailStart)) {
    const b = await body(s.requestId, 3000);
    report.detailResponses.push({ ...s, len: b.len, head: b.head, error: b.error });
  }
  report.detailDom = JSON.parse(await evaluate(`(() => {
    const b = document.querySelector('.PDF_pox');
    return JSON.stringify({ hasBody: !!b, bodyLen: b ? b.innerHTML.length : 0, title: document.querySelector('.PDF_title')?.textContent?.trim()?.slice(0, 40) ?? null });
  })()`));
}

writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  listResponses: report.listResponses.map((r) => ({ url: r.url, type: r.type, status: r.status, len: r.len, err: r.error })),
  listSample: report.listResponses.find((r) => /q4w/.test(r.url))?.head?.slice(0, 1200),
  rowLinks: report.rowLinks,
  detailToken: report.detailToken,
  detailResponses: (report.detailResponses ?? []).map((r) => ({ url: r.url, type: r.type, status: r.status, len: r.len, err: r.error })),
  detailSample: (report.detailResponses ?? []).map((r) => r.head?.slice(0, 500)).filter(Boolean).slice(0, 2),
  detailDom: report.detailDom,
  out: OUT,
}, null, 1));
ws.close();
