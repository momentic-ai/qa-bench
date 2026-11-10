#!/bin/sh
set -eu

test -f /fixture/seeded-state
test -f /var/lib/postgresql/data/PG_VERSION
test -f /fixture/metabase.db/metabase.db.mv.db
su-exec postgres pg_ctl -D /var/lib/postgresql/data -l /tmp/postgres.log -o '-h 127.0.0.1 -p 5432 -k /run/postgresql' -w start
export MB_JETTY_PORT="$FIXTURE_PORT"
export MB_DB_TYPE=h2
export MB_DB_FILE=/fixture/metabase.db
export MB_ANON_TRACKING_ENABLED=false
export MB_CHECK_FOR_UPDATES=false
export MB_SITE_URL="$FIXTURE_URL/"
exec /app/run_metabase.sh
