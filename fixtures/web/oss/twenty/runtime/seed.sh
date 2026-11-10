#!/bin/sh
set -eu

seed_state=/app/packages/twenty-server/.local-storage/diy-mo-seed-complete
if [ ! -f "$seed_state" ]; then
  cd /app/packages/twenty-server
  if yarn command:prod workspace:seed:dev --help | grep -q -- '--light'; then
    # Newer revisions can seed just the standard demo workspace.
    yarn command:prod workspace:seed:dev --light
  else
    # Older revisions expose only the full development seed command.
    yarn command:prod workspace:seed:dev
  fi
  touch "$seed_state"
fi

touch /tmp/setup-complete
if [ "${1:-}" != "--once" ]; then
  # Compose keeps the setup container alive for its healthcheck.
  exec tail -f /dev/null
fi
