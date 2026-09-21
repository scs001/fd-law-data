#!/usr/bin/env node
// Task 1.2 harvest INSIDE the operator's own logged-in Chrome via AppleScript
// (Allow JavaScript from Apple Events). Opens background tabs, extracts the
// search-results DOM and 3 detail pages, closes the tabs, writes the report.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const SEARCH_URL = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?pageId=0b4d0ade615&s21=%E6%B0%91%E9%97%B4%E5%80%9F%E8%B4%B7";

const osa = (script) => execFileSync("osascript", ["-e", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const osaFile = (f) => execFileSync("osascript", [f], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

const writeJs = (name, code) => writeFileSync(`/tmp/${name}.js`, code);
const runJsOnTab = (tabIdx, jsName) =>
  osaFile("/dev/stdin") /* placeholder never used */ ?? null; // replaced below

// execute JS on tab N of window 1 — js read from a file to dodge escaping hell
function execTabJs(tabIdx, jsName) {
  const script = `
set jsCode to read POSIX file "/tmp/${jsName}.js"
tell application "Google Chrome"
  set t to tab ${tabIdx} of window 1
  return execute t javascript jsCode
end tell`;
  writeFileSync("/tmp/osa-exec.applescript", script);
  return osaFile("/tmp/osa-exec.applescript");
}

function openTab(url) {
  // the new tab lands at the END: its index == tab count after creation
  return Number(osa(`
tell application "Google Chrome"
  make new tab at end of window 1 with properties {URL:"${url}"}
  return count of tabs of window 1
end tell`));
}

function closeTab(idx) {
  osa(`tell application "Google Chrome" to close tab ${idx} of window 1`);
}

async function waitTab(idx, minLen = 500, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    writeFileSync("/tmp/osa-len.applescript", `
tell application "Google Chrome"
  set t to tab ${idx} of window 1
  return execute t javascript "document.body ? document.body.textContent.length : -1"
end tell`);
    const n = Number(osaFile("/tmp/osa-len.applescript"));
    if (n >= minLen) return true;
  }
  return false;
}

const report = { startedAt: new Date().toISOString(), steps: {} };
try {
  // ---------- search page ----------
  const searchTab = openTab(SEARCH_URL);
  console.log("search tab:", searchTab);
  await waitTab(searchTab, 700, 50000);
  await new Promise((r) => setTimeout(r, 12000)); // SPA settle
  writeJs(
    "ws-search-dump",
    `JSON.stringify((() => {
      const out = { url: location.href.slice(0,160), counts: [], listContainers: [], pagers: [], detailLinks: [], filterLabels: [], firstItemHtml: null, loginHint: null };
      if (/退出/.test(document.body.textContent)) out.loginHint = "logged-in";
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.textContent || "").trim();
        if (/共.{0,16}条/.test(t) && out.counts.length < 3) out.counts.push(t.slice(0, 40));
      }
      for (const el of document.querySelectorAll("[class]")) {
        const c = String(el.className); const txt = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (/result|caseList|LM[_-]?list|doc[_-]?list|search[_-]?list/i.test(c) && el.children.length >= 2 && out.listContainers.length < 4)
          out.listContainers.push({ tag: el.tagName, cls: c.slice(0,60), n: el.children.length, head: txt.slice(0,90) });
        if (/page|pager|fanye/i.test(c) && el.children.length >= 1 && out.pagers.length < 4) out.pagers.push({ cls: c.slice(0,50), text: txt.slice(0,44) });
        if (/^(裁判日期|法院地域|案由|文书类型|审判程序|案例级别|案件类型)$/.test(txt)) out.filterLabels.push({ tag: el.tagName, cls: c.slice(0,50), text: txt });
      }
      for (const a of document.querySelectorAll("a[href], [data-docid], [onclick*='docId']")) {
        const h = a.getAttribute("href") || a.getAttribute("data-docid") || (a.getAttribute("onclick") || "");
        if (/docId=|docid/i.test(h) && out.detailLinks.length < 8) out.detailLinks.push(h.slice(0,150));
      }
      const li = document.querySelector("[class*='result'] li, [class*='caseList'] li, .LM_list li");
      if (li) out.firstItemHtml = li.outerHTML.replace(/\\s+/g, " ").slice(0, 900);
      out.bodyLen = (document.body.textContent || "").length;
      return out;
    })())`,
  );
  report.steps.searchDom = JSON.parse(execTabJs(searchTab, "ws-search-dump"));
  console.log("SEARCH:", JSON.stringify(report.steps.searchDom, null, 1));

  // ---------- details ----------
  report.steps.details = [];
  const links = report.steps.searchDom.detailLinks || [];
  for (const href of links.slice(0, 3)) {
    const abs = href.startsWith("http") ? href : "https://wenshu.court.gov.cn" + href;
    const idx = openTab(abs);
    const ok = await waitTab(idx, 900, 45000);
    await new Promise((r) => setTimeout(r, 9000));
    writeJs(
      "ws-detail-dump",
      `JSON.stringify((() => {
        const grab = (re) => {
          for (const el of document.querySelectorAll("li,dd,dt,span,div")) {
            const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
            if (re.test(own)) return (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 110);
          }
          return null;
        };
        const qwEl = document.querySelector("[id*='qwContent'], [class*='qwContent'], [class*='doc-content']");
        return {
          url: location.href.slice(0,150),
          docId: new URL(location.href).searchParams.get("docId"),
          title: (document.querySelector("h1,h2,[class*='title']")?.textContent || "").replace(/\\s+/g," ").trim().slice(0,90) || null,
          案号: grab(/^案\\s*号/), 法院: grab(/^法院/), 案由: grab(/^案\\s*由/),
          判决时间: grab(/裁判日期|判决日期/), 发布时间: grab(/公开日期|发布日期/), 受理时间: grab(/受理日期/),
          判决结果: grab(/^判决结果/), 案例级别: grab(/案例级别/), 法院级别: grab(/法院级别/), 审理程序: grab(/审判程序|审理程序/), 法条: grab(/法律依据|相关法条/),
          qwSelector: qwEl ? String(qwEl.id || qwEl.className).slice(0,50) : null,
          qwLen: (qwEl ? qwEl.innerHTML : "").length,
          bodyLen: document.body.textContent.length,
          loaded: ${ok}
        };
      })())`,
    );
    try {
      report.steps.details.push(JSON.parse(execTabJs(idx, "ws-detail-dump")));
      console.log("DETAIL ok:", report.steps.details.at(-1).docId);
    } catch (e) {
      report.steps.details.push({ href: href.slice(0, 80), error: String(e).slice(0, 120) });
    }
    closeTab(idx);
    await new Promise((r) => setTimeout(r, 1500));
  }

  closeTab(searchTab);
  report.finishedAt = new Date().toISOString();
  writeFileSync("/tmp/wenshu-spike-report.json", JSON.stringify(report, null, 1));
  console.log("REPORT → /tmp/wenshu-spike-report.json");
} catch (err) {
  console.error("applescript spike error:", String(err).slice(0, 400));
  process.exitCode = 1;
}
