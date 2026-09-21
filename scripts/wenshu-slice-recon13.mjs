#!/usr/bin/env node
// Recon 13: why the list does not re-query. On the case-type page with the date
// range validated, the facet request carries BOTH conditions but the rendered rows
// stay stale — so the 检索 click is not reaching the page's handler. This drives
// the exact adapter flow and compares three triggers: a synthetic .click(), a real
// CDP mouse click at the element's box, and clicking the hidden .search-rightBtn.
import { writeFileSync } from "node:fs";

const CDP = "http://localhost:9223";
const URL_ = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?pageId=8010a692c1d831aa6255b77ad2cf72c4&s8=05";
const OUT = "/tmp/wenshu-slice-recon13.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP}/json/list`)).json();
const tab = list.find((t) => t.url.includes("wenshu.court.gov.cn") && t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r, rej) => { ws.onopen = r; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const call = (method, params = {}, timeoutMs = 40000) => new Promise((res, rej) => {
  const id = ++seq;
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method}`)); }, timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr, timeoutMs = 30000) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs)).result?.value;

const HOOK = `(() => {
  if (window.__wd) return true;
  window.__wd = { facets: 0, lists: 0, cprq: 0, lastListBody: null, lastFacetBody: null };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__b = null; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const self = this;
    if (typeof b === "string") self.__b = b;
    self.addEventListener("load", () => {
      try {
        const u = self.__u || "", body = self.__b || "";
        if (/api\\/fp\\/cprq/.test(u)) window.__wd.cprq += 1;
        else if (/rest\\.q4w/.test(u) && body.indexOf("groupFields") >= 0) { window.__wd.facets += 1; window.__wd.lastFacetBody = body; }
        else if (/rest\\.q4w/.test(u) && body.indexOf("pageNum") >= 0) { window.__wd.lists += 1; window.__wd.lastListBody = body; }
      } catch (e) {}
    });
    return XS.apply(this, arguments);
  };
  return true;
})()`;

const counters = () => ev(`JSON.stringify(window.__wd || {})`).then((s) => JSON.parse(s ?? "{}"));
const rowsNow = () => ev(`(() => {
  const t = (el) => (el?.textContent || "").replace(/\\s+/g, " ").trim();
  const rs = [...document.querySelectorAll(".LM_list")];
  return JSON.stringify({ n: rs.length, dates: rs.slice(0, 5).map((r) => t(r.querySelector(".cprq"))) });
})()`).then((s) => JSON.parse(s ?? "{}"));

const report = {};
await call("Page.navigate", { url: URL_ });
await sleep(10000);
await ev(HOOK);
report.startUrl = await ev("location.href");
report.rowsBefore = await rowsNow();

// open panel + page size + dates (the adapter's flow)
report.panel = await ev(`(() => { const w = document.querySelector("div.advencedWrapper"); if (!w) return "missing"; if (getComputedStyle(w).display !== "none") return "open"; document.querySelector("div.advenced-search")?.click(); return getComputedStyle(w).display !== "none" ? "opened" : "failed"; })()`);
report.pageSize = await ev(`(() => { const sel = document.querySelector("select.pageSizeSelect"); if (!sel) return "missing"; const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), "value")?.set; if (setter) setter.call(sel, "15"); else sel.value = "15"; sel.dispatchEvent(new Event("change", { bubbles: true })); return sel.value; })()`);
await sleep(4000);
report.setDates = JSON.parse(await ev(`(() => {
  const setVal = (sel, value) => { const el = document.querySelector(sel); if (!el) return null;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    el.focus(); if (setter) setter.call(el, value); else el.value = value;
    for (const type of ["input", "change", "blur"]) el.dispatchEvent(new Event(type, { bubbles: true })); return el.value; };
  return JSON.stringify({ start: setVal("#cprqStart", "2026-09-18"), end: setVal("#cprqEnd", "2026-09-18") });
})()`));
await sleep(4000);
report.countersBeforeClick = await counters();
report.rowsBeforeClick = await rowsNow();
report.buttonInfo = JSON.parse(await ev(`(() => {
  const t = (el) => (el?.textContent || "").replace(/\\s+/g, " ").trim();
  const btn = [...document.querySelectorAll(".searchbtn a")].find((a) => t(a) === "检索");
  if (!btn) return JSON.stringify({ missing: true });
  const r = btn.getBoundingClientRect();
  return JSON.stringify({ html: btn.outerHTML.slice(0, 160), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, vis: btn.offsetParent !== null, parentCls: (btn.parentElement?.className || "").toString() });
})()`));

// trigger 1: synthetic click
await ev(`(() => { const t = (el) => (el?.textContent || "").replace(/\\s+/g, " ").trim(); [...document.querySelectorAll(".searchbtn a")].find((a) => t(a) === "检索")?.click(); return true; })()`);
await sleep(9000);
report.afterSynthetic = { counters: await counters(), rows: await rowsNow() };

// trigger 2: real CDP mouse click at the button's box
if (report.afterSynthetic.counters.lists === report.countersBeforeClick.lists) {
  const r = report.buttonInfo.rect;
  const x = Math.round(r.x + r.w / 2);
  const y = Math.round(r.y + r.h / 2);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await sleep(120);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(80);
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(9000);
  report.afterRealMouse = { at: { x, y }, counters: await counters(), rows: await rowsNow() };
}

// trigger 3: the hidden div.search-rightBtn
if ((report.afterRealMouse ?? report.afterSynthetic).counters.lists === report.countersBeforeClick.lists) {
  const clicked = await ev(`(() => { const b = document.querySelector("div.search-rightBtn"); if (!b) return false; b.click(); return true; })()`);
  await sleep(9000);
  report.afterRightBtn = { clicked, counters: await counters(), rows: await rowsNow() };
}

writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  startUrl: report.startUrl?.slice(0, 80),
  panel: report.panel,
  pageSize: report.pageSize,
  setDates: report.setDates,
  countersBeforeClick: report.countersBeforeClick,
  rowsBeforeClick: report.rowsBeforeClick,
  button: report.buttonInfo,
  afterSynthetic: report.afterSynthetic,
  afterRealMouse: report.afterRealMouse ?? null,
  afterRightBtn: report.afterRightBtn ?? null,
  out: OUT,
}, null, 1));
ws.close();
