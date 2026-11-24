#!/bin/sh
set -eu
. /fixture/app/snapshot/lib/environment.sh

su-exec postgres initdb -D /var/lib/postgresql/data --auth=trust
su-exec postgres pg_ctl -D /var/lib/postgresql/data -l /tmp/postgres.log -o '-h 127.0.0.1 -p 5432 -k /run/postgresql' -w start
su-exec postgres createdb default
redis-server --daemonize yes --maxmemory-policy noeviction
sh /fixture/app/lib/initialize-database.sh
mkdir -p /app/packages/twenty-server/.local-storage
cd /app/packages/twenty-server
if [ -f dist/src/main.js ]; then
  # Older revisions keep their source directory in the compiled output.
  main=dist/src/main
else
  # Newer revisions compile the application entrypoint directly into dist.
  main=dist/main
fi
exec /app/entrypoint.sh node "$main"
