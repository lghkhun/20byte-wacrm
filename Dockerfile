FROM node:20-alpine AS base

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate

FROM base AS builder

ENV NODE_OPTIONS=--max-old-space-size=2048
ENV NEXT_TELEMETRY_DISABLED=1

COPY . .
RUN sh -lc ' \
  (while true; do echo "[docker-build] next build still running..."; sleep 30; done) & \
  heartbeat_pid=$!; \
  npm run build; \
  build_status=$?; \
  kill "$heartbeat_pid" 2>/dev/null || true; \
  wait "$heartbeat_pid" 2>/dev/null || true; \
  exit "$build_status" \
'

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=base /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/postcss.config.js ./postcss.config.js
COPY --from=builder /app/tailwind.config.ts ./tailwind.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/public ./public
COPY --from=builder /app/app ./app
COPY --from=builder /app/components ./components
COPY --from=builder /app/hooks ./hooks
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/server ./server
COPY --from=builder /app/styles ./styles
COPY --from=builder /app/types ./types
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/middleware.ts ./middleware.ts
COPY --from=builder /app/next-env.d.ts ./next-env.d.ts
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
COPY --from=builder /app/scripts/run-with-local-env.mjs ./scripts/run-with-local-env.mjs

RUN mkdir -p /app/.runtime/baileys-auth /app/.runtime/baileys-media
RUN chmod +x /app/scripts/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
