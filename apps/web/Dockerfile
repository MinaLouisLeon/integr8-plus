# The web app: marketing site, signup, the office screens and the super admin
# dashboard, as one Next.js server.
#
# Built from the repository root:
#
#   docker build -f apps/web/Dockerfile -t integr8-web \
#     --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.com \
#     --build-arg NEXT_PUBLIC_APP_VERSION=1.0.0 .
#
# `NEXT_PUBLIC_*` values are baked into the browser bundle at build time, so
# they are build arguments; everything the server reads (API_BASE_URL, the
# Sentry DSN) is set at run time.

# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HUSKY=0
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
ARG NEXT_PUBLIC_APP_VERSION=0.1.0
ARG NEXT_PUBLIC_APP_ENV=production
ARG NEXT_PUBLIC_SENTRY_DSN=
# Public sign-up: off sends visitors to the contact page; open shows the form.
ARG NEXT_PUBLIC_SIGNUP=off
ARG NEXT_PUBLIC_CONTACT_EMAIL=
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
ENV NEXT_PUBLIC_APP_ENV=$NEXT_PUBLIC_APP_ENV
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SIGNUP=$NEXT_PUBLIC_SIGNUP
ENV NEXT_PUBLIC_CONTACT_EMAIL=$NEXT_PUBLIC_CONTACT_EMAIL
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# `output: 'standalone'` in next.config.ts makes the build write a server with
# only the files it traced, which is what the runtime stage copies.
RUN pnpm turbo run build --filter=@integr8/web...

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/web/server.js"]
