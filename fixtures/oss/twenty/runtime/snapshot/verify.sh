#!/bin/sh
set -eu
schema=$(su-exec postgres psql default --set=ON_ERROR_STOP=1 -Atc "SELECT table_schema FROM information_schema.tables WHERE table_name = 'company' AND table_schema LIKE 'workspace_%' ORDER BY table_schema LIMIT 1")
case "$schema" in
  workspace_*) ;;
  *) echo 'No seeded workspace company table.' >&2; exit 1 ;;
esac
count=$(su-exec postgres psql default --set=ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM \"$schema\".company")
test "$count" -gt 0
printf 'Seeded companies: %s\n' "$count"
