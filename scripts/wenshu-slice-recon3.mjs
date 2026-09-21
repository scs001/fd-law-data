#!/usr/bin/env node
// Recon 3: how to drive this page. Recon 2 showed a plain element.click() neither
// opens the 裁判日期 panel nor runs a search (no rest.q4w fired, the DOM values got
// wiped) — the page is a JS component app whose MODEL owns the query, and it builds
// the encrypted ciphertext itself. So find (a) what actually hides the date inputs,
// (b) the component instance and the methods/fields that run a search, (c) the real
// click targets with their attributes.
import { writeFileSync } from "node:fs";

const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const SEARCH = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
const OUT = "/tmp/wenshu-slice-recon3.json";
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

const HIDE_CHAIN = `(() => {
  const el = document.querySelector('#cprqStart');
  if (!el) return JSON.stringify({ missing: true });
  const chain = [];
  for (let n = el; n && chain.length < 7; n = n.parentElement) {
    const cs = getComputedStyle(n);
    chain.push({
      tag: n.tagName, id: n.id || null, cls: (n.className || '').toString().slice(0, 60),
      display: cs.display, visibility: cs.visibility, height: n.getBoundingClientRect().height,
      inlineStyle: (n.getAttribute('style') || '').slice(0, 120),
    });
  }
  return JSON.stringify(chain);
})()`;

const VUE_PROBE = `(() => {
  const out = [];
  const seen = new Set();
  const marks = (root) => {
    const all = [root, ...root.querySelectorAll('*')];
    for (const el of all) {
      for (const k of Object.keys(el)) {
        if (!/^__(vue|react|data|proto)|_view|lawyee/i.test(k)) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        const v = el[k];
        let info = null;
        try {
          if (v && typeof v === 'object') {
            const dataKeys = v.$data ? Object.keys(v.$data).filter((x) => /cprq|date|search|query|condition|page|list/i.test(x)).slice(0, 25) : [];
            const methods = v.$options?.methods ? Object.keys(v.$options.methods).filter((x) => /search|query|submit|cprq|page|list|load/i.test(x)).slice(0, 25) : [];
            const computed = v.$options?.computed ? Object.keys(v.$options.computed).filter((x) => /search|query|cprq|param/i.test(x)).slice(0, 15) : [];
            info = { isVue: !!v.$el, dataKeys, methods, computed };
          } else {
            info = typeof v;
          }
        } catch (e) { info = 'err:' + e.message; }
        out.push({ key: k, tag: el.tagName, id: el.id || null, cls: (el.className || '').toString().slice(0, 40), info });
      }
    }
  };
  const app = document.querySelector('#app') || document.body;
  marks(app);
  return JSON.stringify({ markers: out.slice(0, 30), globals: Object.keys(window).filter((k) => /lawyee|vue|app|wbst|search/i.test(k)).slice(0, 30) });
})()`;

const SEARCH_BOX = `(() => {
  const box = document.querySelector('div.search-wrapper');
  const toolbar = document.querySelector('div.fl.tool_PX')?.parentElement;
  return JSON.stringify({
    box: box ? box.outerHTML.slice(0, 2500) : null,
    toolbar: toolbar ? toolbar.outerHTML.slice(0, 1800) : null,
  });
})()`;

const report = {
  chain: JSON.parse(await evaluate(HIDE_CHAIN)),
  vue: JSON.parse(await evaluate(VUE_PROBE)),
  html: JSON.parse(await evaluate(SEARCH_BOX)),
};
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify({
  chain: report.chain,
  markers: report.vue.markers.slice(0, 14),
  globals: report.vue.globals.slice(0, 20),
  out: OUT,
}, null, 1));
ws.close();
