# The container a Codex or Claude Code eval run executes in.
FROM node:24-bookworm@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl python3 ca-certificates iproute2 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/tools
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
# Chromium for each Playwright version the tools use.
RUN for core in node_modules/.pnpm/playwright-core@*/node_modules/playwright-core; do \
      node "$core/cli.js" install --with-deps chromium; \
    done \
  && chmod -R a+rX /ms-playwright
# Last, so code changes rebuild only this layer.
COPY src src
