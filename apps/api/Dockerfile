# The API and the worker: one image, two commands.
#
# Built from the repository root, because the API depends on workspace packages
# that have to be compiled alongside it:
#
#   docker build -f apps/api/Dockerfile -t integr8-api .
#
# The same image runs the API (default command), the worker, and the migrator:
#
#   docker run integr8-api                                       # the API on :3000
#   docker run integr8-api node dist/jobs/worker-main.js         # the worker
#   docker run integr8-api node node_modules/@integr8/db/dist/migrator/cli.js up
#
# One image rather than three because what matters about a worker is that it
# runs exactly the code the API does; two images drift the moment a hotfix lands
# in one.

# syntax=docker/dockerfile:1.7

# The exact Node release in .nvmrc, in every stage: `pnpm pins:check` fails
# when they differ, so CI, a developer's machine and the server run the same Node.
FROM node:22.22.2-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Husky installs git hooks on `pnpm install`; there is no repository in here.
ENV HUSKY=0
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
# Build: install the whole workspace, compile the API and what it depends on,
# then prune to the API's production dependencies alone.
# ---------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@integr8/api...
# `deploy` copies the package and its dependencies — workspace packages
# included, as real directories — into one self-contained tree. The compiled
# `dist` of each is what ships; sources stay behind.
RUN pnpm deploy --legacy --filter @integr8/api --prod /out

# ---------------------------------------------------------------------------
# Runtime: the pruned tree, Chromium for PDFs, an unprivileged user, and
# nothing else.
# ---------------------------------------------------------------------------
FROM node:22.22.2-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
# Chromium prints PDF documents in the worker (docs/documents ADR-0001 D4), and
# the Noto fonts give it Latin and Arabic to print with. Debian's own packages,
# so their security fixes arrive with the base image. The API process never
# starts Chromium; it is here because the worker is this same image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
ENV PDF_CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Local media storage is for development; production refuses it. The directory
# exists so a staging deployment that uses it has somewhere writable.
RUN mkdir -p /app/.data/media && chown -R node:node /app/.data
USER node
EXPOSE 3000
# Liveness only: a brief database problem is not a reason to restart a healthy
# API. Readiness is `/health/ready`, for the load balancer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
