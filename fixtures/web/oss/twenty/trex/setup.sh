#!/usr/bin/env bash
# Greptile TREX setup for momentic-ai/eval-fixture-twenty.
# Installs per-era Node, Postgres and Redis, this Twenty recipe from qa-bench
# and the twenty-trex helper, builds this checkout, and warms the Yarn cache
# for every codex/*/base branch.
set -euo pipefail

QA_BENCH_REF=main

NODE_VERSIONS="18.20.8 24.16.0 26.12.1"
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
  for c in git make gcc g++ python3 curl xz tar jq ps psql redis-server; do command -v "$c" >/dev/null || echo "$c"; done
  ls /usr/lib/postgresql/*/bin/initdb >/dev/null 2>&1 || echo initdb
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
    git make gcc g++ libc6-dev python3 curl ca-certificates xz-utils tar jq procps \
    postgresql postgresql-client redis-server
  need=$(missing)
  if [ -n "$need" ]; then echo "ERROR: still missing $(echo $need)" >&2; exit 1; fi
fi
# twenty-trex runs its own Postgres and Redis on the default ports, so the packaged services must not.
for svc in postgresql redis-server; do
  $SUDO systemctl disable --now "$svc" >/dev/null 2>&1 || $SUDO service "$svc" stop >/dev/null 2>&1 || true
done

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
  x86_64 | amd64) NODEARCH=x64 ;;
  aarch64 | arm64) NODEARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

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

# The eval snapshots install, seed and verify Twenty with these recipe scripts; TREX runs the same ones.
echo "== fetching qa-bench Twenty recipe at $QA_BENCH_REF"
rm -rf "$PREFIX/qa-bench"
git init -q "$PREFIX/qa-bench"
git -C "$PREFIX/qa-bench" sparse-checkout set --no-cone /fixtures/web/oss/twenty/fixture.json /fixtures/web/oss/twenty/runtime/
GIT_TERMINAL_PROMPT=0 git -C "$PREFIX/qa-bench" fetch -q --depth=1 --filter=blob:none \
  https://github.com/momentic-ai/qa-bench.git "$QA_BENCH_REF"
git -C "$PREFIX/qa-bench" -c advice.detachedHead=false checkout -q FETCH_HEAD
echo "recipe commit: $(git -C "$PREFIX/qa-bench" rev-parse HEAD)"

# ---------------------------------------------------------------- activate
{
printf 'TREX_HOME=%q\n' "$PREFIX"
cat <<'ACTIVATE'
# Source from the root of a Twenty checkout. Selects Node from .nvmrc.
_trex_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
_trex_nvmrc=$({ tr -d 'v \n' <"$_trex_root/.nvmrc"; } 2>/dev/null || true)
case "${_trex_nvmrc%%.*}" in
  18) TREX_NODE=18 ;;
  26) TREX_NODE=26 ;;
  *) TREX_NODE=24 ;;
esac
_trex_pg=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)
PATH="$TREX_HOME/shims:$TREX_HOME/node$TREX_NODE/bin:$_trex_pg:$PATH"
export PATH TREX_NODE
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres
export YARN_ENABLE_TELEMETRY=0 YARN_ENABLE_PROGRESS_BARS=false NX_DAEMON=false NX_NO_CLOUD=true
export CYPRESS_INSTALL_BINARY=0 PUPPETEER_SKIP_DOWNLOAD=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
unset _trex_root _trex_nvmrc _trex_pg
ACTIVATE
} >"$PREFIX/activate"

# ---------------------------------------------------------------- twenty-trex
{
echo '#!/usr/bin/env bash'
printf 'TREX_HOME=%q\n' "$PREFIX"
cat <<'HELPER'
# twenty-trex <command>: build, run and seed a disposable Twenty (server,
# worker, Postgres and Redis) from the current checkout. Run from anywhere
# inside the checkout.
set -euo pipefail
WORK=${TWENTY_TREX_WORK:-/tmp/twenty-trex}
PORT=${TWENTY_TREX_PORT:-3000}
URL="http://localhost:$PORT"
RECIPE="$TREX_HOME/qa-bench/fixtures/web/oss/twenty"
REPO=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SERVER="$REPO/packages/twenty-server"
cd "$REPO"
. "$TREX_HOME/activate"

# Inputs the recipe scripts read: this host's URL and the eval's account.
export FIXTURE_HOST=localhost FIXTURE_PORT=$PORT FIXTURE_URL=$URL
FIXTURE_USERNAME=$(jq -r .username "$RECIPE/fixture.json")
FIXTURE_PASSWORD=$(jq -r .password "$RECIPE/fixture.json")
export FIXTURE_USERNAME FIXTURE_PASSWORD

ready() { curl -fs -o /dev/null --max-time 5 "$URL/healthz"; }
# A zombie has exited; it only waits for its parent to reap it.
alive() { kill -0 "$1" 2>/dev/null && [ "$(ps -o stat= -p "$1" | cut -c1)" != Z ]; }

# Writes a recipe script with the snapshot image's paths mapped to this
# checkout and $WORK, and without su-exec (Postgres runs as this user).
recipe_file() {
  local out="$WORK/recipe-$(basename "$1")"
  sed -e "s|/fixture/app/|$RECIPE/runtime/|g" \
    -e "s|/fixture/seeded-state|$WORK/seeded-state|g" \
    -e "s|/app/entrypoint.sh|$REPO/packages/twenty-docker/twenty/entrypoint.sh|g" \
    -e "s|/app/|$REPO/|g" \
    -e "s|/var/lib/postgresql/data|$WORK/pg|g" \
    -e "s|/run/postgresql|$WORK/run|g" \
    -e "s|/tmp/postgres.log|$WORK/postgres.log|g" \
    -e "s|su-exec postgres ||g" \
    -e "s|initdb -D|initdb -U postgres -D|g" \
    -e "s|redis-server --daemonize yes|redis-server --daemonize yes --dir $WORK|g" \
    "$RECIPE/runtime/$1" >"$out"
  echo "$out"
}

cmd_env() {
  echo "checkout: $REPO"
  echo "node: $(node --version)  yarn: $(yarn --version)  postgres: $(postgres --version)"
  echo "sign-in: $FIXTURE_USERNAME / $FIXTURE_PASSWORD at $URL"
}

cmd_deps() { yarn install --immutable; }
cmd_backend() { npx nx run twenty-server:build; }
cmd_frontend() {
  npx nx build twenty-front
  mkdir -p "$SERVER/dist" && rm -rf "$SERVER/dist/front"
  cp -r packages/twenty-front/build "$SERVER/dist/front"
}
cmd_build() {
  cmd_deps
  cmd_backend
  cmd_frontend
}

stop_pid() {
  local pid
  pid=$(cat "$WORK/$1.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
    for _ in $(seq 1 30); do alive "$pid" || break; sleep 1; done
    if alive "$pid"; then kill -9 "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$WORK/$1.pid"
}

cmd_stop() {
  stop_pid worker
  stop_pid server
  redis-cli shutdown nosave >/dev/null 2>&1 || true
  if [ -f "$WORK/pg/postmaster.pid" ]; then pg_ctl -D "$WORK/pg" -m fast -w stop >/dev/null; fi
}

# Starts the server through a recipe script (initialize.sh on a new database,
# start.sh after seeding), then the worker through after-start.sh, as the eval does.
launch() {
  local script
  mkdir -p "$WORK/run"
  script=$(recipe_file "$1")
  (exec nohup sh "$script" >"$WORK/server.log" 2>&1) &
  echo $! >"$WORK/server.pid"
  for _ in $(seq 1 600); do
    if ready || ! alive "$(cat "$WORK/server.pid")"; then break; fi
    sleep 1
  done
  if ! ready; then
    echo "Twenty did not become ready; last log lines:" >&2
    tail -60 "$WORK/server.log" >&2
    cmd_stop
    exit 1
  fi
  script=$(recipe_file snapshot/after-start.sh)
  (exec nohup sh "$script" >"$WORK/worker.log" 2>&1) &
  echo $! >"$WORK/worker.pid"
  echo "Twenty ready at $URL (server pid $(cat "$WORK/server.pid"), worker pid $(cat "$WORK/worker.pid"))"
}

cmd_start() {
  [ -f "$SERVER/dist/front/index.html" ] || cmd_build
  if ready; then echo "Twenty already running at $URL"; return; fi
  mkdir -p "$WORK"
  if [ -f "$WORK/seeded-state" ]; then launch snapshot/start.sh; else launch snapshot/initialize.sh; fi
}

# Creates the eval's account and workspace through the recipe's snapshot seed.
cmd_seed() {
  ready || cmd_start
  if [ ! -f "$WORK/seeded-state" ]; then
    node "$RECIPE/runtime/snapshot/seed.mjs"
    touch "$WORK/seeded-state"
  fi
  echo "Seeded $FIXTURE_USERNAME (password $FIXTURE_PASSWORD)"
}

# Fresh database, checked with the snapshot's own verify.sh.
cmd_reset() {
  cmd_stop
  rm -rf "$WORK"
  mkdir -p "$WORK"
  rm -f "$SERVER/.local-storage/diy-mo-seed-complete"
  cmd_seed
  sh "$(recipe_file snapshot/verify.sh)"
}

cmd_status() {
  if ready; then echo "running at $URL"; else echo "not running"; exit 1; fi
}

cmd_test_backend() { (cd "$SERVER" && npx jest "$@"); }
cmd_test_frontend() { (cd packages/twenty-front && npx jest "$@"); }

cmd_warm() { # Yarn cache for a base branch, used by the environment build
  cmd_env
  cmd_deps
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
  *) echo "usage: twenty-trex env|deps|build|backend|frontend|start|seed|stop|reset|status|warm|test-backend [jest args]|test-frontend [jest args]" ;;
esac
HELPER
} >"$PREFIX/bin/twenty-trex"
chmod +x "$PREFIX/bin/twenty-trex"
if [ -z "${TREX_PREFIX:-}" ] && { [ -n "$SUDO" ] || [ "$(id -u)" = 0 ]; }; then
  $SUDO ln -sf "$PREFIX/bin/twenty-trex" /usr/local/bin/twenty-trex
fi
if [ -z "${TREX_PREFIX:-}" ]; then
  mkdir -p "$HOME/.local/bin" && ln -sf "$PREFIX/bin/twenty-trex" "$HOME/.local/bin/twenty-trex"
fi

# ---------------------------------------------------------------- build + warm
echo "== building current checkout ($(git -C "$REPO_ROOT" rev-parse --short HEAD))"
"$PREFIX/bin/twenty-trex" env
"$PREFIX/bin/twenty-trex" build
echo "== smoke test: start + seed + verify"
"$PREFIX/bin/twenty-trex" reset
"$PREFIX/bin/twenty-trex" stop
rm -rf "${TWENTY_TREX_WORK:-/tmp/twenty-trex}"

if [ "${TREX_SKIP_WARM:-}" != 1 ]; then
  echo "== warming caches for codex/*/base branches"
  GIT_TERMINAL_PROMPT=0 timeout 900 git fetch --prune --no-tags --depth=1 origin \
    '+refs/heads/codex/*/base:refs/remotes/origin/codex/*/base'
  results=() failed=0
  for ref in $(git for-each-ref --format='%(refname:short)' 'refs/remotes/origin/codex/*/base'); do
    name=$(echo "$ref" | tr '/' '-')
    dir="$PREFIX/warm/$name"
    rm -rf "$dir"
    if git worktree add --detach "$dir" "$ref" >/dev/null 2>&1 &&
      (cd "$dir" && "$PREFIX/bin/twenty-trex" warm); then
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
