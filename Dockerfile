FROM node:22-bookworm-slim AS builder

ARG NPM_REGISTRY=""

WORKDIR /app

RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
  && npm install -g pnpm@12.21.0 \
  && if [ -n "$NPM_REGISTRY" ]; then pnpm config set registry "$NPM_REGISTRY"; fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.server.json tsconfig.web.json vite.config.ts ./
COPY scripts ./scripts
COPY src ./src

RUN pnpm typecheck && pnpm build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV ASSETNEST_DATA_DIR=/data
ENV ASSETNEST_CONFIG_PATH=/config/config.yaml

RUN mkdir -p /data/db /data/assets /data/cache /data/imports /data/exports /data/backups /config \
  && chown -R node:node /data /config /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node config/config.example.yaml /app/config.example.yaml

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
