#!/usr/bin/env bash
# Greptile TREX setup for momentic-ai/eval-fixture-vikunja.
# Installs Go and per-era Node, the eval's Vikunja recipe and the vikunja-trex
# helper, builds this checkout, and warms caches for every codex/*/base branch.
set -euo pipefail

# The upload command fills this with the eval's recipe (fixture.json and
# runtime/snapshot/) as a base64 tar.gz; see README.md.
RECIPE_TGZ_B64=

GO_VERSION=1.25.7
NODE_VERSIONS="22.21.0 24.13.0"
REPO_ROOT=$(pwd)

echo "== system"
uname -a
head -3 /etc/os-release 2>/dev/null || true
echo "user=$(id -un) uid=$(id -u) home=$HOME nproc=$(nproc)"
free -g 2>/dev/null | head -2 || true
df -h / /tmp 2>/dev/null || true

SUDO=""
if [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi

missing() {
  for c in git make gcc curl xz tar sqlite3 jq base64 ps; do command -v "$c" >/dev/null || echo "$c"; done
}
need=$(missing)
if [ -n "$need" ]; then
  echo "== installing system packages (missing: $(echo $need))"
  if ! command -v apt-get >/dev/null || { [ "$(id -u)" != 0 ] && [ -z "$SUDO" ]; }; then
    echo "ERROR: missing $(echo $need) and no apt-get/sudo to install them" >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends \
    git make gcc libc6-dev curl ca-certificates xz-utils tar sqlite3 jq coreutils procps
  need=$(missing)
  if [ -n "$need" ]; then echo "ERROR: still missing $(echo $need)" >&2; exit 1; fi
fi

PREFIX=${TREX_PREFIX:-/opt/trex}
if ! { mkdir -p "$PREFIX" 2>/dev/null && [ -w "$PREFIX" ]; }; then
  if [ -z "$SUDO" ]; then echo "ERROR: cannot create $PREFIX" >&2; exit 1; fi
  $SUDO mkdir -p "$PREFIX" && $SUDO chown "$(id -u):$(id -g)" "$PREFIX"
fi
echo "== toolchain prefix: $PREFIX"
mkdir -p "$PREFIX/bin"

# Downloads to a file first so a dropped connection is retried instead of truncating the archive.
fetch() { curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o "$2" "$1"; }

case "$(uname -m)" in
  x86_64 | amd64) GOARCH_DL=amd64 NODEARCH=x64 ;;
  aarch64 | arm64) GOARCH_DL=arm64 NODEARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

if [ ! -x "$PREFIX/go/bin/go" ] || [ "$("$PREFIX/go/bin/go" env GOVERSION)" != "go$GO_VERSION" ]; then
  echo "== installing go$GO_VERSION"
  tmp=$(mktemp -d)
  fetch "https://dl.google.com/go/go$GO_VERSION.linux-$GOARCH_DL.tar.gz" "$tmp/go.tgz"
  tar -xzf "$tmp/go.tgz" -C "$tmp" && rm "$tmp/go.tgz"
  rm -rf "$PREFIX/go" && mv "$tmp/go" "$PREFIX/go" && rmdir "$tmp"
fi
"$PREFIX/go/bin/go" version

for v in $NODE_VERSIONS; do
  major=${v%%.*}
  if [ ! -x "$PREFIX/node$major/bin/node" ]; then
    echo "== installing node v$v"
    tmp=$(mktemp -d)
    fetch "https://nodejs.org/dist/v$v/node-v$v-linux-$NODEARCH.tar.xz" "$tmp/node.txz"
    tar -xJf "$tmp/node.txz" -C "$tmp" && rm "$tmp/node.txz"
    rm -rf "$PREFIX/node$major" && mv "$tmp/node-v$v-linux-$NODEARCH" "$PREFIX/node$major" && rmdir "$tmp"
  fi
  echo "node$major $("$PREFIX/node$major/bin/node" --version)"
done

# The eval snapshots install and verify Vikunja with these recipe scripts; TREX runs the same ones.
echo "== unpacking the eval's Vikunja recipe"
if [ -z "$RECIPE_TGZ_B64" ]; then echo "ERROR: RECIPE_TGZ_B64 is empty; upload with the README command" >&2; exit 1; fi
rm -rf "$PREFIX/recipe" && mkdir -p "$PREFIX/recipe"
printf '%s' "$RECIPE_TGZ_B64" | base64 -d | tar -xz -C "$PREFIX/recipe"
ls -R "$PREFIX/recipe"

# ---------------------------------------------------------------- activate
{
printf 'TREX_HOME=%q\n' "$PREFIX"
cat <<'ACTIVATE'
# Source from the root of a Vikunja checkout. Selects Node and pnpm from
# frontend/.nvmrc and frontend/package.json.
_trex_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
_trex_nvmrc=$(cat "$_trex_root/frontend/.nvmrc" 2>/dev/null || true)
if [ "${_trex_nvmrc%%.*}" = 22 ]; then TREX_NODE=22; else TREX_NODE=24; fi
PATH="$TREX_HOME/go/bin:$TREX_HOME/node$TREX_NODE/bin:$PATH"
_trex_pnpm=$(jq -r '.packageManager // ""' "$_trex_root/frontend/package.json" 2>/dev/null | sed -n 's/^pnpm@//p')
if [ -n "$_trex_pnpm" ]; then
  if [ ! -x "$TREX_HOME/pnpm/$_trex_pnpm/bin/pnpm" ]; then
    npm install -g --silent --no-audit --no-fund --prefix "$TREX_HOME/pnpm/$_trex_pnpm" "pnpm@$_trex_pnpm" >&2
  fi
  PATH="$TREX_HOME/pnpm/$_trex_pnpm/bin:$PATH"
fi
PATH="$(go env GOPATH)/bin:$PATH"
export PATH TREX_NODE
export GOTOOLCHAIN=local VIKUNJA_SERVICE_ROOTPATH="$_trex_root"
export CYPRESS_INSTALL_BINARY=0 PUPPETEER_SKIP_DOWNLOAD=true
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
unset _trex_root _trex_nvmrc _trex_pnpm
ACTIVATE
} >"$PREFIX/activate"

# ---------------------------------------------------------------- vikunja-trex
{
echo '#!/usr/bin/env bash'
printf 'TREX_HOME=%q\n' "$PREFIX"
cat <<'HELPER'
# vikunja-trex <command>: build, run and seed a disposable Vikunja from the
# current checkout. Run from anywhere inside the checkout.
set -euo pipefail
WORK=${VIKUNJA_TREX_WORK:-/tmp/vikunja-trex}
PORT=${VIKUNJA_TREX_PORT:-3456}
URL="http://localhost:$PORT"
RECIPE="$TREX_HOME/recipe"
REPO=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO"
. "$TREX_HOME/activate"

# Inputs the recipe scripts read: this host's URL and the eval's account.
export FIXTURE_HOST=localhost FIXTURE_PORT=$PORT FIXTURE_URL=$URL
FIXTURE_USERNAME=$(jq -r .username "$RECIPE/fixture.json")
FIXTURE_PASSWORD=$(jq -r .password "$RECIPE/fixture.json")
export FIXTURE_USERNAME FIXTURE_PASSWORD

ready() { curl -fs -o /dev/null --max-time 5 "$URL/api/v1/info"; }

cmd_env() {
  echo "checkout: $REPO"
  echo "go: $(go version)"
  echo "node: $(node --version)  pnpm: $(pnpm --version 2>/dev/null || echo n/a)"
  echo "sign-in: $FIXTURE_USERNAME / $FIXTURE_PASSWORD at $URL"
}

cmd_deps() { (cd frontend && pnpm install --frozen-lockfile); }

cmd_frontend() {
  cmd_deps
  (cd frontend && echo '{"VERSION": "dev"}' >src/version.json && pnpm run build)
  git checkout -q -- frontend/src/version.json 2>/dev/null || true
}

cmd_backend() { go build -o vikunja .; }

cmd_build() {
  cmd_frontend
  cmd_backend
}

# A zombie has exited; it only waits for its parent to reap it.
alive() { kill -0 "$1" 2>/dev/null && [ "$(ps -o stat= -p "$1" | cut -c1)" != Z ]; }

cmd_stop() {
  local pid
  pid=$(cat "$WORK/vikunja.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
    for _ in $(seq 1 30); do alive "$pid" || break; sleep 1; done
    if alive "$pid"; then echo "Vikunja (pid $pid) did not stop" >&2; exit 1; fi
  fi
  rm -f "$WORK/vikunja.pid"
}

# The eval's settings: the VIKUNJA_* exports from its initialize.sh, with this host's paths.
settings() {
  eval "$(grep -E '^export VIKUNJA_' "$RECIPE/runtime/snapshot/initialize.sh")"
  export VIKUNJA_SERVICE_ROOTPATH="$WORK" VIKUNJA_DATABASE_PATH="$WORK/vikunja.db"
  export VIKUNJA_FILES_BASEPATH="$WORK/files" VIKUNJA_SERVICE_INTERFACE=":$PORT"
}

cmd_start() {
  [ -x ./vikunja ] || cmd_build
  if ready; then echo "Vikunja already running at $URL"; return; fi
  mkdir -p "$WORK/files"
  (settings && exec nohup ./vikunja >"$WORK/stdout.log" 2>&1) &
  echo $! >"$WORK/vikunja.pid"
  for _ in $(seq 1 120); do
    if ready; then echo "Vikunja ready at $URL (pid $(cat "$WORK/vikunja.pid"))"; return; fi
    if ! alive "$(cat "$WORK/vikunja.pid")"; then break; fi
    sleep 1
  done
  echo "Vikunja did not become ready; last log lines:" >&2
  tail -50 "$WORK/stdout.log" >&2
  cmd_stop
  exit 1
}

# Registers the eval account through the recipe's snapshot seed.
cmd_seed() {
  ready || cmd_start
  if [ ! -f "$WORK/.seeded" ]; then
    node "$RECIPE/runtime/snapshot/seed.mjs"
    touch "$WORK/.seeded"
  fi
  echo "Seeded $FIXTURE_USERNAME (password $FIXTURE_PASSWORD)"
}

# Fresh database, checked with the snapshot's own verify.sh.
cmd_reset() {
  cmd_stop
  rm -rf "$WORK"
  cmd_seed
  sh "$RECIPE/runtime/snapshot/verify.sh"
}

cmd_status() {
  if ready; then echo "running at $URL"; else echo "not running"; exit 1; fi
}

cmd_test_backend() { go test -p 1 "$@"; }

cmd_test_frontend() { (cd frontend && pnpm exec vitest run "$@"); }

cmd_warm() { # deps, full build and Go test deps, used by the environment build
  cmd_env
  cmd_build
  go test -count=1 -run '^$' ./pkg/... >/dev/null
}

case "${1:-help}" in
  env) cmd_env ;;
  deps) cmd_deps ;;
  build) cmd_build ;;
  backend) cmd_backend ;;
  frontend) cmd_frontend ;;
  start) cmd_start ;;
  seed) cmd_seed ;;
  stop) cmd_stop ;;
  reset) cmd_reset ;;
  status) cmd_status ;;
  test-backend) shift; cmd_test_backend "$@" ;;
  test-frontend) shift; cmd_test_frontend "$@" ;;
  warm) cmd_warm ;;
  *) echo "usage: vikunja-trex env|deps|build|backend|frontend|start|seed|stop|reset|status|warm|test-backend <pkgs>|test-frontend [files]" ;;
esac
HELPER
} >"$PREFIX/bin/vikunja-trex"
chmod +x "$PREFIX/bin/vikunja-trex"
if [ -z "${TREX_PREFIX:-}" ] && { [ -n "$SUDO" ] || [ "$(id -u)" = 0 ]; }; then
  $SUDO ln -sf "$PREFIX/bin/vikunja-trex" /usr/local/bin/vikunja-trex
fi
if [ -z "${TREX_PREFIX:-}" ]; then
  mkdir -p "$HOME/.local/bin" && ln -sf "$PREFIX/bin/vikunja-trex" "$HOME/.local/bin/vikunja-trex"
fi

# ---------------------------------------------------------------- build + warm
echo "== building current checkout ($(git -C "$REPO_ROOT" rev-parse --short HEAD))"
"$PREFIX/bin/vikunja-trex" warm
echo "== smoke test: start + seed"
"$PREFIX/bin/vikunja-trex" reset
"$PREFIX/bin/vikunja-trex" stop
rm -rf "${VIKUNJA_TREX_WORK:-/tmp/vikunja-trex}"

if [ "${TREX_SKIP_WARM:-}" != 1 ]; then
  echo "== warming caches for codex/*/base branches"
  GIT_TERMINAL_PROMPT=0 timeout 600 git fetch --prune --no-tags --depth=1 origin \
    '+refs/heads/codex/*/base:refs/remotes/origin/codex/*/base'
  results=() failed=0
  for ref in $(git for-each-ref --format='%(refname:short)' 'refs/remotes/origin/codex/*/base'); do
    name=$(echo "$ref" | tr '/' '-')
    dir="$PREFIX/warm/$name"
    rm -rf "$dir"
    if git worktree add --detach "$dir" "$ref" >/dev/null 2>&1 &&
      (cd "$dir" && "$PREFIX/bin/vikunja-trex" warm); then
      results+=("ok   $ref")
    else
      results+=("FAIL $ref") failed=1
    fi
    git worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
  done
  git worktree prune
  rm -rf "$PREFIX/warm"
  echo "== warm results"
  printf '%s\n' "${results[@]:-none}"
  if [ "$failed" = 1 ] || [ ${#results[@]} -eq 0 ]; then echo "ERROR: base branches did not all warm" >&2; exit 1; fi
fi
df -h / 2>/dev/null || true
echo "== setup complete"
