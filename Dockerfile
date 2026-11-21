# syntax=docker/dockerfile:1
# Lab 8: one image = the Node game server + the built client it serves (one origin, no CORS).
#
#   docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t dogfight .
#   docker run --rm -p 8787:8787 dogfight            -> http://localhost:8787
#
# Three stages. Only the last one becomes the image: compilers, Vite, TypeScript, eslint and
# the source of the client never reach production — they stay in the throw-away stages.

# ---- 1. build: full install (dev deps too) and the Vite build of the client --------------------
FROM node:22-alpine AS build
WORKDIR /app
# package files FIRST: this layer (and the slow `npm ci`) is reused from cache until a
# dependency changes — editing a .ts file only re-runs the steps below it.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY client/ client/
ARG GIT_SHA
ARG RENDER_GIT_COMMIT
ENV GIT_SHA=${GIT_SHA:-${RENDER_GIT_COMMIT:-dev}}
RUN npm run build -w client

# ---- 2. deps: production dependencies of the server (and shared) only --------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace=server --workspace=shared --no-audit --no-fund \
 && npm cache clean --force

# ---- 3. runtime: what actually runs ------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    STATIC_DIR=client/dist \
    LOG_DIR=server/logs
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
# The server runs its .ts directly (Node 22 type stripping): no compile step, no source maps.
COPY shared/package.json shared/
COPY shared/protocol shared/protocol
COPY shared/sim shared/sim
COPY shared/codec shared/codec
COPY server/package.json server/
COPY server/src server/src
COPY --from=build /app/client/dist client/dist
# Match logs are written here; the node user (uid 1000, from the base image) must own it.
RUN mkdir -p server/logs && chown node:node server/logs
# The version stamp: --build-arg GIT_SHA (CI), or Render's own RENDER_GIT_COMMIT when Render builds.
ARG GIT_SHA
ARG RENDER_GIT_COMMIT
ENV GIT_SHA=${GIT_SHA:-${RENDER_GIT_COMMIT:-dev}}
# Not root: a bug in the server is a bug as user `node`, not as root of the container.
USER node
EXPOSE 8787
# Docker (and compose) mark the container unhealthy when /health stops answering.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Exec form: node IS process 1 and receives SIGTERM itself. `CMD npm start` would put npm in
# between — npm does not forward the signal, Docker waits 10 s and SIGKILLs everyone.
CMD ["node", "server/src/index.ts"]
