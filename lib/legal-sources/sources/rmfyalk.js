// People's Court Case Library. Endpoints were read from the live front-end
// bundle on 2026-09-23: POST /cpws_al_api/api/cpwsAl/search and
// POST /cpws_al_api/api/cpwsAl/content; both take JSON bodies.
import { cleanText, firstDefined, firstArray, createHttpSourceAdapter } from "./common.js";
import { SessionProxyError } from "../errors.js";

const BASE = process.env.RMFYALK_BASE_URL ?? "https://rmfyalk.court.gov.cn";
const LIST_URL = process.env.RMFYALK_LIST_URL ?? `${BASE}/cpws_al_api/api/cpwsAl/search`;
const DETAIL_URL = process.env.RMFYALK_DETAIL_URL ?? `${BASE}/cpws_al_api/api/cpwsAl/content`;

const TYPE_LABELS = { "01": "指导性案例", "02": "参考案例", "04": "特色案事例" };
const GROUP_LABELS = {
  "01": "老年案例",
  "02": "未成年人案例",
  "03": "社会关注案例",
  "04": "涉军案例",
  "05": "多元解纷案例",
  "06": "典型案例",
};

function parseListResponse(json) {
  if (json?.code === "401" || /未登录/.test(String(json?.msg ?? ""))) {
    throw new SessionProxyError("Rmfyalk search requires a logged-in session", { code: "LOGIN_REQUIRED" });
  }
  const rows = firstArray(json, ["data.datas", "data.list", "datas", "rows", "list"]);
  return rows
    .filter((row) => firstDefined(row, ["id", "cpws_al_id"]))
    .map((row) => {
      const id = String(firstDefined(row, ["id", "cpws_al_id"]));
      const type = String(firstDefined(row, ["cpws_al_type"]) ?? "");
      return {
        source_id: id,
        title: cleanText(firstDefined(row, ["cpws_al_title", "title"])),
        url: `${BASE}/view/content.html?id=${encodeURIComponent(id)}&lib=${type === "02" ? "ck" : type === "04" ? "tssp" : "zdx"}`,
        doc_type: type === "02" ? "reference-case" : type === "04" ? "featured-case" : "guiding-case",
        published_at: firstDefined(row, ["cpws_al_publish_time", "cpws_al_update_time", "publish_time"]),
        effective_at: null,
        status: firstDefined(row, ["cpws_al_status"]) === "02" ? "失效" : "有效",
        authority: firstDefined(row, ["cpws_al_court_name", "court_name"]),
        metadata_from_list: {
          case_no: cleanText(firstDefined(row, ["cpws_al_no", "case_no"])),
          infos: cleanText(firstDefined(row, ["cpws_al_infos", "infos"])),
          gist: cleanText(firstDefined(row, ["cpws_al_cpyz", "cpyz"])),
          type,
          groups: Array.isArray(row.cpws_al_group) ? row.cpws_al_group.map((g) => GROUP_LABELS[g] ?? g) : row.cpws_al_group ?? null,
          case_sort_ids: row.cpws_al_case_sort_id ?? null,
        },
      };
    });
}

const SECTION_FIELDS = [
  ["裁判要点", "cpws_al_cpyz"],
  ["基本案情", "cpws_al_jbaq"],
  ["裁判结果", "cpws_al_cpjg"],
  ["裁判理由", "cpws_al_cply"],
  ["相关法条", "cpws_al_glsy"],
  ["执行实施要点", "cpws_al_cpyz"],
  ["执行结果", "cpws_al_cpjg"],
  ["执行理由", "cpws_al_cply"],
  ["执行要旨", "cpws_al_cpyz"],
  ["调解结果", "cpws_al_cply"],
  ["调解指引", "cpws_al_cpyz"],
  ["案例价值", "cpws_al_aljz"],
  ["关联索引", "cpws_al_glsy"],
];

function parseDetailResponse(json) {
  const row = firstDefined(json, ["data.data", "data", "content"]);
  if (!row || typeof row !== "object") return null;
  const sections = {};
  for (const [heading, key] of SECTION_FIELDS) {
    const value = cleanText(row[key]);
    if (value && sections[heading] == null) sections[heading] = value;
  }
  const body = Object.entries(sections).map(([heading, text]) => `${heading}\n${text}`).join("\n\n") || null;
  const type = String(firstDefined(row, ["cpws_al_type"]) ?? "");
  return {
    title: cleanText(firstDefined(row, ["cpws_al_title", "title"])),
    published_at: firstDefined(row, ["cpws_al_publish_time", "cpws_al_update_time"]),
    effective_at: null,
    status: firstDefined(row, ["cpws_al_status"]) === "02" ? "失效" : "有效",
    authority: firstDefined(row, ["cpws_al_court_name", "court_name", "cpws_al_ts_name"]),
    language: "zh-CN",
    content: body,
    metadata: {
      case_no: cleanText(firstDefined(row, ["cpws_al_no", "case_no"])),
      keywords: Array.isArray(row.cpws_al_keyword) ? row.cpws_al_keyword.map(cleanText) : cleanText(row.cpws_al_keyword),
      subtitle: cleanText(row.cpws_al_sub_title),
      type,
      type_label: TYPE_LABELS[type] ?? null,
      groups: Array.isArray(row.cpws_al_group) ? row.cpws_al_group.map((g) => GROUP_LABELS[g] ?? g) : row.cpws_al_group ?? null,
      case_sort_ids: row.cpws_al_case_sort_id ?? null,
      court_division: cleanText(row.cpws_al_ts_name),
      updated_at: firstDefined(row, ["cpws_al_update_time"]),
      download_url: `${BASE}/cpws_al_api/api/cpwsAl/contentDownload?id=${encodeURIComponent(String(firstDefined(row, ["cpws_al_id", "id"]) ?? ""))}`,
    },
    sections,
  };
}

export const rmfyalkAdapter = createHttpSourceAdapter({
  id: "rmfyalk-case-library",
  envPrefix: "RMFYALK",
  docType: "case",
  rateMs: Number(process.env.RMFYALK_RATE_MS ?? 1100),
  list: {
    kind: "json",
    method: "POST",
    url: LIST_URL,
    size: Number(process.env.RMFYALK_PAGE_SIZE ?? 10),
    body: ({ page, size = 10, scope = "all" }) => ({
      page,
      size,
      searchParams: {
        userSearchType: 1,
        isAdvSearch: "0",
        selectValue: "qw",
        lib: scope === "guiding" ? "cpwsAl_01" : scope === "reference" ? "cpwsAl_02" : "cpwsAl_qb",
        sort_field: "",
      },
    }),
    totalPaths: ["data.totalCount", "data.total", "totalCount"],
    pagesPaths: ["data.totalPage", "totalPage"],
  },
  parseList: parseListResponse,
  detail: {
    kind: "json-post",
    urlFromEntry: () => DETAIL_URL,
    body: (entry) => ({ gid: encodeURIComponent(entry.source_id) }),
  },
  parseDetail: parseDetailResponse,
});

export default rmfyalkAdapter;
