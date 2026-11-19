#!/usr/bin/env bash
# Greptile TREX setup for momentic-ai/eval-fixture-metabase.
# Installs per-era JDK/Node toolchains, the Clojure CLI, Postgres, this
# Metabase recipe from qa-bench and the metabase-trex helper, builds this
# checkout, and warms Maven and JS caches for every codex/*/base branch.
set -euo pipefail

QA_BENCH_REF=main

JDK_MAJORS="11 21 25"
NODE_VERSIONS="16.20.2 18.20.8 22.23.2"
CLOJURE_VERSION=1.12.0.1488
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
  for c in git make gcc g++ python3 curl xz tar unzip jq ps psql rlwrap fc-list; do command -v "$c" >/dev/null || echo "$c"; done
  ls /usr/lib/postgresql/*/bin/initdb >/dev/null 2>&1 || echo initdb
  python3 -c 'import venv, ensurepip' 2>/dev/null || echo python3-venv
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
    git make gcc g++ libc6-dev python3 python3-venv curl ca-certificates xz-utils tar unzip jq procps rlwrap \
    fontconfig fonts-dejavu-core postgresql postgresql-client
  need=$(missing)
  if [ -n "$need" ]; then echo "ERROR: still missing $(echo $need)" >&2; exit 1; fi
fi
# metabase-trex runs its own Postgres on the default port, so the packaged service must not.
$SUDO systemctl disable --now postgresql >/dev/null 2>&1 || $SUDO service postgresql stop >/dev/null 2>&1 || true

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
  x86_64 | amd64) JDKARCH=x64 NODEARCH=x64 ;;
  aarch64 | arm64) JDKARCH=aarch64 NODEARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

for v in $JDK_MAJORS; do
  if [ ! -x "$PREFIX/jdk$v/bin/java" ]; then
    echo "== installing Temurin JDK $v"
    tmp=$(mktemp -d)
    fetch "https://api.adoptium.net/v3/binary/latest/$v/ga/linux/$JDKARCH/jdk/hotspot/normal/eclipse" "$tmp/jdk.tgz"
    tar -xzf "$tmp/jdk.tgz" -C "$tmp" && rm "$tmp/jdk.tgz"
    rm -rf "$PREFIX/jdk$v" && mv "$tmp"/jdk* "$PREFIX/jdk$v" && rmdir "$tmp"
  fi
  "$PREFIX/jdk$v/bin/java" -version 2>&1 | head -1
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

if [ ! -x "$PREFIX/clojure/bin/clojure" ]; then
  echo "== installing Clojure CLI $CLOJURE_VERSION"
  tmp=$(mktemp -d)
  fetch "https://download.clojure.org/install/linux-install-$CLOJURE_VERSION.sh" "$tmp/install.sh"
  bash "$tmp/install.sh" --prefix "$PREFIX/clojure" >/dev/null
  rm -rf "$tmp"
fi
JAVA_HOME="$PREFIX/jdk21" "$PREFIX/clojure/bin/clojure" --version

# The 2026 build runs a small Python helper through uv, as the eval image does.
if [ ! -x "$PREFIX/py/bin/uv" ]; then
  python3 -m venv "$PREFIX/py"
  "$PREFIX/py/bin/pip" install -q --no-cache-dir uv==0.8.22
fi

# The eval snapshots install and verify Metabase with these recipe scripts; TREX runs the same ones.
echo "== fetching qa-bench Metabase recipe at $QA_BENCH_REF"
rm -rf "$PREFIX/qa-bench"
git init -q "$PREFIX/qa-bench"
git -C "$PREFIX/qa-bench" sparse-checkout set --no-cone /fixtures/web/oss/metabase/fixture.json /fixtures/web/oss/metabase/runtime/snapshot/
GIT_TERMINAL_PROMPT=0 git -C "$PREFIX/qa-bench" fetch -q --depth=1 --filter=blob:none \
  https://github.com/momentic-ai/qa-bench.git "$QA_BENCH_REF"
git -C "$PREFIX/qa-bench" -c advice.detachedHead=false checkout -q FETCH_HEAD
echo "recipe commit: $(git -C "$PREFIX/qa-bench" rev-parse HEAD)"

# ---------------------------------------------------------------- activate
{
printf 'TREX_HOME=%q\n' "$PREFIX"
cat <<'ACTIVATE'
# Source from the root of a Metabase checkout. Selects the JDK from the CI
# java-version, Node from .nvmrc, and yarn or bun from package.json.
_trex_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
_trex_java=$(grep -A3 'java-version' "$_trex_root/.github/actions/prepare-backend/action.yml" 2>/dev/null |
  sed -n 's/.*default: *["'"'"']*\([0-9]*\).*/\1/p' | head -1)
case "$_trex_java" in
  25) TREX_JDK=25 ;;
  21) TREX_JDK=21 ;;
  *) TREX_JDK=11 ;;
esac
_trex_nvmrc=$({ tr -d 'v \n' <"$_trex_root/.nvmrc"; } 2>/dev/null || true)
case "${_trex_nvmrc%%.*}" in
  18) TREX_NODE=18 ;;
  22) TREX_NODE=22 ;;
  *) TREX_NODE=16 ;;
esac
_trex_pg=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)
JAVA_HOME="$TREX_HOME/jdk$TREX_JDK"
PATH="$JAVA_HOME/bin:$TREX_HOME/node$TREX_NODE/bin:$TREX_HOME/clojure/bin:$TREX_HOME/py/bin:$_trex_pg:$PATH"
_trex_bun=$(jq -r '.packageManager // ""' "$_trex_root/package.json" 2>/dev/null | sed -n 's/^bun@//p')
if [ -n "$_trex_bun" ]; then
  TREX_PM=bun
  if [ ! -x "$TREX_HOME/bun/$_trex_bun/bin/bun" ]; then
    npm install -g --silent --no-audit --no-fund --prefix "$TREX_HOME/bun/$_trex_bun" "bun@$_trex_bun" >&2
  fi
  PATH="$TREX_HOME/bun/$_trex_bun/bin:$PATH"
else
  TREX_PM=yarn
  if [ ! -x "$TREX_HOME/yarn1/bin/yarn" ]; then
    npm install -g --silent --no-audit --no-fund --prefix "$TREX_HOME/yarn1" yarn@1.22.22 >&2
  fi
  PATH="$TREX_HOME/yarn1/bin:$PATH"
fi
export JAVA_HOME PATH TREX_JDK TREX_NODE TREX_PM
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres
export MB_EDITION=oss INTERACTIVE=false CI=true
export CYPRESS_INSTALL_BINARY=0 PUPPETEER_SKIP_DOWNLOAD=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
unset _trex_root _trex_java _trex_nvmrc _trex_pg _trex_bun
ACTIVATE
} >"$PREFIX/activate"

# ---------------------------------------------------------------- metabase-trex
{
echo '#!/usr/bin/env bash'
printf 'TREX_HOME=%q\n' "$PREFIX"
cat <<'HELPER'
# metabase-trex <command>: build, run and seed a disposable Metabase (plus the
# eval's Postgres) from the current checkout. Run from anywhere inside the checkout.
set -euo pipefail
WORK=${METABASE_TREX_WORK:-/tmp/metabase-trex}
PORT=${METABASE_TREX_PORT:-3000}
URL="http://localhost:$PORT"
RECIPE="$TREX_HOME/qa-bench/fixtures/web/oss/metabase"
REPO=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO"
. "$TREX_HOME/activate"

# Inputs the recipe scripts read: this host's URL and the eval's account.
export FIXTURE_HOST=localhost FIXTURE_PORT=$PORT FIXTURE_URL=$URL
FIXTURE_USERNAME=$(jq -r .username "$RECIPE/fixture.json")
FIXTURE_PASSWORD=$(jq -r .password "$RECIPE/fixture.json")
export FIXTURE_USERNAME FIXTURE_PASSWORD

ready() { curl -fs --max-time 5 "$URL/api/health" 2>/dev/null | grep -q '"ok"'; }
# A zombie has exited; it only waits for its parent to reap it.
alive() { kill -0 "$1" 2>/dev/null && [ "$(ps -o stat= -p "$1" | cut -c1)" != Z ]; }
has_script() { jq -e --arg s "$1" '.scripts[$s]' package.json >/dev/null; }

# The namespace the checkout's own `clojure -M:run` starts.
main_ns() {
  sed -n '/^ *:run$/,/main-opts/p' deps.edn | grep -o '"-m" *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# Runs the backend from source in prod mode, the run mode of the eval's uberjar.
write_runner() {
  cat >"$WORK/run-metabase.sh" <<EOF
#!/bin/sh
cd $(printf %q "$REPO")
exec clojure -J-Dmb.run.mode=prod -J-Djava.awt.headless=true -J-Xmx3g -M -m $(main_ns)
EOF
  chmod +x "$WORK/run-metabase.sh"
}

# Writes a recipe script with the snapshot image's paths mapped to $WORK and
# this checkout, and without su-exec (Postgres runs as this user).
recipe_file() {
  local out="$WORK/recipe-$(basename "$1")"
  sed -e "s|/fixture/app/|$RECIPE/runtime/|g" \
    -e "s|/fixture/seeded-state|$WORK/seeded-state|g" \
    -e "s|/fixture/metabase.db|$WORK/metabase.db|g" \
    -e "s|/tmp/metabase.db|$WORK/metabase.db|g" \
    -e "s|exec /app/run_metabase.sh|exec $WORK/run-metabase.sh|g" \
    -e "s|/var/lib/postgresql/data|$WORK/pg|g" \
    -e "s|/run/postgresql|$WORK/run|g" \
    -e "s|/tmp/postgres.log|$WORK/postgres.log|g" \
    -e "s|su-exec postgres ||g" \
    -e "s|initdb -D|initdb -U postgres -D|g" \
    "$RECIPE/runtime/$1" >"$out"
  echo "$out"
}

cmd_env() {
  echo "checkout: $REPO"
  echo "java: $(java -version 2>&1 | head -1)  clojure: $(clojure --version 2>&1)"
  echo "node: $(node --version)  $TREX_PM: $($TREX_PM --version)"
  echo "backend main: $(main_ns)"
  echo "sign-in: $FIXTURE_USERNAME / $FIXTURE_PASSWORD at $URL"
}

cmd_deps() {
  if [ "$TREX_PM" = bun ]; then bun install --frozen-lockfile; else yarn install --frozen-lockfile; fi
}

# The release frontend bundle and static-viz bundle the eval's uberjar ships.
cmd_frontend() {
  [ -d node_modules ] || cmd_deps
  if has_script build-release; then
    $TREX_PM run build-release
    $TREX_PM run build-release:static-viz
  else
    NODE_ENV=production yarn build
    NODE_ENV=production yarn build-static-viz
  fi
}

cmd_backend() { clojure -P -M:run >/dev/null; } # downloads deps; the server compiles at start

cmd_build() {
  cmd_deps
  cmd_backend
  cmd_frontend
}

stop_pid() {
  local pid
  pid=$(cat "$WORK/$1.pid" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 60); do alive "$pid" || break; sleep 1; done
    if alive "$pid"; then echo "$1 (pid $pid) did not stop" >&2; exit 1; fi
  fi
  rm -f "$WORK/$1.pid"
}

cmd_stop() {
  stop_pid metabase
  if [ -f "$WORK/pg/postmaster.pid" ]; then pg_ctl -D "$WORK/pg" -m fast -w stop >/dev/null; fi
}

cmd_start() {
  [ -f resources/frontend_client/index.html ] || cmd_build
  if ready; then echo "Metabase already running at $URL"; return; fi
  mkdir -p "$WORK/run"
  write_runner
  local script
  if [ -f "$WORK/seeded-state" ]; then script=$(recipe_file snapshot/start.sh); else script=$(recipe_file snapshot/initialize.sh); fi
  (exec nohup sh "$script" >"$WORK/metabase.log" 2>&1) &
  echo $! >"$WORK/metabase.pid"
  # The first start compiles the backend from source, which takes a few minutes.
  for _ in $(seq 1 900); do
    if ready || ! alive "$(cat "$WORK/metabase.pid")"; then break; fi
    sleep 1
  done
  if ! ready; then
    echo "Metabase did not become ready; last log lines:" >&2
    tail -60 "$WORK/metabase.log" >&2
    cmd_stop
    exit 1
  fi
  echo "Metabase ready at $URL (pid $(cat "$WORK/metabase.pid"))"
}

# Runs Metabase setup with the eval's account through the recipe's snapshot seed.
cmd_seed() {
  ready || cmd_start
  if [ ! -f "$WORK/seeded-state" ]; then
    node "$RECIPE/runtime/snapshot/seed.mjs"
    touch "$WORK/seeded-state"
  fi
  echo "Seeded $FIXTURE_USERNAME (password $FIXTURE_PASSWORD)"
}

# Fresh application database, checked with the snapshot's own verify.sh.
cmd_reset() {
  cmd_stop
  rm -rf "$WORK"
  mkdir -p "$WORK"
  cmd_seed
  sh "$(recipe_file snapshot/verify.sh)"
}

cmd_status() {
  if ready; then echo "running at $URL"; else echo "not running"; exit 1; fi
}

cmd_test_backend() { clojure -X:dev:test "$@"; }
cmd_test_frontend() { $TREX_PM run test-unit "$@"; }

cmd_warm() { # JS and Maven caches for a base branch, used by the environment build
  cmd_env
  cmd_deps
  cmd_backend
  clojure -P -X:dev:test >/dev/null
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
  *) echo "usage: metabase-trex env|deps|build|backend|frontend|start|seed|stop|reset|status|warm|test-backend [:only ns]|test-frontend [jest args]" ;;
esac
HELPER
} >"$PREFIX/bin/metabase-trex"
chmod +x "$PREFIX/bin/metabase-trex"
if [ -z "${TREX_PREFIX:-}" ] && { [ -n "$SUDO" ] || [ "$(id -u)" = 0 ]; }; then
  $SUDO ln -sf "$PREFIX/bin/metabase-trex" /usr/local/bin/metabase-trex
fi
if [ -z "${TREX_PREFIX:-}" ]; then
  mkdir -p "$HOME/.local/bin" && ln -sf "$PREFIX/bin/metabase-trex" "$HOME/.local/bin/metabase-trex"
fi

# ---------------------------------------------------------------- build + warm
echo "== building current checkout ($(git -C "$REPO_ROOT" rev-parse --short HEAD))"
"$PREFIX/bin/metabase-trex" env
"$PREFIX/bin/metabase-trex" build
echo "== smoke test: start + seed + verify"
"$PREFIX/bin/metabase-trex" reset
"$PREFIX/bin/metabase-trex" stop
rm -rf "${METABASE_TREX_WORK:-/tmp/metabase-trex}"

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
      (cd "$dir" && "$PREFIX/bin/metabase-trex" warm); then
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
