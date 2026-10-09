import test from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rmfyalkAdapter } from "../lib/legal-sources/sources/rmfyalk.js";
import { mfaTreatyAdapter } from "../lib/legal-sources/sources/mfa-treaty.js";
import { govRulesAdapter } from "../lib/legal-sources/sources/gov-rules.js";
import { partyRegulationAdapter } from "../lib/legal-sources/sources/party-regulation.js";
import {
  CcdiHttpClient,
  ccdiSupervisoryAdapter,
  createCcdiSupervisoryAdapter,
  decodeRichEntities,
  parseCcdiListPage,
  parseCcdiDetailPage,
} from "../lib/legal-sources/sources/ccdi-supervisory.js";
import { docxToText } from "../lib/docxtext.js";
import { SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";
import { crawlLegalSource } from "../lib/legal-sources/runtime.js";
import { LocalS3 } from "./fixtures/local-s3.mjs";

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

test("gov rules gateway enumerates regulations and maps metadata", async () => {
  const gatewayJson = {
    resultCode: { code: 200 },
    result: {
      data: {
        pager: { total: 1, pageCount: 1, pageNo: 1, pageSize: 500 },
        list: [{
          f_202321360426: "XX管理办法",
          f_202321807875: "部门规章",
          f_202344311304: "令第15号",
          f_202321915922: "2026-01-01 00:00:00",
          f_202323394765: "国家卫生健康委",
          f_202328191239: ["国家卫生健康委员会"],
          f_202321423473: [],
          f_20232380533: "",
          doc_pub_url: "https://www.gov.cn/zhengce/202601/content_1.htm",
          f_202321758948: "第一条 为了规范管理。",
        }],
      },
    },
  };
  const page = await govRulesAdapter.list({ scope: "department", size: 500 }, jsonHelper(gatewayJson));
  assert.equal(page.entries.length, 1);
  assert.equal(page.total, 1);
  assert.equal(page.entries[0].title, "XX管理办法");
  assert.equal(page.entries[0].category, "部门规章");
  assert.equal(page.entries[0].authority, "国家卫生健康委");
  assert.equal(page.entries[0].url, "https://www.gov.cn/zhengce/202601/content_1.htm");

  const detail = await govRulesAdapter.detail(page.entries[0]);
  assert.equal(detail.document.title, "XX管理办法");
  assert.equal(detail.document.status, "现行有效");
  assert.equal(detail.document.metadata.document_no, "令第15号");
  assert.equal(detail.document.metadata.department, "国家卫生健康委员会");
  assert.equal(detail.document.content, "第一条 为了规范管理。");
});

test("party regulations enumerate every public category page and dedupe across them", async () => {
  const routes = {
    // 党章专题: hand-built anchors, including derivative commentary links.
    "https://www.12371.cn/special/zggcdzc/": `
      <a href="https://www.12371.cn/2022/10/26/ARTIzz1.shtml">中国共产党章程</a>
      <a href="https://www.12371.cn/2022/10/22/ARTIzz2.shtml">二十大关于《中国共产党章程（修正案）》的决议</a>
      <a href="https://www.12371.cn/2022/10/26/ARTIzz3.shtml">《中国共产党章程（修正案）》诞生记</a>
      <a href="https://www.12371.cn/2022/10/27/ARTIzz4.shtml">中国共产党章程（2022年新旧对照版）</a>`,
    // Form categories embed their full lists in inline JS arrays.
    "https://www.12371.cn/special/dnfg/zz/": arrayPage("https://www.12371.cn/2016/10/01/ARTInorm1.shtml", "中国共产党廉洁自律准则"),
    "https://www.12371.cn/special/dnfg/tl/": `
      <script>var itemELMT=[
      {'link_add':'https://www.12371.cn/2025/12/07/ARTItl1.shtml','title':'中国共产党工作机关条例','content':'','brief':''},
      {'link_add':'https://www.12371.cn/2024/03/01/ARTItl2.shtml','title':'中国共产党支部工作条例（试行）','content':'','brief':''},
      {'link_add':'https://www.12371.cn/2024/04/01/ARTItl3.shtml','title':'党的代表大会代表提案办理情况通报','content':'','brief':''}
      ];</script>`,
    "https://www.12371.cn/special/dnfg/gd/": arrayPage("https://www.12371.cn/2023/09/01/ARTInorm2.shtml", "事业单位领导人员管理规定"),
    "https://www.12371.cn/special/dnfg/bf/": arrayPage("https://www.12371.cn/2022/03/01/ARTInorm3.shtml", "创建示范活动管理办法（试行）"),
    "https://www.12371.cn/special/dnfg/gz/": arrayPage("https://www.12371.cn/2021/07/01/ARTInorm4.shtml", "纪检监察机关派驻机构工作规则"),
    "https://www.12371.cn/special/dnfg/xz/": arrayPage("https://www.12371.cn/2014/06/01/ARTInorm5.shtml", "中国共产党发展党员工作细则"),
    // Theme categories: the 条例 list repeats under 党的组织法规.
    "https://www.12371.cn/special/dnfg/zzfg/": `
      <script>var itemELMT=[
      {'link_add':'https://www.12371.cn/2025/12/07/ARTItl1.shtml','title':'中国共产党工作机关条例','content':'','brief':''},
      {'link_add':'https://www.12371.cn/2015/06/01/ARTIzzfg1.shtml','title':'中国共产党国有企业基层组织工作条例（试行）','content':'','brief':''}
      ];</script>`,
    "https://www.12371.cn/special/dnfg/ldfg/": arrayPage("https://www.12371.cn/2015/05/01/ARTInorm6.shtml", "中国共产党统一战线工作条例"),
    "https://www.12371.cn/special/dnfg/zsjs/": arrayPage("https://www.12371.cn/2019/11/01/ARTInorm7.shtml", "中国共产党党校（行政学院）工作条例"),
    "https://www.12371.cn/special/dnfg/jdbz/": arrayPage("https://www.12371.cn/2019/01/01/ARTInorm8.shtml", "中国共产党纪律检查机关监督执纪工作规则"),
    // Landing: 党章 revision history array plus featured plain anchors. The
    // history's current-revision entry points at a special page, not an
    // article, and must be skipped (the 党章专题 anchor covers the full text).
    "https://www.12371.cn/special/dnfg/": `
      <script>var itemELMT=[
      {'link_add':'https://www.12371.cn/special/zggcdzc/zggcdzcqw/','title':'中国共产党章程（2022年修改）','content':'','brief':''},
      {'link_add':'https://www.12371.cn/2017/10/28/ARTIdn1.shtml','title':'中国共产党章程（2017年修改）','content':'','brief':''}
      ];</script>
      <a href=https://www.12371.cn/2025/12/07/ARTItl1.shtml target=_blank>中国共产党工作机关条例</a>
      <a href=https://www.12371.cn/2016/01/01/ARTIdn2.shtml target=_blank>推进领导干部能上能下规定</a>`,
  };
  const helper = urlHelper(routes);
  const page = await partyRegulationAdapter.list({}, helper);
  assert.equal(page.unreachablePages.length, 0);
  assert.equal(page.pages, 12);
  assert.equal(Object.keys(page.categoryCounts).length, 11);
  // Constitution: anchors keep 章程+决议, drop 诞生记/新旧对照; landing array adds history.
  assert.deepEqual(
    page.entries.filter((e) => e.metadata_from_list.category === "constitution").map((e) => e.title),
    ["中国共产党章程", "二十大关于《中国共产党章程（修正案）》的决议", "中国共产党章程（2017年修改）"],
  );
  // Cross-category duplicates keep the first (form) category; the landing
  // repeat of the same article is folded away.
  const workOffice = page.entries.find((e) => e.source_id.endsWith("ARTItl1.shtml"));
  assert.equal(workOffice.metadata_from_list.category, "regulations");
  assert.equal(workOffice.metadata_from_list.category_label, "条例");
  // Landing-only featured anchor survives with a null category tag.
  const promoted = page.entries.find((e) => e.source_id.endsWith("ARTIdn2.shtml"));
  assert.equal(promoted.metadata_from_list.category, null);
  assert.equal(page.entries.length, page.total);
  assert.equal(page.entries.length, 15);
});

test("party regulations single-category crawl fetches only that page", async () => {
  const routes = {
    "https://www.12371.cn/special/dnfg/tl/": arrayPage("https://www.12371.cn/2025/12/07/ARTItl1.shtml", "中国共产党工作机关条例"),
  };
  const helper = urlHelper(routes);
  const page = await partyRegulationAdapter.list({ category: "regulations" }, helper);
  assert.deepEqual(helper.calls, ["https://www.12371.cn/special/dnfg/tl/"]);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].metadata_from_list.category, "regulations");
});

test("party regulations record unreachable categories instead of failing silently", async () => {
  const routes = {
    "https://www.12371.cn/special/dnfg/tl/": arrayPage("https://www.12371.cn/2025/12/07/ARTItl1.shtml", "中国共产党工作机关条例"),
    // 准则 page renders but lists nothing: structure drift, not an empty category.
    "https://www.12371.cn/special/dnfg/zz/": "<html><body>moved</body></html>",
  };
  const helper = urlHelper(routes, {
    "https://www.12371.cn/special/dnfg/gz/": new Error("HTTP 503"),
  });
  const page = await partyRegulationAdapter.list({}, helper);
  const reasons = page.unreachablePages.map((u) => u.reason).join("|");
  assert.match(reasons, /category guidelines yielded no entries/);
  assert.match(reasons, /category rules: HTTP 503/);
  assert.equal(page.entries.length > 0, true);
  // A full outage enumerates nothing and must throw, not emit an empty run.
  const downHelper = { fetchText: async () => { throw new Error("connection refused"); } };
  await assert.rejects(
    () => partyRegulationAdapter.list({}, downHelper),
    (err) => err.name === "StructureDriftError" && /no entries/.test(err.message),
  );
});

test("party regulations reject unknown categories", async () => {
  await assert.rejects(
    () => partyRegulationAdapter.list({ category: "nonexistent" }, urlHelper({})),
    /unknown party-regulation category/,
  );
});

test("party regulations exclude commentary and preserve category", async () => {
  const routes = {
    "https://www.12371.cn/special/dnfg/tl/": `
      <script>var itemELMT=[
      {'link_add':'https://www.12371.cn/2026/01/01/ARTItl1.shtml','title':'中国共产党巡视工作条例','content':'','brief':''},
      {'link_add':'https://www.12371.cn/2026/01/02/ARTItl2.shtml','title':'负责人就条例答记者问','content':'','brief':''}
      ];</script>`,
  };
  const page = await partyRegulationAdapter.list({ category: "regulations" }, urlHelper(routes));
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].metadata_from_list.category_label, "条例");
  const detailHtml = `<h1>中国共产党巡视工作条例</h1>
    <table><tr><th>发文机关</th><td>中共中央</td></tr>
    <tr><th>发布日期</th><td>2025-01-01</td></tr></table>
    <p>第一条 为了强化巡视工作。</p>`;
  const detail = await partyRegulationAdapter.detail(page.entries[0], htmlHelper(detailHtml));
  assert.match(detail.document.source_id, /^https:\/\/www\.12371\.cn\/2026\/01\/01\/ARTItl1\.shtml@v-[0-9a-f]{20}$/);
  // State is keyed by the canonical url (what the list side carries); the row
  // id stays versioned so each revision is its own row.
  assert.equal(detail.document.state_key, page.entries[0].source_id);
  assert.equal(detail.document.metadata.canonical_url, page.entries[0].source_id);
  assert.equal(detail.document.metadata.canonical_source_id, page.entries[0].source_id);
  assert.equal(detail.document.metadata.is_current, true);
  assert.equal(detail.document.authority, "中共中央");
  assert.equal(detail.document.metadata.category, "regulations");
});


test("CCDI parser extracts entries, pagination and detail sections", () => {
  const listHtml = `
    <form name="searchFrom_5" action="law_display/253" method="post"></form>
    <a onclick="submitForm_0(5)">监察法实施条例</a>
    <script>submitForm_1(29, 29);</script>`;
  const page = parseCcdiListPage(listHtml);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].source_id, "253");
  assert.equal(page.entries[0].title, "监察法实施条例");
  assert.equal(page.pages, 29);

  const detailHtml = `
    <h2 class="tit">监察法实施条例</h2>
    <div>来源：国家监察委员会</div>
    <div>发布时间：2021-09-20</div>
    <div>分类：党内法规制度-->条例</div>
    <div class="TRS_Editor"><p>第一条 为了加强监察工作。</p></div>
    <!--endprint-->`;
  const detail = parseCcdiDetailPage(detailHtml, page.entries[0]);
  assert.equal(detail.title, "监察法实施条例");
  assert.equal(detail.published_at, "2021-09-20");
  assert.equal(detail.authority, "国家监察委员会");
  assert.equal(detail.metadata.category, "党内法规制度-->条例");
  assert.equal(detail.content, "第一条 为了加强监察工作。");

  assert.throws(() => parseCcdiListPage(`<script>window.open("/fgk/","_self");document.cookie="C3VK=abc123; path=/;";</script>`), /challenge/);
});

test("CCDI detail parses the unquoted template that carries 93% of the catalog", () => {
  // Current CMS generation: upper-case unquoted <DIV class=TRS_Editor>, the
  // 来源/发布时间 metadata commented out inside <H3 class=daty>, hex entities
  // in 分类. A doPrint() script string precedes the real print markers.
  const detailHtml = `<html><head><script>function doPrint(){var s="<!--startprint-->";}</script></head><body>
    <table><tr><td><div align="left"><strong>分类：&#x56fd;&#x5bb6;&#x6cd5;&#x5f8b;&#x6cd5;&#x89c4;--&gt;&#x6cd5;&#x5f8b;</strong></div></td></tr></table>
    <H2 class=tit>中华人民共和国反垄断法</H2>
    <H3 class=daty><!-- <EM class=e1>来源：&#x5168;&#x56fd;&#x4eba;&#x5927;&#x5e38;&#x59d4;&#x4f1a; </EM> <EM class=e2>发布时间：2007-08-01 </EM> --></H3>
    <DIV class=content><DIV class=TRS_Editor>
      <P class=TRS_Editor align=center><FONT face='楷体'></FONT></P>
      <p>第一条 为了预防和制止垄断行为。</p>
      <p>第二条 适用本法。</p>
    </DIV></DIV>
    <div class=footer>责任编辑：审核</div><!--endprint--></body></html>`;
  const detail = parseCcdiDetailPage(detailHtml, { source_id: "1434", title: "列表标题", url: "u" });
  assert.equal(detail.title, "中华人民共和国反垄断法");
  assert.equal(detail.published_at, "2007-08-01");
  assert.equal(detail.authority, "全国人大常委会");
  assert.equal(detail.metadata.category, "国家法律法规-->法律");
  assert.match(detail.content, /第一条 为了预防和制止垄断行为。\s*第二条 适用本法。/);
  assert.ok(!detail.content.includes("责任编辑"), "footer leaked into content");
  assert.equal(detail.content_status, "full_text");
  assert.equal(detail.attachments.length, 0);
});

test("CCDI keeps legacy metadata when a field is not hidden in a comment", () => {
  const detailHtml = `
    <h2 class="tit">监察法实施条例</h2>
    <div>来源：国家监察委员会</div>
    <div>发布时间：2021-09-20</div>
    <div class="TRS_Editor"><p>第一章 总则</p></div>
    <!--endprint-->`;
  const detail = parseCcdiDetailPage(detailHtml, { source_id: "253", title: "x", url: "u" });
  assert.equal(detail.authority, "国家监察委员会");
  assert.equal(detail.published_at, "2021-09-20");
});

test("decodeRichEntities resolves hex, decimal and extended named entities", () => {
  assert.equal(decodeRichEntities("&#x76d1;&#x5bdf;&#x6cd5;"), "监察法");
  assert.equal(decodeRichEntities("&#30417;&#23519;"), "监察");
  assert.equal(decodeRichEntities("&ldquo;带病提拔&rdquo;&ensp;ok"), "“带病提拔”\u2002ok");
  // Base entities (&nbsp;/&amp;/&#39;) stay the shared parsing.js layer's job;
  // unknown named entities pass through untouched.
  assert.equal(decodeRichEntities("unknown &notanentity; kept"), "unknown &notanentity; kept");
});

test("CCDI adapter extracts docx attachment bodies and keeps original links", async () => {
  const fixture = readFileSync(new URL("./fixtures/sample.docx", import.meta.url));
  const pageHtml = `<html><body>
    <H2 class=tit>某管理办法</H2>
    <div>附件：<a href="/fgk/attachment/2026-01/某管理办法.docx">某管理办法.docx</a></div>
    <!--endprint--></body></html>`;
  const requested = [];
  const adapter = createCcdiSupervisoryAdapter({
    client: {
      request: async () => pageHtml,
      requestBuffer: async (url) => {
        requested.push(url);
        return { body: fixture, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
      },
    },
  });
  const detail = await adapter.detail({ source_id: "9001", title: "某管理办法", url: "https://www.ccdi.gov.cn/fgk/law_display/9001" });
  assert.equal(requested.length, 1);
  assert.match(decodeURIComponent(requested[0]), /某管理办法\.docx$/);
  assert.equal(detail.document.content, docxToText(fixture));
  assert.equal(detail.document.metadata.content_status, "from_attachment");
  assert.deepEqual(detail.document.metadata.attachment_urls, [requested[0]]);
  assert.equal(detail.artifacts[0].filename, "某管理办法.docx");
  assert.equal(detail.artifacts[0].kind, "attachment");
});

test("CCDI adapter marks unextractable attachment pages attachment_only", async () => {
  const pageHtml = `<html><body><a href="/fgk/docs/legacy.doc">旧文档.doc</a><!--endprint--></body></html>`;
  const adapter = createCcdiSupervisoryAdapter({
    client: {
      request: async () => pageHtml,
      requestBuffer: async () => ({ body: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), contentType: "application/msword" }),
    },
  });
  const detail = await adapter.detail({ source_id: "9002", title: "旧文档", url: "https://www.ccdi.gov.cn/fgk/law_display/9002" });
  assert.equal(detail.document.content, null);
  assert.equal(detail.document.metadata.content_status, "attachment_only");
  assert.equal(detail.artifacts.length, 1);
});

test("CCDI adapter records no_content_on_source without inventing placeholder text", async () => {
  const pageHtml = `<html><body><H2 class=tit>空条目</H2><div class=footer>返回</div><!--endprint--></body></html>`;
  const adapter = createCcdiSupervisoryAdapter({
    client: {
      request: async () => pageHtml,
      requestBuffer: async () => { throw new Error("unexpected attachment download"); },
    },
  });
  const detail = await adapter.detail({ source_id: "9003", title: "空条目", url: "https://www.ccdi.gov.cn/fgk/law_display/9003" });
  assert.equal(detail.document.content, null);
  assert.equal(detail.document.metadata.content_status, "no_content_on_source");
  assert.equal(detail.artifacts.length, 0);
});

test("CCDI adapter contract stays intact on the shared singleton", () => {
  assert.equal(ccdiSupervisoryAdapter.id, "ccdi-supervisory-regulations");
  assert.equal(ccdiSupervisoryAdapter.mode, "http");
});

test("CCDI parser rejects the 请求过于频繁 block page instead of emitting an empty document", () => {
  const blockHtml = `<html><body><div class="main">您的访问请求过于频繁，请稍后再试。</div></body></html>`;
  assert.throws(() => parseCcdiDetailPage(blockHtml, { source_id: "1", title: "x", url: "u" }),
    (err) => err.name === "SessionProxyError" && /rate-limit/.test(err.message));
});

test("CCDI list parser rejects the rate-limit page instead of returning zero entries", () => {
  const blockHtml = `<html><body><div class="main">您的访问请求过于频繁，请稍后再试。</div></body></html>`;
  assert.throws(() => parseCcdiListPage(blockHtml),
    (err) => err.name === "SessionProxyError" && /rate-limit/.test(err.message));
});

// List fixture: one form + anchor pair per entry, plus the pagination script
// the parser reads the total page count from.
function ccdiListPage(ids, totalPages = 1) {
  return `<html><body>
    ${ids.map((id, index) => `<form name="searchFrom_${index}" action="law_display/${id}" method="post"></form>
      <a onclick="submitForm_0(${index})">法规${id}</a>`).join("\n")}
    <script>submitForm_1(${totalPages}, ${totalPages});</script></body></html>`;
}

function ccdiListClient(pagesHtml) {
  return {
    request: async (url) => {
      const page = new URL(url).searchParams.get("p");
      if (pagesHtml[page] === undefined) throw new Error(`unexpected CCDI list page ${page}`);
      return pagesHtml[page];
    },
  };
}

test("CCDI list flags an empty page as unreachable instead of silently dropping its entries", async () => {
  const adapter = createCcdiSupervisoryAdapter({
    client: ccdiListClient({
      1: ccdiListPage(["101", "102"], 3),
      // Soft block / partial render: valid HTML, no forms, no block wording.
      2: `<html><body><div>系统繁忙</div><script>submitForm_1(3, 3);</script></body></html>`,
      3: ccdiListPage(["103"], 3),
    }),
    rateMs: 0,
  });
  const listed = await adapter.list({});
  assert.deepEqual(listed.entries.map((entry) => entry.source_id), ["101", "102", "103"]);
  assert.equal(listed.pages, 3);
  assert.equal(listed.unreachablePages.length, 1);
  assert.equal(listed.unreachablePages[0].page, 2);
  assert.match(listed.unreachablePages[0].reason, /no entries/);
});

test("CCDI list flags a short non-final page, but accepts a short last page", async () => {
  const adapter = createCcdiSupervisoryAdapter({
    client: ccdiListClient({
      1: ccdiListPage(["201", "202"], 3),
      2: ccdiListPage(["203"], 3), // width 2 expected, got 1
      3: ccdiListPage(["204"], 3), // last page may be short
    }),
    rateMs: 0,
  });
  const listed = await adapter.list({});
  assert.deepEqual(listed.entries.map((entry) => entry.source_id), ["201", "202", "203", "204"]);
  assert.equal(listed.unreachablePages.length, 1);
  assert.equal(listed.unreachablePages[0].page, 2);
  assert.match(listed.unreachablePages[0].reason, /short list page: 1 < 2/);
});

test("CCDI list throws the block page up for every page, not just page 1", async () => {
  const blockHtml = `<html><body>您的访问请求过于频繁，请稍后再试。</body></html>`;
  const adapter = createCcdiSupervisoryAdapter({
    client: ccdiListClient({ 1: ccdiListPage(["301", "302"], 2), 2: blockHtml }),
    rateMs: 0,
  });
  await assert.rejects(
    () => adapter.list({}),
    (err) => err.name === "SessionProxyError" && /rate-limit/.test(err.message),
  );
});

test("a soft-blocked CCDI list page reaches the run manifest as complete=false", async () => {
  const s3 = new LocalS3();
  const detailHtml = `<html><body><H2 class=tit>法规</H2><DIV class=TRS_Editor><p>第一条 正文。</p></DIV></body></html>`;
  const adapter = createCcdiSupervisoryAdapter({
    client: {
      request: async (url) => {
        const page = new URL(url).searchParams.get("p");
        if (page === "1") return ccdiListPage(["401", "402"], 2);
        if (page === "2") return `<html><body><div>系统繁忙</div><script>submitForm_1(2, 2);</script></body></html>`;
        if (url.includes("/law_display/")) return detailHtml;
        throw new Error(`unexpected CCDI request ${url}`);
      },
      requestBuffer: async () => { throw new Error("unexpected attachment"); },
    },
    rateMs: 0,
  });
  const result = await crawlLegalSource({ s3, bucket: "laws", source: adapter.id, adapter, rateMs: 0 });
  assert.deepEqual(result.records.map((record) => record.source_id), ["401", "402"]);
  assert.equal(result.manifest.coverage.complete, false);
  assert.equal(result.manifest.coverage.unreachablePages.length, 1);
  assert.equal(result.manifest.coverage.unreachablePages[0].page, 2);
});

test("CCDI adapter resolves a bare catalog id into a detail entry", async () => {
  const pageHtml = `<html><body><H2 class=tit>监察法实施条例</H2><DIV class=TRS_Editor><p>第一条 正文。</p></DIV></body></html>`;
  const entry = ccdiSupervisoryAdapter.entryFromId("253");
  assert.equal(entry.source_id, "253");
  assert.match(entry.url, /\/fgk\/law_display\/253$/);
  assert.equal(entry.doc_type, "supervisory-regulation");
  assert.throws(() => ccdiSupervisoryAdapter.entryFromId("law_display/253"), /invalid CCDI source id/);

  const adapter = createCcdiSupervisoryAdapter({
    client: { request: async () => pageHtml, requestBuffer: async () => { throw new Error("unexpected attachment"); } },
    rateMs: 0,
  });
  const detail = await adapter.detail(entry);
  assert.equal(detail.document.source_id, "253");
  assert.equal(detail.document.title, "监察法实施条例");
  assert.equal(detail.document.source_url, entry.url);
});

test("CCDI client resets, backs off once and recovers from a rate-limit block", async () => {
  process.env.CCDI_RATE_LIMIT_BACKOFF_MS = "10";
  const challengePage = `<script>window.open("/fgk/","_self");document.cookie="C3VK=abc123; path=/;";</script>`;
  const blockPage = `<html><body>您的访问请求过于频繁，请稍后再试。</body></html>`;
  const okPage = `<html><body><H2 class=tit>标题</H2><DIV class=TRS_Editor><p>第一条 正文。</p></DIV></body></html>`;
  const calls = [];
  const fetchStub = async (url) => {
    calls.push(String(url));
    return htmlResponse(calls.length === 1 ? challengePage : calls.length === 2 ? blockPage : okPage);
  };
  const taken = mock.method(globalThis, "fetch", fetchStub);
  try {
    const client = new CcdiHttpClient({ rateMs: 0 });
    const text = await client.request("https://www.ccdi.gov.cn/fgk/law_display/253");
    assert.match(text, /第一条 正文。/);
    assert.equal(calls.length, 3);
    // The block reset the session: the challenge cookie from call 1 is gone.
    assert.equal(client.jar.has("C3VK"), false);
  } finally {
    taken.mock.restore();
    delete process.env.CCDI_RATE_LIMIT_BACKOFF_MS;
  }
});

test("CCDI client escalates a persisted block to SessionProxyError", async () => {
  process.env.CCDI_RATE_LIMIT_BACKOFF_MS = "10";
  const blockPage = `<html><body>您的访问请求过于频繁，请稍后再试。</body></html>`;
  const calls = [];
  const fetchStub = async () => {
    calls.push("fetch");
    return htmlResponse(blockPage);
  };
  const taken = mock.method(globalThis, "fetch", fetchStub);
  try {
    const client = new CcdiHttpClient({ rateMs: 0 });
    await assert.rejects(
      () => client.request("https://www.ccdi.gov.cn/fgk/law_display/253"),
      (err) => err.name === "SessionProxyError" && /RATE_LIMITED|rate-limit/i.test(`${err.code} ${err.message}`),
    );
    assert.equal(calls.length, 2);
  } finally {
    taken.mock.restore();
    delete process.env.CCDI_RATE_LIMIT_BACKOFF_MS;
  }
});

function htmlResponse(body, { status = 200, contentType = "text/html; charset=utf-8" } = {}) {
  return {
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-type" ? contentType : null),
      getSetCookie: () => [],
    },
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body).buffer.slice(
      Buffer.from(body).byteOffset,
      Buffer.from(body).byteOffset + Buffer.from(body).byteLength,
    ),
  };
}

function jsonHelper(json) {
  return {
    fetchJson: async () => json,
    fetchText: async () => JSON.stringify(json),
    fetchBuffer: async () => ({ body: Buffer.alloc(0), contentType: "application/octet-stream" }),
  };
}

// URL-routed text helper for multi-page list crawls; `failures` maps a URL to
// the error to throw instead of serving its route. Records every fetch URL.
function urlHelper(routes, failures = {}) {
  const helper = {
    calls: [],
    fetchText: async (url) => {
      helper.calls.push(url);
      if (failures[url]) throw failures[url];
      if (url in routes) return routes[url];
      throw new Error(`unexpected fetch ${url}`);
    },
    fetchJson: async () => { throw new Error("unexpected JSON"); },
    fetchBuffer: async () => ({ body: Buffer.alloc(0), contentType: "application/octet-stream" }),
  };
  return helper;
}

// Minimal category page: one regulation in the inline JS array format.
function arrayPage(url, title) {
  return `<script>var itemELMT=[{'link_add':'${url}','title':'${title}','content':'','brief':''}];</script>`;
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
