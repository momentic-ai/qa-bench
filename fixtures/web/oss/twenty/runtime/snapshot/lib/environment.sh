export NODE_PORT="$FIXTURE_PORT"
export PG_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/default
export REDIS_URL=redis://127.0.0.1:6379
export SERVER_URL="$FIXTURE_URL"
export APP_SECRET=momentic-diy-twenty-fixture-secret
export STORAGE_TYPE=local
export IS_MULTIWORKSPACE_ENABLED=false
export TELEMETRY_ENABLED=false
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=1500"
