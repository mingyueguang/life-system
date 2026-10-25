FROM node:24-bookworm-slim AS deps
WORKDIR /app
# npm install (instead of npm ci): the repository keeps package-lock.json locally,
# but the remote copy may lag package.json; install reconciles and regenerates it.
COPY package.json ./
RUN npm install --no-audit --no-fund
FROM deps AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 DATABASE_PATH=/data/life.sqlite
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app && mkdir -p /data && chown app:app /data
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/scripts ./scripts
COPY --from=builder --chown=app:app /app/server ./server
COPY --from=builder --chown=app:app /app/lib/record-schema.mjs ./lib/record-schema.mjs
# The standalone web bundle inlines zod; the separate scheduler imports it directly.
COPY --from=builder --chown=app:app /app/node_modules/zod ./node_modules/zod
USER app
EXPOSE 3000
CMD ["node","server.js"]
