FROM node:20.19.5-bullseye@sha256:98ea4012488d9fcf75ff36a4cae490abab3cc95c0b26dd68e7f2ec2d0d61022d
ENV CYPRESS_INSTALL_BINARY=0 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
WORKDIR /app
COPY source/package.json source/package-lock.json source/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY source/ ./
COPY source-revision /app/fixture-revision
ARG PR_REVISION_SHA
RUN test "$(cat /app/fixture-revision)" = "$PR_REVISION_SHA" && npm run build
ENV NODE_ENV=production UPTIME_KUMA_IS_CONTAINER=1
CMD ["node", "server/server.js"]
