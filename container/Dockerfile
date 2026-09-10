ARG PI_BASE_IMAGE=base
FROM node:24-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY package.json /tmp/pi-worktree-package.json
RUN npm install --global --ignore-scripts \
    "@earendil-works/pi-coding-agent@$(node -p 'require("/tmp/pi-worktree-package.json").devDependencies["@earendil-works/pi-coding-agent"]')" \
    && rm /tmp/pi-worktree-package.json

FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Optionally replace the bundled base with a trusted image providing Node 24+, Pi, Git and bash.
FROM ${PI_BASE_IMAGE}
USER 0:0
COPY --from=build /build/package.json /opt/pi-worktree/package.json
COPY --from=build /build/node_modules /opt/pi-worktree/node_modules
COPY --from=build /build/dist/extension /opt/pi-worktree/dist/extension
COPY --from=build /build/dist/shared /opt/pi-worktree/dist/shared
COPY --from=build /build/dist/git /opt/pi-worktree/dist/git
COPY container/start.sh /opt/pi-worktree/start.sh
ARG PI_UID=1000
ARG PI_GID=1000
RUN node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' \
    && test "$(pi --version)" = "$(node -p 'require("/opt/pi-worktree/package.json").devDependencies["@earendil-works/pi-coding-agent"]')" \
    && command -v git && command -v bash \
    && test "$PI_UID" -gt 0 && test "$PI_GID" -gt 0 \
    && mkdir -p /pi/agent \
    && chown "$PI_UID:$PI_GID" /pi/agent && chmod 700 /pi/agent \
    && chmod -R go-w /opt/pi-worktree
ENV PI_CODING_AGENT_DIR=/pi/agent HOME=/tmp/pi-home
USER ${PI_UID}:${PI_GID}
WORKDIR /tmp
ENTRYPOINT ["/bin/sh", "/opt/pi-worktree/start.sh"]
CMD []
