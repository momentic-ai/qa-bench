#!/bin/sh
set -eu
. /fixture/app/snapshot/lib/environment.sh

test -f /var/lib/postgresql/data/PG_VERSION
test -f /fixture/seeded-state
su-exec postgres pg_ctl -D /var/lib/postgresql/data -l /tmp/postgres.log -o '-h 127.0.0.1 -p 5432 -k /run/postgresql' -w start
redis-server --daemonize yes --maxmemory-policy noeviction
# This cluster has already run the pinned revision's migrations; fresh Redis needs normal job registration.
export DISABLE_DB_MIGRATIONS=true
cd /app/packages/twenty-server
if [ -f dist/src/main.js ]; then
  # Older revisions retain the source directory in their compiled output.
  main=dist/src/main
else
  # Newer revisions compile directly into dist.
  main=dist/main
fi
exec /app/entrypoint.sh node "$main"
