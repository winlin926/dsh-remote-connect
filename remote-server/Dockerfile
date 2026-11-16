# syntax=docker/dockerfile:1.7
# Build context MUST be the repository root (compose.yaml sets `context: ..`)
# because tsconfig.json compiles the shared tunnel protocol from src/remote.
FROM node:24-alpine AS build
WORKDIR /build

# Server dependencies only: ws + zod (+ TypeScript for the build).
COPY remote-server/package.json remote-server/package-lock.json ./remote-server/
RUN cd remote-server && npm ci --no-audit --no-fund

# Shared protocol sources and the server itself (node_modules/dist are rebuilt).
COPY src ./src
COPY remote-server/tsconfig.json ./remote-server/tsconfig.json
COPY remote-server/src ./remote-server/src
COPY remote-server/web ./remote-server/web
RUN cd remote-server && npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    BIND_HOST=0.0.0.0 \
    DATA_DIR=/data
WORKDIR /app
RUN mkdir -p /data && chown node:node /data

COPY --from=build /build/remote-server/dist ./dist
COPY --from=build /build/remote-server/node_modules ./node_modules
COPY --from=build /build/remote-server/web ./web
COPY --from=build /build/remote-server/package.json ./package.json

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/remote-server/src/main.js"]
