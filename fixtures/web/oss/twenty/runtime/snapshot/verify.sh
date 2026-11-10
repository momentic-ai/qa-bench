#!/bin/sh
set -eu
psql() {
  su-exec postgres psql default --set=ON_ERROR_STOP=1 -Atc "$1"
}
test "$(psql 'SELECT count(*) FROM core."user"')" -eq 1
test "$(psql 'SELECT count(*) FROM core.workspace')" -eq 1
schema=$(psql "SELECT table_schema FROM information_schema.tables WHERE table_name = 'company' AND table_schema LIKE 'workspace_%'")
case "$schema" in
  workspace_*) ;;
  *) echo 'No workspace company table after installation.' >&2; exit 1 ;;
esac
test ! -f /app/packages/twenty-server/.local-storage/diy-mo-seed-complete
for table in company person opportunity task note; do
  count=$(psql "SELECT count(*) FROM \"$schema\".\"$table\"")
  printf 'Native %s records: %s\n' "$table" "$count"
done
printf 'Unseeded Twenty verified: one account and workspace, development seed not run.\n'
