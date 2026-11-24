#!/bin/sh
set -eu

seed_state=/app/packages/twenty-server/.local-storage/diy-mo-seed-complete
if [ ! -f "$seed_state" ]; then
  cd /app/packages/twenty-server
  if yarn command:prod workspace:seed:dev --help | grep -q -- '--light'; then
    # Newer revisions can seed just the standard demo workspace.
    yarn command:prod workspace:seed:dev --light
  else
    # Older revisions expose only the full development seed command.
    yarn command:prod workspace:seed:dev
  fi
  # Replace the development seed's shared password, which matches tim@apple.dev's email.
  password_hash=$(node -e 'process.stdout.write(require("bcrypt").hashSync("momentic-eval-1", 10))')
  psql "$PG_DATABASE_URL" --set=ON_ERROR_STOP=1 --set=hash="$password_hash" <<'SQL'
UPDATE core."user" SET "passwordHash" = :'hash';
SQL
  touch "$seed_state"
fi

touch /tmp/setup-complete
if [ "${1:-}" != "--once" ]; then
  # Compose keeps the setup container alive for its healthcheck.
  exec tail -f /dev/null
fi
