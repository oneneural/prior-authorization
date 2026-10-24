# One application image: Next.js web, Fastify API and pg-boss worker supervised
# by s6-overlay, plus the bounded `init` entry point (provision and migrate).
# Pins, digests and checksums are recorded in docs/operations.md.

# node:24.22.0-bookworm-slim, multi-arch index digest (linux/arm64 manifest
# sha256:156e9bc7a0a267cc6ca77b4283e32b123479342df684ce297455d7b95ff5a6b5,
# linux/amd64 manifest sha256:ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7).
ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
# postgres:18.6-bookworm, the deployment's database image; reused here only for
# its xz and tar to unpack s6-overlay, so no package repository is contacted.
ARG POSTGRES_IMAGE=postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c

# s6-overlay 3.2.3.2 archives, verified by ADD against the checksums published
# with the release (s6-overlay-*.tar.xz.sha256).
FROM --platform=$BUILDPLATFORM ${POSTGRES_IMAGE} AS s6
ARG TARGETARCH
ADD --checksum=sha256:5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12 \
    https://github.com/just-containers/s6-overlay/releases/download/v3.2.3.2/s6-overlay-noarch.tar.xz /tmp/s6/
ADD --checksum=sha256:b17f17a82e7a515c682a91edaf2ffdabb73f891981b6c1fd712115693a2f8b4c \
    https://github.com/just-containers/s6-overlay/releases/download/v3.2.3.2/s6-overlay-aarch64.tar.xz /tmp/s6/
ADD --checksum=sha256:e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408 \
    https://github.com/just-containers/s6-overlay/releases/download/v3.2.3.2/s6-overlay-x86_64.tar.xz /tmp/s6/
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) arch=aarch64 ;; \
      amd64) arch=x86_64 ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mkdir /s6-root; \
    tar -C /s6-root -Jxpf /tmp/s6/s6-overlay-noarch.tar.xz; \
    tar -C /s6-root -Jxpf "/tmp/s6/s6-overlay-$arch.tar.xz"

# pnpm 12.14.0 from the npm registry with the npm bundled in the Node image; npm
# checks the tarball integrity recorded in the registry metadata.
FROM ${NODE_IMAGE} AS pnpm
RUN --mount=type=cache,id=pa-npm-cache,target=/root/.npm \
    npm install --global --prefix /opt/pnpm --no-audit --no-fund --save-exact pnpm@12.14.0 \
    && /opt/pnpm/bin/pnpm --version

FROM ${NODE_IMAGE} AS build
COPY --from=pnpm /opt/pnpm /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH NEXT_TELEMETRY_DISABLED=1 CI=1
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/connectors/package.json packages/connectors/
COPY packages/agents/package.json packages/agents/
# Frozen install with the reviewed allowBuilds (esbuild stays disabled).
RUN --mount=type=cache,id=pa-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY . .
RUN pnpm build

# Production dependencies of the API, worker and database packages only, in the
# same workspace layout; the web server ships as Next standalone output instead.
FROM ${NODE_IMAGE} AS prod-deps
COPY --from=pnpm /opt/pnpm /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH CI=1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/connectors/package.json packages/connectors/
COPY packages/agents/package.json packages/agents/
RUN --mount=type=cache,id=pa-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm-store \
      --filter '@pa/api...' --filter '@pa/worker...' \
    && rm -rf apps/web

FROM ${NODE_IMAGE} AS runtime
# Package managers from the base image are not needed at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin app \
    && mkdir -p /var/lib/app/evidence \
    && chown app:app /var/lib/app/evidence
COPY --from=s6 /s6-root/ /
COPY --from=prod-deps /app/ /app/
COPY --from=build /src/packages/config/dist/ /app/packages/config/dist/
COPY --from=build /src/packages/contracts/dist/ /app/packages/contracts/dist/
COPY --from=build /src/packages/db/dist/ /app/packages/db/dist/
COPY --from=build /src/packages/db/migrations/ /app/packages/db/migrations/
COPY --from=build /src/packages/db/sql/ /app/packages/db/sql/
COPY --from=build /src/packages/domain/dist/ /app/packages/domain/dist/
COPY --from=build /src/packages/connectors/dist/ /app/packages/connectors/dist/
COPY --from=build /src/packages/agents/dist/ /app/packages/agents/dist/
# Approved synthetic inputs and recorded model responses only. Evaluator
# oracles and expectations (evals/) never enter the build context.
COPY --from=build /src/packages/connectors/fixtures/ /app/packages/connectors/fixtures/
COPY --from=build /src/packages/agents/recordings/ /app/packages/agents/recordings/
COPY --from=build /src/apps/api/dist/ /app/apps/api/dist/
COPY --from=build /src/apps/worker/dist/ /app/apps/worker/dist/
COPY --from=build /src/apps/web/.next/standalone/ /app/web/
COPY --from=build /src/apps/web/.next/static/ /app/web/apps/web/.next/static/
COPY docker/rootfs/ /

# s6-overlay: read-only root with a tmpfs /run. Stage 2 fails, and the container
# stops, when the services are not all up and ready within 120 s (the default, 0,
# waits forever). Shutdown timing comes from the per-service timeout-down files
# plus the final 3-second S6_KILL_GRACETIME (its default, set explicitly); their
# sum stays inside Compose's 60-second stop_grace_period (docs/operations.md).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    EVIDENCE_ROOT=/var/lib/app/evidence \
    S6_READ_ONLY_ROOT=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=120000 \
    S6_KILL_GRACETIME=3000 \
    S6_VERBOSITY=1

ARG PA_BUILD_REVISION=unknown
ARG PA_BUILD_CREATED=unknown
LABEL org.opencontainers.image.title="prior-authorization-app" \
      org.opencontainers.image.description="Prior authorization pilot: web, API and worker under s6-overlay (synthetic data only)" \
      org.opencontainers.image.revision="${PA_BUILD_REVISION}" \
      org.opencontainers.image.created="${PA_BUILD_CREATED}" \
      org.opencontainers.image.base.name="docker.io/library/node:24.22.0-bookworm-slim"
ENV PA_BUILD_REVISION=${PA_BUILD_REVISION}

USER 10001:10001
WORKDIR /app
EXPOSE 3105
ENTRYPOINT ["/init"]
