# fd-law-data crawler image (flk incremental crawl; no PG client-side need
# beyond the loader which runs on the data machine, not in this image).
# curl is required by lib/auth-broker/proxy-fetch.js: identity-bound egress
# (rmfyalk platform session) shells out to curl for its TLS fingerprint;
# without it every proxied request fails with "spawn curl ENOENT" and the
# crawl silently reports listed=0 (page-level failure, not fatal).
FROM docker.m.daocloud.io/library/node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Tencent's apt mirror over plain http: the daocloud slim base ships no
# system CA store, so https mirrors fail handshake (apt package integrity is
# GPG-verified regardless of transport).
RUN sed -i 's|https://deb.debian.org|http://mirrors.cloud.tencent.com|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit --registry=https://registry.npmmirror.com

COPY lib/ lib/
COPY bin/ bin/

RUN useradd -m crawler && chown -R crawler /app
USER crawler

CMD ["node", "bin/flk-crawl.mjs"]
