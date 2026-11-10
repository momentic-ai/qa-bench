#!/bin/sh
set -eu

sh /fixture/app/snapshot/verify.sh
# Stop via the image's supervisor so it cannot restart Gitea while SQLite closes.
s6-svc -d /etc/s6/gitea
s6-svwait -d -t 30000 /etc/s6/gitea
if command -v sqlite3 > /dev/null 2>&1; then
  # Bundled SQLite can additionally check the database after the clean service exit.
  sqlite3 /data/gitea/gitea.db 'PRAGMA wal_checkpoint(TRUNCATE);'
  [ "$(sqlite3 /data/gitea/gitea.db 'PRAGMA integrity_check;')" = ok ]
fi

# Each sandbox starts without prior sessions or logs, while keeping repositories and wiki history.
rm -rf /data/gitea/sessions /data/gitea/log /data/gitea/tmp
mkdir -p /data/gitea/log
chown git:git /data/gitea/log
sed -i \
  -e 's|^ROOT_URL[[:space:]]*=.*|ROOT_URL = http://localhost:3000/|' \
  -e 's|^DOMAIN[[:space:]]*=.*|DOMAIN = localhost|' \
  /data/gitea/conf/app.ini
# Upstream declares /data a volume, so Daytona captures its contents from the root filesystem.
mkdir -p /fixture-seeded
tar -C /data -cf /fixture-seeded/gitea-data.tar gitea git
rm -f /tmp/setup-complete
sync
