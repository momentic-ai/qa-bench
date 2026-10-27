#!/bin/sh
set -eu
. /fixture/app/snapshot/lib/environment.sh
export DISABLE_DB_MIGRATIONS=true
export DISABLE_CRON_JOBS_REGISTRATION=true
exec sh "${FIXTURE_SEED_SCRIPT:-/fixture/app/seed.sh}" --once
