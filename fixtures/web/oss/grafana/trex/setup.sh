#!/usr/bin/env bash
# Greptile TREX setup for momentic-ai/eval-fixture-grafana.
# Installs per-era Go/Node toolchains, the eval's Grafana recipe and the
# grafana-trex helper, builds this checkout, and warms dependency and Go build
# caches for every codex/*/base branch.
set -euo pipefail

# The upload command fills this with the eval's recipe (fixture.json and
# runtime/snapshot/) as a base64 tar.gz; see README.md.
RECIPE_TGZ_B64=

GO_VERSIONS="1.17.13 1.19.13 1.24.6 1.26.6 1.27.3"
NODE_VERSIONS="16.20.2 22.16.0 24.22.1"
REPO_ROOT=$(pwd)
# Greptile stops the setup script after 30 minutes, so warming stops starting new
# bases after this many seconds and leaves the rest to build on demand.
WARM_BUDGET=${TREX_WARM_BUDGET:-1440}
SETUP_START=$(date +%s)

echo "== system"
uname -a
head -3 /etc/os-release 2>/dev/null || true
echo "user=$(id -un) uid=$(id -u) home=$HOME nproc=$(nproc)"
free -g 2>/dev/null | head -2 || true
df -h / /tmp 2>/dev/null || true

SUDO=""
if [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi

missing() {
  for c in git make gcc g++ python3 curl xz tar sqlite3 jq base64 ps; do command -v "$c" >/dev/null || echo "$c"; done
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
    git make gcc g++ libc6-dev python3 curl ca-certificates xz-utils tar sqlite3 jq coreutils procps
  need=$(missing)
  if [ -n "$need" ]; then echo "ERROR: still missing $(echo $need)" >&2; exit 1; fi
fi

PREFIX=${TREX_PREFIX:-/opt/trex}
if ! { mkdir -p "$PREFIX" 2>/dev/null && [ -w "$PREFIX" ]; }; then
  if [ -z "$SUDO" ]; then echo "ERROR: cannot create $PREFIX" >&2; exit 1; fi
  $SUDO mkdir -p "$PREFIX" && $SUDO chown "$(id -u):$(id -g)" "$PREFIX"
fi
echo "== toolchain prefix: $PREFIX"
mkdir -p "$PREFIX/bin" "$PREFIX/shims"

# Downloads to a file first so a dropped connection is retried instead of truncating the archive.
fetch() { curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o "$2" "$1"; }

case "$(uname -m)" in
  x86_64 | amd64) GOARCH_DL=amd64 NODEARCH=x64 ;;
  aarch64 | arm64) GOARCH_DL=arm64 NODEARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

for v in $GO_VERSIONS; do
  if [ ! -x "$PREFIX/go$v/bin/go" ]; then
    echo "== installing go$v"
    tmp=$(mktemp -d)
    fetch "https://dl.google.com/go/go$v.linux-$GOARCH_DL.tar.gz" "$tmp/go.tgz"
    tar -xzf "$tmp/go.tgz" -C "$tmp" && rm "$tmp/go.tgz"
    rm -rf "$PREFIX/go$v" && mv "$tmp/go" "$PREFIX/go$v" && rmdir "$tmp"
  fi
  "$PREFIX/go$v/bin/go" version
done

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

# Runs the Yarn release each checkout commits (yarnPath), so no Yarn download is needed.
cat >"$PREFIX/shims/yarn" <<'SHIM'
#!/usr/bin/env bash
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
release=$(sed -n 's/^yarnPath: *//p' "$root/.yarnrc.yml" 2>/dev/null | tr -d '"'"'")
if [ -z "$release" ]; then echo "yarn shim: no yarnPath in $root/.yarnrc.yml" >&2; exit 1; fi
exec node "$root/$release" "$@"
SHIM
chmod +x "$PREFIX/shims/yarn"

# The eval snapshots configure and verify Grafana with these recipe scripts; TREX runs the same ones.
echo "== unpacking the eval's Grafana recipe"
if [ -z "$RECIPE_TGZ_B64" ]; then echo "ERROR: RECIPE_TGZ_B64 is empty; upload with the README command" >&2; exit 1; fi
rm -rf "$PREFIX/recipe" && mkdir -p "$PREFIX/recipe"
printf '%s' "$RECIPE_TGZ_B64" | base64 -d | tar -xz -C "$PREFIX/recipe"
find "$PREFIX/recipe" -type f

# ---------------------------------------------------------------- activate
{
printf 'TREX_HOME=%q\n' "$PREFIX"
cat <<'ACTIVATE'
# Source from the root of a Grafana checkout. Selects Go from go.mod and Node
# from .nvmrc (Node 16 when there is none).
_trex_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
_trex_go=$(awk '$1=="go"{print $2; exit}' "$_trex_root/go.mod" 2>/dev/null || true)
_trex_minor=$(printf '%s' "${_trex_go:-1.27}" | cut -d. -f2)
if [ "$_trex_minor" -le 17 ]; then TREX_GO=1.17.13
elif [ "$_trex_minor" -le 19 ]; then TREX_GO=1.19.13
elif [ "$_trex_minor" -le 24 ]; then TREX_GO=1.24.6
elif [ "$_trex_minor" -le 26 ]; then TREX_GO=1.26.6
else TREX_GO=1.27.3; fi
_trex_nvmrc=$({ tr -d 'v \n' <"$_trex_root/.nvmrc"; } 2>/dev/null || true)
case "${_trex_nvmrc%%.*}" in
  22) TREX_NODE=22 ;;
  24 | 25 | 26) TREX_NODE=24 ;;
  *) TREX_NODE=16 ;;
esac
PATH="$TREX_HOME/shims:$TREX_HOME/go$TREX_GO/bin:$TREX_HOME/node$TREX_NODE/bin:$PATH"
PATH="$(go env GOPATH)/bin:$PATH"
export PATH TREX_GO TREX_NODE
export GOTOOLCHAIN=auto GOFLAGS="${GOFLAGS:-}"
export YARN_ENABLE_TELEMETRY=0 YARN_ENABLE_PROGRESS_BARS=false
export CYPRESS_INSTALL_BINARY=0 PUPPETEER_SKIP_DOWNLOAD=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Appended, so it overrides a smaller heap limit the VM may preset.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"
unset _trex_root _trex_go _trex_minor _trex_nvmrc
ACTIVATE
} >"$PREFIX/activate"

# ---------------------------------------------------------------- grafana-trex
{
echo '#!/usr/bin/env bash'
printf 'TREX_HOME=%q\n' "$PREFIX"
cat <<'HELPER'
# grafana-trex <command>: build, run and check a disposable Grafana from the
# current checkout. Run from anywhere inside the checkout.
set -euo pipefail
WORK=${GRAFANA_TREX_WORK:-/tmp/grafana-trex}
PORT=${GRAFANA_TREX_PORT:-3000}
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

ready() { curl -fs -o /dev/null --max-time 5 "$URL/api/health"; }

server_cmd() {
  local bin
  for bin in bin/linux-*/grafana bin/grafana; do
    if [ -x "$bin" ]; then echo "$bin server"; return; fi
  done
  for bin in bin/linux-*/grafana-server; do
    if [ -x "$bin" ]; then echo "$bin"; return; fi
  done
}

cmd_env() {
  echo "checkout: $REPO"
  echo "go: $(go version)"
  echo "node: $(node --version)  yarn: $(yarn --version)"
  echo "sign-in: $FIXTURE_USERNAME / $FIXTURE_PASSWORD at $URL"
}

cmd_deps() { yarn install --immutable; }
cmd_backend() { make build-go; }
cmd_frontend() {
  [ -d node_modules ] || [ -f .pnp.cjs ] || cmd_deps
  yarn build
}
cmd_build() {
  cmd_deps
  cmd_backend
  cmd_frontend
}

# A zombie has exited; it only waits for its parent to reap it.
alive() { kill -0 "$1" 2>/dev/null && [ "$(ps -o stat= -p "$1" | cut -c1)" != Z ]; }

cmd_stop() {
  local pid
  pid=$(cat "$WORK/grafana.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
    for _ in $(seq 1 60); do alive "$pid" || break; sleep 1; done
    if alive "$pid"; then kill -9 "$pid" 2>/dev/null || true; sleep 1; fi
    if alive "$pid"; then echo "Grafana (pid $pid) did not stop" >&2; exit 1; fi
  fi
  rm -f "$WORK/grafana.pid"
}

# The eval's settings: the GF_* exports from its start.sh, plus this host's paths
# in place of the image's GF_PATHS_* and sample.ini.
settings() {
  eval "$(grep -E '^export GF_' "$RECIPE/runtime/snapshot/start.sh")"
  export GF_PATHS_HOME="$REPO" GF_PATHS_DATA="$WORK/data" GF_PATHS_LOGS="$WORK/log"
  export GF_PATHS_PLUGINS="$WORK/plugins" GF_PATHS_PROVISIONING="$WORK/provisioning"
  export GF_SERVER_HTTP_PORT="$PORT"
}

cmd_start() {
  [ -n "$(server_cmd)" ] || cmd_build
  if ready; then echo "Grafana already running at $URL"; return; fi
  mkdir -p "$WORK"/{data,log,plugins} "$WORK"/provisioning/{datasources,dashboards,notifiers,plugins,access-control,alerting}
  cp conf/sample.ini "$WORK/grafana.ini"
  # shellcheck disable=SC2046
  (settings && exec nohup $(server_cmd) --homepath "$REPO" --config "$WORK/grafana.ini" >"$WORK/stdout.log" 2>&1) &
  echo $! >"$WORK/grafana.pid"
  for _ in $(seq 1 180); do
    if ready; then echo "Grafana ready at $URL (pid $(cat "$WORK/grafana.pid"))"; return; fi
    if ! alive "$(cat "$WORK/grafana.pid")"; then break; fi
    sleep 1
  done
  echo "Grafana did not become ready; last log lines:" >&2
  tail -50 "$WORK/stdout.log" >&2
  cmd_stop
  exit 1
}

# The eval's snapshot seed only checks the admin account its settings create.
cmd_seed() {
  ready || cmd_start
  curl -fsS -o /dev/null -u "$FIXTURE_USERNAME:$FIXTURE_PASSWORD" "$URL/api/user" ||
    { echo "admin $FIXTURE_USERNAME cannot sign in" >&2; exit 1; }
  echo "Admin $FIXTURE_USERNAME (password $FIXTURE_PASSWORD)"
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

cmd_test_backend() { go test -short "$@"; }
cmd_test_frontend() { yarn jest --ci "$@"; }

cmd_warm() { # deps and Go build cache, used by the environment build
  cmd_env
  cmd_deps
  cmd_backend
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
  *) echo "usage: grafana-trex env|deps|build|backend|frontend|start|seed|stop|reset|status|warm|test-backend <pkgs>|test-frontend [files]" ;;
esac
HELPER
} >"$PREFIX/bin/grafana-trex"
chmod +x "$PREFIX/bin/grafana-trex"
if [ -z "${TREX_PREFIX:-}" ] && { [ -n "$SUDO" ] || [ "$(id -u)" = 0 ]; }; then
  $SUDO ln -sf "$PREFIX/bin/grafana-trex" /usr/local/bin/grafana-trex
fi
if [ -z "${TREX_PREFIX:-}" ]; then
  mkdir -p "$HOME/.local/bin" && ln -sf "$PREFIX/bin/grafana-trex" "$HOME/.local/bin/grafana-trex"
fi

# ---------------------------------------------------------------- build + warm
echo "== building current checkout ($(git -C "$REPO_ROOT" rev-parse --short HEAD))"
"$PREFIX/bin/grafana-trex" env
"$PREFIX/bin/grafana-trex" build
echo "== smoke test: start + verify"
"$PREFIX/bin/grafana-trex" reset
"$PREFIX/bin/grafana-trex" stop
rm -rf "${GRAFANA_TREX_WORK:-/tmp/grafana-trex}"

if [ "${TREX_SKIP_WARM:-}" != 1 ]; then
  echo "== warming caches for codex/*/base branches"
  GIT_TERMINAL_PROMPT=0 timeout 900 git fetch --prune --no-tags --depth=1 origin \
    '+refs/heads/codex/*/base:refs/remotes/origin/codex/*/base'
  results=() failed=0
  for ref in $(git for-each-ref --format='%(refname:short)' 'refs/remotes/origin/codex/*/base'); do
    if [ $(($(date +%s) - SETUP_START)) -ge "$WARM_BUDGET" ]; then
      results+=("skip $ref")
      continue
    fi
    name=$(echo "$ref" | tr '/' '-')
    dir="$PREFIX/warm/$name"
    rm -rf "$dir"
    if git worktree add --detach "$dir" "$ref" >/dev/null 2>&1 &&
      (cd "$dir" && "$PREFIX/bin/grafana-trex" warm); then
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
