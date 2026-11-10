#!/bin/sh
set -eu

cd /app/packages/twenty-server
if grep -q 'setup-db.ts' /app/entrypoint.sh; then
  # Older images launch a development TypeScript script for these schemas.
  psql "$PG_DATABASE_URL" --set=ON_ERROR_STOP=1 --file=/fixture/app/data/init-db.sql
  yarn database:migrate:prod
else
  # Newer entrypoints initialize an empty database through their production CLI.
  echo 'Database initialization is handled by the production entrypoint.'
fi
