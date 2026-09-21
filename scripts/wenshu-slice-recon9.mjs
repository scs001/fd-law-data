#!/usr/bin/env node
// Recon 9: can a captured query be REPLAYED with fetch? The list/facet responses
// come back as plain JSON (only the detail payload is encrypted), so if the query
// body the page builds can be re-sent with a different pageNum/pageSize, listing a
// slice costs ~0.3s per page instead of driving the pager DOM. This hooks XHR in
// the page, drives the proven slice flow, dumps the exact request (headers + body),
// then replays it with a bumped pageSize/pageNum and shows what comes back.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon9.json";
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

// hook XHR so the page's own query request can be captured verbatim
await evaluate(`(() => {
  if (window.__capInstalled) return true;
  window.__capInstalled = true;
  window.__cap = [];
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send, XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; this.__h = {}; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = v; } catch {} return XH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const self = this;
    this.addEventListener('load', () => {
      try {
        window.__cap.push({ u: self.__u, m: self.__m, h: self.__h, body: typeof b === 'string' ? b : null, len: (self.responseText || '').length, status: self.status, respHead: (self.responseText || '').slice(0, 400) });
      } catch (e) { window.__cap.push({ err: String(e) }); }
    });
    return XS.apply(this, arguments);
  };
  return true;
})()`);

// drive the proven slice flow
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
await evaluate(`window.__cap = []`);
await evaluate(`[...document.querySelectorAll('.searchbtn a')].find((a) => (a.textContent||'').trim() === '检索')?.click()`);
await sleep(13000);

const captured = JSON.parse(await evaluate(`JSON.stringify(window.__cap ?? [])`));
const listReq = captured.filter((c) => /rest\.q4w/.test(c.u ?? "") && (c.body ?? "").includes("pageNum")).pop();
const report = { captured: captured.map((c) => ({ u: c.u, m: c.m, h: c.h, len: c.len, status: c.status, body: (c.body ?? "").slice(0, 1200) })), };

if (!listReq) {
  report.error = "no captured list request";
} else {
  report.request = { u: listReq.u, h: listReq.h, body: listReq.body };
  // replay: same ciphertext/token, bigger page + page 2
  const replay = async (patch) => {
    const params = new URLSearchParams(listReq.body);
    for (const [k, v] of Object.entries(patch)) params.set(k, String(v));
    const expr = `(async () => {
      const r = await fetch(${JSON.stringify(listReq.u)}, { method: 'POST', headers: ${JSON.stringify({ ...listReq.h, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" })}, body: ${JSON.stringify(params.toString())} });
      const t = await r.text();
      let keys = null, total = null, sample = null, rowCount = null;
      try {
        const j = JSON.parse(t);
        keys = Object.keys(j);
        const res = j.result;
        if (res && typeof res === 'object') {
          keys = Object.keys(j).concat('result:' + Object.keys(res).slice(0, 12).join(','));
          for (const k of ['totalCount','total','count','totalNum','sumCount']) if (res[k] !== undefined) total = res[k];
          const arr = res.data ?? res.list ?? res.rows ?? res.docList ?? res.items;
          if (Array.isArray(arr)) { rowCount = arr.length; sample = JSON.stringify(arr[0] ?? null).slice(0, 500); }
          else { sample = JSON.stringify(res).slice(0, 400); }
        }
      } catch (e) { keys = 'not-json'; sample = t.slice(0, 300); }
      return JSON.stringify({ status: r.status, len: t.length, keys, total, rowCount, sample });
    })()`;
    return JSON.parse(await evaluate(expr, 45000));
  };
  report.replayPage1Size30 = await replay({ pageSize: 30, pageNum: 1 });
  report.replayPage2Size30 = await replay({ pageSize: 30, pageNum: 2 });
  report.replayNoPageSize = await replay({ pageSize: 5, pageNum: 1 });
}

writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  captured: report.captured.map((c) => ({ u: c.u, m: c.m, len: c.len, body: c.body.slice(0, 260) })),
  requestHeaders: report.request?.h ?? null,
  replay1: report.replayPage1Size30 ?? null,
  replay2: report.replayPage2Size30 ?? null,
  replayOrigSize: report.replayNoPageSize ?? null,
  error: report.error ?? null,
  out: OUT,
}, null, 1));
ws.close();
