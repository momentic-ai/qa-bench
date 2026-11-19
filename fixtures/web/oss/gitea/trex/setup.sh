#!/usr/bin/env bash
# Greptile TREX setup for momentic-ai/eval-fixture-gitea.
# Installs per-era Go/Node toolchains, this Gitea recipe from qa-bench and the
# gitea-trex helper, builds this checkout, and warms caches for every
# codex/*/base branch.
set -euo pipefail

QA_BENCH_REF=main

GIT_VERSION=2.56.1
GO_VERSIONS="1.16.15 1.22.12 1.23.12 1.26.5"
NODE_VERSIONS="16.20.2 20.20.2 22.23.5"
REPO_ROOT=$(pwd)

echo "== system"
uname -a
head -3 /etc/os-release 2>/dev/null || true
echo "user=$(id -un) uid=$(id -u) home=$HOME nproc=$(nproc)"
free -g 2>/dev/null | head -2 || true
df -h / /tmp 2>/dev/null || true

SUDO=""
if [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi

# Asks the compiler, since Debian keeps some headers in multiarch directories.
has_header() { echo "#include <$1>" | gcc -E - >/dev/null 2>&1; }
missing() {
  for c in git make gcc curl xz tar sqlite3 jq; do command -v "$c" >/dev/null || echo "$c"; done
  if command -v gcc >/dev/null; then
    for h in zlib.h expat.h curl/curl.h openssl/ssl.h; do has_header "$h" || echo "$h"; done
  fi
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
    git make gcc libc6-dev curl ca-certificates xz-utils tar sqlite3 jq \
    zlib1g-dev libexpat1-dev libcurl4-openssl-dev libssl-dev
  need=$(missing)
  if [ -n "$need" ]; then echo "ERROR: still missing $(echo $need)" >&2; exit 1; fi
fi
git --version

PREFIX=${TREX_PREFIX:-/opt/trex}
if ! { mkdir -p "$PREFIX" 2>/dev/null && [ -w "$PREFIX" ]; }; then
  if [ -z "$SUDO" ]; then echo "ERROR: cannot create $PREFIX" >&2; exit 1; fi
  $SUDO mkdir -p "$PREFIX" && $SUDO chown "$(id -u):$(id -g)" "$PREFIX"
fi
echo "== toolchain prefix: $PREFIX"
mkdir -p "$PREFIX/bin"

case "$(uname -m)" in
  x86_64 | amd64) GOARCH_DL=amd64 NODEARCH=x64 ;;
  aarch64 | arm64) GOARCH_DL=arm64 NODEARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

for v in $GO_VERSIONS; do
  if [ ! -x "$PREFIX/go$v/bin/go" ]; then
    echo "== installing go$v"
    tmp=$(mktemp -d)
    curl -fsSL --retry 3 "https://dl.google.com/go/go$v.linux-$GOARCH_DL.tar.gz" | tar -xz -C "$tmp"
    rm -rf "$PREFIX/go$v" && mv "$tmp/go" "$PREFIX/go$v" && rmdir "$tmp"
  fi
  "$PREFIX/go$v/bin/go" version
done

for v in $NODE_VERSIONS; do
  major=${v%%.*}
  if [ ! -x "$PREFIX/node$major/bin/node" ]; then
    echo "== installing node v$v"
    tmp=$(mktemp -d)
    curl -fsSL --retry 3 "https://nodejs.org/dist/v$v/node-v$v-linux-$NODEARCH.tar.xz" | tar -xJ -C "$tmp"
    rm -rf "$PREFIX/node$major" && mv "$tmp/node-v$v-linux-$NODEARCH" "$PREFIX/node$major" && rmdir "$tmp"
  fi
  echo "node$major $("$PREFIX/node$major/bin/node" --version)"
done

# Gitea 2026 tests use `git config set` (git >= 2.46); build a current git for them.
git_ok() {
  [ -x "$PREFIX/git/libexec/git-core/git-remote-http" ] &&
    [ "$("$PREFIX/git/bin/git" --version 2>/dev/null)" = "git version $GIT_VERSION" ]
}
if ! git_ok; then
  echo "== building git $GIT_VERSION"
  rm -rf "$PREFIX/git"
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 "https://cdn.kernel.org/pub/software/scm/git/git-$GIT_VERSION.tar.xz" | tar -xJ -C "$tmp"
  make -C "$tmp/git-$GIT_VERSION" -s -j"$(nproc)" prefix="$PREFIX/git" \
    NO_RUST=1 NO_TCLTK=1 NO_GETTEXT=1 NO_PERL=1 NO_PYTHON=1 install >/dev/null
  rm -rf "$tmp"
fi
git_ok || { echo "ERROR: git $GIT_VERSION did not install with HTTP transport" >&2; exit 1; }
"$PREFIX/git/bin/git" --version

# The eval snapshots seed and verify Gitea with these recipe scripts; TREX runs the same ones.
echo "== fetching qa-bench Gitea recipe at $QA_BENCH_REF"
rm -rf "$PREFIX/qa-bench"
git init -q "$PREFIX/qa-bench"
git -C "$PREFIX/qa-bench" sparse-checkout set --no-cone /fixtures/web/oss/gitea/fixture.json /fixtures/web/oss/gitea/runtime/snapshot/
GIT_TERMINAL_PROMPT=0 git -C "$PREFIX/qa-bench" fetch -q --depth=1 --filter=blob:none \
  https://github.com/momentic-ai/qa-bench.git "$QA_BENCH_REF"
git -C "$PREFIX/qa-bench" -c advice.detachedHead=false checkout -q FETCH_HEAD
echo "recipe commit: $(git -C "$PREFIX/qa-bench" rev-parse HEAD)"

# ---------------------------------------------------------------- activate
{
printf 'TREX_HOME=%q\n' "$PREFIX"
cat <<'ACTIVATE'
# Source from the root of a Gitea checkout. Selects Go, Node and pnpm from
# go.mod / package.json and exports GITEA_TAGS for the sqlite build tags.
_trex_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
_trex_go=$(awk '$1=="go"{print $2; exit}' "$_trex_root/go.mod" 2>/dev/null || true)
_trex_minor=$(printf '%s' "${_trex_go:-1.26}" | cut -d. -f2)
if [ "$_trex_minor" -le 16 ]; then TREX_GO=1.16.15
elif [ "$_trex_minor" -le 22 ]; then TREX_GO=1.22.12
elif [ "$_trex_minor" -le 23 ]; then TREX_GO=1.23.12
else TREX_GO=1.26.5; fi
_trex_nodemin=$(grep -oE '"node": *">= *[0-9]+' "$_trex_root/package.json" 2>/dev/null | grep -oE '[0-9]+$' | head -1 || true)
if [ -f "$_trex_root/pnpm-lock.yaml" ] || [ "${_trex_nodemin:-22}" -ge 21 ]; then TREX_NODE=22
elif [ "${_trex_nodemin:-22}" -ge 17 ]; then TREX_NODE=20
else TREX_NODE=16; fi
if [ -f "$_trex_root/models/db/driver_sqlite_modernc.go" ]; then GITEA_TAGS=""
else GITEA_TAGS="sqlite sqlite_unlock_notify"; fi
PATH="$TREX_HOME/go$TREX_GO/bin:$TREX_HOME/node$TREX_NODE/bin:$PATH"
if [ "$TREX_GO" = 1.26.5 ]; then PATH="$TREX_HOME/git/bin:$PATH"; fi
_trex_pnpm=$(grep -oE '"packageManager": *"pnpm@[^"]+' "$_trex_root/package.json" 2>/dev/null | sed 's/.*pnpm@//' || true)
if [ -n "$_trex_pnpm" ]; then
  if [ ! -x "$TREX_HOME/pnpm/$_trex_pnpm/bin/pnpm" ]; then
    npm install -g --silent --no-audit --no-fund --prefix "$TREX_HOME/pnpm/$_trex_pnpm" "pnpm@$_trex_pnpm" >&2
  fi
  PATH="$TREX_HOME/pnpm/$_trex_pnpm/bin:$PATH"
fi
PATH="$(go env GOPATH)/bin:$PATH"
export PATH GITEA_TAGS TREX_GO TREX_NODE
export GOTOOLCHAIN=auto GOFLAGS="${GOFLAGS:-}" SCARF_ANALYTICS=false
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
if [ "$(id -u)" = 0 ]; then export I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true; fi
unset _trex_root _trex_go _trex_minor _trex_nodemin _trex_pnpm
ACTIVATE
} >"$PREFIX/activate"

# ---------------------------------------------------------------- gitea-trex
{
echo '#!/usr/bin/env bash'
printf 'TREX_HOME=%q\n' "$PREFIX"
cat <<'HELPER'
# gitea-trex <command>: build, run and seed a disposable Gitea from the
# current checkout. Run from anywhere inside the checkout.
set -euo pipefail
WORK=${GITEA_TREX_WORK:-/tmp/gitea-trex}
PORT=${GITEA_TREX_PORT:-3000}
URL="http://localhost:$PORT"
RECIPE="$TREX_HOME/qa-bench/fixtures/web/oss/gitea"
CONF="$WORK/gitea/conf/app.ini"
REPO=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO"
. "$TREX_HOME/activate"

# The recipe scripts read these; values match the eval except for local paths.
export FIXTURE_HOST=localhost FIXTURE_PORT=$PORT FIXTURE_URL=$URL GITEA_LOCAL_URL=$URL
export GITEA_DATA=$WORK GITEA_RUN_USER=$(id -un) GITEA_CUSTOM=$WORK/gitea
FIXTURE_USERNAME=$(jq -r .username "$RECIPE/fixture.json")
FIXTURE_PASSWORD=$(jq -r .password "$RECIPE/fixture.json")
export FIXTURE_USERNAME FIXTURE_PASSWORD

gitea() { ./gitea "$@" -c "$CONF" -w "$REPO"; }

installed() { grep -q '^INSTALL_LOCK *= *true' "$CONF" 2>/dev/null; }

# Settings the snapshot image gets from its Docker template; the recipe's env.sh and installer set the rest.
write_config() {
  mkdir -p "$WORK"/gitea/{conf,log} "$WORK"/git
  cat >"$CONF" <<EOF
RUN_MODE = dev
RUN_USER = $GITEA_RUN_USER

[server]
HTTP_ADDR = 0.0.0.0
APP_DATA_PATH = $WORK/gitea

[repository]
ROOT = $WORK/git/repositories

[security]
INSTALL_LOCK = false

[cron.update_checker]
ENABLED = false

[log]
MODE = file
ROOT_PATH = $WORK/gitea/log
EOF
}

# Applies the recipe's GITEA__* settings with Gitea's own converter, as the image does on each start.
apply_env() {
  (
    . "$RECIPE/runtime/snapshot/env.sh"
    if ./gitea config edit-ini --help >/dev/null 2>&1; then
      ./gitea config edit-ini --config "$CONF" --apply-env --in-place
    else
      [ -x "$WORK/environment-to-ini" ] || go build -o "$WORK/environment-to-ini" ./contrib/environment-to-ini
      "$WORK/environment-to-ini" --config "$CONF"
    fi
  ) >"$WORK/gitea/log/env.log" 2>&1 || { cat "$WORK/gitea/log/env.log" >&2; exit 1; }
}

ready() { curl -fs -o /dev/null --max-time 5 "$URL/"; }

cmd_env() {
  echo "checkout: $REPO"
  echo "go: $(go version)  git: $(git --version)"
  echo "node: $(node --version)  npm: $(npm --version)  pnpm: $([ -f pnpm-lock.yaml ] && pnpm --version || echo n/a)"
  echo "GITEA_TAGS='$GITEA_TAGS'"
  echo "sign-in: $FIXTURE_USERNAME / $FIXTURE_PASSWORD at $URL"
}

cmd_deps() {
  if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else npm ci; fi
}

cmd_build() { make build TAGS="$GITEA_TAGS"; }
cmd_backend() { make backend TAGS="$GITEA_TAGS"; }
cmd_frontend() { make frontend; }

cmd_stop() {
  local pid
  pid=$(cat "$WORK/gitea.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then echo "Gitea (pid $pid) did not stop" >&2; exit 1; fi
  fi
  rm -f "$WORK/gitea.pid"
}

cmd_start() {
  [ -x ./gitea ] || cmd_build
  if ready; then echo "Gitea already running at $URL"; return; fi
  [ -f "$CONF" ] || write_config
  apply_env
  if installed; then
    gitea migrate >"$WORK/gitea/log/migrate.log" 2>&1 || { cat "$WORK/gitea/log/migrate.log"; exit 1; }
  fi
  nohup ./gitea web -c "$CONF" -w "$REPO" >"$WORK/gitea/log/stdout.log" 2>&1 &
  echo $! >"$WORK/gitea.pid"
  for _ in $(seq 1 120); do
    if ready; then echo "Gitea ready at $URL (pid $(cat "$WORK/gitea.pid"))"; return; fi
    if ! kill -0 "$(cat "$WORK/gitea.pid")" 2>/dev/null; then break; fi
    sleep 1
  done
  echo "Gitea did not become ready; last log lines:" >&2
  tail -50 "$WORK/gitea/log/stdout.log" >&2
  cmd_stop
  exit 1
}

# Installs Gitea through the recipe's snapshot seed, then restarts it like a snapshot restore.
cmd_seed() {
  ready || cmd_start
  if ! installed; then
    sh "$RECIPE/runtime/snapshot/seed.sh"
    cmd_stop
    cmd_start
  fi
  curl -fsS -u "$FIXTURE_USERNAME:$FIXTURE_PASSWORD" "$URL/api/v1/user" | jq -e .is_admin >/dev/null ||
    { echo "admin $FIXTURE_USERNAME cannot sign in" >&2; exit 1; }
  echo "Seeded admin $FIXTURE_USERNAME (password $FIXTURE_PASSWORD)"
}

# Fresh install, checked with the snapshot's own verify.sh.
cmd_reset() {
  cmd_stop
  rm -rf "$WORK"
  cmd_seed
  sh "$RECIPE/runtime/snapshot/verify.sh"
}

cmd_status() {
  if ready; then echo "running at $URL"; else echo "not running"; exit 1; fi
}

cmd_test_backend() { go test -tags "$GITEA_TAGS" "$@"; }

cmd_test_frontend() {
  if [ -f pnpm-lock.yaml ]; then pnpm exec vitest run "$@"
  elif [ -f jest.config.js ]; then NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx jest "$@"
  else npx vitest run "$@"; fi
}

cmd_warm() { # deps + full build, used by the environment build
  cmd_env
  cmd_build
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
  *) echo "usage: gitea-trex env|deps|build|backend|frontend|start|seed|stop|reset|status|warm|test-backend <pkgs>|test-frontend [files]" ;;
esac
HELPER
} >"$PREFIX/bin/gitea-trex"
chmod +x "$PREFIX/bin/gitea-trex"
if [ -z "${TREX_PREFIX:-}" ] && { [ -n "$SUDO" ] || [ "$(id -u)" = 0 ]; }; then
  $SUDO ln -sf "$PREFIX/bin/gitea-trex" /usr/local/bin/gitea-trex
fi
if [ -z "${TREX_PREFIX:-}" ]; then
  mkdir -p "$HOME/.local/bin" && ln -sf "$PREFIX/bin/gitea-trex" "$HOME/.local/bin/gitea-trex"
fi

# ---------------------------------------------------------------- build + warm
echo "== building current checkout ($(git -C "$REPO_ROOT" rev-parse --short HEAD))"
"$PREFIX/bin/gitea-trex" warm
echo "== smoke test: start + seed"
"$PREFIX/bin/gitea-trex" reset
"$PREFIX/bin/gitea-trex" stop
rm -rf "${GITEA_TREX_WORK:-/tmp/gitea-trex}"

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
      (cd "$dir" && "$PREFIX/bin/gitea-trex" warm); then
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
