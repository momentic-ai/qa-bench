#!/bin/sh
set -eu

# Restore the clean database and bare repositories into this sandbox's own data volume.
mkdir -p /data
tar -C /data -xf /fixture-seeded/gitea-data.tar
config=/data/gitea/conf/app.ini
[ -f /data/gitea/gitea.db ]
[ -f "$config" ]
# The old revision reads its installed config before processing environment overrides.
sed -i \
  -e "s|^ROOT_URL[[:space:]]*=.*|ROOT_URL = $FIXTURE_URL/|" \
  -e "s|^DOMAIN[[:space:]]*=.*|DOMAIN = $FIXTURE_HOST|" \
  -e "s|^HTTP_PORT[[:space:]]*=.*|HTTP_PORT = $FIXTURE_PORT|" \
  -e 's|^INSTALL_LOCK[[:space:]]*=.*|INSTALL_LOCK = true|' \
  "$config"
export GITEA__security__INSTALL_LOCK=true
exec sh /fixture/app/snapshot/initialize.sh
