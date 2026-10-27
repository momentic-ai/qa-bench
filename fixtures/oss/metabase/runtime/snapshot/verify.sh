#!/bin/sh
set -eu
count=$(su-exec postgres psql release_operations --set=ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM release_requests')
test "$count" -eq 6
printf 'Seeded release requests: %s\n' "$count"
