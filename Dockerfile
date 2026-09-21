# fd-law-data crawler image (flk incremental crawl; no PG client-side need
# beyond the loader which runs on the data machine, not in this image).
FROM docker.m.daocloud.io/library/node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit --registry=https://registry.npmmirror.com

COPY lib/ lib/
COPY bin/ bin/

RUN useradd -m crawler && chown -R crawler /app
USER crawler

CMD ["node", "bin/flk-crawl.mjs"]
