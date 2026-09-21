// Unit tests for the guiding-cases page parsers (lib/guidecases/site.js).
// Fixtures are trimmed slices of live pages captured 2026-09-21 — no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseListPage, parseCaseNumber, missingNumbers, parseDetailPage, splitSections,
  decodeEntities, normalizeText, listPageUrl, detailUrl, SelectorDriftError,
} from "../lib/guidecases/site.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/guidecases/${name}`, import.meta.url), "utf8");

const list1 = fixture("list-page-1.html");
const list15 = fixture("list-page-15.html");
const detail279 = fixture("detail-279.html");
const detail001 = fixture("detail-001.html");
const detail267 = fixture("detail-267.html");
const detailNotice = fixture("detail-notice.html");

test("URL builders follow the column's two shapes", () => {
  assert.equal(listPageUrl(1), "https://www.court.gov.cn/shenpan/gengduo/77.html");
  assert.equal(listPageUrl(15), "https://www.court.gov.cn/shenpan/gengduo/77_15.html");
  assert.equal(detailUrl("490521"), "https://www.court.gov.cn/shenpan/xiangqing/490521.html");
});

test("parseListPage: page 1 yields 20 case entries and the column total", () => {
  const { entries, total } = parseListPage(list1);
  assert.equal(entries.length, 20);
  assert.equal(total, 293);
  const first = entries[0];
  assert.equal(first.id, "490521");
  assert.equal(first.caseNo, 279);
  assert.equal(first.kind, "case");
  assert.equal(first.date, "2026-02-28");
  assert.equal(first.url, detailUrl("490521"));
  // the list truncates anchor text; the title attribute carries the full title
  assert.match(first.title, /西某工业软件有限公司诉广州沃某模具有限公司侵害计算机软件著作权纠纷案$/);
  assert.equal(entries.every((e) => e.kind === "case"), true);
});

test("parseListPage: the last page carries the batch notice alongside cases", () => {
  const { entries } = parseListPage(list15);
  assert.equal(entries.length, 13);
  const notices = entries.filter((e) => e.kind === "notice");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].id, "4213");
  assert.equal(notices[0].caseNo, null);
  assert.match(notices[0].title, /关于发布第一批指导性案例的通知/);
  const cases = entries.filter((e) => e.kind === "case");
  assert.equal(cases.length, 12);
  assert.deepEqual(cases.map((c) => c.caseNo).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("parseCaseNumber accepts both prefix variants and rejects notice titles", () => {
  assert.equal(parseCaseNumber("指导案例62号：王新明合同诈骗案"), 62);
  assert.equal(parseCaseNumber("指导性案例279号：西某工业软件有限公司诉…"), 279);
  assert.equal(parseCaseNumber("指导性案例　260号:张某山等人非法采矿案"), 260);
  assert.equal(parseCaseNumber("最高人民法院关于发布第16批指导性案例的通知"), null);
});

test("missingNumbers reports the hole at 45 without inventing entries", () => {
  assert.deepEqual(missingNumbers([1, 2, 4]), { min: 1, max: 4, count: 3, missing: [3] });
  assert.deepEqual(missingNumbers([]), { min: null, max: null, count: 0, missing: [] });
  const numbers = [1, 2, 3, 5];
  assert.deepEqual(missingNumbers(numbers).missing, [4]);
});

test("decodeEntities/normalizeText handle the site's entity-encoded titles", () => {
  assert.equal(decodeEntities("&amp;nbsp;最高人民法院关于发布第六批指导性案例的通知"), "&nbsp;最高人民法院关于发布第六批指导性案例的通知");
  assert.equal(normalizeText("　最高人民法院关于发布第四批指导性案例的通知 "), "最高人民法院关于发布第四批指导性案例的通知");
  assert.equal(normalizeText("指导性案例260号:张某山等人非法采矿刑事附带民事公益诉讼案"), "指导性案例260号:张某山等人非法采矿刑事附带民事公益诉讼案");
});

test("parseDetailPage: a modern case carries all six sections", () => {
  const page = parseDetailPage(detail279, { url: detailUrl("490521") });
  assert.equal(page.title, "指导性案例279号：西某工业软件有限公司诉广州沃某模具有限公司侵害计算机软件著作权纠纷案");
  assert.equal(page.source, "最高人民法院新闻局");
  assert.equal(page.publishAt, "2026-02-28 18:50:04");
  assert.deepEqual(page.sectionOrder, ["关键词", "裁判要点", "基本案情", "裁判结果", "裁判理由", "相关法条"]);
  assert.match(page.sections.keyword, /^民事\/侵害计算机软件著作权\//);
  assert.match(page.sections.gist, /实质性相似/);
  assert.match(page.sections.facts, /西某软件公司/);
  assert.match(page.sections.result, /粤73民初1099号/);
  assert.match(page.sections.reasoning, /证据保全/);
  assert.match(page.sections.statutes, /著作权法/);
});

test("parseDetailPage: an early case uses the inline-heading shape and still yields six sections", () => {
  // Old pages put the heading and its content inside one <strong> and use <p>
  // instead of <br />, so the heading shares its line: <strong>关键词　民事…</strong>
  const page = parseDetailPage(detail001, { url: detailUrl("4214") });
  assert.equal(page.title, "指导案例1号：上海中原物业顾问有限公司诉陶德华居间合同纠纷案");
  assert.deepEqual(page.sectionOrder, ["关键词", "裁判要点", "相关法条", "基本案情", "裁判结果", "裁判理由"]);
  assert.equal(page.sections.keyword, "民事 居间合同 二手房买卖 违约");
  assert.match(page.sections.gist, /居间合同/);
  assert.match(page.sections.statutes, /中华人民共和国合同法/);
});

test("parseDetailPage: an execution case titles its holding section 执行实施要点", () => {
  // Execution cases (251–256, 267) have neither 裁判结果 nor 裁判理由, and name
  // their holding section 执行实施要点 — the alias must land under gist rather
  // than leak into the preceding 关键词 field.
  const page = parseDetailPage(detail267, { url: detailUrl("474501") });
  assert.deepEqual(page.sectionOrder, ["关键词", "执行实施要点", "基本案情", "相关法条"]);
  assert.equal(page.sections.keyword, "执行/执行实施/网络平台账号/账号密码交付/实名认证信息变更");
  assert.match(page.sections.gist, /^对于交付网络平台账号及密码的执行/);
  assert.equal(page.sections.result, null);
  assert.equal(page.sections.reasoning, null);
});

test("splitSections maps a known alias and refuses an unknown heading", () => {
  const aliased = splitSections("关键词\n民事/执行\n执行实施要点\n1.要点内容\n基本案情\n2.案情");
  assert.equal(aliased.fields.keyword, "民事/执行");
  assert.equal(aliased.fields.gist, "1.要点内容");
  assert.equal(aliased.fields.facts, "2.案情");
  assert.deepEqual(aliased.order, ["关键词", "执行实施要点", "基本案情"]);

  // an unseen 要点-shaped heading must stop the parse, not pollute the
  // section above it
  assert.throws(() => splitSections("关键词\n民事/执行\n裁判摘要要点\n1.内容"), SelectorDriftError);
  assert.throws(() => parseDetailPage(
    `<div class="detail"><div class="title">x</div><div class="txt_txt">关键词<br />a<br />审理要旨<br />b</div></div>`,
    { url: "https://example.invalid/x" },
  ), SelectorDriftError);
});

test("parseDetailPage: a section the page does not carry stays absent, not empty", () => {
  const html = `<div class="detail"><div class="title">指导案例900号：测试</div>
    <div class="clearfix detail_mes"><ul class="clearfix fl message">
      <li class="fl">来源：测试</li><li class="fl">发布时间：2026-01-01 00:00:00</li></ul></div>
    <div class="txt big"><div class="txt_txt">　　关键词<br />民事/测试<br /><strong>　　裁判要点</strong><br />1.要点</div>
    <div class="txt_etr"><span class="fr">责任编辑：x</span></div></div></div>`;
  const page = parseDetailPage(html, { url: detailUrl("900") });
  assert.deepEqual(page.sectionOrder, ["关键词", "裁判要点"]);
  assert.equal(page.sections.keyword, "民事/测试");
  assert.equal(page.sections.gist, "1.要点");
  assert.equal(page.sections.facts, null);
  assert.equal(page.sections.reasoning, null);
});

test("parseDetailPage: a batch notice carries no sections but keeps its body", () => {
  const page = parseDetailPage(detailNotice, { url: detailUrl("4213") });
  assert.equal(page.sectionOrder.length, 0);
  assert.match(page.title, /第一批指导性案例的通知/);
  assert.match(page.body, /指导案例/);
});

test("parseDetailPage throws on a page that lost its pinned containers", () => {
  assert.throws(() => parseDetailPage("<html><body>nothing here</body></html>"), SelectorDriftError);
});

test("splitSections tolerates a heading that shares its line with content", () => {
  const { fields } = splitSections("关键词 民事/合同\n裁判要点\n1.内容");
  assert.equal(fields.keyword, "民事/合同");
  assert.equal(fields.gist, "1.内容");
  assert.equal(fields.facts, null);
});

test("splitSections does not mistake a content line for a heading", () => {
  const { fields } = splitSections("关键词\n民事/合同\n裁判理由认为本案应当驳回\n裁判要点\n1.内容");
  assert.equal(fields.keyword, "民事/合同\n裁判理由认为本案应当驳回");
  assert.equal(fields.gist, "1.内容");
  assert.equal(fields.reasoning, null);
});

test("splitSections keeps unrecognized leading text out of the sections", () => {
  const { fields, preamble } = splitSections("指导性案例279号\n（最高人民法院审判委员会讨论通过）\n关键词\n民事/合同");
  assert.deepEqual(preamble, ["指导性案例279号", "（最高人民法院审判委员会讨论通过）"]);
  assert.equal(fields.keyword, "民事/合同");
});
