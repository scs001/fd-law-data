// Zero-dependency config: merges .env (if present) over process.env.
// Storage-doc §3 contract: credentials live in .env, never in code.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnvFile(path = join(pkgRoot, ".env")) {
  const loaded = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return loaded;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
    loaded[key] = val;
  }
  return loaded;
}

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export function loadConfig(overrides = {}) {
  loadEnvFile();
  const env = process.env;
  return {
    // RustFS / S3
    s3Endpoint: overrides.s3Endpoint ?? env.RUSTFS_ENDPOINT,
    s3AccessKey: overrides.s3AccessKey ?? env.RUSTFS_ACCESS_KEY,
    s3SecretKey: overrides.s3SecretKey ?? env.RUSTFS_SECRET_KEY,
    s3Region: overrides.s3Region ?? env.RUSTFS_REGION ?? "us-east-1",
    lawsBucket: overrides.lawsBucket ?? env.LAWS_BUCKET ?? "laws",
    exportBucket: overrides.exportBucket ?? env.LAWS_EXPORT_BUCKET ?? "laws-export",
    // flk crawler pacing
    flkRateMs: num(overrides.flkRateMs ?? env.FLK_RATE_MS, 1100),
    flkPageSize: num(overrides.flkPageSize ?? env.FLK_PAGE_SIZE, 100),
    flkLookbackDays: num(overrides.flkLookbackDays ?? env.FLK_LOOKBACK_DAYS, 7),
    flkTz: overrides.flkTz ?? env.FLK_TZ ?? "Asia/Shanghai",
    // wenshu crawler
    wenshuBucket: overrides.wenshuBucket ?? env.WENSHU_BUCKET ?? "wenshu",
    wenshuRateMs: num(overrides.wenshuRateMs ?? env.WENSHU_RATE_MS, 1000),
    wenshuLookbackDays: num(overrides.wenshuLookbackDays ?? env.WENSHU_LOOKBACK_DAYS, 7),
    wenshuPageSize: num(overrides.wenshuPageSize ?? env.WENSHU_PAGE_SIZE, 10),
    wenshuResultCap: num(overrides.wenshuResultCap ?? env.WENSHU_RESULT_CAP, 200),
    wenshuTz: overrides.wenshuTz ?? env.WENSHU_TZ ?? "Asia/Shanghai",
    wenshuBudgetMs: num(overrides.wenshuBudgetMs ?? env.WENSHU_BUDGET_MS, 19 * 3600 * 1000),
    // account via env/Secret only — never logged, never committed
    wenshuAccountUser: overrides.wenshuAccountUser ?? env.WENSHU_ACCOUNT_USER,
    wenshuAccountPassword: overrides.wenshuAccountPassword ?? env.WENSHU_ACCOUNT_PASSWORD,
    // sticky exit proxy for wenshu egress (empty = direct; design.md D6)
    wenshuProxyUrl: overrides.wenshuProxyUrl ?? env.WENSHU_PROXY_URL,
    // guiding-cases column (court.gov.cn, no login)
    guideCasesPrefix: overrides.guideCasesPrefix ?? env.GUIDE_CASES_PREFIX ?? "guide-cases/",
    guideCasesRateMs: num(overrides.guideCasesRateMs ?? env.GUIDE_CASES_RATE_MS, 1100),
    // loader only
    pg: {
      host: overrides.pgHost ?? env.PG_HOST ?? "127.0.0.1",
      port: num(overrides.pgPort ?? env.PG_PORT, 5432),
      user: overrides.pgUser ?? env.PG_USER,
      password: overrides.pgPassword ?? env.PG_PASSWORD,
      database: overrides.pgDatabase ?? env.PG_DATABASE ?? "law_db",
    },
    // incremental embed worker (flk-embed; the historical corpus was embedded
    // with this exact service/model — pinned by the worker's self-check)
    embedEndpoint: overrides.embedEndpoint ?? env.EMBED_ENDPOINT ?? "https://api.siliconflow.cn/v1",
    embedApiKey: overrides.embedApiKey ?? env.EMBED_API_KEY,
    embedModel: overrides.embedModel ?? env.EMBED_MODEL ?? "Qwen/Qwen3-Embedding-0.6B",
    // No default: the vector store is deployment-specific. A hardcoded tailnet
    // address here would both leak infrastructure and silently point a new
    // deployment at someone else's collection.
    qdrantUrl: overrides.qdrantUrl ?? env.QDRANT_URL,
    qdrantCollection: overrides.qdrantCollection ?? env.QDRANT_COLLECTION ?? "law_chunks_v2",
  };
}
