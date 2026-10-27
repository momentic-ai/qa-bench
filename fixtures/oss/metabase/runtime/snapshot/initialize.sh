#!/bin/sh
set -eu

su-exec postgres initdb -D /var/lib/postgresql/data --auth=trust
su-exec postgres pg_ctl -D /var/lib/postgresql/data -l /tmp/postgres.log -o '-h 127.0.0.1 -p 5432 -k /run/postgresql' -w start
su-exec postgres createdb release_operations
su-exec postgres psql --dbname=release_operations --set=ON_ERROR_STOP=1 --file=/fixture/app/data/sample-data.sql
export MB_JETTY_PORT="$FIXTURE_PORT"
export MB_DB_TYPE=h2
export MB_DB_FILE=/tmp/metabase.db
export MB_ANON_TRACKING_ENABLED=false
export MB_CHECK_FOR_UPDATES=false
export MB_SITE_URL="$FIXTURE_URL/"
exec /app/run_metabase.sh
