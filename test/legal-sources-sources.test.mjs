import test from "node:test";
import assert from "node:assert/strict";
import { rmfyalkAdapter } from "../lib/legal-sources/sources/rmfyalk.js";
import { mfaTreatyAdapter } from "../lib/legal-sources/sources/mfa-treaty.js";
import { govRulesAdapter } from "../lib/legal-sources/sources/gov-rules.js";
import { partyRegulationAdapter } from "../lib/legal-sources/sources/party-regulation.js";
import { ccdiSupervisoryAdapter } from "../lib/legal-sources/sources/ccdi-supervisory.js";
import { SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";

test("all five wave-1 adapters share the runtime contract", () => {
  assert.deepEqual([...SOURCE_ADAPTERS.keys()].sort(), [
    "ccdi-supervisory-regulations",
    "gov-rules-library",
    "mfa-treaty-library",
    "party-regulation-library",
    "rmfyalk-case-library",
  ]);
  for (const adapter of SOURCE_ADAPTERS.values()) {
    assert.equal(typeof adapter.list, "function");
    assert.equal(typeof adapter.detail, "function");
    assert.equal(adapter.mode, "http");
  }
});

test("rmfyalk maps the live search/content JSON contract", async () => {
  const listJson = {
    code: "0",
    data: {
      totalCount: 2,
      totalPage: 1,
      datas: [
        {
          id: "case-1",
          cpws_al_title: "指导案例1号",
          cpws_al_type: "01",
          cpws_al_no: "指导案例1号",
          cpws_al_status: "01",
          cpws_al_infos: "民事/合同纠纷",
        },
        {
          id: "case-2",
          cpws_al_title: "参考案例2号",
          cpws_al_type: "02",
          cpws_al_status: "02",
        },
      ],
    },
  };
  const page = await rmfyalkAdapter.list({ page: 1, size: 10 }, jsonHelper(listJson));
  assert.equal(page.entries.length, 2);
  assert.equal(page.total, 2);
  assert.equal(page.entries[0].doc_type, "guiding-case");
  assert.equal(page.entries[1].doc_type, "reference-case");
  assert.equal(page.entries[1].status, "失效");

  const detailJson = {
    code: "0",
    data: {
      data: {
        cpws_al_id: "case-1",
        cpws_al_title: "指导案例1号",
        cpws_al_no: "指导案例1号",
        cpws_al_status: "01",
        cpws_al_keyword: ["合同", "违约"],
        cpws_al_cpyz: "<p>裁判要点内容</p>",
        cpws_al_jbaq: "基本案情内容",
        cpws_al_cpjg: "裁判结果内容",
        cpws_al_cply: "裁判理由内容",
        cpws_al_glsy: "相关法条内容",
        cpws_al_update_time: "2026-01-02 10:00:00",
      },
    },
  };
  const detail = await rmfyalkAdapter.detail(page.entries[0], jsonHelper(detailJson));
  assert.equal(detail.document.title, "指导案例1号");
  assert.equal(detail.document.metadata.keywords[0], "合同");
  assert.equal(detail.document.metadata.sections["裁判要点"], "裁判要点内容");
  assert.match(detail.document.content, /裁判要点\n裁判要点内容/);
  assert.match(detail.document.source_url, /cpwsAl\/content/);
});

test("mfa treaty parses server-rendered pagination, metadata and attachments", async () => {
  const listHtml = `<ul>
    <li><div><a href="detail1.jsp?objid=1758592256114">蒙古过境运输协定</a></div><div>双边</div></li>
    <li><div><a href="detail1.jsp?objid=1659013439956">万国邮政公约</a></div><div>多边</div></li>
  </ul><div class="page"><a href="?nPageIndex_=747">尾页</a></div>`;
  const page = await mfaTreatyAdapter.list({ page: 1 }, htmlHelper(listHtml, { pages: 1 }));
  assert.equal(page.entries.length, 2);
  assert.equal(page.entries[0].source_id, "1758592256114");
  assert.match(page.entries[0].url, /detail1\.jsp\?objid=/);

  const detailHtml = `<h1>蒙古过境运输协定</h1>
    <table>
      <tr><th>缔约方</th><td>中国；蒙古</td></tr>
      <tr><th>类别</th><td>双边</td></tr>
      <tr><th>我国签署时间</th><td>2014.08.21</td></tr>
      <tr><th>条约生效时间</th><td>2017.05.05</td></tr>
      <tr><th>保存机关</th><td>蒙古国政府</td></tr>
    </table>
    <a href="/web/files/treaty.pdf">条约文本</a>`;
  const detail = await mfaTreatyAdapter.detail(page.entries[0], htmlHelper(detailHtml, { buffers: { "treaty.pdf": Buffer.from("PDF") } }));
  assert.equal(detail.document.metadata.parties, "中国；蒙古");
  assert.equal(detail.document.published_at, "2014-08-21T00:00:00+08:00");
  assert.equal(detail.artifacts[0].filename, "treaty.pdf");
});

test("gov rules filters titles and maps lifecycle metadata", async () => {
  const listHtml = `<ul>
    <li><a href="/a.shtml">部门规章：XX管理办法</a></li>
    <li><a href="/b.shtml">新闻：不相关</a></li>
  </ul>`;
  const page = await govRulesAdapter.list({ scope: "department" }, htmlHelper(listHtml));
  assert.equal(page.entries.length, 1);
  const detailHtml = `<h1>XX管理办法</h1>
    <table><tr><th>发文字号</th><td>令第15号</td></tr>
    <tr><th>发文机关</th><td>国家卫生健康委</td></tr>
    <tr><th>施行日期</th><td>2026-02-01</td></tr>
    <tr><th>有效性</th><td>现行有效</td></tr></table>`;
  const detail = await govRulesAdapter.detail(page.entries[0], htmlHelper(detailHtml));
  assert.equal(detail.document.authority, "国家卫生健康委");
  assert.equal(detail.document.status, "现行有效");
  assert.equal(detail.document.metadata.document_no, "令第15号");
});

test("party regulations exclude commentary and preserve category", async () => {
  const listHtml = `<ul>
    <li><a href="/2026/01/01/ARTI1.shtml">中国共产党巡视工作条例</a></li>
    <li><a href="/2026/01/02/ARTI2.shtml">负责人就条例答记者问</a></li>
  </ul>`;
  const page = await partyRegulationAdapter.list({ category: "regulations" }, htmlHelper(listHtml));
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].metadata_from_list.category_label, "条例");
  const detailHtml = `<h1>中国共产党巡视工作条例</h1>
    <table><tr><th>发文机关</th><td>中共中央</td></tr>
    <tr><th>发布日期</th><td>2025-01-01</td></tr></table>
    <p>第一条 为了强化巡视工作。</p>`;
  const detail = await partyRegulationAdapter.detail(page.entries[0], htmlHelper(detailHtml));
  assert.match(detail.document.source_id, /^https:\/\/www\.12371\.cn\/2026\/01\/01\/ARTI1\.shtml@v-[0-9a-f]{20}$/);
  assert.equal(detail.document.metadata.canonical_url, page.entries[0].source_id);
  assert.equal(detail.document.metadata.is_current, true);
  assert.equal(detail.document.authority, "中共中央");
  assert.equal(detail.document.metadata.category, "regulations");
});

test("CCDI challenge is structure drift, never parsed as content", async () => {
  const challengePage = await ccdiSupervisoryAdapter.list({ page: 1 }, htmlHelper(`<script>window.open("/fgk/", "_self");</script>`));
  assert.equal(challengePage.entries.length, 0);
  assert.equal(challengePage.unreachablePages.length, 1);
  assert.match(challengePage.unreachablePages[0].reason, /anti-automation challenge/);
  assert.equal(challengePage.total, 0);
  const listHtml = `<ul><li><a href="/fgk/a.shtml">监察法实施条例</a></li></ul>`;
  const page = await ccdiSupervisoryAdapter.list({ page: 1 }, htmlHelper(listHtml));
  assert.equal(page.entries[0].title, "监察法实施条例");
});

function jsonHelper(json) {
  return {
    fetchJson: async () => json,
    fetchText: async () => JSON.stringify(json),
    fetchBuffer: async () => ({ body: Buffer.alloc(0), contentType: "application/octet-stream" }),
  };
}

function htmlHelper(html, { pages = null, buffers = {} } = {}) {
  return {
    fetchText: async () => html,
    fetchJson: async () => { throw new Error("unexpected JSON"); },
    fetchBuffer: async (url) => {
      const name = new URL(url).pathname.split("/").pop();
      if (!buffers[name]) throw new Error(`unexpected attachment ${url}`);
      return { body: buffers[name], contentType: "application/pdf" };
    },
  };
}
