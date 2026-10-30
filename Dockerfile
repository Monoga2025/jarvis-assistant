FROM node:24.15.0-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY eslint.config.js tsconfig.json tsconfig.build.json ./
COPY plugins ./plugins
COPY config/openclaw.railway.json5 ./config/openclaw.railway.json5
RUN npm run build \
  && npm run plugin:validate \
  && OPENCLAW_CONFIG_PATH=/app/config/openclaw.railway.json5 \
     OPENCLAW_GATEWAY_TOKEN=build-validation-token-0123456789abcdef \
     JARVIS_TIMEZONE=America/Bogota \
     TELEGRAM_OWNER_ID=123456789 \
     GOOGLE_PRIMARY_CALENDAR_ID=primary \
     GOOGLE_MANAGED_CALENDAR_ID=jarvis-calendar-disabled \
     JARVIS_DATABASE_PATH=/data/jarvis-v1/jarvis.sqlite \
     JARVIS_PLUGIN_PATH=/app/plugins/jarvis-tools \
     ./node_modules/.bin/openclaw config validate \
  && npm prune --omit=dev

FROM node:24.15.0-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu gzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/plugins/jarvis-tools/dist ./plugins/jarvis-tools/dist
COPY --chown=node:node plugins/jarvis-tools/package.json plugins/jarvis-tools/openclaw.plugin.json ./plugins/jarvis-tools/
COPY --from=build --chown=node:node /app/config/openclaw.railway.json5 ./config/openclaw.railway.json5
COPY --chown=node:node workspace ./workspace
COPY --chown=node:node data ./data
COPY deploy/railway-entrypoint.sh ./deploy/railway-entrypoint.sh
COPY deploy/configure-automations.sh ./deploy/configure-automations.sh
COPY deploy/migrate-session-model.sh ./deploy/migrate-session-model.sh

RUN chmod 0755 /app/deploy/railway-entrypoint.sh /app/deploy/configure-automations.sh /app/deploy/migrate-session-model.sh \
  && install -d -o node -g node -m 0700 /data

# Railway mounts volumes as root. The entrypoint performs only bounded ownership
# and secret-file initialization, then replaces itself with OpenClaw as uid 1000.
USER root
ENTRYPOINT ["/app/deploy/railway-entrypoint.sh"]
CMD ["/app/node_modules/.bin/openclaw", "gateway"]
