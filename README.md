# fd-law-data

Incremental crawlers + loaders for Chinese legal open data. Node.js >= 20;
runtime dependencies: `pg` (flk loader) and `playwright` (wenshu browser side).

| Module | Source | Output | Runs where |
|---|---|---|---|
| `bin/flk-crawl.mjs` | flk.npc.gov.cn (no login) | `laws` bucket `incremental/` JSONL + docx | cluster CronJob (helm-law-scraw `flkLawCrawl`) |
| `bin/flk-load.mjs` | `laws` bucket `incremental/` | `law_db.laws` rows → `law_chunks` (embedded=false) → `laws-export` shards | **data machine** (PG is 127.0.0.1-only there) |
| `bin/guide-cases-crawl.mjs` | court.gov.cn 指导案例 column (no login) | `laws` bucket `guide-cases/` JSONL + manifest | cluster CronJob (suspended by default) or local |
| `bin/guide-cases-load.mjs` | `laws` bucket `guide-cases/` | `law_db.guide_cases` rows + curated 不再参照 status | **data machine** |
| `scripts/verify-publish-format.mjs` | `law_db` | publish-format report + recommended first `--since` | data machine |
| `bin/wenshu-login.mjs` | wenshu session bootstrap (local, headed; human solves the slider) | `wenshu` bucket `sessions/` session jar | local (operator machine) |
| `bin/wenshu-crawl.mjs` | wenshu.court.gov.cn daily incremental (login-gated) | `wenshu` bucket `raw/{y}/{m}/` JSONL + manifest + seen-set | **operator Mac only** (home IP + warm browser; the cluster CronJob is not a supported shape — see below) |
| `bin/wenshu-load.mjs` | `wenshu` bucket `raw/` | `wenshu_db` src_files/dict_texts/judgments + month `blocks/` rebuild | **data machine** (wherever `wenshu_db` is reachable) |
| `bin/wenshu-probe.mjs` | wenshu spike/diagnostics (local) | JSON probe report | local (needs valid session) |

The crawler holds **no PG credentials**; the loader holds no crawler secrets.
Credentials come from `.env` (see `.env.example`) or the k8s Secret
`flk-law-crawl-credentials` (keys: `rustfs-access-key`, `rustfs-secret-key`).

## Wave-1 authoritative legal sources

These sources share one runtime (`lib/legal-sources/runtime.js`), one object
layout, and one idempotent table (`law_db.legal_documents`):

| Source id | Entry points | Access known on 2026-09-23 | Output |
|---|---|---|---|
| `rmfyalk-case-library` | `bin/rmfyalk-{crawl,load}.mjs` | search/content APIs require login (`401 未登录`); endpoints verified from the live front-end bundle | `legal-sources/rmfyalk-case-library/` |
| `mfa-treaty-library` | `bin/mfa-treaty-{crawl,load}.mjs` | public server-rendered list/detail pages | same pattern under `legal-sources/mfa-treaty-library/` |
| `gov-rules-library` | `bin/gov-rules-{crawl,load}.mjs` | public HTML parser; override `GOV_RULES_LIST_URL` if the MOJ/gov.cn path moves | same pattern |
| `party-regulation-library` | `bin/party-regulation-{crawl,load}.mjs` | public 12371.cn special/category pages | same pattern |
| `ccdi-supervisory-regulations` | `bin/ccdi-supervisory-{crawl,load}.mjs` | plain HTTP reaches a JS cookie challenge; it is recorded as structure drift, never parsed as content | same pattern |

```bash
# read-only; writes nothing
node bin/rmfyalk-crawl.mjs --dry-run --size 1 --max-pages 1
node bin/mfa-treaty-crawl.mjs --dry-run --max-pages 1

# crawler: object storage only
node bin/<source>-crawl.mjs --full       # first sweep
node bin/<source>-crawl.mjs              # incremental state/hash refresh

# data machine: legal_documents only; guards laws/law_chunks row counts
node bin/<source>-load.mjs
node bin/legal-sources-report.mjs        # cross-source coverage/gaps
```

Object layout is deliberately append-only:

```text
legal-sources/<source>/
  structured/run-YYYY-MM-DD-partNNN.jsonl
  manifest/run-YYYY-MM-DD-<runid>.manifest.json
  raw/<source_id>/...                     # response/HTML snapshots
  attachments/<source_id>/...             # PDF/docx; DB stores keys, not blobs
  state.json                              # hashes, retry queue, watermark
```

`legal_documents` has a unique `(source, source_id)` key. Unchanged hashes are
skipped; changed hashes update in place. The loader only writes this table and
fails if `laws`/`law_chunks` counts move. Verify the DDL without mutating PG:

```bash
npm run verify:legal-documents-ddl     # temp schema + transactional rollback
```

### Rmfyalk session note

A live dry-run on 2026-09-23 reached the API but got `{"code":"401"}`. The
adapter raises `SessionProxyError("LOGIN_REQUIRED")` rather than recording an
empty corpus. CronJobs therefore ship suspended until a source-scoped session
and, if required, `RMFYALK_CASE_LIBRARY_PROXY_URL` are provisioned.

### FLK historical backfill

`--backfill` is a separate cursor (`incremental/backfill-state.json`) and output
prefix (`incremental/backfill/`) so it cannot move the daily watermark. It seeds
`known` and `src_seq` from the live incremental state, so already-crawled ids
are not re-fetched and src_id never collides.

```bash
# one bounded window per run; safe to run repeatedly
node bin/flk-crawl.mjs --backfill --until 2026-09-23 --batch-days 365

# coverage: completed windows, local rows by category/year, optional source totals
node scripts/flk-backfill-report.mjs
node scripts/flk-backfill-report.mjs --live
```

The loader accepts both `incremental/...` and `incremental/backfill/...` part
files, applies the same `(src_db, source_id)` skip, and still refuses to modify
`law`/`lawv2` historical rows.

### Auth Broker / identity pool

The independent `legal-auth-broker` image owns human login, per-account browser
profiles, proxy identity binding, encrypted session extraction and identity
leases. Crawler images never log in and never contain account credentials.

Core objects:

```text
db/002_legal_source_identity.sql      identity + lease + audit tables
lib/auth-broker/identity.js           lease SQL / state machine
lib/auth-broker/session-jar.js        AES-256-GCM jar + redaction
lib/auth-broker/browser-profile.js    per-identity Chromium profile
lib/auth-broker/logins/rmfyalk.js     captures faxin-cpws-al-token
lib/auth-broker/proxy.js              same/cross-proxy probes and policy
lib/auth-broker/service.js            internal lease API
bin/legal-auth-broker.mjs             serve / login / probe
Dockerfile.auth-broker                generic browser/login image
k8s/legal-auth-broker.yaml            job, lease API and internal Service
```

Operational flow:

```bash
# one-time secret material (values are examples only)
# kubectl -n scraw create secret generic legal-auth-broker \
#   --from-literal=broker-token=<random> \
#   --from-literal=jar-key=<32-byte-base64> \
#   --from-literal=vnc-password=<random>

# create an identity-specific Secret for proxy ids and the login proxy URL.

# login job: open noVNC only through a private tunnel
kubectl -n scraw apply -f k8s/legal-auth-broker.yaml
kubectl -n scraw port-forward pod/<login-pod> 6080:6080
# open http://127.0.0.1:6080/vnc.html and complete the upstream login

# broker lease API is ClusterIP-only
node bin/legal-source-crawl.mjs --source rmfyalk-case-library \
  --account-id acct001 --dry-run
```

Default policy is `login_proxy_id == crawl_proxy_id`. A different crawl proxy
must pass login-proxy probe, crawl-proxy probe and a small-batch run before it
is allowed. Logs emit identity/proxy/status only; tokens, cookies, names and
national identifiers are redacted.

### Deployment debt before enabling CronJobs

1. Push a Jenkins image containing this code (the manifests currently reference
   the placeholder tag `v0.2.0-legal-sources`) and pin that immutable sha tag.
2. Apply `k8s/legal-source-crawl-cronjobs.yaml` or the `helm-law-scraw`
   `legalSources` block; `helm template` renders six CronJobs.
3. Leave every new CronJob suspended until its real dry-run/load check passes.

## Daily operation

```bash
# cluster (normally via the CronJob; manual run shown)
node bin/flk-crawl.mjs                # window = watermark - 7d .. today

# data machine: catalog -> chunks -> export shards (embed workers pick up shards)
node bin/flk-load.mjs                 # add --dry-run / --no-chunks / --no-export as needed
```

First run ever: seed the watermark from the historical catalog (data machine):

```bash
node scripts/verify-publish-format.mjs        # prints: Recommended first-run seed: --since YYYY-MM-DD
# then run the crawler once with that date (any machine):
node bin/flk-crawl.mjs --since 2024-06-30
```

## Reconciliation (daily, ~1 min)

1. Crawl manifest: `incremental/{y}/{m}/flk-YYYY-MM-DD.manifest.json` —
   `candidates` vs `emitted` vs `counts{ok,pending,missing}`.
2. Loader stdout: files processed / laws inserted / chunks / export shards.
3. Spot-check: `SELECT count(*) FROM laws WHERE src_db='flk'` grows by the
   manifest's `ok+pending+missing`; `law_chunks` grows accordingly.

## Recovery procedures

**Non-ok records (pending/missing):** nightly order is crawl → retry-pending →
load, so fixed records are INSERTed once, complete. `--retry-pending` rewrites
the daily JSONL in place; the loader (INSERT-only by spec) skips source ids it
has already inserted — therefore a record that reached PG as `pending` before a
retry needs the manual UPDATE (rare; chunks/vectorization only ever derive from
`content_status='ok'` rows, so pending rows are inert until fixed):

```bash
node bin/flk-crawl.mjs --retry-pending --days 14
# data machine, for any row already loaded as pending whose JSONL is now ok:
#   UPDATE laws SET content = $content, content_status = 'ok', file_path = $path
#   WHERE src_db = 'flk' AND source_id = $bbbs;
```

To make the loader re-read a file from scratch: it already reprocesses
automatically whenever a daily file's content hash changes (backfill appended
to the same day, or `--retry-pending` rewrote records) — the `.done` marker
stores the sha256 it last processed. Shards are rewritten under the same
rule; ingestion stays idempotent via `(src_db, source_id)` skips.

**State loss** (`incremental/state.json` deleted): re-seed with
`--since <watermark-from-before>`; `src_id` restarts its sequence — loader
dedup is `(src_db, source_id)` via ON CONFLICT, and recycled `src_id` values on
*new* source ids simply occupy fresh rows (`uq_laws_src` conflicts are skipped).

**flk site change:** list/detail/download shapes are pinned by tests + the
live findings in `openspec/changes/flk-law-incremental/design.md` (D7). A
redesign means re-running that spike; crawler failures are loud (non-zero
exit), never silent truncation.

## Testing

```bash
npm install
npm test                 # unit tests (chunker lossless, docx extraction, keys)
RUSTFS_SMOKE=1 node --test test/s3-signing.test.mjs   # live read-only SigV4 check
node bin/flk-crawl.mjs --dry-run --since 2026-08-01 --codes 201   # live crawl, no S3 writes
```

## Deployment (live)

**xinru cluster, `scraw` namespace** (where the proxy/scraw infra actually
runs — NOT the migrating cheap cluster):

```bash
# one-time secrets (already created 2026-09-18):
#   harbor-lawcraw-pull            — dockerconfigjson for 100.64.0.8:30880/lawcraw_business
#   flk-law-crawl-credentials      — rustfs-access-key / rustfs-secret-key
kubectl -n scraw apply -f k8s/flk-crawl-cronjob.yaml   # daily 02:30 Asia/Shanghai
```

Image: **built by the Jenkins job `fd-law-data`** — gitee push (webhook token
`fd-law-data`) → `docker build` → push to `100.64.0.8:30880/lawcraw_business/`,
tagged with the immutable `sha-<short-hash>` of the commit it was built from
(push a branch and read the tag off the build log, then pin it in the
manifest). The job also builds the Playwright image via the `BUILD_WENSHU`
parameter, off by default because the build node's disk is tight.

```bash
# trigger by hand (or just push to main — the webhook does it):
#   https://jenkins.finddatatech.cloud/job/fd-law-data/build
# the pipeline is the fleet's standard shape; copy from it rather than improvise
```

Historically these images were hand-built via cheap-1
(`docker buildx --builder law-builder`): before the gitee repo and the Jenkins
job existed there was no other channel, so `v0.1.x` tags are not reproducible
and predate the job. New pins use `sha-<hash>` only.

## Guiding cases (指导性案例)

## Guiding cases (指导性案例)

The SPC's guiding cases: the case library's most authoritative tier, published
in full on the court's own site behind **no login** — the batch column at
`/shenpan/gengduo/77.html` (15 pages, 1–279号; 45号 has never appeared in it)
plus a detail page per case carrying 关键词 / 裁判要点 / 基本案情 / 裁判结果 /
裁判理由 / 相关法条. Batch-release notices live in the same column and are
captured too (`doc_type='notice'`). Decision record and alternatives:
`openspec/changes/court-guiding-cases/design.md`.

The corpus is ~280 documents (a few MB), so there is no watermark: each run
**sweeps the whole column** and re-fetches a case only when its content hash
changed. That also keeps a date-based scheme's blind spot — a case edited in
place under an unchanged date — visible.

```bash
# any machine with RustFS credentials
node bin/guide-cases-crawl.mjs --list        # column sweep only: counts + holes
node bin/guide-cases-crawl.mjs --dry-run     # full parse, writes nothing
node bin/guide-cases-crawl.mjs               # -> laws bucket guide-cases/
node bin/guide-cases-crawl.mjs --limit 5     # smoke run on the newest cases

# data machine (law_db reachable)
node bin/guide-cases-load.mjs                # upsert + apply the deprecation list
node bin/guide-cases-load.mjs --dry-run      # report only
```

`--limit` writes a manifest flagged `partial: true`; it is a smoke mode, not
a release.

### Reference status (不再参照)

Deprecations come from standalone SPC notices in the 权威发布 column, which the
channel list pages do **not** index — only the site's own search
(`/search.html?content=不再参照`) surfaces them, so they cannot be discovered
by crawling. Two are known (site search, 2026-09-21; re-check when the column
gains a batch):

| Notice | Effective | Cases |
|---|---|---|
| 法〔2020〕343号 | 2021-01-01 | 9号、20号 |
| 法〔2026〕119号 | 2026-08-15 | 123号、136号、139号、204号 |

The list lives in `lib/guidecases/deprecations.js` and is applied by the
loader, so extending it needs no re-crawl. A deprecated case stays in the
corpus — the notice withdraws the reference, not the case.

### Reconciliation (per run, ~1 min)

Three counts that must agree:

1. crawl manifest: `sweep.entries` / `sweep.cases` / `coverage.missing`
   (the column's own pager total is cross-checked during the sweep — a
   mismatch aborts the run);
2. `SELECT count(*) FROM guide_cases WHERE doc_type='case'`;
3. loader summary `rows.cases` / `rows.deprecated`.

The loader prints `missingNumbersInDb` as well, and refuses to finish if
`laws` or `law_chunks` row counts moved during the load.

### Testing

```bash
node --test test/guidecases-*.test.mjs   # parsers, sweep, idempotency — no network
```

Fixtures under `test/fixtures/guidecases/` are trimmed slices of live pages; a
site redesign shows up as `SelectorDriftError` (a case page with no known
section heading aborts the run) or as a sweep-total mismatch.

## wenshu

Daily incremental capture from wenshu.court.gov.cn into the existing
`wenshu_db` / `wenshu` bucket shape (catalog rows + full-text blocks),
idempotent on re-runs. Full decision record:
`openspec/changes/wenshu-incremental-crawl/{proposal,design}.md`.

### Session bootstrap / refresh

One-time setup on a local machine with a display (the helper is headed):

```bash
### Session model (live-verified 2026-09-19): the STANDING WARM BROWSER

Wenshu sessions are **activity-bound server-side**: an idle session dies in
~20 min regardless of what cookies/localStorage a browser holds. Transplanting
a jar to another browser/IP/context gets rejected. A durable login state is
therefore a dedicated always-on browser whose keepalive never lets the
session idle — the same reason the operator's own Chrome stays logged in.

**Operational shape:**

```bash
# 1) start the standing browser ONCE (survives days/weeks; minimize, never close)
node scripts/wenshu-warm-browser.mjs      # opens a window; pass the word-click
                                          # captcha ONCE; keepalive (5 min) takes
                                          # over; state file /tmp/wenshu-warm-state.json

# 2) crawls ATTACH to it via CDP (nightly, on-demand, or manual):
node bin/wenshu-crawl.mjs --cdp http://localhost:9223
```

Re-login is needed ONLY when the standing browser is closed/killed or the Mac
reboots (symptom: crawl exits 42 with `WARM_BROWSER`). One captcha pass
restores it.

Legacy helpers (kept for fallbacks):

```bash
node bin/wenshu-login.mjs                 # one-shot login → jar upload; the jar
                                           # goes stale in minutes (activity-bound)
                                           # — usable only with --profile immediately
node bin/wenshu-crawl.mjs --profile ~/.cache/fd-law-data/wenshu-login-profile
node scripts/wenshu-jar-refresh.mjs       # extract a jar from the operator's own
                                           # logged-in Chrome (snapshot + promote
                                           # session cookies + CDP export)
```

The account comes from `.env` (`WENSHU_ACCOUNT_USER` /
`WENSHU_ACCOUNT_PASSWORD`) — values are NEVER committed. The crawler
fail-louds (exit 42) whenever the session is invalid; it never crawls
logged-out.

**The cluster is the wrong place to run this.** A jar-based cold start works
only when the jar is fresh AND the egress IP matches where the login happened;
the site bans on exactly that mismatch. Until a sticky egress (design.md D6) is
in place, the only supported shape is the **standing warm browser on the
operator Mac** (home/office IP) driven by the local nightly. The cluster
CronJob and its manifest are kept for that sticky-egress future and both carry
`suspend: true`; on 2026-09-21 the live one was deleted after it had fired
daily from the datacenter IP with the account attached while the account was
already banned (read the warning at the top of
`k8s/wenshu-crawl-cronjob.yaml` before re-applying it).

### Daily operation

Nightly order, on the operator Mac (home IP, warm browser on CDP 9223):
`wenshu-nightly.mjs` crawl → `bin/wenshu-load.mjs` (data machine, manual or
cron — wherever `wenshu_db` is reachable; tailnet PG per `.env`).

Meta-only runs (`--meta-only`) capture the full metadata row — 案号 / 标题 /
判决时间 / 法院 — without touching a single detail page, and land as
`crawl-{date}-meta{N}.jsonl`. They have **no 发布时间** (that field only exists
on the detail page), so filter these rows by 判决时间, not 发布时间.

Each crawl writes `raw/{y}/{m}/crawl-{date}.jsonl` plus
`crawl-{date}.manifest.json`, and updates the per-month seen-set
`raw/{y}/{m}/seen.json` — it blocks look-back duplicates within the month;
runs also union-check adjacent months at window boundaries. Loader rules:

- feed-CSV precedence: a month with a registered monthly feed CSV skips
  crawled files for that month;
- per-file DELETE→INSERT — re-loading a daily file is a no-op;
- month block rebuild: `blocks/{y}/{m}/*.zst` (8 MiB raw payload, zstd-19,
  `WENSHUBLOCK1` header with `docs[]`/`offsets[]`) — month-prefix rewrite only;
- single-doc retrieval verify on every run.

### Reconciliation (daily, ~2 min)

Three counts that must agree:

1. manifest `emitted` / `counts`;
2. `SELECT count(*) FROM judgments WHERE src_id = (SELECT src_id FROM src_files WHERE path='raw/{y}/{m}/crawl-{date}.jsonl')`;
3. block doc count for the month (summed over the month's files):
   `SELECT count(*) FROM judgments WHERE block_key LIKE 'blocks/{y}/{m}/%'`.

Investigate when they diverge. `truncated: true` in a manifest means the
nightly budget ran out before finishing — occasional is fine; sustained means
volume outgrew the window (phase-2 trigger, design.md D1).

### Volume watch / phase-2 trigger

Watch manifest `candidates` per day. Sustained >~50k docs/day, or more than 3
consecutive `truncated` manifests → the browser route cannot keep up → time
for the phase-2 decision (API reverse-engineering + account pool), per
design.md D1.

### Spike / selector drift

```bash
node bin/wenshu-probe.mjs --session-health --search-map --detail 3 --volume
```

Local, needs a valid session. The output JSON is exactly the format to paste
into `openspec/changes/wenshu-incremental-crawl/design.md`.

Site-redesign symptom: crawl exits with `selector-drift:` errors → fix the
SELECTORS in `lib/wenshu/site.js` only (single source), re-run the probe.

### Testing

```bash
node --test test/wenshu-*.test.mjs   # pure/unit, no live site
```

There is no live-crawl dry-run against wenshu (login-gated) — the probe tool
is the live check.

### Deployment (live)

**xinru cluster, `scraw` namespace**: helm chart `wenshuCrawl` block, or the
standalone `k8s/wenshu-crawl-cronjob.yaml`. Image:
`lawcraw_business/fd-law-data-wenshu` — Playwright image built from
`fd-law-data/Dockerfile.wenshu`.

Secret `wenshu-crawl-credentials` keys: `rustfs-access-key`,
`rustfs-secret-key`, `wenshu-account-user`, `wenshu-account-password`. Real
account values enter ONLY via local-only kubectl/values — never committed. PG
credentials never enter the crawler. The loader runs wherever `wenshu_db` is
reachable (data machine / tailnet PG per `.env`).
